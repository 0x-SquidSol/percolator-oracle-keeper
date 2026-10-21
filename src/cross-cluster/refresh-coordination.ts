/**
 * cross-cluster/refresh-coordination.ts
 *
 * Shared state between the recovery cranker and the push loop, kept in its own
 * module so neither imports the other.
 *
 * 1. Push holds. A no-observation refresh crank is accepted only while the
 *    market's latest pushed mark equals the mark the last accrual used; once a
 *    new PushAuthMark lands, a refresh returns Custom(22) until the next
 *    accrual (which re-stales the whole cohort again). When a market has more
 *    positioned portfolios than one transaction can refresh, the cranker sends
 *    the rest as follow-up transactions and holds that market's pushes until
 *    they land, so they share the accrual's price window. A hold always
 *    expires on its own (`untilMs`), so a cranker that dies mid-hold cannot
 *    freeze a market's price.
 *
 * 2. Per-market crank refresh health, written by the cranker every cycle and
 *    read by the /health handler.
 */

/** Longest a push hold may last, whatever the caller asks for. */
export const MAX_PUSH_HOLD_MS = 15_000;

const holds = new Map<string, number>();

/** Hold pushes for `market` for `ms` (capped at MAX_PUSH_HOLD_MS). */
export function holdPushes(market: string, ms: number, nowMs: number = Date.now()): void {
  holds.set(market, nowMs + Math.max(0, Math.min(ms, MAX_PUSH_HOLD_MS)));
}

export function releasePushes(market: string): void {
  holds.delete(market);
}

/** True while a hold for `market` is active. Expired holds are dropped. */
export function isPushHeld(market: string, nowMs: number = Date.now()): boolean {
  const until = holds.get(market);
  if (until === undefined) return false;
  if (nowMs >= until) {
    holds.delete(market);
    return false;
  }
  return true;
}

import type { SweepHealth } from "./positioned-sweep.ts";
import { resetLayoutGuardMetrics } from "./layout-guard-metrics.ts";

export interface CrankRefreshHealth {
  /** stale_account_count_long/short at this cycle's pre-crank read. */
  staleLong: number;
  staleShort: number;
  /** stale counts after this cycle's cranks (simulated post-state or a verification read); null = unknown. */
  postStaleLong: number | null;
  postStaleShort: number | null;
  /** Positioned portfolios this cycle tried to refresh. */
  positioned: number;
  /** Refreshes that did not fit the accrual transaction this cycle. */
  overflow: number;
  /** ... of which landed in follow-up transactions. */
  overflowRefreshed: number;
  /** Why the follow-up refreshes did not all land (null = they did, or there were none). */
  overflowError: string | null;
  /** Consecutive cycles the market ended loss-stale (stale count > 0 after our cranks). */
  lossStaleCycles: number;
  /**
   * "loss-stale" once lossStaleCycles reaches the alert threshold. "layout-unknown": the market
   * account matches no row of the layout table (market-layout.ts); "layout-unsupported": the layout
   * is known but the SDK portfolio parser cannot read its portfolios. Both mean the keeper is NOT
   * refreshing this market's portfolios (accrual crank only) and the market is unhealthy.
   */
  status: "ok" | "loss-stale" | "layout-unknown" | "layout-unsupported";
  /** Layout the account was read with (absent on samples from before the layout table). */
  layout?: MarketLayoutHealth;
  updatedAt: number;
  /**
   * GH#181: the chain slot and the engine's `slot_last` at this cycle's read. The v2.2 layer's
   * record REPLACES the cranker's on a sweep market (see the K-9 note in v22/loop.ts), so the
   * slot pair has to live here too or `slot-lag` -- the #133 condition -- cannot be evaluated
   * for any v2.2 market. Optional: records written before this field, and any writer that does
   * not know the chain slot, produce no slot-lag verdict rather than a wrong one.
   */
  chainSlot?: bigint;
  engineSlot?: bigint | null;
  /**
   * Drift-layout markets (continuous sweep): bound-vs-insurance coverage, stale and
   * laggard counts, pace. Absent on legacy markets, so their /health is unchanged.
   */
  sweep?: SweepHealth;
  /**
   * K-9: ADL state of asset 0 at this cycle's pre-crank read (adl-state.ts). Absent when the account could not be
   * decoded (unknown layout), so a market the decoder cannot read shows no ADL fields rather than a guess.
   */
  adl?: { reduceOnly: boolean; aLong: string; aShort: string; oiEffLong: string; oiEffShort: string };
  /** Multi-asset markets only: the ADL state of every non-Disabled asset slot (adl-state.ts adlHealthOf). */
  adlAssets?: Array<{ asset: number; reduceOnly: boolean; aLong: string; aShort: string; oiEffLong: string; oiEffShort: string }>;
}

/** Layout verdict for one market read. */
export interface MarketLayoutHealth {
  /** Table row id, or "unknown". */
  id: string;
  /** null = the keeper can fully read this market. */
  problem: string | null;
  kind: "ok" | "unknown" | "unsupported";
  accountLen: number;
  /** The table row is marked provisional (numbers may still move). */
  provisional: boolean;
  /** Positions on the asset at the read (null: not decodable). */
  hasPositions: boolean | null;
}

/** Process-lifetime counters: cranker market reads that hit a layout problem. */
const layoutProblemCounts = { unknown: 0, unsupported: 0 };

export function countLayoutProblem(kind: "unknown" | "unsupported"): void {
  layoutProblemCounts[kind]++;
}

export function getLayoutProblemCounts(): { unknown: number; unsupported: number } {
  return { ...layoutProblemCounts };
}

const refreshHealth = new Map<string, CrankRefreshHealth>();

export function setCrankRefreshHealth(market: string, h: CrankRefreshHealth): void {
  refreshHealth.set(market, h);
}

export function getCrankRefreshHealth(market: string): CrankRefreshHealth | undefined {
  return refreshHealth.get(market);
}

/**
 * Forget the refresh health (and any push hold) of every market not in `keep`. A market the registry
 * dropped (retired in Supabase) must also leave /health: its last crank sample would otherwise sit there
 * forever, looking alive. Returns the markets removed.
 */
export function pruneCrankRefreshHealth(keep: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const m of [...refreshHealth.keys()]) {
    if (keep.has(m)) continue;
    refreshHealth.delete(m);
    removed.push(m);
  }
  for (const m of [...holds.keys()]) {
    if (keep.has(m)) continue;
    holds.delete(m);
    if (!removed.includes(m)) removed.push(m);
  }
  return removed;
}

/** Test hook. */
export function resetRefreshCoordination(): void {
  holds.clear();
  refreshHealth.clear();
  layoutProblemCounts.unknown = 0;
  layoutProblemCounts.unsupported = 0;
  resetLayoutGuardMetrics();
}
