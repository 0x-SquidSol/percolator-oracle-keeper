import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failoverFetch, isFailoverStatus, isTransientRpcError, parseFallbackUrls, preflightOutageDecision } from "./rpc-failover.ts";

const P = "https://primary.example/?api-key=SECRET";
const F1 = "https://fb1.example";
const F2 = "https://fb2.example";
const ok = () => new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200 });
const st = (n: number) => new Response("x", { status: n });

function fakeBase(script: Record<string, Array<Response | Error>>, calls: string[]) {
  return async (input: string | URL | Request) => {
    const u = String(input);
    calls.push(u);
    const q = script[u] ?? [ok()];
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return r.clone();
  };
}

test("the Helius quota stop (429 max usage) fails over to the fallback and returns its 200", async () => {
  const calls: string[] = [];
  const f = failoverFetch(P, [F1], fakeBase({ [P]: [st(429)] }, calls));
  const res = await f(P, { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [P, F1]);
});

test("a dead primary is skipped during the cooldown, then retried", async () => {
  let t = 1_000;
  const calls: string[] = [];
  const f = failoverFetch(P, [F1], fakeBase({ [P]: [st(429)] }, calls), { now: () => t, cooldownMs: 60_000 });
  await f(P, { body: "a" });
  await f(P, { body: "b" });
  assert.deepEqual(calls, [P, F1, F1]);
  t += 61_000;
  await f(P, { body: "c" });
  assert.deepEqual(calls.slice(3), [P, F1]);
});

test("transport errors fail over; second fallback is used when the first is down", async () => {
  const calls: string[] = [];
  const f = failoverFetch(P, [F1, F2], fakeBase({ [P]: [new Error("fetch failed")], [F1]: [st(503)] }, calls));
  assert.equal((await f(P, { body: "{}" })).status, 200);
  assert.deepEqual(calls, [P, F1, F2]);
});

test("a 400 is the caller's problem and is NOT replayed", async () => {
  const calls: string[] = [];
  const f = failoverFetch(P, [F1], fakeBase({ [P]: [st(400)] }, calls));
  assert.equal((await f(P, { body: "{}" })).status, 400);
  assert.deepEqual(calls, [P]);
});

test("everything down: the last real response is returned (web3.js then applies its own backoff), or the error rethrown", async () => {
  const f = failoverFetch(P, [F1], fakeBase({ [P]: [st(429)], [F1]: [st(429)] }, []));
  assert.equal((await f(P, { body: "{}" })).status, 429);
  const g = failoverFetch(P, [F1], fakeBase({ [P]: [new Error("a")], [F1]: [new Error("b")] }, []));
  await assert.rejects(() => g(P, { body: "{}" }), /b/);
});

test("requests to other URLs and an empty fallback list pass straight through", async () => {
  const calls: string[] = [];
  await failoverFetch(P, [F1], fakeBase({}, calls))("https://other.example", {});
  await failoverFetch(P, [], fakeBase({ [P]: [st(429)] }, calls))(P, {});
  assert.deepEqual(calls, ["https://other.example", P]);
});

test("onFailover never receives the primary URL (it carries the API key)", async () => {
  const seen: string[] = [];
  const f = failoverFetch(P, [F1], fakeBase({ [P]: [st(429)] }, []), { onFailover: (i) => seen.push(JSON.stringify(i)) });
  await f(P, {});
  assert.ok(seen.length === 1 && !seen[0]!.includes("SECRET"));
});

test("status and error classification", () => {
  for (const s of [401, 402, 403, 429, 500, 503]) assert.ok(isFailoverStatus(s), String(s));
  for (const s of [200, 400, 404]) assert.ok(!isFailoverStatus(s), String(s));
  assert.ok(isTransientRpcError(new Error("429 Too Many Requests: max usage reached")));
  assert.ok(isTransientRpcError(new Error("fetch failed")));
  assert.ok(!isTransientRpcError(new Error("market X is owned by Y, not the fresh wrapper")));
});

test("parseFallbackUrls: default public devnet, off, list, bad entries", () => {
  assert.deepEqual(parseFallbackUrls(undefined), ["https://api.devnet.solana.com"]);
  assert.deepEqual(parseFallbackUrls("off"), []);
  assert.deepEqual(parseFallbackUrls("https://a.example, https://b.example"), ["https://a.example", "https://b.example"]);
  assert.throws(() => parseFallbackUrls("http://a.example"), /https/);
  assert.throws(() => parseFallbackUrls("nope"), /not a URL/);
});

test("preflightOutageDecision: only an unchanged, previously verified registry may start without RPC", () => {
  assert.equal(preflightOutageDecision("abc", "abc\n"), "proceed");
  assert.equal(preflightOutageDecision("abc", "abd"), "refuse");
  assert.equal(preflightOutageDecision("abc", undefined), "refuse");
});

// ── end to end: the real preflight script against a local RPC that answers 429 max usage reached ──
function runPreflight(stamp: "match" | "stale" | "none") {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const srv = http.createServer((_q, r) => { r.statusCode = 429; r.end("max usage reached"); });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-"));
      const reg = path.join(dir, "registry.json");
      const M = "11111111111111111111111111111111";
      fs.writeFileSync(reg, JSON.stringify({ markets: [{ label: "t", marketAddress: M, poolAddress: M, dexType: "pumpswap" }] }));
      const sha = crypto.createHash("sha256").update(fs.readFileSync(reg)).digest("hex");
      if (stamp !== "none") fs.writeFileSync(`${reg}.preflight-ok`, (stamp === "match" ? sha : "0".repeat(64)) + "\n");
      // The child must not block the event loop that serves the 429s, so spawn asynchronously.
      import("node:child_process").then(({ spawn }) => {
        const c = spawn(process.execPath, ["--import", "tsx/esm", "scripts/preflight-v22fresh.ts"], {
          env: { ...process.env, DEVNET_RPC_URL: `http://127.0.0.1:${port}`, WRAPPER_PROGRAM_ID: "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM", REGISTRY_PATH: reg, DEVNET_RPC_FALLBACK_URLS: "off" },
        });
        let out = "";
        c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
        c.on("close", (code) => { srv.close(); resolve({ code, out }); });
      });
    });
  });
}
void spawnSync;

test("preflight on an exhausted RPC: unchanged verified registry starts degraded (exit 0)", { timeout: 120_000 }, async () => {
  const r = await runPreflight("match");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /starting degraded/);
});

test("preflight on an exhausted RPC: an unverified or changed registry still refuses (exit 1)", { timeout: 120_000 }, async () => {
  for (const s of ["none", "stale"] as const) {
    const r = await runPreflight(s);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REFUSE/);
  }
});
