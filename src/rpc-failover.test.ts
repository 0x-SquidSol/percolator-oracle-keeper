import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTransientRpcError, parseFallbackUrls, preflightOutageDecision } from "./rpc-failover.ts";

test("status and error classification", () => {
  assert.ok(isTransientRpcError(new Error("rpc-degraded: all devnet RPC endpoints are down")));
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
