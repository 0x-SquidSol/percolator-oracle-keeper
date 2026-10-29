/** F6: the signature status decides whether a transaction landed. A7-1: it is polled over HTTP, never via the primary's websocket. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Connection } from "@solana/web3.js";
import { confirmBySignature, customCodeOf } from "./tx-confirm.ts";
import type { ConfirmConnection } from "./tx-confirm.ts";
import { failoverFromEnv, GENESIS_HASH } from "../rpc-failover.ts";

type Status = { err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" } | null;

function conn(o: { statuses: Status[] | "throw" | "hang"; height?: number | "throw" }) {
  let reads = 0;
  let heights = 0;
  const c = {
    async getSignatureStatuses() {
      reads++;
      if (o.statuses === "throw") throw new Error("rpc-degraded: all devnet RPC endpoints are down");
      if (o.statuses === "hang") return new Promise(() => {});
      const s = o.statuses[Math.min(reads - 1, o.statuses.length - 1)] ?? null;
      return { context: { slot: 1 }, value: [s ? { slot: 1, confirmations: 1, ...s } : null] };
    },
    async getBlockHeight() {
      heights++;
      if (o.height === "throw") throw new Error("rpc-degraded: all devnet RPC endpoints are down");
      return o.height ?? 2; // past lastValidBlockHeight 1
    },
  };
  return { c: c as unknown as ConfirmConnection, reads: () => reads, heights: () => heights };
}
const FAST = { statusRetries: 2, statusRetryDelayMs: 0 };

describe("confirmBySignature", () => {
  it("status confirmed on the first poll -> landed, no block-height read", async () => {
    const k = conn({ statuses: [{ err: null, confirmationStatus: "confirmed" }] });
    assert.deepEqual(await confirmBySignature(k.c, "s", "b", 1, FAST), { status: "landed", signature: "s", via: "signature-status", slot: 1 });
    assert.equal(k.reads(), 1);
    assert.equal(k.heights(), 0);
  });
  it("no status until after the block height passed, then confirmed on a re-check -> landed (the SOLCAT/ANSEM case)", async () => {
    const k = conn({ statuses: [...Array(10).fill(null), { err: null, confirmationStatus: "confirmed" }] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "landed");
    assert.equal(k.heights(), 1);
  });
  it("status 'processed' then 'finalized' -> keeps polling, then landed", async () => {
    const k = conn({ statuses: [{ err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "finalized" }] });
    assert.equal((await confirmBySignature(k.c, "s", "b", 1, FAST)).status, "landed");
    assert.equal(k.reads(), 2);
  });
  it("the status shows an on-chain error -> failed with its code (never 'landed')", async () => {
    const k = conn({ statuses: [{ err: { InstructionError: [1, { Custom: 38 }] }, confirmationStatus: "confirmed" }] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "failed");
    assert.equal((r as { code: number }).code, 38);
  });
  it("no status, block height past lastValidBlockHeight -> not-landed after the re-checks (retry next cycle)", async () => {
    const k = conn({ statuses: [null] });
    const r = await confirmBySignature(k.c, "s", "b", 1, FAST);
    assert.equal(r.status, "not-landed");
    assert.equal(k.reads(), 10 + FAST.statusRetries); // 10 fast polls, the last one followed by the height check, + re-checks
    assert.match((r as { reason: string }).reason, /block height exceeded/);
  });
  it("no status, block height not yet past -> keeps polling until the deadline, then not-landed", async () => {
    const k = conn({ statuses: [null], height: 1 });
    const r = await confirmBySignature(k.c, "s", "b", 1, { ...FAST, statusRetryDelayMs: 20, deadlineMs: 300 });
    assert.equal(r.status, "not-landed");
    assert.match((r as { reason: string }).reason, /deadline/);
  });
  it("every RPC call throws (all endpoints down) -> not-landed at the deadline, never a hang", async () => {
    const k = conn({ statuses: "throw", height: "throw" });
    const t0 = Date.now();
    const r = await confirmBySignature(k.c, "s", "b", 1, { ...FAST, statusRetryDelayMs: 20, deadlineMs: 300 });
    assert.equal(r.status, "not-landed");
    assert.match((r as { reason: string }).reason, /deadline.*read failed/);
    assert.ok(Date.now() - t0 < 1_000);
  });
  it("an RPC call that never answers is cut off at the deadline", async () => {
    const k = conn({ statuses: "hang" });
    const t0 = Date.now();
    const r = await confirmBySignature(k.c, "s", "b", 1, { ...FAST, deadlineMs: 300 });
    assert.equal(r.status, "not-landed");
    assert.ok(Date.now() - t0 < 1_000);
  });
  it("an error seen only at 'processed' is not final (minority fork): waits for 'confirmed'", async () => {
    const k = conn({ statuses: [{ err: { InstructionError: [1, { Custom: 41 }] }, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }] });
    assert.equal((await confirmBySignature(k.c, "s", "b", 1, FAST)).status, "landed");
  });
  it("one read that never answers is cut off at the per-read cap; the next poll decides, not the deadline", async () => {
    let reads = 0;
    const c = {
      getSignatureStatuses() {
        reads++;
        return reads === 1 ? new Promise(() => {}) : Promise.resolve({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] });
      },
      async getBlockHeight() { return 0; },
    } as unknown as ConfirmConnection;
    const t0 = Date.now();
    const r = await confirmBySignature(c, "s", "b", 1, { ...FAST, deadlineMs: 30_000 });
    assert.equal(r.status, "landed");
    assert.ok(Date.now() - t0 < 7_000, `${Date.now() - t0} ms`);
  });
});

/**
 * A7-1 regression, through a real web3.js Connection built as cross-cluster.ts builds devnetConn (failover fetch, no
 * wsEndpoint: web3.js derives ws://host:(port+1) from the primary URL). Local fakes: the primary answers HTTP 429 and
 * has no websocket; the fallback answers; the chain advances 1 block / 400 ms and the blockhash is valid for 150 of them.
 * Before the fix a tx that landed in 300 ms was reported only at expiry (~60 s); with every endpoint down it never returned.
 */
describe("confirmBySignature through the RPC failover (primary down, its websocket unreachable)", () => {
  const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

  async function freePortPair(): Promise<number> {
    const free = (p: number) =>
      new Promise<boolean>((res) => {
        const s = net.createServer();
        s.once("error", () => res(false));
        s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
      });
    for (;;) {
      const p = 20_000 + Math.floor(Math.random() * 40_000);
      if ((await free(p)) && (await free(p + 1))) return p;
    }
  }

  async function setup(o: { landed: boolean; err?: unknown }) {
    const t0 = Date.now();
    const height = () => 1_000 + Math.floor((Date.now() - t0) / 400);
    const slot = () => 5_000 + Math.floor((Date.now() - t0) / 400);
    const calls: string[] = [];
    let primaryMode: "up" | "429" = "up";
    let fallbackUp = true;
    const server = (name: string) =>
      http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const b = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
          calls.push(`${name}:${b.method}`);
          if ((name === "P" && primaryMode === "429") || (name === "F" && !fallbackUp)) {
            res.writeHead(name === "P" ? 429 : 503).end("max usage reached");
            return;
          }
          const ok = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }));
          const landedNow = o.landed && Date.now() - t0 > 300;
          if (b.method === "getGenesisHash") ok(GENESIS_HASH.devnet);
          else if (b.method === "getSlot") ok(slot());
          else if (b.method === "getBlockTime") ok(Math.floor(Date.now() / 1000 - (slot() - Number(b.params?.[0])) * 0.4));
          else if (b.method === "getBlockHeight") ok(height());
          else if (b.method === "getSignatureStatuses")
            ok({ context: { slot: slot() }, value: [landedNow ? { slot: slot() - 2, confirmations: 2, err: o.err ?? null, confirmationStatus: "confirmed" } : null] });
          else ok(null);
        });
      });
    const pPort = await freePortPair(); // pPort + 1 (the derived ws port) stays unbound: connection refused
    const fPort = await freePortPair();
    const p = server("P");
    const f = server("F");
    await new Promise<void>((r) => p.listen(pPort, "127.0.0.1", () => r()));
    await new Promise<void>((r) => f.listen(fPort, "127.0.0.1", () => r()));
    const failover = failoverFromEnv("devnet", `http://127.0.0.1:${pPort}`, [`http://127.0.0.1:${fPort}`], {}, (i, init) => fetch(i, init));
    assert.ok(failover);
    const c = new Connection(`http://127.0.0.1:${pPort}`, { commitment: "confirmed", fetch: failover.fetch });
    await c.getSlot(); // healthy warm-up: primary vetted and active
    primaryMode = "429";
    return {
      c,
      calls,
      lastValid: height() + 150,
      fallbackDown: () => (fallbackUp = false),
      close: () => {
        for (const s of [p, f]) {
          s.closeAllConnections();
          s.close();
        }
      },
    };
  }
  /** Resolve the confirm or give up after `ms` (a hang is the pre-fix behaviour, not a test-runner timeout). */
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

  it("a tx that landed is reported landed in seconds, not at blockhash expiry", async () => {
    const s = await setup({ landed: true });
    try {
      const t0 = Date.now();
      const r = await within(confirmBySignature(s.c, SIG, "b", s.lastValid), 10_000);
      assert.notEqual(r, "timeout", "still waiting after 10 s (blockhash valid for ~60 s)");
      assert.equal((r as { status: string }).status, "landed");
      assert.equal((r as { via: string }).via, "signature-status");
      assert.ok(Date.now() - t0 < 3_000, `${Date.now() - t0} ms`);
      assert.ok(s.calls.filter((x) => x === "F:getSignatureStatuses").length >= 1, "polled through the fallback");
    } finally {
      s.close();
    }
  });

  it("a tx that landed but failed on chain -> failed with its code", async () => {
    const s = await setup({ landed: true, err: { InstructionError: [2, { Custom: 41 }] } });
    try {
      const r = await within(confirmBySignature(s.c, SIG, "b", s.lastValid), 10_000);
      assert.notEqual(r, "timeout");
      assert.equal((r as { status: string }).status, "failed");
      assert.equal((r as { code: number }).code, 41);
    } finally {
      s.close();
    }
  });

  it("every endpoint down after the send -> returns not-landed at the deadline instead of hanging", async () => {
    const s = await setup({ landed: false });
    s.fallbackDown();
    try {
      const t0 = Date.now();
      const r = await within(confirmBySignature(s.c, SIG, "b", s.lastValid, { statusRetryDelayMs: 500, deadlineMs: 4_000 }), 10_000);
      assert.notEqual(r, "timeout", "no verdict after 10 s");
      assert.equal((r as { status: string }).status, "not-landed");
      assert.ok(Date.now() - t0 < 6_000, `${Date.now() - t0} ms`);
    } finally {
      s.close();
    }
  });
});

describe("customCodeOf", () => {
  it("reads both the JSON and the hex form", () => {
    assert.equal(customCodeOf({ InstructionError: [1, { Custom: 56 }] }), 56);
    assert.equal(customCodeOf("custom program error: 0x26"), 38);
    assert.equal(customCodeOf("nope"), null);
  });
});
