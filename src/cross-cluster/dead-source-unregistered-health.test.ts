/**
 * #214 / #184: a market whose price SOURCE is dead (raw pool price bit-identical for hours, still pushed every cycle) and a market the keeper
 * has no registry row for must NOT read status "ok", and must raise an alert the sink can page on (critical).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, evaluateMarketPush, thresholdsFromEnv, type MarketPushSample } from "./alerting.ts";
import { makeHealthHandler, marketPushSample, newMarketStat, noteDepthAttempt, recordRawPrice } from "./keeper-loop.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";

const T = DEFAULT_THRESHOLDS;
const NOW = 100_000_000;
const sample = (over: Partial<MarketPushSample> = {}): MarketPushSample => ({
  label: "MICRO/USDC",
  market: "MICRO",
  noPushCycles: 0, // pushed every cycle: that is the whole point of #214
  lastPushAt: NOW - 1_000,
  lastError: null,
  markGap: null,
  sourceUnchangedSince: NOW - 60_000,
  terminal: false,
  ...over,
});

describe("#214 dead price source", () => {
  it("frozen past the warn threshold: status is source-frozen (not ok), alert is warn", () => {
    const r = evaluateMarketPush(sample({ sourceUnchangedSince: NOW - T.sourceFrozenMs - 1 }), T, NOW);
    assert.equal(r.status, "source-frozen");
    assert.deepEqual(r.active.map((a) => [a.kind, a.severity]), [["source-frozen", "warn"]]);
  });

  it("frozen past the dead threshold: the alert is critical (pageable)", () => {
    const r = evaluateMarketPush(sample({ sourceUnchangedSince: NOW - T.sourceDeadMs - 1 }), T, NOW);
    assert.equal(r.status, "source-frozen");
    assert.deepEqual(r.active.map((a) => [a.kind, a.severity]), [["source-frozen", "critical"]]);
    assert.match(r.active[0].message, /fresh mark/);
  });

  it("just under the warn threshold stays ok; no-push and mark-lagging outrank source-frozen", () => {
    assert.equal(evaluateMarketPush(sample({ sourceUnchangedSince: NOW - T.sourceFrozenMs + 1 }), T, NOW).status, "ok");
    const frozen = NOW - T.sourceDeadMs - 1;
    assert.equal(evaluateMarketPush(sample({ sourceUnchangedSince: frozen, noPushCycles: 1_000 }), T, NOW).status, "no-push");
    assert.equal(evaluateMarketPush(sample({ sourceUnchangedSince: frozen, markGap: { pct: 40, ageMs: 600_000, checks: 4, dir: -1 } }), T, NOW).status, "mark-lagging");
  });

  it("a terminal market is never source-frozen", () => {
    assert.deepEqual(evaluateMarketPush(sample({ sourceUnchangedSince: NOW - T.sourceDeadMs - 1, terminal: true }), T, NOW), { status: "ok", active: [] });
  });

  it("ALERT_SOURCE_DEAD_MS is configurable, rejects garbage, and never sits below the warn threshold", () => {
    assert.equal(thresholdsFromEnv({ ALERT_SOURCE_DEAD_MS: "7200000" }).sourceDeadMs, 7_200_000);
    assert.throws(() => thresholdsFromEnv({ ALERT_SOURCE_DEAD_MS: "0" }));
    const t = { ...T, sourceFrozenMs: 10 * 3_600_000, sourceDeadMs: 6 * 3_600_000 };
    assert.deepEqual(evaluateMarketPush(sample({ sourceUnchangedSince: NOW - 8 * 3_600_000 }), t, NOW).active, [], "below the warn threshold: nothing");
    const r = evaluateMarketPush(sample({ sourceUnchangedSince: NOW - 10 * 3_600_000 - 1 }), t, NOW);
    assert.equal(r.active[0].severity, "critical", "dead threshold is max(dead, frozen), never below the warn threshold");
  });

  it("the real stat path: a frozen raw price on a market that lands every push reads source-frozen", () => {
    const stat = newMarketStat({ label: "NPC", marketAddress: "N", poolAddress: "p", dexType: "pumpswap" });
    recordRawPrice(stat, 1_234n, NOW - T.sourceDeadMs - 5);
    recordRawPrice(stat, 1_234n, NOW);
    assert.equal(stat.noPushCycles, 0);
    assert.equal(evaluateMarketPush(marketPushSample(stat, false), T, NOW).status, "source-frozen");
  });
});

describe("#184 a market the keeper has no registry row for", () => {
  it("is 'unregistered' with a critical alert, never ok", () => {
    const r = evaluateMarketPush(sample({ unregistered: true }), T, NOW);
    assert.equal(r.status, "unregistered");
    assert.deepEqual(r.active.map((a) => [a.kind, a.severity]), [["market-unregistered", "critical"]]);
  });

  it("terminal (Resolved/closed) still wins: a deliberately retired market is not alerted", () => {
    assert.deepEqual(evaluateMarketPush(sample({ unregistered: true, terminal: true }), T, NOW), { status: "ok", active: [] });
  });

  it("marketPushSample carries the flag", () => {
    const stat = newMarketStat({ label: "X", marketAddress: "X" });
    assert.equal(marketPushSample(stat, false, true).unregistered, true);
    assert.equal(marketPushSample(stat, false).unregistered, false);
  });
});

describe("/health surfaces both", () => {
  function health(stats: Map<string, ReturnType<typeof newMarketStat>>, registered: string[]): Record<string, unknown> {
    const state = {
      startedAt: Date.now(), lastCycleAt: Date.now(), cycleCount: 3, timeoutCount: 0, stats,
      lastSuccessfulPushAt: Date.now(), consecutiveBatchReadFailures: 0, lastBatchReadError: null,
      wallet: createWalletBalanceState(), cycleAttempted: 0, cyclePushed: 0, zeroPushStreak: 0,
      terminalMarkets: new Set<string>(), landedThisCycle: new Set<string>(), tickPublisher: { counters: () => ({ published: 0 }) },
    };
    let body = "";
    const reg = { markets: registered.map((a) => ({ marketAddress: a, label: a })) };
    makeHealthHandler(state as never, { intervalMs: 1500, healthPort: 0, healthBind: "127.0.0.1", dryRun: false, minKeeperBalanceLamports: 1, balanceCheckIntervalMs: 1 } as never, reg as never)(
      { url: "/health" } as never, { writeHead() {}, end(b: string) { body = b; } } as never);
    return JSON.parse(body) as Record<string, unknown>;
  }
  const mk = (addr: string) => { const s = newMarketStat({ label: addr, marketAddress: addr, poolAddress: "p", dexType: "pumpswap" }); s.lastPushAt = Date.now(); return s; };

  it("a pushed market with a dead source is listed, not ok, and degrades the overall status", () => {
    const s = mk("DEAD");
    s.sourceUnchangedSince = Date.now() - T.sourceDeadMs - 1_000;
    const h = health(new Map([["DEAD", s]]), ["DEAD"]);
    assert.equal((h.markets as Record<string, { status: string }>).DEAD.status, "source-frozen");
    assert.deepEqual(h.sourceFrozenMarkets, ["DEAD"]);
    assert.equal(h.status, "degraded-markets");
  });

  it("a stat with no registry row reads unregistered and degrades the overall status", () => {
    const h = health(new Map([["GHOST", mk("GHOST")]]), []);
    assert.equal((h.markets as Record<string, { status: string }>).GHOST.status, "unregistered");
    assert.deepEqual(h.unregisteredMarkets, ["GHOST"]);
    assert.equal(h.status, "degraded-markets");
  });

  it("a healthy board adds neither field (key set unchanged)", () => {
    const h = health(new Map([["OK", mk("OK")]]), ["OK"]);
    assert.equal(h.status, "ok");
    assert.equal("sourceFrozenMarkets" in h, false);
    assert.equal("unregisteredMarkets" in h, false);
  });
});

describe("#174 gap 3: 'could not read the reserve' is visible, not a silent 35 B push", () => {
  it("a constant-product market that keeps sending no depth while depth push is on raises depth-unavailable after the window; any depth clears it", () => {
    const stat = newMarketStat({ label: "CPMM", marketAddress: "C", poolAddress: "p", dexType: "pumpswap" });
    noteDepthAttempt(stat, true, false, NOW - T.depthAbsentMs - 1);
    noteDepthAttempt(stat, true, false, NOW - 1_000); // still absent: the clock does not restart
    const r = evaluateMarketPush(marketPushSample(stat, false), T, NOW);
    assert.equal(r.status, "ok", "advisory: the consequence is paged by the v22 depth-capacity alert");
    assert.deepEqual(r.active.map((a) => [a.kind, a.severity]), [["depth-unavailable", "warn"]]);
    noteDepthAttempt(stat, true, true, NOW);
    assert.deepEqual(evaluateMarketPush(marketPushSample(stat, false), T, NOW).active, []);
  });

  it("not expected (flag off / non-CPMM venue) never starts the clock; under the window nothing fires", () => {
    const stat = newMarketStat({ label: "DLMM", marketAddress: "D", poolAddress: "p", dexType: "meteora-dlmm" });
    noteDepthAttempt(stat, false, false, NOW - 10 * T.depthAbsentMs);
    assert.equal(stat.depthAbsentSince, null);
    noteDepthAttempt(stat, true, false, NOW - T.depthAbsentMs + 1);
    assert.deepEqual(evaluateMarketPush(marketPushSample(stat, false), T, NOW).active, []);
  });

  it("ALERT_DEPTH_ABSENT_MS is configurable and rejects garbage", () => {
    assert.equal(thresholdsFromEnv({ ALERT_DEPTH_ABSENT_MS: "60000" }).depthAbsentMs, 60_000);
    assert.throws(() => thresholdsFromEnv({ ALERT_DEPTH_ABSENT_MS: "-1" }));
  });
});
