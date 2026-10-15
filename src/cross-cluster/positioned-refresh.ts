/**
 * cross-cluster/positioned-refresh.ts
 *
 * Pure helpers for the recovery cranker's "accrue, then refresh every
 * positioned portfolio" transaction. Kept free of RPC so the decoding and the
 * transaction plan can be tested against real devnet account bytes.
 *
 * Why the cranker needs this (measured on devnet 2026-09-28, engine c141d47f,
 * predicate unchanged at 35ddd692):
 *
 *   The loss-stale predicate is `asset_is_loss_stale_at_slot` (v16.rs ~7558):
 *
 *     stale_account_count_long != 0
 *       || stale_account_count_short != 0
 *       || (asset has exposure && asset.slot_last < header.current_slot)
 *
 *   Every accrual that moves K or F for a side runs
 *   `kernel_mark_kf_stale_cohorts`, which sets
 *   `stale_account_count_<side> = stored_pos_count_<side>`. The count only goes
 *   back down as each positioned portfolio is refreshed. The keeper's
 *   observation crank accrues the market through the LP portfolio, so after it
 *   lands every other positioned portfolio (and the LP itself) is stale, the
 *   market reads `loss_stale_active = 1`, and risk-increasing trades revert
 *   `Custom(21)` (EngineLockActive) until someone refreshes all of them.
 *
 *   A refresh is a PermissionlessCrank with NO observation. The engine's
 *   planner (`select_auto_crank_plan`, v16.rs ~2269) picks `RefreshAccount`
 *   for a stale account and uses the committed price. The wrapper only accepts
 *   that when nothing is pending for the asset:
 *   `reject_incomplete_asset_health_observation_view` returns
 *   `EngineNonProgress` (Custom(22)) if `dt != 0` and the mark or funding would
 *   still move. So the refreshes have to run in the same transaction as the
 *   accrual, after it, where `dt == 0`. A no-observation crank on an account
 *   that is not stale selects `NoAction` and also returns Custom(22), which
 *   would revert the whole transaction; the cranker prunes such refreshes by
 *   simulating first.
 *
 *   The observation crank is capped at `max_accrual_dt_slots` per call. If the
 *   gap is larger, the wrapper commits a partial accrual and returns early
 *   (`bounded_market_catchup_only`) without refreshing anything, and a
 *   refresh after it fails. So when the market is behind, the plan puts
 *   `floor(gap / max_accrual_dt_slots)` bounded catch-up cranks first.
 */
import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  encodePermissionlessCrank,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  V17_PORTFOLIO_ACCOUNT_LEN,
  parsePortfolioV17,
} from "@percolatorct/sdk";

import { SDK_PORTFOLIO_LENS, describeUnknownLayout, detectLayout, engineSlotBase, layoutById } from "./market-layout.ts";
import type { MarketLayout } from "./market-layout.ts";
import { buildLivenessRepairIx } from "./liveness-repair.ts";
import type { LivenessRepair } from "./liveness-repair.ts";

import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { accrueCrankCuFor, catchupCrankCuFor, maxCatchupCranksFor, observationAssetsFor, observationHints } from "./multi-asset.ts";

/**
 * The asset every single-asset registry market trades. A K-6 multi-asset market observes every asset its registry
 * row lists (multi-asset.ts `observationAssetsFor`); the builders below look that up per market.
 */
export const REFRESH_ASSET_INDEX = 0;

// ── Market account offsets ────────────────────────────────────────────────
// Every offset comes from the layout table in market-layout.ts (group header
// fields relative to the group offset, AssetStateV16Account fields relative to
// the engine slot base). The v2.1 numbers were cross-checked against live
// devnet reads: current_slot equals asset.slot_last right after a crank, and
// loss_stale_active tracks the predicate above.
const LEGACY_LAYOUT = layoutById("v2.1-legacy");

const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;

export interface MarketRefreshState {
  maxAccrualDtSlots: bigint;
  currentSlot: bigint;
  lossStaleActive: boolean;
  lifecycle: number;
  slotLast: bigint;
  kfEpochLong: bigint;
  kfEpochShort: bigint;
  storedPosLong: bigint;
  storedPosShort: bigint;
  staleLong: bigint;
  staleShort: bigint;
  /** asset_contributes_to_loss_stale_summary (v16.rs ~7542). */
  contributesToLossStale: boolean;
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}
function u128(d: Uint8Array, off: number): bigint {
  return u64(d, off) | (u64(d, off + 8) << 64n);
}

/**
 * Decode the refresh inputs with the layout the account length identifies.
 * Throws on an unknown layout (the message names the length and the known
 * strides): the caller must report it, never decode with another layout's offsets.
 */
export function decodeMarketRefreshState(
  data: Uint8Array,
  assetIndex = REFRESH_ASSET_INDEX,
): MarketRefreshState {
  const det = detectLayout(data);
  if (!det.known) throw new Error(`decodeMarketRefreshState: ${describeUnknownLayout(det)}`);
  const L = det.layout;
  if (assetIndex < 0 || assetIndex >= det.slots) {
    throw new Error(`decodeMarketRefreshState: asset ${assetIndex} out of range (${det.slots} slots)`);
  }
  const g = L.groupOff;
  const a = engineSlotBase(L, assetIndex);
  const A = L.asset;
  const lifecycle = data[a + A.lifecycle];
  const storedPosLong = u64(data, a + A.storedPosLong);
  const storedPosShort = u64(data, a + A.storedPosShort);
  const staleLong = u64(data, a + A.staleLong);
  const staleShort = u64(data, a + A.staleShort);
  const contributesToLossStale =
    (lifecycle === LIFECYCLE_ACTIVE || lifecycle === LIFECYCLE_DRAIN_ONLY) &&
    (u128(data, a + A.oiEffLong) !== 0n ||
      u128(data, a + A.oiEffShort) !== 0n ||
      storedPosLong !== 0n ||
      storedPosShort !== 0n ||
      staleLong !== 0n ||
      staleShort !== 0n ||
      u64(data, a + A.pendingOblLong) !== 0n ||
      u64(data, a + A.pendingOblShort) !== 0n ||
      u128(data, a + A.lossWeightSumLong) !== 0n ||
      u128(data, a + A.lossWeightSumShort) !== 0n);
  return {
    maxAccrualDtSlots: u64(data, g + L.header.maxAccrualDtSlots),
    currentSlot: u64(data, g + L.header.currentSlot),
    lossStaleActive: data[g + L.header.lossStaleActive] !== 0,
    lifecycle,
    slotLast: u64(data, a + A.slotLast),
    kfEpochLong: u64(data, a + A.kfEpochLong),
    kfEpochShort: u64(data, a + A.kfEpochShort),
    storedPosLong,
    storedPosShort,
    staleLong,
    staleShort,
    contributesToLossStale,
  };
}

/** Absolute byte offsets of stale_account_count_long/short for `assetIndex` (tests patch these). */
export function staleCountOffsets(
  assetIndex = REFRESH_ASSET_INDEX,
  layout: MarketLayout = LEGACY_LAYOUT,
): { long: number; short: number } {
  const a = engineSlotBase(layout, assetIndex);
  return { long: a + layout.asset.staleLong, short: a + layout.asset.staleShort };
}

/** Mirror of `asset_is_loss_stale_at_slot(asset, header.current_slot)`. */
export function isAssetLossStale(s: MarketRefreshState): boolean {
  return (
    s.staleLong !== 0n ||
    s.staleShort !== 0n ||
    (s.contributesToLossStale && s.slotLast < s.currentSlot)
  );
}

/** True when the market has any stored position, i.e. an accrual can re-stale someone. */
export function marketHasPositions(s: MarketRefreshState): boolean {
  return s.storedPosLong !== 0n || s.storedPosShort !== 0n;
}

/** One active leg as the margin screen needs it (F1, v22/liquidation.ts). */
export interface RiskLeg {
  assetIndex: number;
  /** 0 = long, 1 = short */
  side: number;
  basis: bigint;
  aBasis: bigint;
}
/** Settled equity (capital + pnl + fee_credits) and the active legs of a portfolio, as of the account bytes read. */
export interface RiskSnap {
  equity: bigint;
  legs: RiskLeg[];
}

/** Snapshot of a decoded portfolio for the margin screen. Pure. */
export function riskSnapOf(parsed: { capital: bigint; pnl: bigint; feeCredits: bigint; legs: ReadonlyArray<{ active: boolean; assetIndex: number; side: number; basisPosQ: bigint; aBasis: bigint }> }): RiskSnap {
  return {
    equity: parsed.capital + parsed.pnl + parsed.feeCredits,
    legs: parsed.legs.filter((l) => l.active).map((l) => ({ assetIndex: l.assetIndex, side: l.side, basis: l.basisPosQ, aBasis: l.aBasis })),
  };
}

export interface PositionedPortfolio {
  pubkey: PublicKey;
  longLegs: number;
  shortLegs: number;
  isLp: boolean;
  /**
   * ALL active legs of the portfolio, on every asset (absent on hand-built entries: then the on-asset count is
   * used). A refresh settles every leg of the account, so its compute depends on this number, not on the legs
   * held on the one asset being cranked (v2.2 caps it at V22_POSITION_CAP).
   */
  activeLegs?: number;
  /** Sum of `loss_weight` over the active legs on the asset (sweep ordering; absent on hand-built entries). */
  lossWeight?: bigint;
  /** Lowest `kf_epoch_snap` of the active long / short legs on the asset (null: no leg on that side). */
  kfEpochSnapLong?: bigint | null;
  kfEpochSnapShort?: bigint | null;
  /** F1: settled equity and legs for the liquidation screen (absent on hand-built entries: never a candidate). */
  risk?: RiskSnap;
  /** F1: extra plan weight of a liquidation candidate (its liquidation crank); absent / 0 = not a candidate. */
  liqWeight?: number;
}

/**
 * Portfolios of this market that hold an active leg on `assetIndex`. Accounts
 * that are not full-size portfolios, or do not decode, are skipped. A leg is
 * counted by its side (0 = long, 1 = short), which is how
 * `stored_pos_count_<side>` counts it.
 *
 * K-6: `assetIndex` may be a LIST (a multi-asset market's observed assets): a portfolio is then positioned when it
 * holds a leg on ANY of them, and its long / short counts are summed over them (matching the summed
 * `stored_pos_count` of `decodeMarketRefreshStateFor`). A single number is the pre-K-6 behaviour.
 */
export function selectPositionedPortfolios(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  assetIndex: number | ReadonlyArray<number> = REFRESH_ASSET_INDEX,
): PositionedPortfolio[] {
  const onAsset: (a: number) => boolean = typeof assetIndex === "number" ? (a) => a === assetIndex : (a) => assetIndex.includes(a);
  const out: PositionedPortfolio[] = [];
  for (const { pubkey, data } of accounts) {
    if (!SDK_PORTFOLIO_LENS.has(data.length)) continue;
    let parsed;
    try {
      parsed = parsePortfolioV17(data);
    } catch {
      continue;
    }
    let longLegs = 0;
    let shortLegs = 0;
    let lossWeight = 0n;
    let kfEpochSnapLong: bigint | null = null;
    let kfEpochSnapShort: bigint | null = null;
    let activeLegs = 0;
    for (const leg of parsed.legs) {
      if (leg.active) activeLegs++;
      if (!leg.active || !onAsset(leg.assetIndex)) continue;
      lossWeight += leg.lossWeight;
      if (leg.side === 0) {
        longLegs++;
        kfEpochSnapLong = kfEpochSnapLong === null || leg.kfEpochSnap < kfEpochSnapLong ? leg.kfEpochSnap : kfEpochSnapLong;
      } else {
        shortLegs++;
        kfEpochSnapShort = kfEpochSnapShort === null || leg.kfEpochSnap < kfEpochSnapShort ? leg.kfEpochSnap : kfEpochSnapShort;
      }
    }
    if (longLegs + shortLegs === 0) continue;
    out.push({ pubkey, longLegs, shortLegs, isLp: parsed.matcherEnabled === true, activeLegs, lossWeight, kfEpochSnapLong, kfEpochSnapShort });
  }
  return out;
}

/**
 * True when the cached positioned set accounts for exactly the market's
 * stored positions. A mismatch means someone opened or closed a position
 * since discovery, so the set must be re-read before it is used.
 */
export function positionedSetMatchesMarket(
  set: ReadonlyArray<PositionedPortfolio>,
  s: MarketRefreshState,
): boolean {
  let longs = 0n;
  let shorts = 0n;
  for (const p of set) {
    longs += BigInt(p.longLegs);
    shorts += BigInt(p.shortLegs);
  }
  return longs === s.storedPosLong && shorts === s.storedPosShort;
}

/**
 * Observation crank (accrues asset 0 from the committed AUTH_MARK mark). K-6: on a multi-asset registry market it
 * carries one hint per observed asset (`observationAssetsFor`), so every asset accrues in this instruction; on every
 * other market the hint list is `[{asset 0}]`, byte-identical to before.
 */
export function buildObservationCrankIx(
  owner: PublicKey,
  market: PublicKey,
  portfolio: PublicKey,
  /**
   * The asset's oracle leg accounts (read-only, after the base accounts) and the hint count. EMPTY by default, which
   * is the AUTH_MARK form every v1 / v2.1 caller uses and is byte-identical to before. A Hybrid market needs its
   * legs: without them the wrapper answers NotEnoughAccountKeys (security review F-3).
   */
  oracleAccounts: ReadonlyArray<PublicKey> = [],
): TransactionInstruction {
  return buildPermissionlessCrankIx(owner, market, portfolio, true, oracleAccounts);
}

/** No-observation crank: refreshes a stale portfolio from committed state. */
export function buildRefreshCrankIx(
  owner: PublicKey,
  market: PublicKey,
  portfolio: PublicKey,
): TransactionInstruction {
  return buildPermissionlessCrankIx(owner, market, portfolio, false);
}

function buildPermissionlessCrankIx(
  owner: PublicKey,
  market: PublicKey,
  portfolio: PublicKey,
  withObservation: boolean,
  oracleAccounts: ReadonlyArray<PublicKey> = [],
): TransactionInstruction {
  const keys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, { owner, market, portfolio });
  if (withObservation) for (const a of oracleAccounts) keys.push({ pubkey: a, isSigner: false, isWritable: false });
  const data = encodePermissionlessCrank({
    nowSlot: 0n, // wrapper authenticates against Clock::get()
    observations: withObservation ? observationHints(observationAssetsFor(market.toBase58()), oracleAccounts.length) : [],
  });
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys,
    data: data as unknown as Buffer,
  });
}

// ── Transaction plan ──────────────────────────────────────────────────────

/**
 * Per-crank CU estimates used to size the accrual transaction.
 *
 * Re-measured on devnet 2026-10-04 (wrapper 7c906e45 / engine 35ddd692), from
 * landed keeper cranks: catch-up ~27.5k; full accrual ~61k when the mark has
 * not moved, but 120k-162.6k right after a mark move (OTC 157k on every
 * up-tick, Jimothy 162.6k, backpack 152.4k); refresh 92k-153k (OTC trader
 * Haf5hMma 108k-151k). The old accrual estimate (150k) was BELOW the
 * post-move peak, so an accrual-only plan exhausted its budget and reverted
 * ProgramFailedToComplete (OTC streaks, 2026-10-03/04). See
 * ACCRUAL_TX_CU_HEADROOM for the per-transaction margin on top.
 *
 * REFRESH_CRANK_CU 130k -> 145k (wrapper #523 / engine #275, the #175 Earn-drain
 * fix "E1"): a refresh that fully nets a leg's loss now books the netted support
 * into the loss domain (one extra backing add + recompute), measured on the
 * swordcat/backpack live replays at up to +10.9k per refresh. Worst refresh is
 * then ~153k + 11k = 164k. At 130k x 8 the packed plan's limit (1.34M) is below
 * the worst 8-refresh cycle (163k + 8 x 164k = 1.475M, above even the 1.4M
 * re-sim), so the last refresh is pruned; at 145k x 7 the planned limit
 * (200k + 7 x 145k + 100k = 1.315M) covers the worst 7-refresh cycle
 * (163k + 7 x 164k = 1.311M) with no boost. Capacity: 7 refreshes beside the
 * accrual (an 8th positioned portfolio goes to a follow-up tx).
 */
export const CATCHUP_CRANK_CU = 30_000;
export const ACCRUE_CRANK_CU = 200_000;
export const REFRESH_CRANK_CU = 145_000;
export const MAX_TX_CU = 1_400_000;
/**
 * Extra CU on every accrual transaction, reserved before packing refreshes.
 * Refresh estimates are averages (an LP refresh ~92-110k, a trader refresh
 * up to ~153k): a plan with few refreshes has no averaging slack, so a
 * 2-refresh OTC plan sized at exactly the sum of estimates (410k) ran out at
 * 162k + 151k + 110k = 423k. The headroom absorbs that per-transaction
 * variance and the sim-to-land race (an accrual simulated before a push
 * lands at ~61k but executes after it at ~157k). It costs at most one
 * refresh of capacity: 7 refreshes fit beside the accrual (REFRESH_CRANK_CU 145k).
 */
export const ACCRUAL_TX_CU_HEADROOM = 100_000;
/** ExpireBackingBucket / FinalizeResetSide: one market-only state transition each (well under 40k CU). */
export const REPAIR_CU = 40_000;
/** Measured on devnet (ANSEM, 2026-09-29): liquidating a bankrupt leg ~200k CU. */
export const LIQUIDATE_CRANK_CU = 250_000;

// ── Leg-aware sizing (v2.2: at most V22_POSITION_CAP legs per account) ─────────────────────────────────────────
//
// Everything above is SINGLE-LEG sizing: a v2.1 account holds one leg on a single-asset market, and that is what
// 145k / 250k / seven-per-tx were measured on. v2.2 lets an account hold up to V22_POSITION_CAP (4) legs, and a
// refresh / liquidation settles EVERY leg. The numbers below are the release candidate's own measurements
// (ledger v22-combination-2026-10-08.md, cu-per-tag-fold-final.txt, reviewer round 2 of the liquidation-cap
// review, engine release/v22-engine-rem bfa3d037 + wrapper release/v22-wrapper-rem c6ee0b6e):
//
//   typical refresh, n legs      35,000 x (3 + n): 175k / 210k / 245k at 2 / 3 / 4 legs (the Wave A "A6" weight; A6 = 4 cap-leg
//                                refreshes + tag 77 = 1,005,351 CU, 3 x cap-leg liquidating 934,336, 2 x cap + 3 x 1-leg mix 932,383)
//   worst settle shape, 4 legs   1,013,864 CU (2n-domain reversal + real liens + a real ADL event, #287 hook included;
//                                852,932 without liens/ADL). Per extra leg the reviewer measured about +176k (5 legs 1,184,471,
//                                6 legs 1,360,918 before the hook), which is how the 3-leg figure (838k) is EXTRAPOLATED, not measured
//   liquidation crank, 4 legs    455k plain, 728,649 worst (genuine pending K loss); 1 leg 250k as before; linear between
//
// A 4-leg account's worst settle (1.01M) plus an accrual or a second account does not fit the 1.4M transaction cap
// with any margin, so an account with V22_SOLO_MIN_LEGS or more legs is planned ALONE in its own transaction (the
// wrapper treats 3+ legs as heavy for the same reason: WRAPPER_PRE_CRANK_MIN_LEGS = 3). Fewer legs are packed by the
// typical figure and fail closed (simulation, then a smaller transaction) if a bad shape overruns.
//
// The model is OPT-IN: every planner takes an optional `LegCostModel` and, without one, computes exactly what it
// always did. Only a v2.2 layout selects it (`legCostModelFor`), so the v2.1 numbers cannot move.

/** `WRAPPER_MAX_PORTFOLIO_ASSETS` of the release candidate (final: founder decision 2026-10-08). The SDK mirrors it as WRAPPER_BATCH_MAX_LEGS = min(11, cap); a test pins the two together. */
export const V22_POSITION_CAP = 4;
/** `WRAPPER_PRE_CRANK_MIN_LEGS`: an account with this many legs or more is heavy; the keeper plans it alone. */
export const V22_SOLO_MIN_LEGS = 3;
/** CU per weight unit of a refresh (3 + legs), measured from Wave A (8 single-leg 1,016,434; 2 x 14-leg 1,199,659). */
export const V22_CU_PER_WEIGHT = 35_000;
/** Worst measured settle of a cap-leg (4) account: liens + ADL, with the real #287 hook. */
export const V22_WORST_SETTLE_CU_AT_CAP = 1_013_864;
/** Reviewer-measured growth of the worst settle per extra leg. */
export const V22_WORST_SETTLE_CU_PER_LEG = 176_000;
/** Worst measured liquidation crank of a cap-leg account (x1_seed_pending_loss_long, peak settle). */
export const V22_LIQUIDATE_CU_AT_CAP = 728_649;

export interface LegCostModel {
  readonly id: string;
  /** Active legs a refresh of `p` settles: the whole portfolio, never fewer than the legs on the asset. */
  legs(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">): number;
  /** Typical refresh CU of `p`; `baseCu` is the single-leg figure of the calling planner (145k legacy, 114k sweep). */
  refreshCu(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">, baseCu: number): number;
  /** Liquidation crank CU of `p`; `baseCu` is the single-leg figure (250k). */
  liquidateCu(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">, baseCu: number): number;
  /** Worst measured / extrapolated settle of `p`: what its own transaction must be able to absorb. */
  worstRefreshCu(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">): number;
  /** True when `p` is planned alone in its transaction. */
  isSolo(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">): boolean;
}

type LegCountable = Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">;
const legsOf = (p: LegCountable): number => Math.max(p.activeLegs ?? 0, p.longLegs + p.shortLegs);
const typicalRefreshCu = (p: LegCountable, baseCu: number): number => {
  const n = legsOf(p);
  return n <= 1 ? baseCu : Math.max(baseCu, V22_CU_PER_WEIGHT * (3 + n));
};

export const V22_LEG_COST: LegCostModel = {
  id: "v2.2-leg-cap-4",
  legs: legsOf,
  refreshCu: typicalRefreshCu,
  liquidateCu(p, baseCu) {
    const n = legsOf(p);
    if (n <= 1) return baseCu;
    const slope = (V22_LIQUIDATE_CU_AT_CAP - baseCu) / (V22_POSITION_CAP - 1);
    return Math.max(baseCu, Math.ceil((baseCu + slope * (n - 1)) / 1_000) * 1_000);
  },
  worstRefreshCu(p) {
    const n = Math.max(1, legsOf(p));
    const worst = V22_WORST_SETTLE_CU_AT_CAP - (V22_POSITION_CAP - n) * V22_WORST_SETTLE_CU_PER_LEG;
    return Math.max(typicalRefreshCu(p, REFRESH_CRANK_CU), worst);
  },
  isSolo: (p) => legsOf(p) >= V22_SOLO_MIN_LEGS,
};

/**
 * The sizing a market's layout selects: the leg-aware model on a v2.2 layout, `undefined` (the exact single-leg
 * arithmetic) on every v2.1 layout and on an unknown one.
 */
export function legCostModelFor(layout: Pick<MarketLayout, "id" | "wrapperVersion"> | null | undefined): LegCostModel | undefined {
  if (!layout) return undefined;
  return layout.id === "v2.2-b" || layout.id === "v2.2-drift" ? V22_LEG_COST : undefined;
}

/**
 * CU limit of a transaction that carries ONE solo account: an accrual (when it has one) plus the account's worst
 * settle plus headroom, under the 1.4M cap. A 4-leg account: 200k + 1,013,864 + 100k = 1,313,864.
 */
export function soloTxComputeUnits(model: LegCostModel, p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">, opts: { accrueCu?: number; headroomCu?: number } = {}): number {
  const accrue = opts.accrueCu ?? 0;
  const headroom = opts.headroomCu ?? ACCRUAL_TX_CU_HEADROOM;
  return Math.min(MAX_TX_CU, accrue + model.worstRefreshCu(p) + headroom);
}

/**
 * True when a (post-refresh) portfolio holds an active leg and its equity
 * `capital + pnl` is not positive — bankrupt. The refresh crank alone only
 * re-certifies such an account; the keeper's next accrual re-stales it, so
 * without a second crank in the SAME transaction the engine never reaches its
 * Liquidate step and the loss keeps growing against the counterparty backing
 * (ANSEM `DcVGSEfZ`, 2026-09-29: capital 0, PnL -88M -> -223M in ~2h while
 * the Earn vault's backing was consumed).
 */
export function isBankruptPortfolio(data: Uint8Array): boolean {
  try {
    const p = parsePortfolioV17(data);
    return p.activeBitmap !== 0n && !p.matcherEnabled && p.capital + p.pnl <= 0n;
  } catch {
    return false;
  }
}
/**
 * Most catch-up cranks that still leave room for the accrual + refreshes.
 * A market further behind gets a catch-up-only transaction this cycle: a
 * refresh cannot clear loss-stale while `slot_last < current_slot` anyway.
 */
export const MAX_CATCHUP_WITH_REFRESH = 10;
/** Catch-up-only transaction size (40 x ~19 bytes + ~270 fixed fits 1232 bytes; 40 x 30k CU fits 1.4M). */
export const MAX_CATCHUP_CRANKS = 40;

export type PlannedCrankKind = "repair" | "catchup" | "accrue" | "refresh" | "liquidate";

export interface PlannedCrank {
  kind: PlannedCrankKind;
  /** The crank's target portfolio; for a "repair" (market-only instruction) the market itself. */
  portfolio: PublicKey;
  ix: TransactionInstruction;
  /** Set on "repair" entries: which liveness repair this is. */
  repair?: LivenessRepair;
}

export interface CrankPlan {
  cranks: PlannedCrank[];
  /**
   * Refreshes that did not fit this transaction's CU budget. The cranker sends
   * them as follow-up transactions (`planOverflowRefreshTxs`) in the same price
   * window, so every positioned portfolio is refreshed each cohort.
   */
  overflow: PositionedPortfolio[];
  computeUnits: number;
}

/**
 * Number of bounded catch-up cranks to put before the full accrual. Each one
 * advances `slot_last` by exactly `maxDt` and returns early; the crank after
 * them sees a gap below `maxDt`, accrues to `now`, and runs the engine
 * dispatch, so the refreshes behind it see `dt == 0`. The count is computed
 * from the slot the market was read at; if the chain crosses another
 * multiple of `maxDt` before the transaction lands, the pre-simulation or the
 * landing fails cleanly and the next cycle recomputes it.
 */
export function catchupCrankCount(gap: bigint, maxDt: bigint): number {
  if (maxDt <= 0n || gap <= 0n) return 0;
  const n = gap / maxDt;
  return Number(n > BigInt(MAX_CATCHUP_CRANKS) ? BigInt(MAX_CATCHUP_CRANKS) : n);
}

/** True when this cycle's catch-up leaves room to accrue and refresh in the same transaction. */
export function catchupAllowsRefresh(catchup: number): boolean {
  return catchup <= MAX_CATCHUP_WITH_REFRESH;
}

/**
 * Build the per-market crank sequence:
 *   [catch-up x n] -> accrue(LP, observation) -> refresh(p) for each positioned p
 * Non-LP portfolios are refreshed first and the LP last: the LP is re-staled by
 * its own accrual, and this is the order measured end-to-end on devnet.
 * `refreshTargets` should already exclude portfolios pruned by simulation.
 */
export function planCrankTx(params: {
  owner: PublicKey;
  market: PublicKey;
  lpPortfolio: PublicKey;
  catchup: number;
  refreshTargets: ReadonlyArray<PositionedPortfolio>;
  /** Liveness repairs (liveness-repair.ts) to land BEFORE any crank this cycle. */
  repairs?: ReadonlyArray<LivenessRepair>;
  /**
   * Positioned portfolios found bankrupt after their refresh (see
   * `isBankruptPortfolio`): each gets a SECOND no-observation crank right after
   * its refresh, which the engine's auto-crank planner resolves to
   * `AutoCrankPlanV16::Liquidate` once the account is current.
   */
  liquidateTargets?: ReadonlyArray<PublicKey>;
  /**
   * Leg-aware sizing (v2.2; see `legCostModelFor`). Omitted = the single-leg arithmetic, unchanged. With a model a
   * solo (3+ leg) target is never packed beside the accrual: it goes to `overflow`, where `chunkOverflowTargets`
   * gives it its own transaction, and each other target costs `refreshCu` for its leg count.
   */
  cost?: LegCostModel;
  /** The LP's positioned entry (leg count): the accrual crank settles it, so a heavy LP is the accrual's cost. */
  lp?: PositionedPortfolio | null;
}): CrankPlan {
  const { owner, market, lpPortfolio, catchup, refreshTargets } = params;
  const cost = params.cost;
  const repairs = params.repairs ?? [];
  const cranks: PlannedCrank[] = repairs.map((r) => ({
    kind: "repair" as const,
    portfolio: market,
    ix: buildLivenessRepairIx(market, r),
    repair: r,
  }));
  const repairCu = repairs.length * REPAIR_CU;
  // K-6: a multi-asset market's observation cranks carry one hint per asset and cost more; single-asset: hints = 1,
  // every figure below is the pre-K-6 one.
  const hints = observationAssetsFor(market.toBase58()).length;
  const catchupCu = catchupCrankCuFor(CATCHUP_CRANK_CU, hints);
  const catchupN = hints <= 1 ? catchup : Math.min(catchup, maxCatchupCranksFor(MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, hints, MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM - repairCu));
  for (let i = 0; i < catchupN; i++) {
    cranks.push({ kind: "catchup", portfolio: lpPortfolio, ix: buildObservationCrankIx(owner, market, lpPortfolio) });
  }
  // The observation crank settles the LP it targets: a heavy LP (3+ legs) makes the accrual itself the big crank.
  const accrueCu = accrueCrankCuFor(cost && params.lp && cost.isSolo(params.lp) ? cost.worstRefreshCu(params.lp) : ACCRUE_CRANK_CU, hints);
  // K-6 (multi-asset only): the catch-up and the accrual must fit one transaction, else catch up first.
  const multiTooBig = hints > 1 && catchupN > 0 && repairCu + catchupN * catchupCu + accrueCu > MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM;
  if (!catchupAllowsRefresh(catchup) || catchupN < catchup || multiTooBig) {
    // Too far behind to finish this cycle: catch-up cranks only.
    return {
      cranks,
      overflow: [],
      computeUnits: Math.min(MAX_TX_CU, repairCu + catchupN * catchupCu + ACCRUAL_TX_CU_HEADROOM),
    };
  }
  cranks.push({ kind: "accrue", portfolio: lpPortfolio, ix: buildObservationCrankIx(owner, market, lpPortfolio) });
  let cu = repairCu + catchupN * catchupCu + accrueCu;
  /** Packing ceiling: the headroom is reserved, never spent on another refresh. */
  const packCap = MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM;

  const ordered = [...refreshTargets].sort((x, y) => Number(x.isLp) - Number(y.isLp));
  const overflow: PositionedPortfolio[] = [];
  for (const p of ordered) {
    const refreshCu = cost ? cost.refreshCu(p, REFRESH_CRANK_CU) : REFRESH_CRANK_CU;
    if ((cost && cost.isSolo(p)) || cu + refreshCu > packCap) {
      overflow.push(p);
      continue;
    }
    cranks.push({ kind: "refresh", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
    cu += refreshCu;
    const liquidateCu = cost ? cost.liquidateCu(p, LIQUIDATE_CRANK_CU) : LIQUIDATE_CRANK_CU;
    if (!p.isLp && (params.liquidateTargets ?? []).some((t) => t.equals(p.pubkey)) && cu + liquidateCu <= packCap) {
      cranks.push({ kind: "liquidate", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
      cu += liquidateCu;
    }
  }
  return { cranks, overflow, computeUnits: Math.min(MAX_TX_CU, cu + ACCRUAL_TX_CU_HEADROOM) };
}

// ── Overflow refreshes (follow-up transactions) ──────────────────────────

/**
 * Refresh-only transaction for `targets`: one no-observation crank per target,
 * plus a second (liquidate) crank right after each non-LP target listed in
 * `liquidateTargets`. Used for the refreshes that did not fit the accrual
 * transaction. It must land after the accrual and before the market's next
 * price push (see refresh-coordination.ts): a no-observation crank is only
 * accepted while the committed mark has not moved since the accrual.
 * The caller sizes `targets` with `chunkOverflowTargets`, so this fits MAX_TX_CU.
 */
export function planRefreshTx(params: {
  owner: PublicKey;
  market: PublicKey;
  targets: ReadonlyArray<PositionedPortfolio>;
  liquidateTargets?: ReadonlyArray<PublicKey>;
  /** Leg-aware sizing (v2.2); omitted = the single-leg arithmetic, unchanged. */
  cost?: LegCostModel;
}): CrankPlan {
  const { owner, market, targets } = params;
  const cost = params.cost;
  const liq = params.liquidateTargets ?? [];
  const cranks: PlannedCrank[] = [];
  let cu = 0;
  /** Largest worst-case settle among solo targets in this transaction: its limit must absorb it. */
  let soloWorst = 0;
  for (const p of targets) {
    cranks.push({ kind: "refresh", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
    cu += cost ? cost.refreshCu(p, REFRESH_CRANK_CU) : REFRESH_CRANK_CU;
    if (cost && cost.isSolo(p)) soloWorst = Math.max(soloWorst, cost.worstRefreshCu(p));
    const liquidateCu = cost ? cost.liquidateCu(p, LIQUIDATE_CRANK_CU) : LIQUIDATE_CRANK_CU;
    if (!p.isLp && liq.some((t) => t.equals(p.pubkey)) && cu + liquidateCu <= MAX_TX_CU) {
      cranks.push({ kind: "liquidate", portfolio: p.pubkey, ix: buildRefreshCrankIx(owner, market, p.pubkey) });
      cu += liquidateCu;
    }
  }
  // The accrual tx's 1.4M budget absorbs per-refresh variance across 7 refreshes;
  // a short follow-up has no such slack (live 2026-10-02: a lone LP refresh hit
  // ComputationalBudgetExceeded at 130k), so it gets explicit headroom.
  return { cranks, overflow: [], computeUnits: cranks.length === 0 ? 0 : Math.min(MAX_TX_CU, Math.max(cu, soloWorst) + FOLLOWUP_CU_HEADROOM) };
}

/** Extra CU on every follow-up refresh tx (see planRefreshTx). */
export const FOLLOWUP_CU_HEADROOM = 200_000;

/** Refreshes per follow-up transaction: the CU cap, leaving room for one liquidation. */
export const REFRESHES_PER_OVERFLOW_TX = Math.floor((MAX_TX_CU - LIQUIDATE_CRANK_CU) / REFRESH_CRANK_CU);

/**
 * Split the overflow into follow-up transaction groups, in order. Every target
 * appears in exactly one group; each group fits MAX_TX_CU even with one
 * liquidation added (more liquidations than that are skipped by
 * `planRefreshTx`'s CU check and caught by the next cycle).
 */
export function chunkOverflowTargets(
  overflow: ReadonlyArray<PositionedPortfolio>,
  perTx: number = REFRESHES_PER_OVERFLOW_TX,
  /**
   * Leg-aware sizing (v2.2). Groups are then filled by each target's refresh CU (reserving the heaviest
   * liquidation among the group's members) and a solo target (3+ legs) is ALWAYS a group of its own; `perTx` is
   * not used. For single-leg targets this packs exactly `REFRESHES_PER_OVERFLOW_TX` per group, as before.
   */
  cost?: LegCostModel,
): PositionedPortfolio[][] {
  const out: PositionedPortfolio[][] = [];
  if (cost) {
    let group: PositionedPortfolio[] = [];
    let sum = 0;
    let maxLiq = 0;
    const flush = (): void => {
      if (group.length > 0) out.push(group);
      group = [];
      sum = 0;
      maxLiq = 0;
    };
    for (const p of overflow) {
      if (cost.isSolo(p)) {
        flush();
        out.push([p]);
        continue;
      }
      const rcu = cost.refreshCu(p, REFRESH_CRANK_CU);
      const lcu = Math.max(maxLiq, cost.liquidateCu(p, LIQUIDATE_CRANK_CU));
      if (group.length > 0 && sum + rcu + lcu > MAX_TX_CU) flush();
      group.push(p);
      sum += rcu;
      maxLiq = Math.max(maxLiq, cost.liquidateCu(p, LIQUIDATE_CRANK_CU));
    }
    flush();
    return out;
  }
  const n = Math.max(1, Math.floor(perTx));
  for (let i = 0; i < overflow.length; i += n) out.push(overflow.slice(i, i + n));
  return out;
}

/**
 * True when a simulation/transaction failed because an instruction ran out of
 * compute: the runtime reports a BPF program that hits its CU meter as
 * `ProgramFailedToComplete` (log: "exceeded CUs meter at BPF instruction"),
 * and older runtimes as `ComputationalBudgetExceeded`. Neither is an engine
 * verdict on the instruction, so the cranker must not treat it as "the engine
 * rejected this refresh". `ProgramFailedToComplete` without logs is treated
 * as exhaustion too: the only response is one re-simulation at a larger
 * budget, which a genuine panic simply fails again.
 */
export function isComputeExhaustion(err: unknown, logs?: ReadonlyArray<string> | null): boolean {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return false;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(ie)) return false;
  if (ie[1] === "ComputationalBudgetExceeded") return true;
  if (ie[1] !== "ProgramFailedToComplete") return false;
  if (!logs || logs.length === 0) return true;
  return logs.some((l) => /exceeded CUs meter|exceeded maximum compute|computational budget exceeded/i.test(l));
}

/**
 * Parse `{"InstructionError":[idx,{"Custom":n}]}` from a simulation error.
 * Returns the instruction index (in the full transaction, compute-budget ix
 * included) and the custom code, if present.
 */
export function parseInstructionError(err: unknown): { index: number; custom: number | null } | null {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return null;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(ie) || typeof ie[0] !== "number") return null;
  const detail = ie[1];
  let custom: number | null = null;
  if (detail && typeof detail === "object" && "Custom" in detail) {
    const c = (detail as { Custom: unknown }).Custom;
    if (typeof c === "number") custom = c;
  }
  return { index: ie[0], custom };
}
