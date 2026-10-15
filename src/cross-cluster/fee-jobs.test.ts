/** The shared fee-job loop: classification, isolation, alerting. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { FeeJobFailureTracker, FEE_JOB_FAILURE_ALERT_AFTER, runFeeJobSweep, summarizeSweep } from "./fee-jobs.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";

const ctx = { conn: {} as never, keeper: Keypair.generate(), dryRun: false };
const markets = ["A", "B", "C", "D", "E", "F"].map((x) => ({ marketAddress: x, label: `${x}/USDC` }));
const outcomes: Record<string, FeeJobOutcome | "throw"> = {
  A: { kind: "done", detail: "moved 5" },
  B: { kind: "nothing" },
  C: { kind: "skipped", reason: "no vault" },
  D: { kind: "blocked", reason: "Custom(56) not bound" },
  E: { kind: "failed", error: "rpc 429" },
  F: "throw",
};
const job: FeeJob = {
  name: "test-job",
  async run(_c, m) {
    const o = outcomes[m.marketAddress];
    if (o === "throw") throw new Error("kaboom");
    return o;
  },
};

describe("runFeeJobSweep", () => {
  it("buckets every outcome; a throwing job is a failure, not a crash", async () => {
    const r = await runFeeJobSweep(job, ctx, markets, 2);
    assert.deepEqual(summarizeSweep(r), { done: 1, nothing: 1, skipped: 1, blocked: 1, waiting: 0, failed: 2 });
    assert.ok(r.failed.some((f) => f.market === "F" && /kaboom/.test(f.error)));
  });
  it("bounds concurrency", async () => {
    let inflight = 0; let peak = 0;
    const slow: FeeJob = { name: "slow", async run() { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return { kind: "nothing" }; } };
    await runFeeJobSweep(slow, ctx, markets, 3);
    assert.equal(peak, 3);
  });
});

describe("FeeJobFailureTracker", () => {
  it("blocked legs alert every sweep (deduped by the sink); failures only after a streak", async () => {
    const t = new FeeJobFailureTracker();
    const r = await runFeeJobSweep(job, ctx, markets);
    for (let i = 1; i < FEE_JOB_FAILURE_ALERT_AFTER; i++) {
      const a = t.alertsFor(r);
      assert.deepEqual(a.map((x) => x.kind), ["fee-leg-blocked"], `sweep ${i}`);
    }
    const a = t.alertsFor(r);
    assert.deepEqual(a.map((x) => x.kind).sort(), ["fee-job-failed", "fee-job-failed", "fee-leg-blocked"]);
    const clean = { ...r, failed: [] };
    t.alertsFor(clean);
    assert.deepEqual(t.alertsFor(r).map((x) => x.kind), ["fee-leg-blocked"], "streak reset after a clean sweep");
  });
});
