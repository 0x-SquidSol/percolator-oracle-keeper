/**
 * B20 (E2E 2026-09-30): the price-push loop must not send PushAuthMark to a
 * Resolved market or a CloseSlab tombstone (it reverted Custom(21) in preflight
 * every cycle). Real SOL bytes; mode byte (abs 1218) / kind (byte 10) patched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { pushAuthMarkBatch, resetTerminalPushLogForTests } from "./auth-mark-pusher.ts";
import { countPushableMarkets } from "./keeper-loop.ts";
import { DEFAULT_THRESHOLDS, evaluatePushCycle } from "./alerting.ts";
import { nonComputeBudget } from "./test-ix.ts";
import type { PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOL_BYTES = Buffer.from(readFileSync(join(here, "__fixtures__", "sol-market-v18-fees.b64"), "utf8").trim(), "base64");
const resolved = (): Buffer => { const b = Buffer.from(SOL_BYTES); b[592 + 626] = 1; return b; };
const recovery = (): Buffer => { const b = Buffer.from(SOL_BYTES); b[592 + 626] = 2; return b; };
const tombstone = (): Buffer => { const b = Buffer.from(SOL_BYTES.subarray(0, 64)); b[10] = 8; return b; };
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
const mk = () => Keypair.generate().publicKey.toBase58();

function conn(data: Map<string, Buffer>) {
  const simulated: string[][] = [];
  const sent: string[][] = [];
  return {
    simulated, sent,
    conn: {
      async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) { return pks.map((pk) => ({ data: data.get(pk.toBase58())! })); },
      async simulateTransaction(tx: { instructions: Array<{ programId: PublicKey; keys: Array<{ pubkey: { toBase58(): string } }> }> }) {
        const ms = nonComputeBudget(tx.instructions).map((ix) => ix.keys[1].pubkey.toBase58());
        simulated.push(ms);
        return { value: { err: null } };
      },
      async sendRawTransaction() { sent.push(simulated[simulated.length - 1]); return "sig"; },
    },
  };
}

describe("B20: PushAuthMark skips Resolved / tombstoned markets", () => {
  it("live markets are pushed; resolved + tombstone are dropped BEFORE the batch, reported as terminal, not as drops", async () => {
    resetTerminalPushLogForTests();
    const [live, res, dead] = [mk(), mk(), mk()];
    const c = conn(new Map([[live, SOL_BYTES], [res, resolved()], [dead, tombstone()]]));
    const out = await pushAuthMarkBatch(c.conn as never, Keypair.generate(),
      [live, res, dead].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n })), 100n, BLOCKHASH, false);
    assert.deepEqual(c.simulated.flat(), [live], "only the live market ever reaches a transaction");
    assert.deepEqual(out.pushedMarkets, [live]);
    assert.deepEqual([...(out.terminalMarkets ?? [])].sort(), [res, dead].sort());
    assert.ok(!out.skippedMarkets.includes(res) && !out.skippedMarkets.includes(dead), "not counted as preflight drops");
  });
  it("a board of only terminal markets sends nothing and reports no drops", async () => {
    const [res] = [mk()];
    const c = conn(new Map([[res, resolved()]]));
    const out = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [{ marketAddress: res, assetIndex: 0, priceE6: 1n }], 100n, BLOCKHASH, false);
    assert.equal(c.simulated.length, 0);
    assert.deepEqual(out.skippedMarkets, []);
    assert.deepEqual(out.terminalMarkets, [res]);
  });
});

describe("B20: push health does not count terminal markets", () => {
  it("a board of only terminal markets raises no zero-push alert", () => {
    const [a, b] = [mk(), mk()];
    const registered = countPushableMarkets([{ marketAddress: a }, { marketAddress: b }], new Set([a, b]));
    assert.equal(registered, 0);
    let streak = 0;
    for (let i = 0; i < 20; i++) streak = evaluatePushCycle({ cycle: i, registered, attempted: 0, pushed: 0 }, streak, DEFAULT_THRESHOLDS).zeroStreak;
    assert.equal(streak, 0);
  });
  it("a live market that stops pushing still alerts (control)", () => {
    const [a, b] = [mk(), mk()];
    assert.equal(countPushableMarkets([{ marketAddress: a }, { marketAddress: b }], new Set([a])), 1);
  });
});

describe("Recovery (expired-close valve): not pushed", () => {
  it("a market in Recovery (mode 2) is dropped before the batch like a Resolved one", async () => {
    resetTerminalPushLogForTests();
    const [live, rec] = [mk(), mk()];
    const c = conn(new Map([[live, SOL_BYTES], [rec, recovery()]]));
    const out = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [live, rec].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n })), 100n, BLOCKHASH, false);
    assert.deepEqual(c.simulated.flat(), [live]);
    assert.deepEqual(out.terminalMarkets, [rec]);
  });
});
