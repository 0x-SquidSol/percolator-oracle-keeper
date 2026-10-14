/**
 * cross-cluster/v22/liquidation.ts   (flag KEEPER_V22_LIQUIDATE)
 *
 * F1 (ledger v22-market-simulations-2026-10-14.md section 3): on an OFF-BAND v2.2 market the engine liquidates an underwater
 * account only on a SECOND no-observation crank on that account in the SAME transaction as its refresh
 * (`[accrue, refresh T, crank T]`). A second crank in a later transaction returns Custom(22), and the sweep sent one crank per
 * portfolio, so positions walked to bankruptcy and latched the bankruptcy h-lock. This module is the PURE half of the keeper fix:
 * the margin arithmetic that finds accounts at or below maintenance, and the tx-budget arithmetic that decides how many
 * liquidation cranks one sweep tx may carry. sweep.ts owns the tx shape and the simulate-first / fall-back behaviour.
 *
 * TWO STAGES (neither sends anything):
 *   A. PLAN TIME, from account bytes the keeper already read: an account whose last settled equity is within `padBps` of
 *      its maintenance requirement (price moves between rounds, so the pad is generous) is a CANDIDATE. A candidate weighs
 *      more in the round plan (`liqExtraWeight`), so the planner splits txs (each with its own accrue crank) to make room.
 *   B. SEND TIME, from the simulation of the plain tx: the simulation returns the post-refresh state of the candidates and
 *      the market, so the margin is measured exactly at the post-accrual price. Only accounts at or below maintenance there get
 *      a liquidation crank, appended right after their refresh, and the extended tx is simulated again before it is sent.
 *
 * MARGIN (the sim's validated formula, `sim/market.ts` keeperSweep): equity = capital + pnl + fee_credits;
 * notional = sum over legs of |basis * A_side / a_basis| * effective_price / POS_SCALE; requirement =
 * max(notional * maintenance_margin_bps / 10_000, min_nonzero_mm_req). Positive pnl is counted in full (the engine may haircut
 * unmatured pnl), which can only UNDER-flag; the pad and the simulation cover that: a liquidation crank on a healthy account
 * costs one pruned simulation (Custom(22)), a missed one costs the market. The engine is the authority; this is a screen.
 */
import { Transaction } from "@solana/web3.js";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { LIQUIDATE_CRANK_CU, V22_CU_PER_WEIGHT, V22_LEG_COST } from "../positioned-refresh.ts";
import type { PositionedPortfolio, RiskSnap } from "../positioned-refresh.ts";
import { engineSlotBase } from "../market-layout.ts";
import type { MarketLayout } from "../market-layout.ts";

/** Engine POS_SCALE (position units per token): sim/engine-offsets.json, verified against live v2.2 accounts. */
export const POS_SCALE = 1_000_000n;
/** Offsets relative to the group base (`layout.groupOff`) of the variant-B `V16ConfigAccount` (packed: u16, u32, u128, u128, u64 x 2, ...). */
export const V22_MARGIN_CFG_OFF = { minNonzeroMmReq: 38, maintenanceMarginBps: 86 } as const;
/** Offsets relative to the engine slot base: `a_long`, `a_short` (u128 each) of AssetStateV16Account; `effective_price` is in market-layout. */
export const V22_ASSET_A_OFF = { aLong: 49, aShort: 65 } as const;

/** Most liquidation cranks one sweep tx carries (the 1.4M CU and 1,232 B limits bound it further). */
export const DEFAULT_LIQ_MAX_PER_TX = 4;
/** Stage A pad: a candidate is within this many bps of NOTIONAL above its maintenance requirement (default 5 points of notional). */
export const DEFAULT_LIQ_PAD_BPS = 500;
/**
 * Stage B pad (exact post-refresh measure): 0 = at or below the requirement. Measured in the sim harness (crashHL-SMFL, keeper shape):
 * a pad of 10 bps of notional already costs 33 wasted extra simulations (an account that a partial liquidation left at exactly
 * maintenance keeps measuring "at") and a pad of 100 bps costs 70, with no extra liquidation; pad 0 costs none and the market survives.
 */
export const DEFAULT_LIQ_EXACT_PAD_BPS = 0;
/** Solana's packet limit. */
export const MAX_TX_BYTES = 1_232;
/** Compute headroom left under the 1.4M cap (same as weightBudgetFor). */
export const LIQ_TX_HEADROOM_CU = 60_000;
export const LIQ_TX_MAX_CU = 1_400_000;
export const LIQ_ACCRUE_CU = 200_000;

export const SANE_MMR_BPS_MAX = 5_000n;

export interface AssetMarginParams {
  priceE6: bigint;
  aLong: bigint;
  aShort: bigint;
}
export interface MarginParams {
  mmrBps: bigint;
  minNonzeroMmReq: bigint;
  /** by asset index */
  assets: ReadonlyMap<number, AssetMarginParams>;
}

function dv(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}
const rd64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);
const rd128 = (d: Uint8Array, o: number): bigint => rd64(d, o) | (rd64(d, o + 8) << 64n);

/**
 * Read the margin parameters of a variant-B market account (null on any other layout or on a value outside sanity:
 * an unreadable market is never guessed at, the caller simply does not add a liquidation crank). Single-asset markets
 * are the registry norm; every asset slot in the account is read.
 */
export function readMarginParams(data: Uint8Array, layout: MarketLayout, slots: number): MarginParams | null {
  if (layout.id !== "v2.2-b") return null;
  const cfg = layout.groupOff;
  if (data.length < cfg + V22_MARGIN_CFG_OFF.maintenanceMarginBps + 8) return null;
  const mmrBps = rd64(data, cfg + V22_MARGIN_CFG_OFF.maintenanceMarginBps);
  const minNonzeroMmReq = rd128(data, cfg + V22_MARGIN_CFG_OFF.minNonzeroMmReq);
  if (mmrBps <= 0n || mmrBps > SANE_MMR_BPS_MAX) return null;
  const assets = new Map<number, AssetMarginParams>();
  for (let i = 0; i < slots; i++) {
    const e = engineSlotBase(layout, i);
    if (data.length < e + V22_ASSET_A_OFF.aShort + 16) return null;
    const priceE6 = rd64(data, e + layout.asset.effectivePrice);
    const aLong = rd128(data, e + V22_ASSET_A_OFF.aLong);
    const aShort = rd128(data, e + V22_ASSET_A_OFF.aShort);
    assets.set(i, { priceE6, aLong, aShort });
  }
  return { mmrBps, minNonzeroMmReq, assets };
}

export interface MarginState {
  equity: bigint;
  notional: bigint;
  /** maintenance requirement in collateral atoms */
  requirement: bigint;
  /** equity * 10_000 / notional (bps of notional), null with no notional; negative when equity is negative */
  ratioBps: bigint | null;
}

/** Margin of a risk snapshot under `params`. A leg on an asset the market does not carry is ignored. Pure. */
export function marginOf(snap: RiskSnap, params: MarginParams): MarginState {
  let notional = 0n;
  for (const leg of snap.legs) {
    const a = params.assets.get(leg.assetIndex);
    if (!a || a.priceE6 <= 0n) continue;
    const abs = leg.basis < 0n ? -leg.basis : leg.basis;
    const side = leg.side === 0 ? a.aLong : a.aShort;
    const eff = leg.aBasis > 0n ? (abs * side) / leg.aBasis : abs;
    notional += (eff * a.priceE6) / POS_SCALE;
  }
  if (notional === 0n) return { equity: snap.equity, notional, requirement: 0n, ratioBps: null };
  const byBps = (notional * params.mmrBps) / 10_000n;
  const requirement = byBps > params.minNonzeroMmReq ? byBps : params.minNonzeroMmReq;
  return { equity: snap.equity, notional, requirement, ratioBps: (snap.equity * 10_000n) / notional };
}

/** At or below maintenance, with a pad of `padBps` of notional (0 = exactly at or below the requirement). */
export function atOrBelowMaintenance(m: MarginState, padBps: number): boolean {
  if (m.notional === 0n) return false;
  return m.equity <= m.requirement + (m.notional * BigInt(padBps)) / 10_000n;
}

/** Extra plan weight of a liquidation candidate: its liquidation crank in 35k-CU weight units, rounded up. */
export function liqExtraWeight(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">): number {
  return Math.ceil(V22_LEG_COST.liquidateCu(p, LIQUIDATE_CRANK_CU) / V22_CU_PER_WEIGHT);
}

export interface StageAConfig {
  params: MarginParams;
  padBps: number;
}

/**
 * Stage A. Returns the counterparties with `liqWeight` set when they are candidates (copy; the input is untouched) and the
 * candidate keys. The LP is never a candidate: its protection is the protective round, not this path.
 */
export function markLiquidationCandidates(
  counterparties: ReadonlyArray<PositionedPortfolio>,
  cfg: StageAConfig | null,
): { marked: PositionedPortfolio[]; candidates: Map<string, PositionedPortfolio> } {
  const candidates = new Map<string, PositionedPortfolio>();
  if (!cfg) return { marked: [...counterparties], candidates };
  const marked = counterparties.map((p) => {
    if (p.isLp || !p.risk) return p;
    if (!atOrBelowMaintenance(marginOf(p.risk, cfg.params), cfg.padBps)) return p;
    const m = { ...p, liqWeight: liqExtraWeight(p) };
    candidates.set(p.pubkey.toBase58(), m);
    return m;
  });
  return { marked, candidates };
}

export interface FlaggedAccount {
  portfolio: PositionedPortfolio;
  /** margin ratio in bps of notional (lower = worse) */
  ratioBps: bigint;
}

/** Stage B selection input: the accounts measured at or below maintenance after the simulated refresh. */
export interface FitInput {
  flagged: ReadonlyArray<FlaggedAccount>;
  /** estimated CU of the tx WITHOUT any liquidation crank (accrue crank + refreshes) */
  baseCu: number;
  maxPerTx: number;
  maxCu?: number;
}
export interface FitResult {
  chosen: FlaggedAccount[];
  /** at or below maintenance but not fitting this tx (kept for the next round, where Stage A weighs them) */
  deferred: Array<{ account: FlaggedAccount; why: "max-per-tx" | "compute" | "size" }>;
}

/** Worst first (lowest ratio), then take while count and compute fit. Pure; the size bound is applied by `fitSize`. */
export function fitLiquidations(i: FitInput): FitResult {
  const cap = (i.maxCu ?? LIQ_TX_MAX_CU) - LIQ_TX_HEADROOM_CU;
  const order = [...i.flagged].sort((a, b) => (a.ratioBps < b.ratioBps ? -1 : a.ratioBps > b.ratioBps ? 1 : a.portfolio.pubkey.toBase58() < b.portfolio.pubkey.toBase58() ? -1 : 1));
  const chosen: FlaggedAccount[] = [];
  const deferred: FitResult["deferred"] = [];
  let cu = i.baseCu;
  for (const f of order) {
    const add = V22_LEG_COST.liquidateCu(f.portfolio, LIQUIDATE_CRANK_CU);
    if (chosen.length >= i.maxPerTx) deferred.push({ account: f, why: "max-per-tx" });
    else if (cu + add > cap) deferred.push({ account: f, why: "compute" });
    else {
      chosen.push(f);
      cu += add;
    }
  }
  return { chosen, deferred };
}

/** Estimated CU of the plain tx: the accrue crank (when present) plus 35k per refresh weight unit (solo accounts: typical settle). */
export function estimateBaseCu(hasAccrue: boolean, refresh: ReadonlyArray<PositionedPortfolio>): number {
  let cu = hasAccrue ? LIQ_ACCRUE_CU : 0;
  for (const p of refresh) cu += V22_LEG_COST.refreshCu(p, 114_000);
  return cu;
}

/** Serialized size of the tx the executor builds (heap frame + CU limit + the ixs), or Infinity when it cannot be serialized. */
export function serializedTxSize(feePayer: PublicKey, ixs: ReadonlyArray<TransactionInstruction>): number {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: LIQ_TX_MAX_CU }));
  for (const ix of ixs) tx.add(ix);
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.feePayer = feePayer;
  try {
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Drop the last (least urgent: `chosen` is worst-first) liquidation until the tx built by `build(kept)` fits the packet.
 * Returns the kept entries with their instruction list, and the dropped ones. Compute binds first in practice (a 250k-CU
 * liquidation crank at most four to five per tx), so this is the second line, tested with a synthetic builder.
 */
export function fitToPacket<T>(
  chosen: ReadonlyArray<T>,
  build: (kept: ReadonlyArray<T>) => TransactionInstruction[],
  feePayer: PublicKey,
  maxBytes: number = MAX_TX_BYTES,
): { kept: T[]; dropped: T[]; ixs: TransactionInstruction[] } {
  let kept = [...chosen];
  const dropped: T[] = [];
  while (kept.length > 0) {
    const ixs = build(kept);
    if (serializedTxSize(feePayer, ixs) <= maxBytes) return { kept, dropped, ixs };
    dropped.unshift(kept[kept.length - 1]);
    kept = kept.slice(0, -1);
  }
  return { kept, dropped, ixs: [] };
}
