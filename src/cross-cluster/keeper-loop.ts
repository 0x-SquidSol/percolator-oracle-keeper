/**
 * cross-cluster/keeper-loop.ts
 *
 * Production keeper loop: reads mainnet DEX pool prices and pushes them to
 * the corresponding devnet markets via PushAuthMark.
 *
 * Each cycle:
 *   1. For every market in the registry, read the mainnet pool price.
 *      Pool prices are deduplicated: if two markets share a pool, the pool
 *      is fetched only once per cycle.
 *   2. Push (or dry-run) PushAuthMark to the devnet market.
 *   3. Errors are isolated per-market — one bad pool or push does not
 *      abort the rest of the cycle.
 *
 * Health endpoint:
 *   GET /health  →  JSON with per-market stats and service-level counters.
 *   Suitable for Railway / Render health checks.
 */
import http from "http";
import { Connection, Keypair } from "@solana/web3.js";
import type { DexType, Registry } from "./registry.ts";
import type { DecimalsCache } from "./price-reader.ts";
import { readAllPoolPricesE6 } from "./price-reader.ts";
import { createMarkSmoother } from "./mark-smoother.ts";
import type { MarkSmoother } from "./mark-smoother.ts";
import { createTickPublisher, type TickPublisher, type TickInput } from "./tick-publisher.ts";
import { checkCircuitBreaker, markGap, recordMarkInForce } from "../circuit-breaker.ts";
import type { CircuitBreakerState } from "../circuit-breaker.ts";
import { pushAuthMarkBatch, fetchOracleAuthority, getQuarantinedMarkets, pruneAuthMarkPusherState } from "./auth-mark-pusher.ts";
import { evaluateBandPinExpiry, evaluateMarketPush, evaluatePushCycle, getAlertSink } from "./alerting.ts";
import type { Alert, BandPinSample, MarketPushSample } from "./alerting.ts";
import { getCrankRefreshHealth, getLayoutProblemCounts, isPushHeld, pruneCrankRefreshHealth } from "./refresh-coordination.ts";
import { p2bHealthFields } from "./p2b-health.ts";
import { rpcFailoverHealth } from "../rpc-failover.ts";
import { restartHealth } from "../restart-escalation.ts";
import { v22HealthFields } from "./v22/health.ts";
import { layoutGuardSnapshot } from "./layout-guard-metrics.ts";
import type { LayoutGuardSnapshot } from "./layout-guard-metrics.ts";
import { rpcMetrics } from "./rpc-metrics.ts";
import { getCachedBlockhash, invalidateBlockhash } from "./blockhash-cache.ts";
import type { CrankRefreshHealth } from "./refresh-coordination.ts";
import { healthFileConfigFromEnv, startHealthFileMirror } from "./health-file.ts";
import type { SweepHealth } from "./positioned-sweep.ts";
import { pushDepthEnabled, resolvePushDepth, type PushDepth } from "./push-depth.ts";
import { DEPTH_SOURCE_ONCHAIN_DEX, DepthSourceCache, pushDepthOnchainEnabled, type DexDepthPin } from "./depth-source.ts";
import { WRAPPER_PROGRAM_ID as DEPTH_WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { getMarketAccrual, laggingAssets, multiAssetKey, priceUnitsOfRegistry, pruneMarketAccrual } from "./multi-asset.ts";
import { DEADLINE_FRESH_MS, getPushDeadline, isKnownTerminal, markTerminal, prunePushDeadlines, refreshPushDeadlines } from "./push-deadline.ts";
import type { PushDeadline } from "./push-deadline.ts";
import type { PriceUnit } from "./multi-asset.ts";
import { pushGenerationKey } from "./auth-mark-pusher.ts";

/** Round 2: pins re-read every KEEPER_DEPTH_SRC_REFRESH_MS (default 5 min). */
const depthSourceCache = new DepthSourceCache(Number(process.env.KEEPER_DEPTH_SRC_REFRESH_MS) > 0 ? Number(process.env.KEEPER_DEPTH_SRC_REFRESH_MS) : 5 * 60_000);
import {
  type WalletBalanceState,
  createWalletBalanceState,
  shouldRefreshBalance,
  applyBalanceReading,
  recordBalanceReadFailure,
  formatSol,
} from "./wallet-balance-guard.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoopConfig {
  /**
   * F2 (second independent pusher): markets for which this process is on STANDBY (the primary keeper is keeping them
   * alive). A standby market is still read and smoothed (so the mark is warm at takeover) but never pushed, and it is
   * counted as healthy for the no-push / zero-push alerts. Absent = every market is pushed (the primary keeper).
   */
  standby?: (marketAddress: string) => boolean;
  /** Milliseconds between cycle starts. */
  intervalMs: number;
  /** HTTP health server port. */
  healthPort: number;
  /** Health server bind address (e.g. "0.0.0.0"). */
  healthBind: string;
  /** If true, build instructions and log them but do not send. */
  dryRun: boolean;
  /**
   * D2a: max milliseconds to wait for a single runCycle() before giving up
   * on it and starting the next cycle anyway. Defaults to 10_000 if unset.
   * See the `Promise.race` in the main loop below for why this exists.
   */
  cycleTimeoutMs?: number;
  /**
   * #71: pause pushes below this balance. The guard existed only in the dead
   * index.ts, so the live keeper had none. Required — there is no safe default
   * for "how broke is too broke to sign".
   */
  minKeeperBalanceLamports: number;
  /** How often to re-read the keeper's balance. */
  balanceCheckIntervalMs: number;
  /**
   * P3 senior draw (d119eebd): called for every market whose push LANDED, with the
   * pushed mark. The vault-LP cranker cranks a bound market's vault LP on a real move.
   * Fire-and-forget: never awaited by the push cycle.
   */
  onPushLanded?: (marketAddress: string, priceE6: bigint, label: string) => void;
  /**
   * P3 senior backing exhausted (p3-exhausted-resolve.ts): true = do not push this market,
   * so `last_good_oracle_slot` stops advancing and the tag 39 stale window can run.
   */
  withholdPush?: (marketAddress: string) => boolean;
  /** Chart tick publisher (default: built from TICK_INGEST_URL/KEY; a no-op when unset). */
  tickPublisher?: TickPublisher;
}

interface MarketStat {
  label: string;
  marketAddress: string;
  /**
   * K-6: this stat's key in LoopState.stats. The market address for a single-asset market (every /health key and map
   * unchanged), `<market>#<asset>` for one asset of a multi-asset market (multi-asset.ts PriceUnit.key).
   */
  key: string;
  /** K-6: the asset this stat tracks when it belongs to a multi-asset market, else null. */
  multiAsset: { assetIndex: number; source: "pool" | "fixed"; symbol: string | null } | null;
  poolAddress: string;
  dexType: string;
  lastPriceE6: bigint;
  /** Unix ms of last push (live or dry-run). */
  lastPushAt: number | null;
  lastSig: string | null;
  totalPushes: number;
  totalErrors: number;
  lastErrorMsg: string | null;
  /** True if the last attempt found oracle_authority != keeper. */
  authorityMismatch: boolean;
  /**
   * K-1: consecutive cycles in which this market did NOT land a push (any
   * reason: no pool price, breaker block, dropped from the batch, withheld).
   * Reset by a landed push. A dry-run "push" counts as landed.
   */
  noPushCycles: number;
  /** K-3: smoothed source price this cycle (E6), 0 when there was none. */
  sourcePriceE6: bigint;
  /** K-3: the breaker's gap episode after this cycle's check; null when the source was published as-is. */
  markGap: { pct: number; ageMs: number; checks: number; dir: 1 | -1 } | null;
  /** K-3 (WIF/KMNO): raw pool price unchanged since this unix ms; null until a price was read. */
  sourceUnchangedSince: number | null;
  /** The last raw pool price read (E6), for sourceUnchangedSince. */
  lastRawPriceE6: bigint;
  /** G8: the depth_e6 carried by the last landed push (null = that push was the 35 B form, or none yet). */
  lastDepthE6: bigint | null;
  /** G8: where that depth came from (null when lastDepthE6 is null). */
  lastDepthSource: string | null;
}

/**
 * A fresh /health stat record for one registry entry, or (K-6) for one price unit of a multi-asset market (pass the
 * unit: its `key` and `multi` select the per-asset record). A plain registry entry gives the pre-K-6 record.
 */
export function newMarketStat(m: {
  label: string;
  marketAddress: string;
  poolAddress?: string;
  dexType?: string;
  key?: string;
  multi?: boolean;
  assetIndex?: number;
  source?: "pool" | "fixed";
  symbol?: string;
}): MarketStat {
  return {
    label: m.label,
    marketAddress: m.marketAddress,
    key: m.key ?? m.marketAddress,
    multiAsset: m.multi ? { assetIndex: m.assetIndex ?? 0, source: m.source ?? "pool", symbol: m.symbol ?? null } : null,
    poolAddress: m.poolAddress ?? "",
    dexType: m.dexType ?? "",
    lastPriceE6: 0n,
    lastPushAt: null,
    lastSig: null,
    totalPushes: 0,
    totalErrors: 0,
    lastErrorMsg: null,
    authorityMismatch: false,
    noPushCycles: 0,
    sourcePriceE6: 0n,
    markGap: null,
    sourceUnchangedSince: null,
    lastRawPriceE6: 0n,
    lastDepthE6: null,
    lastDepthSource: null,
  };
}

/**
 * K-3: track how long the RAW pool price has been bit-identical. A DLMM pool
 * whose active bin never moves (or a dead pool) reads the same price every
 * cycle; the keeper then republishes it as a fresh mark while the token moves
 * elsewhere (WIF/KMNO marks did not change for 74.8k/19.5k slots on 10-03).
 */
export function recordRawPrice(
  stat: Pick<MarketStat, "sourceUnchangedSince" | "lastRawPriceE6">,
  rawPriceE6: bigint,
  nowMs: number,
): void {
  if (stat.sourceUnchangedSince === null || rawPriceE6 !== stat.lastRawPriceE6) {
    stat.sourceUnchangedSince = nowMs;
    stat.lastRawPriceE6 = rawPriceE6;
  }
}

/**
 * The /health `lastError` for a market whose pool produced no price this cycle:
 * the reader's specific refusal reason when it gave one (e.g. a non-USD quote,
 * which never self-heals), else the generic message.
 */
export function noPoolPriceReason(skipReasons: ReadonlyMap<string, string>, poolAddress: string): string {
  const why = skipReasons.get(poolAddress);
  return why ? `no pool price this cycle: ${why}` : "no pool price this cycle";
}

/**
 * Record a push that LANDED for one market, and clear its last error.
 *
 * `lastErrorMsg` used to be sticky: a transient cold-start condition (the mark
 * smoother withholding its first few cycles until minSamples) stayed on
 * /health as `lastError` for the life of the process, even while the market
 * pushed every cycle. On 2026-10-01 that stale "mark smoother re-priming"
 * label on two healthy, current markets read as the cause of a trading outage.
 * A landed push supersedes every earlier error; a later failure sets it again.
 *
 * @param stat - The market's /health stat record (mutated).
 * @param stamp - Unix ms the push was confirmed landed.
 * @param signature - The batch transaction signature that carried it.
 * @returns Nothing; mutates `stat`.
 * @example
 * recordLandedPush(stat, Date.now(), res.signature); // stat.lastErrorMsg === null
 */
export function recordLandedPush(
  stat: Pick<MarketStat, "totalPushes" | "lastPushAt" | "lastSig" | "lastErrorMsg"> &
    Partial<Pick<MarketStat, "noPushCycles">>,
  stamp: number,
  signature: string,
): void {
  stat.totalPushes++;
  stat.lastPushAt = stamp;
  stat.lastSig = signature;
  stat.lastErrorMsg = null;
  stat.noPushCycles = 0;
}

interface LoopState {
  startedAt: number;
  lastCycleAt: number | null;
  cycleCount: number;
  /** D2a: cycles that hit the cycleTimeoutMs watchdog (runCycle never resolved in time). */
  timeoutCount: number;
  stats: Map<string, MarketStat>;
  /**
   * Pricing-outage visibility (2026-07-31 audit). A total mainnet-read
   * failure used to be the LEAST visible failure in the service: the cycle
   * logged and returned, per-market stats untouched, /health green, while
   * every market stayed tradeable against a frozen AuthMark. These fields
   * make that state impossible to miss.
   */
  lastSuccessfulPushAt: number | null;
  consecutiveBatchReadFailures: number;
  lastBatchReadError: string | null;
  /** #71 wallet-balance guard state. */
  wallet: WalletBalanceState;
  /** Ops track: markets in this cycle's push batch, and how many landed. Reset every cycle. */
  cycleAttempted: number;
  cyclePushed: number;
  /** Consecutive cycles with zero landed pushes (markets registered). */
  zeroPushStreak: number;
  /** B20: markets last seen Resolved/closed — excluded from the zero-push health count. */
  terminalMarkets: Set<string>;
  /** K-1: markets whose push landed (or dry-ran) this cycle. Reset every cycle. */
  landedThisCycle: Set<string>;
  /** F2: markets held on standby this cycle (not pushed on purpose). Reset every cycle. */
  standbyThisCycle?: Set<string>;
  /** Chart tick publisher; no-op unless TICK_INGEST_URL + TICK_INGEST_KEY are set. */
  tickPublisher: TickPublisher;
}

/**
 * B20: markets the push loop can actually push — registered minus those last
 * seen Resolved/closed. A board of only terminal markets is not a pricing outage.
 */
/**
 * The pushes of a batch that actually went out (in the batch's pushed set, with a
 * signature, not terminal) — what the P3 vault-LP crank hook runs on. A market dropped
 * from the batch (preflight revert / quarantine) or terminal did NOT move its mark.
 */
export function landedPushes<T extends { marketAddress: string; priceE6: bigint; assetIndex?: number; multi?: boolean }>(
  pushes: ReadonlyArray<T>,
  res: { pushedMarkets: ReadonlyArray<string>; pushedKeys?: ReadonlyArray<string>; terminalMarkets?: ReadonlyArray<string>; signature?: string | null },
): T[] {
  if (!res.signature) return [];
  const pushed = new Set(res.pushedMarkets);
  const pushedKeys = new Set(res.pushedKeys ?? []);
  const terminal = new Set(res.terminalMarkets ?? []);
  // K-6: an asset of a multi-asset market landed only if ITS push went out (the market has several).
  const went = (p: T): boolean =>
    p.multi ? pushedKeys.has(pushGenerationKey({ marketAddress: p.marketAddress, assetIndex: p.assetIndex ?? 0 })) : pushed.has(p.marketAddress);
  return pushes.filter((p) => went(p) && !terminal.has(p.marketAddress));
}

/**
 * Publish this cycle's LANDED pushes (mark + raw pool price) to the tick publisher.
 * Only markets in `landedPushes(...)` are published; never throws.
 */
export function publishLandedTicks(
  publisher: TickPublisher,
  pushes: ReadonlyArray<{ marketAddress: string; assetIndex: number; priceE6: bigint; multi?: boolean }>,
  res: { pushedMarkets: ReadonlyArray<string>; pushedKeys?: ReadonlyArray<string>; terminalMarkets?: ReadonlyArray<string>; signature?: string | null },
  /** Raw source price of the push's market (K-6: and asset; a single-asset caller may ignore the second argument). */
  rawByMarket: (marketAddress: string, assetIndex: number) => bigint | null,
  slot: bigint,
  landedMs: number,
): void {
  try {
    const landed = landedPushes(pushes, res);
    if (landed.length === 0) return;
    const inputs: TickInput[] = landed.map((p) => ({
      marketAddress: p.marketAddress,
      assetIndex: p.assetIndex,
      markE6: p.priceE6,
      oracleE6: rawByMarket(p.marketAddress, p.assetIndex),
    }));
    publisher.publish(inputs, slot, landedMs);
  } catch {
    // never let chart telemetry disturb the push loop
  }
}

/** P3 exhausted-backing gate: skip the push when the hook says to withhold it. */
/**
 * Per-market crank refresh health for /health. `status` is non-ok once a market
 * has ended loss-stale (stale count > 0 after the keeper's refreshes) for
 * ALERT_LOSS_STALE_CYCLES cycles: every risk-increasing trade reverts Custom(21).
 */
export function crankHealthFields(h: CrankRefreshHealth | undefined): Record<string, string | number | boolean | null | NonNullable<CrankRefreshHealth["adlAssets"]>> {
  if (!h) return { crankStatus: null };
  return {
    ...(h.layout
      ? {
          marketLayout: h.layout.id,
          marketLayoutUnknown: h.layout.kind === "unknown",
          marketLayoutProblem: h.layout.problem,
          marketLayoutProvisional: h.layout.provisional,
        }
      : {}),
    ...(h.sweep ? sweepHealthFields(h.sweep) : {}),
    // K-9: ADL (reduce-only) state, only when the cranker decoded it (v2.1 and v2.2 layouts).
    ...(h.adl
      ? { adlReduceOnly: h.adl.reduceOnly, adlALong: h.adl.aLong, adlAShort: h.adl.aShort, adlOiLong: h.adl.oiEffLong, adlOiShort: h.adl.oiEffShort }
      : {}),
    // Multi-asset markets: every non-Disabled asset (QA retest 4: asset 0 alone hid the other assets).
    ...(h.adlAssets ? { adlAssets: h.adlAssets, adlReduceOnlyAssets: h.adlAssets.filter((x) => x.reduceOnly).map((x) => x.asset).join(",") } : {}),
    crankStatus: h.status,
    // Sweep markets carry stale portfolios by design (every accrual re-stales them); there
    // `lossStale` means what users feel: a risk-increasing order would be refused now.
    lossStale: h.sweep
      ? Number(h.sweep.blocksRiskIncrease)
      : h.postStaleLong !== null ? Number(h.postStaleLong + (h.postStaleShort ?? 0) > 0) : Number(h.staleLong + h.staleShort > 0),
    lossStaleCycles: h.lossStaleCycles,
    staleLong: h.staleLong,
    staleShort: h.staleShort,
    postStaleLong: h.postStaleLong,
    postStaleShort: h.postStaleShort,
    positioned: h.positioned,
    overflow: h.overflow,
    overflowRefreshed: h.overflowRefreshed,
    overflowError: h.overflowError,
    crankHealthAgo: `${Math.floor((Date.now() - h.updatedAt) / 1000)}s`,
  };
}

/**
 * Sweep (drift-layout market) fields for /health: `sweepCoverageRatio` is
 * max(bound/available) over both sides (null = infinite: a bound faces zero
 * insurance), `sweepCovered` the engine's coverage verdict, and
 * `sweepBlocksRiskIncrease` whether an open would be refused right now.
 */
export function sweepHealthFields(s: SweepHealth): Record<string, string | number | boolean | null> {
  return {
    sweepPace: s.pace,
    sweepCoverageRatio: s.coverageRatio,
    sweepCovered: s.covered,
    sweepBlocksRiskIncrease: s.blocksRiskIncrease,
    sweepRelaxedEligible: s.relaxedEligible,
    sweepTrackerMalformed: s.trackerMalformed,
    sweepIneligibleReason: s.ineligibleReason,
    sweepBoundLong: s.boundLong,
    sweepBoundShort: s.boundShort,
    sweepAvailableLongDomain: s.availableLongDomain,
    sweepAvailableShortDomain: s.availableShortDomain,
    sweepStaleLong: s.staleLong,
    sweepStaleShort: s.staleShort,
    sweepLaggardLong: s.laggardLong,
    sweepLaggardShort: s.laggardShort,
    sweepK: s.k,
    sweepTxsPlanned: s.txsPlanned,
    sweepTxsSent: s.txsSent,
    sweepRefreshed: s.refreshed,
    sweepPruned: s.pruned,
    sweepPositioned: s.positioned,
    sweepUnvisited: s.neverVisited,
  };
}

/**
 * Top-level /health fields for market-layout problems. Present ONLY once a problem has been seen
 * (so a keeper on fully recognised layouts serves the exact same top-level keys as before):
 * `layoutProblemMarkets` = markets currently unreadable, `sweepLayoutUnknown` /
 * `sweepLayoutUnsupported` = process-lifetime counts of cranker reads that hit each problem.
 */
export function layoutProblemFields(layoutProblemMarkets: string[]): Record<string, string[] | number | LayoutGuardSnapshot> {
  const c = getLayoutProblemCounts();
  const guard = layoutGuardSnapshot();
  if (layoutProblemMarkets.length === 0 && c.unknown === 0 && c.unsupported === 0 && guard.refusals === 0) return {};
  return {
    layoutProblemMarkets,
    sweepLayoutUnknown: c.unknown,
    sweepLayoutUnsupported: c.unsupported,
    // v2.2: the VERSION-keyed guard's refusal counters (by reason / on-chain VERSION); present only once one fired.
    ...(guard.refusals > 0 ? { layoutGuard: guard } : {}),
  };
}

/** F2: extra top-level /health fields (the pusher role). Unset = nothing is added, so the primary's payload is unchanged. */
let healthExtension: (() => Record<string, unknown>) | null = null;
export function setHealthExtension(fn: (() => Record<string, unknown>) | null): void {
  healthExtension = fn;
}
function healthExtensionFields(): Record<string, unknown> {
  try {
    return healthExtension ? healthExtension() : {};
  } catch {
    return {};
  }
}

export function withheldFromPush(market: string, withholdPush: ((m: string) => boolean) | undefined): boolean {
  if (!withholdPush) return false;
  try {
    return withholdPush(market);
  } catch {
    return false; // a failing gate never stops pushes
  }
}

/**
 * K-6: record one MULTI-ASSET push's outcome on its own stat (`p.key`) and breaker. Mirrors the single-asset branch of
 * runCycle, judged by the asset's own push (`pushedKeys`, generation key) instead of its market's.
 */
export function recordMultiAssetPushOutcome(
  state: Pick<LoopState, "stats" | "landedThisCycle">,
  p: { key: string; marketAddress: string; assetIndex: number; depth?: PushDepth | null },
  res: { pushedKeys?: ReadonlyArray<string>; inactiveKeys?: ReadonlyArray<string>; signature?: string | null },
  o: { dryRun: boolean; stamp: number; pending?: CircuitBreakerState },
): "landed" | "inactive" | "dropped" {
  const stat = state.stats.get(p.key);
  if (!stat) return "dropped";
  stat.authorityMismatch = false;
  const genKey = pushGenerationKey(p);
  if ((res.inactiveKeys ?? []).includes(genKey)) {
    // The asset is not Active/DrainOnly (the program would refuse the push with 21): not landed, not an error.
    stat.lastErrorMsg = "asset not Active/DrainOnly — not pushed";
    return "inactive";
  }
  if (o.dryRun) {
    stat.lastSig = "DRY_RUN";
    stat.lastDepthE6 = p.depth?.depthE6 ?? null;
    stat.lastDepthSource = p.depth?.source ?? null;
    stat.noPushCycles = 0;
    state.landedThisCycle.add(p.key);
    return "landed";
  }
  if ((res.pushedKeys ?? []).includes(genKey) && res.signature) {
    if (o.pending) {
      crossClusterCircuitBreakerStates.set(p.key, commitPublishedBreakerState(crossClusterCircuitBreakerStates.get(p.key), o.pending, o.stamp));
    }
    recordLandedPush(stat, o.stamp, res.signature);
    stat.lastDepthE6 = p.depth?.depthE6 ?? null;
    stat.lastDepthSource = p.depth?.source ?? null;
    state.landedThisCycle.add(p.key);
    return "landed";
  }
  stat.totalErrors++;
  stat.lastErrorMsg = "dropped from batch (reverted in preflight or quarantined)";
  return "dropped";
}

/** K-6: the mark a fixed-source unit pushes (e6), or null when the unit is not a valid fixed source. */
export function fixedPushFor(unit: Pick<PriceUnit, "source" | "fixedPriceE6">): bigint | null {
  return unit.source === "fixed" && unit.fixedPriceE6 !== undefined && unit.fixedPriceE6 > 0n ? unit.fixedPriceE6 : null;
}

export function countPushableMarkets(markets: ReadonlyArray<{ marketAddress: string }>, terminal: ReadonlySet<string>): number {
  return markets.filter((m) => !terminal.has(m.marketAddress)).length;
}

/** Emit the structured push `[health]` line every N cycles. */
export const PUSH_HEALTH_LINE_EVERY_CYCLES = 10;

/**
 * Health status for the pricing pipeline, separated from the handler so it
 * is testable as a pure function. "stalled-pricing" means: markets are
 * registered, and either the batch read has failed many times running or no
 * push has landed for PUSH_STALL_MS — the frozen-mark condition.
 */
export const PUSH_STALL_MS = 120_000;
export const BATCH_FAILURE_ALERT_THRESHOLD = 5;
export function pricingHealthStatus(
  state: Pick<
    LoopState,
    "lastSuccessfulPushAt" | "consecutiveBatchReadFailures" | "startedAt"
  >,
  marketCount: number,
  nowMs: number,
): "ok" | "stalled-pricing" {
  if (marketCount === 0) return "ok"; // empty board: nothing CAN push
  if (state.consecutiveBatchReadFailures >= BATCH_FAILURE_ALERT_THRESHOLD) {
    return "stalled-pricing";
  }
  // Never pushed since boot counts from process start — a keeper that comes
  // up broken must not read "ok" forever just because the field is null.
  const last = state.lastSuccessfulPushAt ?? state.startedAt;
  return nowMs - last > PUSH_STALL_MS ? "stalled-pricing" : "ok";
}

// ── Health server ─────────────────────────────────────────────────────────────

/**
 * Labels of markets whose last crank-refresh health is "loss-stale", excluding terminal (Resolved / closed)
 * markets: the cranker stops at a terminal market and never refreshes its cached health, so without this a
 * market resolved while loss-stale stays listed (and /health stays degraded) forever (2026-10-15: swordcat,
 * swordcat-c4 resolved by BandPinExpired during a keeper outage).
 */
export function lossStaleMarketLabels(
  stats: ReadonlyMap<string, { label: string }>,
  terminal: ReadonlySet<string> | undefined,
  healthOf: (addr: string) => { status: string } | undefined,
): string[] {
  return [...stats.entries()]
    .filter(([addr]) => !(terminal?.has(addr) ?? false) && healthOf(addr)?.status === "loss-stale")
    .map(([addr, stat]) => stat.label || addr);
}

/**
 * K-6: the /health row of a MULTI-ASSET market, from its per-asset stats. Every asset is evaluated like a market of its
 * own (no-push, mark-lagging) and checked for accrual lag (the cranker's latest read, multi-asset.ts); the market's
 * `status` is "ok" only when every asset is, so ONE stale asset makes the market (and the keeper) degraded.
 * Returns the row plus the labels to add to the top-level lists. Pure apart from the accrual sample lookup.
 */
export function multiAssetMarketHealth(
  marketAddress: string,
  label: string,
  assetStats: ReadonlyArray<MarketStat>,
  ctx: { terminal: boolean; thresholds: ReturnType<typeof getAlertSink>["thresholds"]; nowMs: number; accrualLagWarnSlots: number },
): { row: Record<string, unknown>; noPush: string[]; markLagging: string[]; accrualLagging: string[] } {
  const accrual = getMarketAccrual(marketAddress);
  const lagging = new Set(ctx.terminal ? [] : laggingAssets(accrual, ctx.accrualLagWarnSlots));
  const noPush: string[] = [];
  const markLagging: string[] = [];
  const accrualLagging: string[] = [];
  const sorted = [...assetStats].sort((a, b) => (a.multiAsset?.assetIndex ?? 0) - (b.multiAsset?.assetIndex ?? 0));
  const assets = sorted.map((stat) => {
    const assetIndex = stat.multiAsset?.assetIndex ?? 0;
    const verdict = evaluateMarketPush(marketPushSample(stat, ctx.terminal), ctx.thresholds, ctx.nowMs);
    const lag = accrual?.assets.find((a) => a.assetIndex === assetIndex) ?? null;
    let status: string = verdict.status;
    if (verdict.status === "no-push") noPush.push(stat.label);
    if (verdict.active.some((a) => a.kind === "mark-lagging")) markLagging.push(stat.label);
    if (lagging.has(assetIndex)) {
      accrualLagging.push(stat.label);
      if (status === "ok") status = "accrual-lagging";
    }
    return {
      assetIndex,
      symbol: stat.multiAsset?.symbol ?? null,
      source: stat.multiAsset?.source ?? "pool",
      status,
      noPushCycles: stat.noPushCycles,
      lastPriceE6: stat.lastPriceE6.toString(),
      lastPriceUsd: stat.lastPriceE6 > 0n ? (Number(stat.lastPriceE6) / 1e6).toFixed(4) : null,
      sourcePriceUsd: stat.sourcePriceE6 > 0n ? (Number(stat.sourcePriceE6) / 1e6).toString() : null,
      // R3.24: the last RAW pool reading, so a unit the smoother is still withholding shows its pool is being read.
      rawSourcePriceUsd: stat.lastRawPriceE6 > 0n ? (Number(stat.lastRawPriceE6) / 1e6).toString() : null,
      markGapPct: stat.markGap ? Number(stat.markGap.pct.toFixed(2)) : null,
      lastPushAgo: stat.lastPushAt !== null ? `${Math.floor((ctx.nowMs - stat.lastPushAt) / 1000)}s` : null,
      totalPushes: stat.totalPushes,
      totalErrors: stat.totalErrors,
      authorityMismatch: stat.authorityMismatch,
      lastError: stat.lastErrorMsg,
      accrualLagSlots: lag ? lag.lagSlots : null,
      assetLossStale: lag ? lag.lossStale : null,
    };
  });
  const stale = assets.filter((a) => a.status !== "ok");
  const lastPushes = sorted.map((s) => s.lastPushAt).filter((t): t is number => t !== null);
  const oldestPush = lastPushes.length === sorted.length && lastPushes.length > 0 ? Math.min(...lastPushes) : null;
  return {
    row: {
      status: stale.length === 0 ? "ok" : (stale.find((a) => a.status === "no-push")?.status ?? stale[0].status),
      label,
      multiAsset: true,
      assetCount: assets.length,
      staleAssets: stale.map((a) => a.assetIndex),
      // The OLDEST asset push (null until every asset has pushed once): what a single "last push" must mean here.
      lastPushAgo: oldestPush !== null ? `${Math.floor((ctx.nowMs - oldestPush) / 1000)}s` : null,
      noPushCycles: Math.max(0, ...sorted.map((s) => s.noPushCycles)),
      totalPushes: sorted.reduce((n, s) => n + s.totalPushes, 0),
      totalErrors: sorted.reduce((n, s) => n + s.totalErrors, 0),
      accrualReadAgo: accrual ? `${Math.floor((ctx.nowMs - accrual.atMs) / 1000)}s` : null,
      assets,
    },
    noPush,
    markLagging,
    accrualLagging,
  };
}

export function makeHealthHandler(state: LoopState, config: LoopConfig, registry: Registry) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404);
      res.end();
      return;
    }
    const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
    const markets: Record<string, object> = {};
    const nowMs = Date.now();
    const thresholds = getAlertSink().thresholds;
    const noPushMarkets: string[] = [];
    const markLaggingMarkets: string[] = [];
    // K-6: assets of multi-asset markets are grouped under their market (one /health row per market, `assets` inside).
    const multiByMarket = new Map<string, MarketStat[]>();
    /** One {label} per MARKET (single-asset: its stat; multi-asset: the registry label) for the market-level lists. */
    const marketLabels = new Map<string, { label: string }>();
    for (const [addr, stat] of state.stats) {
      if (stat.multiAsset) {
        const list = multiByMarket.get(stat.marketAddress) ?? [];
        list.push(stat);
        multiByMarket.set(stat.marketAddress, list);
        continue;
      }
      marketLabels.set(addr, stat);
      const verdict = evaluateMarketPush(marketPushSample(stat, !pushExpected(state, registry, addr)), thresholds, nowMs);
      if (verdict.status === "no-push") noPushMarkets.push(stat.label || addr);
      if (verdict.active.some((a) => a.kind === "mark-lagging")) markLaggingMarkets.push(stat.label || addr);
      // R3.24 (b): a terminal market reads "resolved" (or closed / recovery), never ok-with-a-stale-error.
      const terminalStatus = terminalHealthStatus(state, addr);
      markets[addr] = {
        status: terminalStatus ?? verdict.status,
        ...(terminalStatus ? { terminal: true } : {}),
        noPushCycles: stat.noPushCycles,
        sourcePriceUsd: stat.sourcePriceE6 > 0n ? (Number(stat.sourcePriceE6) / 1e6).toString() : null,
        rawSourcePriceUsd: stat.lastRawPriceE6 > 0n ? (Number(stat.lastRawPriceE6) / 1e6).toString() : null,
        markGapPct: stat.markGap ? Number(stat.markGap.pct.toFixed(2)) : null,
        markGapAgo: stat.markGap ? `${Math.floor(stat.markGap.ageMs / 1000)}s` : null,
        sourceUnchangedFor:
          stat.sourceUnchangedSince !== null ? `${Math.floor((nowMs - stat.sourceUnchangedSince) / 1000)}s` : null,
        label: stat.label,
        lastPriceUsd:
          stat.lastPriceE6 > 0n
            ? (Number(stat.lastPriceE6) / 1e6).toFixed(4)
            : null,
        lastPriceE6: stat.lastPriceE6.toString(),
        lastPushAgo:
          stat.lastPushAt !== null
            ? `${Math.floor((Date.now() - stat.lastPushAt) / 1000)}s`
            : null,
        totalPushes: stat.totalPushes,
        totalErrors: stat.totalErrors,
        authorityMismatch: stat.authorityMismatch,
        lastError: terminalStatus ? null : stat.lastErrorMsg,
        depthE6: stat.lastDepthE6 === null ? null : stat.lastDepthE6.toString(),
        depthSource: stat.lastDepthSource,
        ...crankHealthFields(getCrankRefreshHealth(addr)),
      };
    }
    const accrualLaggingAssets: string[] = [];
    for (const [addr, assetStats] of multiByMarket) {
      const label = registry.markets.find((m) => m.marketAddress === addr)?.label ?? addr;
      marketLabels.set(addr, { label });
      const h = multiAssetMarketHealth(addr, label, assetStats, {
        terminal: !pushExpected(state, registry, addr),
        thresholds,
        nowMs,
        accrualLagWarnSlots: thresholds.slotLagWarn,
      });
      noPushMarkets.push(...h.noPush);
      markLaggingMarkets.push(...h.markLagging);
      accrualLaggingAssets.push(...h.accrualLagging);
      const terminalStatus = terminalHealthStatus(state, addr);
      markets[addr] = { ...h.row, ...(terminalStatus ? { status: terminalStatus, terminal: true } : {}), ...crankHealthFields(getCrankRefreshHealth(addr)) };
    }
    const lossStaleMarkets = lossStaleMarketLabels(marketLabels, state.terminalMarkets, getCrankRefreshHealth);
    // Markets whose account the keeper cannot read (unknown stride / unsupported portfolio layout):
    // their portfolios are not being refreshed. Reported, never silently treated as a legacy market.
    const layoutProblemMarkets = [...marketLabels.entries()]
      .filter(([addr]) => getCrankRefreshHealth(addr)?.status.startsWith("layout-"))
      .map(([addr, stat]) => stat.label || addr);
    // A quarantined market reverted its push 3 cycles running, so the pusher
    // stopped batching it to keep it from freezing everyone else's price.
    //
    // Reported in the BODY, deliberately still HTTP 200: railway.toml
    // health-gates deploys on this path and the Dockerfile HEALTHCHECK runs
    // `curl -sf`, which fails on 5xx. A 503 here would restart the keeper — and
    // since quarantine is in-memory, the restart clears it, the bad market gets
    // re-batched, takes 3 strikes, and 503s again: a restart loop that breaks
    // pricing for every market to report a problem with one. The service is
    // genuinely healthy in this state (it is doing exactly what it should);
    // it is the MARKET that is degraded, so alert on the field, not the code.
    const quarantinedMarkets = getQuarantinedMarkets();
    // stalled-pricing outranks degraded-markets: a frozen mark on EVERY
    // market (free-option risk against the LPs for the whole outage) is the
    // condition the 2026-07-31 audit found completely invisible here.
    const pricingStatus = pricingHealthStatus(state, registry.markets.length, Date.now());
    // RPC fallback: running on a fallback endpoint, or every endpoint down, is `rpc-degraded` (still HTTP 200 for
    // the same restart-loop reason as above). A stalled-pricing verdict outranks it; fields name the active endpoint.
    // Restart escalation: N launches in M minutes is `restart-loop` (loud counter under `restarts`).
    const rpcFailover = rpcFailoverHealth();
    const restarts = restartHealth();
    const payload = JSON.stringify({
      walletLow: state.wallet.low,
      walletBalanceSol: formatSol(state.wallet.balanceLamports),
      status:
        pricingStatus !== "ok"
          ? pricingStatus
          : rpcFailover.degraded
            ? "rpc-degraded"
            : restarts?.escalated
              ? "restart-loop"
              : quarantinedMarkets.length > 0 ||
              lossStaleMarkets.length > 0 ||
              layoutProblemMarkets.length > 0 ||
              noPushMarkets.length > 0 ||
              markLaggingMarkets.length > 0 ||
              accrualLaggingAssets.length > 0
            ? "degraded-markets"
            : "ok",
      lastSuccessfulPushAgo:
        state.lastSuccessfulPushAt !== null
          ? `${Math.floor((Date.now() - state.lastSuccessfulPushAt) / 1000)}s`
          : null,
      consecutiveBatchReadFailures: state.consecutiveBatchReadFailures,
      lastBatchReadError: state.lastBatchReadError,
      quarantinedMarkets,
      lossStaleMarkets,
      noPushMarkets,
      markLaggingMarkets,
      // K-6: present only when a multi-asset market is registered (single-asset deployments keep today's key set).
      ...(multiByMarket.size > 0 ? { accrualLaggingAssets } : {}),
      ...layoutProblemFields(layoutProblemMarkets),
      uptimeSec,
      cycleCount: state.cycleCount,
      timeoutCount: state.timeoutCount,
      tickPublisher: state.tickPublisher.counters(),
      rpc: rpcMetrics.snapshot(),
      ...rpcFailover.fields,
      ...(restarts ? { restarts } : {}),
      lastCycleAgo:
        state.lastCycleAt !== null
          ? `${Math.floor((Date.now() - state.lastCycleAt) / 1000)}s`
          : null,
      dryRun: config.dryRun,
      // G8: present only when KEEPER_PUSH_DEPTH is on, so the flag-off payload keeps today's exact key set.
      ...(pushDepthEnabled() ? { pushDepth: true } : {}),
      intervalMs: config.intervalMs,
      markets,
      // v2.1 (P2b), additive: `earnVaults` + `p2b`. `{}` (nothing added) unless the wrapper supports P2b.
      ...p2bHealthFields(),
      // v2.2 layer, additive: `v22`. `{}` unless KEEPER_V22=on.
      ...v22HealthFields(),
      ...healthExtensionFields(),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  };
}

// ── Single cycle ──────────────────────────────────────────────────────────────

// One-time oracle-authority check cache (keeper == oracle_authority?). A
// batched tx is atomic, so we only ever include known-pushable markets.
const authorityChecked = new Set<string>();
const notPushable = new Set<string>();
/**
 * Audit fix (2026-07-31): these latches used to hold until process restart —
 * a market whose oracle_authority was later FIXED on-chain stayed unpushable
 * forever. Re-verify everything every 30 minutes; a wrongly-latched market
 * self-heals within that horizon, and the cost is one authority read per
 * market per half hour.
 */
const AUTHORITY_RECHECK_MS = 30 * 60_000;
let lastAuthorityRecheckAt = Date.now();
function maybeResetAuthorityLatches(): void {
  if (Date.now() - lastAuthorityRecheckAt < AUTHORITY_RECHECK_MS) return;
  lastAuthorityRecheckAt = Date.now();
  if (authorityChecked.size > 0 || notPushable.size > 0) {
    console.log(
      `[loop] periodic authority re-check: clearing ${authorityChecked.size} checked / ` +
        `${notPushable.size} not-pushable latches`,
    );
  }
  authorityChecked.clear();
  notPushable.clear();
}

/**
 * Robust AuthMark: per-pool median over a trailing window, so bot round-trips
 * on a hot pool (two-level ±1–2% churn — what drained the CATE LP) never
 * reach the engine as oscillation. See mark-smoother.ts for the full story.
 */
// The default 180s median window makes the AuthMark lag spot by ~90s — fine for
// anti-churn resistance, but far too slow for a responsive perp: the mark trails
// the ticking display price, so slippage-bounded orders get rejected. On the
// devnet playground (test funds) responsiveness beats the CATE anti-manipulation
// margin, so run a short window (still a median over several samples, so a single
// bad pool read never reaches the engine). Env-tunable: CC_MARK_WINDOW_MS.
// NOTE (mainnet): a real-money deployment should keep a longer window OR move to a
// pull oracle (Pyth) that prices the trade in-tx — do NOT ship this short window
// to mainnet without that.
const MARK_WINDOW_MS = Number(process.env.CC_MARK_WINDOW_MS ?? 15_000);
const markSmoother = createMarkSmoother({ windowMs: MARK_WINDOW_MS });
/**
 * The same median over the same samples, at e12, for the per-LOT mark of v2.2 lot markets (per-lot precision, QA
 * 2026-10-12). Every decision (withholding, circuit breaker, health) still uses the e6 smoother above; this one only
 * supplies extra digits for a price the e6 path already accepted (auth-mark-pusher.ts perLotMarkFromE12 guards that).
 */
const markSmootherE12 = createMarkSmoother({ windowMs: MARK_WINDOW_MS });
/** /health lastError of a unit skipped because the cranker holds its market's pushes. */
export const PUSH_HELD_MSG = "push held: cranker follow-up refreshes in flight for this market (auto-expires)";

/**
 * /health lastError while the smoother withholds: what the window holds vs what it needs, so a pool that can never
 * prime (sampled too sparsely for the window) is visible as such instead of a generic "re-priming" forever. Keeps the
 * historical prefix so existing log greps still match.
 */
export function primingMessage(st: { samples: number; spanMs: number; minSamples: number; minSpanMs: number }): string {
  return (
    `mark smoother re-priming — withholding push until minSamples (window holds ${st.samples} sample(s) over ` +
    `${(st.spanMs / 1000).toFixed(1)} s; needs ${st.minSamples} over ${(st.minSpanMs / 1000).toFixed(1)} s)`
  );
}

/** Pools whose last smooth() published (window primed). A pool not in here is priming / re-priming. */
const primedPools = new Set<string>();

/**
 * R3.24: is this market terminal for the push loop? Either the pusher already reported it non-Live (state set), or a
 * market read (cranker / deadline read) decoded it Resolved / closed / Recovery. The state set is kept in step.
 */
export function isTerminalForPush(state: Pick<LoopState, "terminalMarkets">, marketAddress: string): boolean {
  if (state.terminalMarkets.has(marketAddress)) return true;
  if (!isKnownTerminal(marketAddress)) return false;
  state.terminalMarkets.add(marketAddress);
  return true;
}

/**
 * R3.24: markets that need a deadline read BEFORE this cycle's smoothing: pool-priced, not terminal, whose pool window
 * is not primed (so the smoother may withhold), and with no deadline entry fresher than DEADLINE_FRESH_MS. After
 * priming this is empty, so steady state costs no extra RPC.
 */
export function deadlineReadsNeeded(
  units: ReadonlyArray<Pick<PriceUnit, "marketAddress" | "poolAddress" | "source">>,
  terminal: ReadonlySet<string>,
  primed: ReadonlySet<string>,
  nowMs: number,
): string[] {
  const out = new Set<string>();
  for (const u of units) {
    if (u.source !== "pool" || primed.has(u.poolAddress)) continue;
    if (terminal.has(u.marketAddress) || isKnownTerminal(u.marketAddress)) continue;
    if (getPushDeadline(u.marketAddress, nowMs, DEADLINE_FRESH_MS) !== undefined) continue;
    out.add(u.marketAddress);
  }
  return [...out];
}

/**
 * R3.24 (a): the price to publish for a market whose smoother window is still priming, or null to keep withholding.
 * Bypass only when the market is Live and one of its fail-closed deadlines is close (push-deadline.ts), and only with
 * a price the window already holds. Unknown deadline = keep the priming gate (the anti-manipulation default).
 */
export function deadlineBypass(deadline: PushDeadline | undefined, windowMedianE6: bigint | null): { priceE6: bigint; reason: string } | null {
  if (!deadline || deadline.terminal !== null || !deadline.urgent || windowMedianE6 === null || windowMedianE6 <= 0n) return null;
  return { priceE6: windowMedianE6, reason: deadline.urgentReason ?? "a fail-closed deadline is close" };
}

/**
 * R3.24: feed every live pool's reading of this cycle into the smoothers ONCE, before any per-unit skip (push hold,
 * P3 withhold, authority latch). Fills `smoothed` / `smoothedE12` (pool -> published mark or null) and keeps `primed`
 * in step. Terminal markets' pools are not sampled for them (another live market on the same pool still samples it).
 */
export function samplePoolsForCycle(
  units: ReadonlyArray<Pick<PriceUnit, "marketAddress" | "poolAddress" | "source">>,
  isTerminal: (marketAddress: string) => boolean,
  prices: ReadonlyMap<string, bigint>,
  pricesE12: ReadonlyMap<string, bigint>,
  smoothers: { e6: Pick<MarkSmoother, "smooth">; e12: Pick<MarkSmoother, "smooth"> },
  nowMs: number,
  smoothed: Map<string, bigint | null>,
  smoothedE12: Map<string, bigint | null>,
  primed: Set<string>,
): void {
  for (const u of units) {
    if (u.source !== "pool" || smoothed.has(u.poolAddress)) continue;
    if (isTerminal(u.marketAddress)) continue;
    const raw = prices.get(u.poolAddress);
    if (raw === undefined || raw <= 0n) continue;
    const px = smoothers.e6.smooth(u.poolAddress, raw, nowMs);
    smoothed.set(u.poolAddress, px);
    // Same sample, same instant, at e12 (the e6 value x 1e6 when the read produced no e12), so the two windows stay aligned.
    smoothedE12.set(u.poolAddress, smoothers.e12.smooth(u.poolAddress, pricesE12.get(u.poolAddress) ?? raw * 1_000_000n, nowMs));
    if (px === null) primed.delete(u.poolAddress);
    else primed.add(u.poolAddress);
  }
}

/** Test hook: forget which pools are primed (the smoothers themselves are module-private). */
export function resetPrimedPools(): void {
  primedPools.clear();
}

function parseCrossClusterPositiveNumberEnv(
  name: string,
  fallback: number,
  maxExclusive?: number,
): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
  if (maxExclusive !== undefined && value >= maxExclusive) {
    throw new Error(`${name} must be less than ${maxExclusive}`);
  }
  return value;
}

function parseCrossClusterPositiveIntegerEnv(name: string, fallback: number): number {
  const value = parseCrossClusterPositiveNumberEnv(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const CROSS_CLUSTER_MAX_MOVE_PCT = parseCrossClusterPositiveNumberEnv(
  "CROSS_CLUSTER_MAX_MOVE_PCT",
  10,
  100,
);
/**
 * K-3 — the longest the breaker may keep the mark away from the source price
 * (see CircuitBreakerConfig.sustainedRelocationMs). Default 5 min; 0 disables.
 */
export function parseSustainedRelocationMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 300_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("CROSS_CLUSTER_SUSTAINED_RELOCATION_MS must be a non-negative integer (0 disables)");
  }
  return n;
}
const CROSS_CLUSTER_SUSTAINED_RELOCATION_MS = parseSustainedRelocationMs(
  process.env.CROSS_CLUSTER_SUSTAINED_RELOCATION_MS,
);

const CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS = parseCrossClusterPositiveIntegerEnv(
  "CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS",
  3,
);

if (CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS < 2) {
  throw new Error(
    "CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS must be at least 2",
  );
}

const crossClusterCircuitBreakerStates = new Map<string, CircuitBreakerState>();

function getCrossClusterCircuitBreakerState(
  marketAddress: string,
  label: string,
): CircuitBreakerState {
  let state = crossClusterCircuitBreakerStates.get(marketAddress);
  if (!state) {
    state = {
      symbol: label,
      lastPrice: 0,
      circuitBreakerTrips: 0,
      cbTripPrice: 0,
      cbConsecutiveTrips: 0,
    };
    crossClusterCircuitBreakerStates.set(marketAddress, state);
  }
  return state;
}

function priceE6ToUsdNumber(priceE6: bigint): number {
  return Number(priceE6) / 1_000_000;
}

/**
 * #116 — turn the breaker's accepted price into the E6 value to publish.
 *
 * When the breaker accepted the smoothed price unchanged, the original E6 is
 * published bit-for-bit (no float round-trip). When it clamped a relocation to
 * the cumulative-bound edge, the edge is converted to E6 rounding toward the
 * old baseline (down for an upward clamp, up for a downward one), so E6
 * rounding can never carry the published mark past the bound. The returned
 * `priceUsd` is the exact value of the returned E6, so the breaker baseline
 * matches what lands on chain.
 */
export function acceptedPublishPrice(
  smoothedE6: bigint,
  smoothedUsd: number,
  acceptedUsd: number,
  baselineUsd?: number,
): { priceE6: bigint; priceUsd: number } {
  if (acceptedUsd === smoothedUsd) {
    return { priceE6: smoothedE6, priceUsd: smoothedUsd };
  }
  // #125 follow-up — a cumulative-bound HOLD re-publishes the current baseline.
  // The baseline is always an exact E6 value (Number(e6) / 1e6), so recover that
  // E6 exactly. floor/ceil of `baseline * 1e6` is off by one unit for ~1.5% of
  // E6 values (float noise lands just below/above the integer), which would
  // ratchet a held mark one unit per republish, every cycle.
  if (baselineUsd !== undefined && acceptedUsd === baselineUsd) {
    let e6 = BigInt(Math.round(acceptedUsd * 1_000_000));
    if (e6 < 1n) e6 = 1n;
    return { priceE6: e6, priceUsd: priceE6ToUsdNumber(e6) };
  }
  const scaled = acceptedUsd * 1_000_000;
  // Clamped toward the baseline: an upward clamp sits below the smoothed price
  // (round down), a downward clamp sits above it (round up).
  let e6 = BigInt(acceptedUsd < smoothedUsd ? Math.floor(scaled) : Math.ceil(scaled));
  if (e6 < 1n) e6 = 1n;
  return { priceE6: e6, priceUsd: priceE6ToUsdNumber(e6) };
}

/**
 * Split a breaker-accepted candidate into (a) the accounting that MUST be
 * committed immediately and (b) the baseline that may only be committed once
 * the mark is actually published.
 *
 * `checkCircuitBreaker()` resets `cbConsecutiveTrips` when it accepts a price.
 * That reset is load-bearing: circuit-breaker.ts documents "the next push at
 * the normal level resets cbConsecutiveTrips, so the spike can never accumulate
 * to confirmTrips". Deferring the whole candidate until a successful push would
 * throw the reset away on every dropped cycle — and on this keeper roughly one
 * cycle in five ends with no successful batch push. A spike could then
 * accumulate across dropped cycles and re-baseline the breaker onto a bad
 * price, which is precisely what the breaker exists to prevent.
 *
 * So: trip accounting commits now, `lastPrice` defers.
 */
export function splitBreakerCommit(
  current: CircuitBreakerState,
  candidate: CircuitBreakerState,
  acceptedPriceUsd: number,
): { commitNow: CircuitBreakerState; deferred: CircuitBreakerState } {
  const commitNow = cloneCircuitBreakerState(candidate);
  commitNow.lastPrice = current.lastPrice; // baseline does NOT advance yet
  // K-3: a sustained-relocation snap only takes effect once it lands. Until
  // then the gap episode stays open (so a dropped snap retries next cycle) and
  // the window is untouched.
  delete commitNow.cbSnapPending;
  const deferred = cloneCircuitBreakerState(candidate);
  deferred.lastPrice = acceptedPriceUsd; // advances only on a confirmed push
  return { commitNow, deferred };
}

/**
 * #125 — the state to persist once a push of `pending.lastPrice` has LANDED.
 *
 * `committed` is the state currently persisted for the market (its lastPrice is
 * the mark that was in force until this push). The breaker records the mark in
 * force on every check, but the check runs before the push is sent; recording
 * the replaced mark again at `landedAtMs` keeps it in the trailing window for
 * the full window after it actually stopped being the on-chain mark, so the
 * window cannot be shortened by push latency.
 */
export function commitPublishedBreakerState(
  committed: CircuitBreakerState | undefined,
  pending: CircuitBreakerState,
  landedAtMs: number,
): CircuitBreakerState {
  const next = cloneCircuitBreakerState(pending);
  if (next.cbSnapPending) {
    // K-3: a landed sustained-relocation snap. The mark it replaced was wrong
    // by more than the band for the whole episode; keeping it in the window
    // would clamp the market straight back to a lagging mark. The window
    // restarts at the published source price and the gap episode ends; the
    // next divergence must be sustained again from scratch.
    delete next.cbSnapPending;
    next.cbWindowMax = undefined;
    next.cbWindowMin = undefined;
    next.cbGapSince = undefined;
    next.cbGapDir = undefined;
    next.cbGapChecks = undefined;
    recordMarkInForce(next, next.lastPrice, landedAtMs);
    return next;
  }
  if (committed && committed.lastPrice > 0) {
    recordMarkInForce(next, committed.lastPrice, landedAtMs);
  }
  recordMarkInForce(next, next.lastPrice, landedAtMs);
  return next;
}

/**
 * Copies EVERY field. This used to list the fields by hand and was not updated
 * when #104 (for #82) added cbDriftAnchorPrice/cbDriftAnchorAt, so the anchor was
 * dropped on every cycle and the cumulative bound degenerated to a per-step
 * bound. A shallow spread cannot fall behind the interface again. The #125
 * window deques are arrays, but circuit-breaker.ts never mutates them in place
 * (every update assigns a fresh array); they are copied here anyway so a future
 * in-place edit cannot alias the persisted state through a candidate.
 */
export function cloneCircuitBreakerState(state: CircuitBreakerState): CircuitBreakerState {
  const copy: CircuitBreakerState = { ...state };
  if (state.cbWindowMax) copy.cbWindowMax = state.cbWindowMax.slice();
  if (state.cbWindowMin) copy.cbWindowMin = state.cbWindowMin.slice();
  return copy;
}

// Blockhash cache — a fresh one is valid ~60-90s; refetch every 15s so each
// cycle doesn't pay a getLatestBlockhash round-trip.

/**
 * FAST cycle: ONE getMultipleAccounts to read every mainnet DEX pool, ONE
 * batched PushAuthMark tx for all pushable markets, fired WITHOUT awaiting
 * confirmation. ~3 RPC calls per cycle (was ~25), so the on-chain AuthMark can
 * refresh near per-slot. Price source is unchanged — the mainnet DEX pools.
 */
async function runCycle(
  mainnetConn: Connection,
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  decimalsCache: DecimalsCache,
  state: LoopState,
  config: LoopConfig,
): Promise<void> {
  // A market register-poll just dropped leaves /health with it.
  for (const addr of pruneDeregisteredMarkets(state, registry)) {
    console.log(`[keeper] ${addr.slice(0, 8)}… no longer registered — removed from /health`);
  }
  // K-6: price units — one per single-asset market (key = market address, exactly the old per-entry state) and one
  // per listed asset of a multi-asset market (key `<market>#<asset>`). Every per-unit map below is keyed by `key`.
  const units = priceUnitsOfRegistry(registry.markets);
  // Ensure stat entries exist.
  for (const unit of units) {
    if (!state.stats.has(unit.key)) {
      state.stats.set(unit.key, unit.multi ? newMarketStat(unit) : newMarketStat(registry.markets.find((m) => m.marketAddress === unit.marketAddress) ?? unit));
    }
  }

  // ── 1. Oracle-authority check (only pushable markets go in a batch) ─────────
  // "One-time" per 30-minute window — see maybeResetAuthorityLatches. K-6: per unit (each asset has its own profile).
  maybeResetAuthorityLatches();
  const unchecked = units.filter((m) => !authorityChecked.has(m.key));
  if (unchecked.length > 0) {
    await Promise.all(
      unchecked.map(async (m) => {
        let auth;
        try {
          auth = await fetchOracleAuthority(devnetConn, m.marketAddress, m.assetIndex);
        } catch (err) {
          // COULD NOT READ (RPC blip) — do NOT mark checked, do NOT blacklist.
          // Leaving it unchecked means we retry on the next cycle. Previously a
          // transient null here latched the market into `notPushable` FOREVER
          // (the set is module-level and never cleared), so a single rate-limit
          // burst at boot could take markets offline permanently while /health
          // still reported "ok".
          const s = state.stats.get(m.key)!;
          s.lastErrorMsg = `authority check failed (will retry): ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
          return;
        }
        authorityChecked.add(m.key);
        // Only a SUCCESSFULLY READ, genuinely different authority is permanent.
        const ok = auth !== null && auth.equals(keeper.publicKey);
        if (!ok) {
          notPushable.add(m.key);
          const s = state.stats.get(m.key)!;
          s.authorityMismatch = true;
          s.lastErrorMsg = "oracle_authority != keeper — market not pushable";
          console.warn(`[loop] ${m.label}: not pushable (oracle_authority != keeper)`);
        }
      }),
    );
  }

  // ── 2. Read ALL pool prices in ONE getMultipleAccounts (DEX-pool source) ────
  let prices: Map<string, bigint>;
  const priceSkipReasons = new Map<string, string>();
  const pricesE12 = new Map<string, bigint>();
  const quoteReservesUsdE6 = new Map<string, bigint>();
  const pushDepthOn = pushDepthEnabled();
  const pushDepthOnchain = pushDepthOnchainEnabled();
  if (pushDepthOnchain) {
    try {
      await depthSourceCache.refresh(devnetConn, DEPTH_WRAPPER_PROGRAM_ID, registry.markets.map((m) => m.marketAddress));
    } catch (err) {
      console.warn(`[loop] depth-source refresh failed (attested path this cycle): ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
    }
  }
  try {
    prices = await readAllPoolPricesE6(
      mainnetConn,
      // K-6: pool-sourced units only (a fixed asset has no pool). For single-asset rows these are the rows' own fields.
      units.filter((u) => u.source === "pool").map((u) => ({ poolAddress: u.poolAddress, dexType: u.dexType as DexType, label: u.label, symbol: u.symbol, mainnetCa: u.mainnetCa })),
      decimalsCache,
      // SOL/USD reference for WSOL-quoted (pumpswap) pools when no SOL/USDC
      // market is registered — see the param's doc comment.
      process.env.SOL_USD_REFERENCE_POOL,
      priceSkipReasons,
      pricesE12,
      pushDepthOn ? quoteReservesUsdE6 : undefined,
    );
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    state.consecutiveBatchReadFailures++;
    state.lastBatchReadError = msg;
    console.error(
      `[loop] batch pool read error (${state.consecutiveBatchReadFailures} consecutive) — ${msg}`,
    );
    return;
  }
  state.consecutiveBatchReadFailures = 0;
  state.lastBatchReadError = null;

  // ── 3. Build the pushable set for this cycle ────────────────────────────────
  const pushes: Array<{ key: string; multi: boolean; marketAddress: string; assetIndex: number; priceE6: bigint; priceE12?: bigint; depth?: PushDepth | null; dex?: DexDepthPin | null }> = [];
  const smoothNowMs = Date.now();
  // Smooth once per POOL per cycle, not once per market: N markets sharing a
  // pool would insert N identical samples per cycle, silently shrinking the
  // smoother's time window by N× against its MAX_SAMPLES cap (3 sharers cut
  // the 180s window to ~149s — undoing the widening that was deployed
  // precisely because 90s was insufficient).
  const smoothedThisCycle = new Map<string, bigint | null>();
  const smoothedE12ThisCycle = new Map<string, bigint | null>();
  const pendingCircuitBreakerStates = new Map<string, CircuitBreakerState>();
  // R3.24: a market whose pool window is still priming would be withheld this cycle. Make sure its fail-closed
  // deadlines (push-deadline.ts) are known before deciding that: one read for all such markets, only while priming.
  await refreshPushDeadlines(devnetConn, deadlineReadsNeeded(units, state.terminalMarkets, primedPools, smoothNowMs));
  // R3.24: sample EVERY live pool once per cycle, before any per-unit skip. The smoother used to be fed only on the
  // cycles a unit reached it, so a pool whose only market was push-held most cycles (2xhs asset 2, cbBTC, 2026-10-15:
  // 25 unheld cycles of 174, i.e. one sample per ~21 s against a 15 s window) never held 3 samples and re-primed
  // forever, while its siblings' pools were kept primed by other markets. Withholding a push must not starve its window.
  samplePoolsForCycle(units, (m) => isTerminalForPush(state, m), prices, pricesE12, { e6: markSmoother, e12: markSmootherE12 }, smoothNowMs, smoothedThisCycle, smoothedE12ThisCycle, primedPools);
  for (const entry of units) {
    if (notPushable.has(entry.key)) continue;
    // R3.24 (b): a terminal market (Resolved / closed / Recovery) is never smoothed, breaker-checked or pushed again,
    // and it stays terminal (resolution is one-way). It used to be re-discovered by the PUSHER every cycle, so a cycle
    // in which the smoother or the breaker held it back dropped it from the terminal set and it alerted as no-push.
    if (isTerminalForPush(state, entry.marketAddress)) {
      const ts = state.stats.get(entry.key);
      if (ts) ts.lastErrorMsg = null;
      continue;
    }
    // The cranker is landing follow-up refreshes for this market's current
    // accrual; a push now would void them (Custom(22)). Auto-expires.
    if (isPushHeld(entry.marketAddress)) {
      // R3.24: say so. This skip was silent, so a market held most cycles showed only an unrelated stale lastError.
      const hs = state.stats.get(entry.key);
      if (hs) hs.lastErrorMsg = PUSH_HELD_MSG;
      continue;
    }
    if (withheldFromPush(entry.marketAddress, config.withholdPush)) {
      const ws = state.stats.get(entry.key);
      if (ws) ws.lastErrorMsg = "push withheld: P3 senior backing exhausted, waiting for the tag 39 stale window";
      continue;
    }
    const stat = state.stats.get(entry.key)!;
    if (entry.source === "fixed") {
      // K-6: a synthetic asset with a constant mark. No pool, so no smoother, no breaker and no source-frozen clock:
      // the configured mark is pushed every cycle (that push is what keeps the asset's oracle fresh).
      const fixed = fixedPushFor(entry);
      if (fixed === null) {
        stat.totalErrors++;
        stat.lastErrorMsg = "fixed source without a valid fixedPriceE6";
        continue;
      }
      if (config.standby?.(entry.marketAddress)) {
        (state.standbyThisCycle ??= new Set()).add(entry.key);
        state.landedThisCycle.add(entry.key);
        stat.sourcePriceE6 = fixed;
        continue;
      }
      stat.sourcePriceE6 = fixed;
      stat.lastPriceE6 = fixed;
      pushes.push({ key: entry.key, multi: entry.multi, marketAddress: entry.marketAddress, assetIndex: entry.assetIndex, priceE6: fixed, depth: null });
      continue;
    }
    const rawPriceE6 = prices.get(entry.poolAddress);
    if (rawPriceE6 === undefined || rawPriceE6 <= 0n) {
      stat.totalErrors++;
      stat.lastErrorMsg = noPoolPriceReason(priceSkipReasons, entry.poolAddress);
      stat.sourcePriceE6 = 0n;
      continue;
    }
    recordRawPrice(stat, rawPriceE6, smoothNowMs);
    // The mark that settles trades is the SMOOTHED price, never raw spot.
    let priceE6 = smoothedThisCycle.get(entry.poolAddress);
    if (priceE6 === undefined) {
      priceE6 = markSmoother.smooth(entry.poolAddress, rawPriceE6, smoothNowMs);
      smoothedThisCycle.set(entry.poolAddress, priceE6);
      // Same sample, same instant, at e12 (the e6 value x 1e6 when the read produced no e12), so the two windows stay aligned.
      smoothedE12ThisCycle.set(entry.poolAddress, markSmootherE12.smooth(entry.poolAddress, pricesE12.get(entry.poolAddress) ?? rawPriceE6 * 1_000_000n, smoothNowMs));
      if (priceE6 === null) primedPools.delete(entry.poolAddress);
      else primedPools.add(entry.poolAddress);
    }
    let smoothedE12: bigint | null | undefined = smoothedE12ThisCycle.get(entry.poolAddress);
    if (priceE6 === null) {
      // R3.24 (a): the priming gate is only safe while no fail-closed deadline is close. When one is, publish the
      // median of what the window already holds (bounded by the breaker below, the band and the engine step cap).
      const bypass = deadlineBypass(getPushDeadline(entry.marketAddress, smoothNowMs, DEADLINE_FRESH_MS), markSmoother.peek(entry.poolAddress));
      if (bypass === null) {
        stat.totalErrors++;
        stat.lastErrorMsg = primingMessage(markSmoother.status(entry.poolAddress));
        continue;
      }
      priceE6 = bypass.priceE6;
      smoothedE12 = markSmootherE12.peek(entry.poolAddress);
      console.warn(`[loop] ${entry.label}: smoother still priming but ${bypass.reason} — publishing the window median now (R3.24 deadline bypass)`);
    }
    // F2: standby (the primary is alive). The smoother above is already warm; do not touch the breaker or push.
    if (config.standby?.(entry.marketAddress)) {
      (state.standbyThisCycle ??= new Set()).add(entry.key);
      state.landedThisCycle.add(entry.key);
      stat.sourcePriceE6 = priceE6;
      continue;
    }

    const currentCircuitBreakerState = getCrossClusterCircuitBreakerState(
      entry.key,
      entry.label,
    );
    const candidateCircuitBreakerState = cloneCircuitBreakerState(
      currentCircuitBreakerState,
    );
    const priceUsd = priceE6ToUsdNumber(priceE6);
    const acceptedUsd = checkCircuitBreaker(candidateCircuitBreakerState, priceUsd, {
      maxMovePct: CROSS_CLUSTER_MAX_MOVE_PCT,
      confirmTrips: CROSS_CLUSTER_CIRCUIT_BREAKER_CONFIRM_TRIPS,
      sustainedRelocationMs: CROSS_CLUSTER_SUSTAINED_RELOCATION_MS,
      log: (msg) => console.warn(`[loop] ${msg}`),
    });
    stat.sourcePriceE6 = priceE6;
    {
      const g = markGap(candidateCircuitBreakerState, priceUsd, Date.now());
      stat.markGap = g && { pct: g.pct, ageMs: g.ageMs, checks: g.checks, dir: g.dir };
    }
    if (acceptedUsd === null) {
      // Keep breaker trip accounting for sustained-relocation detection, but do
      // not advance the accepted baseline. checkCircuitBreaker() does not move
      // lastPrice on a rejected candidate.
      crossClusterCircuitBreakerStates.set(
        entry.key,
        candidateCircuitBreakerState,
      );
      stat.totalErrors++;
      stat.lastErrorMsg =
        `circuit breaker blocked mark move at ${priceUsd.toFixed(6)}`;
      continue;
    }

    // The candidate is breaker-accepted, but it is not the published AuthMark
    // yet. Stage the new baseline and commit it only after pushAuthMarkBatch
    // confirms this market was actually pushed.
    //
    // TRIP ACCOUNTING IS COMMITTED NOW, BASELINE IS NOT. checkCircuitBreaker()
    // resets cbConsecutiveTrips on an accepted price — that reset is what makes
    // circuit-breaker.ts's documented invariant hold ("the next push at the
    // normal level resets cbConsecutiveTrips, so the spike can never accumulate
    // to confirmTrips"). Deferring the WHOLE candidate would discard the reset
    // whenever the push does not land, and on this keeper roughly one cycle in
    // five ends without a successful batch push (254,292 pushes over 324,639
    // cycles, plus 3,645 hard timeouts). A spike could then accumulate across
    // dropped cycles and re-baseline the breaker onto a bad price — the exact
    // failure the breaker exists to prevent. Only `lastPrice` may be deferred.
    //
    // #116: the breaker may accept a CLAMPED price (a confirmed relocation
    // rate-limited to the edge of the cumulative bound). Publish exactly what
    // it accepted — never the smoothed price it was shown — and record that
    // same value as the pending baseline.
    const publish = acceptedPublishPrice(
      priceE6,
      priceUsd,
      acceptedUsd,
      currentCircuitBreakerState.lastPrice,
    );
    const { commitNow, deferred } = splitBreakerCommit(
      currentCircuitBreakerState,
      candidateCircuitBreakerState,
      publish.priceUsd,
    );
    crossClusterCircuitBreakerStates.set(entry.key, commitNow);
    pendingCircuitBreakerStates.set(entry.key, deferred);

    stat.lastPriceE6 = publish.priceE6;
    // e12 rides along only when the breaker published the smoothed price itself (not a clamp / hold).
    if (publish.priceE6 !== priceE6) smoothedE12 = null;
    pushes.push({
      key: entry.key,
      multi: entry.multi,
      marketAddress: entry.marketAddress,
      assetIndex: entry.assetIndex,
      priceE6: publish.priceE6,
      ...(smoothedE12 ? { priceE12: smoothedE12 } : {}),
      // G8: flag off / non-CPMM / reserve unknown -> null -> the exact 35 B bytes of today.
      depth: resolvePushDepth(pushDepthOn, quoteReservesUsdE6.get(entry.poolAddress)),
      // Round 2: the active, same-cluster pin (mode 2); the pusher re-checks it against the live generation.
      ...(pushDepthOnchain ? { dex: depthSourceCache.get(entry.marketAddress) } : {}),
    });
  }
  if (pushes.length === 0) return;

  // ── 4. One slot + one (cached) blockhash for the whole batch ────────────────
  const nowSlot = BigInt(await devnetConn.getSlot("processed"));
  const now = Date.now();
  // Shared with the cranker (blockhash-cache.ts): one fetch per 15 s for the whole process.
  const cachedBlockhash = await getCachedBlockhash(devnetConn, "processed");

  // ── 4b. Wallet-balance guard (#71) ──────────────────────────────────────────
  // A keeper that cannot pay produces reverting transactions, not fresh marks.
  // Pausing makes the stall explicit on /health instead of burning what is left
  // of the balance on transactions that fail. Checked here — after prices are
  // computed, before anything is signed — so a low wallet costs no RPC writes.
  {
    const nowMs = Date.now();
    if (shouldRefreshBalance(state.wallet, nowMs, config.balanceCheckIntervalMs)) {
      try {
        const lamports = await devnetConn.getBalance(keeper.publicKey, "confirmed");
        const transition = applyBalanceReading(
          state.wallet,
          lamports,
          config.minKeeperBalanceLamports,
          nowMs,
        );
        if (transition === "went-low") {
          console.error(
            `[keeper][ALERT] WALLET LOW: ${formatSol(lamports)} SOL is below the ` +
              `${formatSol(config.minKeeperBalanceLamports)} SOL threshold — PAUSING PUSHES. ` +
              `Refund ${keeper.publicKey.toBase58()}`,
          );
        } else if (transition === "recovered") {
          console.log(
            `[keeper] WALLET REFUNDED: ${formatSol(lamports)} SOL — resuming pushes.`,
          );
        }
      } catch (err) {
        // Deliberately does NOT clear a previous `low` verdict: an RPC failure is
        // not evidence of funds. See recordBalanceReadFailure's doc comment.
        recordBalanceReadFailure(state.wallet, nowMs);
        console.error(
          `[keeper] wallet balance check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (state.wallet.low) {
      console.error(
        `[keeper] wallet low (${formatSol(state.wallet.balanceLamports)} SOL) — skipping ${pushes.length} push(es) this cycle`,
      );
      return;
    }
  }

  // ── 5. One batched PushAuthMark tx, fire-and-forget ─────────────────────────
  try {
    state.cycleAttempted = pushes.length; // adjusted below for terminal markets
    const res = await pushAuthMarkBatch(devnetConn, keeper, pushes, nowSlot, cachedBlockhash, config.dryRun);
    state.cycleAttempted = pushes.length - (res.terminalMarkets?.length ?? 0);
    state.cyclePushed = config.dryRun ? state.cycleAttempted : res.signature ? res.pushedMarkets.length : 0;
    const stamp = Date.now();
    // Record PER MARKET, not per batch. This loop used to stamp every market in
    // `pushes` as freshly pushed whenever the batch reported success — so a
    // market that was dropped (reverting or quarantined) still showed a fresh
    // lastPushAt and a rising totalPushes on /health. That made a frozen price
    // look healthy, which is how a stuck market goes unnoticed for days.
    const pushedSet = new Set(res.pushedMarkets);
    const terminalSet = new Set(res.terminalMarkets ?? []);
    // R3.24 (b): sticky. A market the pusher saw non-Live never becomes pushable again; replacing the set every cycle
    // forgot every terminal market that did not reach the batch this cycle (smoother priming, breaker hold).
    for (const m of terminalSet) {
      state.terminalMarkets.add(m);
      if (!isKnownTerminal(m)) markTerminal(m);
    }
    const dexPushed = new Set(res.dexPushedMarkets ?? []);
    for (const m of res.dexRefusedMarkets ?? []) depthSourceCache.invalidate(m);
    for (const p of pushes) {
      if (terminalSet.has(p.marketAddress)) continue; // B20: Resolved/closed — not an error
      if (p.multi) {
        // K-6: an asset of a multi-asset market is judged by ITS push (generation key), with its own stat and breaker.
        recordMultiAssetPushOutcome(state, p, res, { dryRun: config.dryRun, stamp, pending: pendingCircuitBreakerStates.get(p.key) });
        continue;
      }
      const stat = state.stats.get(p.marketAddress)!;
      stat.authorityMismatch = false;
      if (config.dryRun) {
        stat.lastSig = "DRY_RUN";
        stat.lastDepthE6 = p.depth?.depthE6 ?? null;
        stat.lastDepthSource = p.depth?.source ?? null;
        stat.noPushCycles = 0;
        state.landedThisCycle.add(p.marketAddress);
      } else if (pushedSet.has(p.marketAddress) && res.signature) {
        const pendingCircuitBreakerState = pendingCircuitBreakerStates.get(
          p.marketAddress,
        );
        if (pendingCircuitBreakerState) {
          crossClusterCircuitBreakerStates.set(
            p.marketAddress,
            commitPublishedBreakerState(
              crossClusterCircuitBreakerStates.get(p.marketAddress),
              pendingCircuitBreakerState,
              stamp,
            ),
          );
        }
        recordLandedPush(stat, stamp, res.signature);
        stat.lastDepthE6 = dexPushed.has(p.marketAddress) ? null : (p.depth?.depthE6 ?? null);
        stat.lastDepthSource = dexPushed.has(p.marketAddress) ? DEPTH_SOURCE_ONCHAIN_DEX : (p.depth?.source ?? null);
        state.landedThisCycle.add(p.marketAddress);
      } else {
        stat.totalErrors++;
        stat.lastErrorMsg = "dropped from batch (reverted in preflight or quarantined)";
      }
    }
    if (config.onPushLanded && !config.dryRun) {
      // The P3 vault-LP hook is per MARKET mark move; a multi-asset market has no single mark (and cannot hold a bound
      // vault LP: tag 40 ACTIVATE refuses one), so its assets never fire it.
      for (const p of landedPushes(pushes, res).filter((x) => !x.multi)) {
        try {
          config.onPushLanded(p.marketAddress, p.priceE6, state.stats.get(p.marketAddress)?.label ?? p.marketAddress);
        } catch {
          // never let the vault-LP hook disturb the push loop
        }
      }
    }
    if (!config.dryRun) {
      publishLandedTicks(
        state.tickPublisher,
        pushes,
        res,
        (m, assetIndex) => {
          const raw = (state.stats.get(m) ?? state.stats.get(multiAssetKey(m, assetIndex)))?.lastRawPriceE6 ?? 0n;
          return raw > 0n ? raw : null;
        },
        nowSlot,
        stamp,
      );
    }
    if (res.pushed && res.signature) {
      state.lastSuccessfulPushAt = stamp;
      console.log(`[loop] batched push × ${res.count}: sig=${res.signature.slice(0, 16)}…`);
    } else if (config.dryRun && pushes.length > 0) {
      // Dry-run "pushes" count as liveness — the pipeline produced prices.
      state.lastSuccessfulPushAt = stamp;
    }
    if (res.skippedMarkets.length > 0) {
      console.warn(
        `[loop] ${res.skippedMarkets.length} market(s) NOT priced this cycle: ` +
          res.skippedMarkets.map((m) => m.slice(0, 8) + "…").join(", "),
      );
    }
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    console.error(`[loop] batch push error — ${msg}`);
    if (/blockhash/i.test(msg)) invalidateBlockhash(devnetConn); // force refresh next cycle
    for (const p of pushes) {
      const s = state.stats.get(p.key)!; // K-6: p.key === p.marketAddress for a single-asset market
      s.totalErrors++;
      s.lastErrorMsg = msg;
    }
  }
}

/**
 * K-1: after every cycle (including a timed-out one), a market that did not
 * land a push extends its no-push streak. A landed push already reset it.
 */
export function advanceNoPushStreaks(
  stats: Iterable<Pick<MarketStat, "marketAddress" | "noPushCycles"> & Partial<Pick<MarketStat, "key">>>,
  landed: ReadonlySet<string>,
): void {
  // K-6: `landed` holds stat keys (= the market address for a single-asset market).
  for (const stat of stats) {
    if (!landed.has(stat.key ?? stat.marketAddress)) stat.noPushCycles++;
  }
}

/**
 * K-1: should this market be pushing? Not when it was last seen Resolved/closed,
 * and not when the hot-reloaded registry no longer lists it (stats are never
 * pruned, so a de-registered market would otherwise alert forever).
 */
/**
 * Drop every per-market record of a market the registry no longer lists (retired in Supabase and removed
 * by register-poll). `stats` was never pruned, so a retired market stayed on /health with a frozen
 * "last push 59s ago" / crank sample, which reads as alive. Returns the addresses removed.
 */
export function pruneDeregisteredMarkets(
  state: Pick<LoopState, "stats" | "terminalMarkets" | "landedThisCycle">,
  registry: Pick<Registry, "markets">,
): string[] {
  const keep = new Set(registry.markets.map((m) => m.marketAddress));
  // K-6: per-asset keys of multi-asset markets (`<market>#<asset>`) live in the same maps; keep the listed ones.
  const keepKeys = new Set([...keep, ...priceUnitsOfRegistry(registry.markets).map((u) => u.key)]);
  const removed: string[] = [];
  for (const addr of [...state.stats.keys()]) {
    if (keepKeys.has(addr)) continue;
    state.stats.delete(addr);
    state.terminalMarkets.delete(addr);
    state.landedThisCycle.delete(addr);
    removed.push(addr);
  }
  for (const addr of pruneCrankRefreshHealth(keep)) if (!removed.includes(addr)) removed.push(addr);
  // Module-level per-market maps: authority latches, breaker state, nonce / quarantine / terminal-log.
  for (const m of [...authorityChecked]) if (!keepKeys.has(m)) authorityChecked.delete(m);
  for (const m of [...notPushable]) if (!keepKeys.has(m)) notPushable.delete(m);
  for (const m of [...crossClusterCircuitBreakerStates.keys()]) if (!keepKeys.has(m)) crossClusterCircuitBreakerStates.delete(m);
  pruneAuthMarkPusherState(keep);
  pruneMarketAccrual(keep);
  prunePushDeadlines(keep);
  return removed;
}

function pushExpected(state: LoopState, registry: Registry, market: string): boolean {
  return !isTerminalForPush(state, market) && registry.markets.some((m) => m.marketAddress === market);
}

/** Deadline cache entries older than this are not used for the pin alert (the cranker refreshes them every crank). */
const PIN_ALERT_MAX_AGE_MS = 4 * DEADLINE_FRESH_MS;

/** R3.24 (c): the band-pin alert sample of one market (its stats: the market's own, or every asset's of a multi-asset row). */
export function bandPinSampleFor(
  state: Pick<LoopState, "stats" | "terminalMarkets">,
  registry: Pick<Registry, "markets">,
  marketAddress: string,
  label: string,
  nowMs: number,
): BandPinSample {
  const stats = [...state.stats.values()].filter((st) => st.marketAddress === marketAddress);
  const terminal = isTerminalForPush(state, marketAddress) || !registry.markets.some((m) => m.marketAddress === marketAddress);
  const d = getPushDeadline(marketAddress, nowMs, PIN_ALERT_MAX_AGE_MS);
  const pushes = stats.map((st) => st.lastPushAt).filter((t): t is number => t !== null);
  return {
    label,
    market: marketAddress,
    terminal: terminal || (d?.terminal ?? null) !== null,
    pin: d?.pin ?? null,
    noPushCycles: stats.length > 0 ? Math.max(...stats.map((st) => st.noPushCycles)) : 0,
    lastPushAt: pushes.length === stats.length && pushes.length > 0 ? Math.min(...pushes) : null,
  };
}

/**
 * R3.24 (b): the /health status word of a market that will never be pushed again ("resolved" / "closed" /
 * "recovery"), or null for a pushable market. A market the pusher reported non-Live before any read decoded it is
 * "terminal".
 */
export function terminalHealthStatus(state: Pick<LoopState, "terminalMarkets">, marketAddress: string): string | null {
  if (!isTerminalForPush(state, marketAddress)) return null;
  return getPushDeadline(marketAddress)?.terminal ?? "terminal";
}

/** K-1/K-3: the per-market sample the alert evaluator and /health read. `terminal` = no push expected. */
export function marketPushSample(stat: MarketStat, terminal: boolean): MarketPushSample {
  return {
    label: stat.label,
    market: stat.marketAddress,
    noPushCycles: stat.noPushCycles,
    lastPushAt: stat.lastPushAt,
    lastError: stat.lastErrorMsg,
    markGap: stat.markGap,
    sourceUnchangedSince: stat.sourceUnchangedSince,
    terminal,
  };
}

/** K-1/K-3: reconcile per-market push alerts once per cycle. Never throws. */
async function reportMarketPush(state: LoopState, registry: Registry): Promise<void> {
  try {
    const sink = getAlertSink();
    const now = Date.now();
    const active: Alert[] = [];
    for (const stat of state.stats.values()) {
      const ev = evaluateMarketPush(marketPushSample(stat, !pushExpected(state, registry, stat.marketAddress)), sink.thresholds, now);
      active.push(...ev.active);
    }
    // R3.24 (c): a live band market's pin approaching expiry, per market (the pin is market-level: any asset expires it).
    for (const m of registry.markets) {
      active.push(...evaluateBandPinExpiry(bandPinSampleFor(state, registry, m.marketAddress, m.label, now), sink.thresholds));
    }
    await sink.reconcile("push-market", active);
  } catch (err) {
    console.error(`[keeper] market push health report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Ops track: pushes landed per cycle. A cycle abandoned by the watchdog, a
 * paused wallet, or a total mainnet-read failure all count as zero — that is
 * the frozen-AuthMark condition regardless of which one caused it. Never throws.
 */
async function reportPushCycle(state: LoopState, registered: number): Promise<void> {
  try {
    const sink = getAlertSink();
    const sample = {
      cycle: state.cycleCount,
      registered,
      attempted: state.cycleAttempted,
      pushed: state.cyclePushed,
    };
    const ev = evaluatePushCycle(sample, state.zeroPushStreak, sink.thresholds);
    state.zeroPushStreak = ev.zeroStreak;
    if (state.cycleCount % PUSH_HEALTH_LINE_EVERY_CYCLES === 0) {
      sink.health("push", { ...sample, zeroStreak: ev.zeroStreak, timeouts: state.timeoutCount });
    }
    await sink.reconcile("push", ev.active);
  } catch (err) {
    console.error(`[keeper] push health report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── D2a: hang detection ───────────────────────────────────────────────────────

const DEFAULT_CYCLE_TIMEOUT_MS = 10_000;

/** Sentinel error thrown when a cycle is abandoned by the watchdog timeout. */
class CycleTimeoutError extends Error {}

/**
 * Rejects after `ms` with a CycleTimeoutError. Racing this against runCycle()
 * means a black-holed RPC socket (a request that never resolves and never
 * rejects — the failure mode `withRpcRetry`/try-catch can't help with,
 * because there's no error to catch) can no longer stall the main loop
 * forever. This is best-effort: web3.js's Connection methods don't accept an
 * AbortSignal, so the abandoned runCycle() call isn't actually cancelled —
 * it keeps running in the background and its result (or error) is discarded
 * when it eventually settles. What this DOES guarantee is that the loop's
 * `lastCycleAt` keeps advancing and a new cycle gets a chance to run, so the
 * keeper can't go fully silent because of one wedged RPC call. Full
 * cancellation + an external process-level watchdog are D2b/D3 (deferred).
 */
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new CycleTimeoutError(`runCycle exceeded ${ms}ms`)), ms);
  });
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

/**
 * Start the cross-cluster keeper loop.
 *
 * Runs indefinitely. Handles SIGINT/SIGTERM for graceful shutdown.
 * The health server is started before the first cycle begins.
 */
export async function startKeeperLoop(
  mainnetConn: Connection,
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  config: LoopConfig,
): Promise<void> {
  const cycleTimeoutMs = config.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS;

  // Initialise per-market stats
  const state: LoopState = {
    startedAt: Date.now(),
    lastCycleAt: null,
    cycleCount: 0,
    timeoutCount: 0,
    tickPublisher: config.tickPublisher ?? createTickPublisher(),
    lastSuccessfulPushAt: null,
    consecutiveBatchReadFailures: 0,
    wallet: createWalletBalanceState(),
    lastBatchReadError: null,
    cycleAttempted: 0,
    cyclePushed: 0,
    zeroPushStreak: 0,
    terminalMarkets: new Set(),
    landedThisCycle: new Set(),
    // K-6: one stat per price unit; for single-asset markets exactly the old per-market record.
    stats: new Map(priceUnitsOfRegistry(registry.markets).map((u) => [u.key, u.multi ? newMarketStat(u) : newMarketStat(registry.markets.find((m) => m.marketAddress === u.marketAddress) ?? u)])),
  };

  const decimalsCache: DecimalsCache = new Map();

  // Health server
  const server = http.createServer(makeHealthHandler(state, config, registry));
  server.listen(config.healthPort, config.healthBind, () => {
    console.log(
      `[keeper] Health: http://${config.healthBind}:${config.healthPort}/health`,
    );
  });
  // Optional file mirror of /health for readers without access to the port (KEEPER_HEALTH_FILE; health-file.ts).
  const healthFile = healthFileConfigFromEnv(process.env);
  if (healthFile) {
    const host = config.healthBind === "0.0.0.0" ? "127.0.0.1" : config.healthBind;
    const readHealth = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const req = http.get({ host, port: config.healthPort, path: "/health", timeout: 5_000 }, (r) => {
          let body = "";
          r.setEncoding("utf8");
          r.on("data", (c: string) => (body += c));
          r.on("end", () => resolve(body));
        });
        req.on("timeout", () => req.destroy(new Error("health read timeout")));
        req.on("error", reject);
      });
    startHealthFileMirror(healthFile, readHealth, `http://${host}:${config.healthPort}/health BUILDTAG=${process.env.BUILDTAG ?? "?"}`);
    console.log(`[keeper] Health file: ${healthFile.file} every ${healthFile.intervalMs}ms`);
  }

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("[keeper] SIGINT/SIGTERM — shutting down…");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const mode = config.dryRun ? "DRY-RUN" : "LIVE";
  console.log(
    `[keeper] Cross-cluster keeper (${mode}):` +
      ` ${registry.markets.length} markets, interval=${config.intervalMs}ms`,
  );

  // Main loop
  while (!stopping) {
    const cycleStart = Date.now();
    state.cycleCount++;
    state.cycleAttempted = 0;
    state.cyclePushed = 0;
    state.landedThisCycle = new Set();
    state.standbyThisCycle = new Set();
    console.log(
      `\n[keeper] === Cycle ${state.cycleCount} ${new Date().toISOString()} ===`,
    );

    try {
      // D2a: race the cycle against a timeout so a black-holed RPC call can't
      // stall the loop silently forever — see timeoutAfter()'s doc comment
      // for exactly what this does and does not guarantee.
      await Promise.race([
        runCycle(mainnetConn, devnetConn, keeper, registry, decimalsCache, state, config),
        timeoutAfter(cycleTimeoutMs),
      ]);
    } catch (err) {
      if (err instanceof CycleTimeoutError) {
        state.timeoutCount++;
        console.error(
          `[keeper][ALERT] Cycle ${state.cycleCount} TIMED OUT after ${cycleTimeoutMs}ms — moving on to the` +
            ` next cycle so the loop doesn't stall. (timeoutCount=${state.timeoutCount}; the abandoned` +
            ` in-flight call may still complete in the background and will be discarded.)`,
        );
      } else {
        console.error(
          `[keeper] Unexpected cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    state.lastCycleAt = Date.now();
    advanceNoPushStreaks(
      [...state.stats.values()].filter((st) => pushExpected(state, registry, st.marketAddress)),
      state.landedThisCycle,
    );
    // B20: terminal markets can never be pushed; a board of only terminal markets is not an outage.
    // K-6: counted per price unit (= per market when every market is single-asset).
    await reportPushCycle(state, countPushableMarkets(priceUnitsOfRegistry(registry.markets), state.terminalMarkets) - (state.standbyThisCycle?.size ?? 0));
    await reportMarketPush(state, registry);
    const elapsed = Date.now() - cycleStart;
    const remaining = config.intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
}
