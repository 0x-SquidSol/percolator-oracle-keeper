/**
 * K-1 (2026-10-03): per-market push health. BOME (7mqDbApo) failed 46,623 of
 * 46,623 cycles with "no pool price this cycle" and lastPushAgo null, while
 * /health said status "ok": the board-wide checks only look at whether ANY
 * market pushed. Plus the K-3 mark-lagging and source-frozen signals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AlertSink,
  DEFAULT_THRESHOLDS,
  evaluateMarketPush,
  thresholdsFromEnv,
  type MarketPushSample,
} from "./alerting.ts";
import {
  advanceNoPushStreaks,
  marketPushSample,
  newMarketStat,
  recordLandedPush,
  recordRawPrice,
} from "./keeper-loop.ts";

const T = DEFAULT_THRESHOLDS;
const NOW = 10_000_000;
const sample = (over: Partial<MarketPushSample> = {}): MarketPushSample => ({
  label: "BOME/USDC — pumpswap",
  market: "7mqDbApo",
  noPushCycles: 0,
  lastPushAt: NOW - 2_000,
  lastError: null,
  markGap: null,
  sourceUnchangedSince: NOW - 60_000,
  terminal: false,
  ...over,
});

describe("K-1 market no-push", () => {
  it("BOME shape: never pushed, every cycle failing -> no-push, critical alert", () => {
    const r = evaluateMarketPush(
      sample({ noPushCycles: 46_623, lastPushAt: null, lastError: "no pool price this cycle", sourceUnchangedSince: null }),
      T,
      NOW,
    );
    assert.equal(r.status, "no-push");
    const a = r.active.find((x) => x.kind === "market-no-push");
    assert.ok(a, "alert fires");
    assert.equal(a.severity, "critical");
    assert.match(a.message, /never since keeper boot/);
    assert.match(a.message, /no pool price this cycle/);
  });

  it("a healthy market is ok with no alerts", () => {
    assert.deepEqual(evaluateMarketPush(sample(), T, NOW), { status: "ok", active: [] });
  });

  it("threshold boundary: N-1 cycles ok, N cycles degraded", () => {
    assert.equal(evaluateMarketPush(sample({ noPushCycles: T.marketNoPushCycles - 1 }), T, NOW).status, "ok");
    assert.equal(evaluateMarketPush(sample({ noPushCycles: T.marketNoPushCycles }), T, NOW).status, "no-push");
  });

  it("a terminal (Resolved/closed) market is never degraded", () => {
    assert.deepEqual(evaluateMarketPush(sample({ noPushCycles: 99_999, terminal: true }), T, NOW), { status: "ok", active: [] });
  });

  it("the streak grows on every cycle without a landed push and a landed push resets it", () => {
    const bome = newMarketStat({ label: "BOME", marketAddress: "B", poolAddress: "p", dexType: "pumpswap" });
    const sol = newMarketStat({ label: "SOL", marketAddress: "S", poolAddress: "q", dexType: "meteora-dlmm" });
    for (let i = 0; i < 50; i++) {
      const landed = new Set<string>();
      recordLandedPush(sol, NOW + i, "sig");
      landed.add("S");
      advanceNoPushStreaks([bome, sol], landed);
    }
    assert.equal(bome.noPushCycles, 50);
    assert.equal(sol.noPushCycles, 0);
    assert.equal(evaluateMarketPush(marketPushSample(bome, false), T, NOW).status, "no-push");
    recordLandedPush(bome, NOW, "sig2");
    assert.equal(bome.noPushCycles, 0);
  });
});

describe("K-3 mark lagging", () => {
  it("Agency shape: mark held 100% below the source for 30 min -> mark-lagging, names the free side", () => {
    const r = evaluateMarketPush(
      sample({ label: "Agency", markGap: { pct: 103, ageMs: 30 * 60_000, checks: 1_200, dir: 1 } }),
      T,
      NOW,
    );
    assert.equal(r.status, "mark-lagging");
    const a = r.active.find((x) => x.kind === "mark-lagging");
    assert.ok(a);
    assert.match(a.message, /BELOW the source/);
    assert.match(a.message, /a long opened now is a free option/);
  });

  it("a short or small gap does not alert", () => {
    assert.equal(evaluateMarketPush(sample({ markGap: { pct: 50, ageMs: T.markLagMs - 1, checks: 70, dir: 1 } }), T, NOW).status, "ok");
    assert.equal(evaluateMarketPush(sample({ markGap: { pct: 2, ageMs: 3_600_000, checks: 2_400, dir: -1 } }), T, NOW).status, "ok");
  });

  it("no-push outranks mark-lagging but both alerts fire", () => {
    const r = evaluateMarketPush(
      sample({ noPushCycles: 1_000, markGap: { pct: 40, ageMs: 600_000, checks: 400, dir: -1 } }),
      T,
      NOW,
    );
    assert.equal(r.status, "no-push");
    assert.deepEqual(r.active.map((a) => a.kind).sort(), ["mark-lagging", "market-no-push"]);
  });
});

describe("K-3 source frozen (WIF/KMNO shape)", () => {
  it("warns after the raw price has been bit-identical for the threshold and degrades the status to source-frozen (#214)", () => {
    const stat = newMarketStat({ label: "WIF", marketAddress: "W", poolAddress: "p", dexType: "meteora-dlmm" });
    recordRawPrice(stat, 250_800n, NOW - T.sourceFrozenMs - 1);
    recordRawPrice(stat, 250_800n, NOW - 1_000); // same price again: the clock does not restart
    const r = evaluateMarketPush(marketPushSample(stat, false), T, NOW);
    assert.equal(r.status, "source-frozen");
    assert.deepEqual(r.active.map((a) => a.kind), ["source-frozen"]);
    assert.equal(r.active[0].severity, "warn");
    recordRawPrice(stat, 250_801n, NOW); // any change restarts it
    assert.deepEqual(evaluateMarketPush(marketPushSample(stat, false), T, NOW).active, []);
  });
});

describe("thresholds from env", () => {
  it("reads the K-1/K-3 thresholds and rejects garbage", () => {
    const t = thresholdsFromEnv({
      ALERT_MARKET_NO_PUSH_CYCLES: "100",
      ALERT_MARK_LAG_MS: "60000",
      ALERT_MARK_LAG_PCT: "20",
      ALERT_SOURCE_FROZEN_MS: "3600000",
    });
    assert.equal(t.marketNoPushCycles, 100);
    assert.equal(t.markLagMs, 60_000);
    assert.equal(t.markLagPct, 20);
    assert.equal(t.sourceFrozenMs, 3_600_000);
    assert.throws(() => thresholdsFromEnv({ ALERT_MARKET_NO_PUSH_CYCLES: "0" }));
    assert.deepEqual(thresholdsFromEnv({}), DEFAULT_THRESHOLDS);
  });
});

describe("sink delivery for push-market alerts", () => {
  it("fires once, respects the cooldown, and resolves when the market pushes again", async () => {
    const lines: string[] = [];
    let now = NOW;
    const sink = new AlertSink({ thresholds: T, now: () => now, log: (l) => lines.push(l), logError: (l) => lines.push(l) });
    const bad = evaluateMarketPush(sample({ noPushCycles: 500, lastPushAt: null }), T, now).active;
    assert.equal((await sink.reconcile("push-market", bad)).length, 1);
    now += 1_000;
    assert.equal((await sink.reconcile("push-market", bad)).length, 0, "cooldown");
    await sink.reconcile("push-market", []);
    assert.ok(lines.some((l) => l.startsWith("[ALERT-RESOLVED]") && l.includes("market-no-push")));
  });
});
