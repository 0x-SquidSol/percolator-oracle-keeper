/**
 * cross-cluster/p2b-hedged-lockout.ts
 *
 * Hedged-lockout alert (growth-v19 N-1/N-2, percolator-prog #524, reviewer test
 * `sec3_hedged_lockout_of_both_sides`).
 *
 * The failure mode. On a growth asset the wrapper caps BOTH sides' USERS open interest at
 * `N_cap = lambda * C_m / P` (`users_side_oi_q`: the engine OI on a side minus the vault LP's own leg).
 * One actor (or a crowd) can open longs AND shorts that offset each other, delta-neutral: users'
 * OI reaches N_cap on both sides while the vault LP stays near FLAT. Both crowds are then closed
 * by capacity ("capacity-full") although the LP carries almost no risk, and fresh users cannot
 * open either side. The N-2 utilisation fee makes building this lock-out cost real money
 * (~$65 on a $1k C_m) but cannot stop it; it is an operator-visible condition, so the keeper
 * alerts on it.
 *
 * Rule (thresholds are env-tunable): ALERT when
 *   users OI long  / N_cap >= HEDGED_LOCKOUT_UTIL_BPS   (default 9000 = 90%)   AND
 *   users OI short / N_cap >= HEDGED_LOCKOUT_UTIL_BPS                          AND
 *   |lp_net_q|     / N_cap <= HEDGED_LOCKOUT_FLAT_BPS   (default 300  = 3%).
 * One side full is the normal "crowd side is full" state; an LP that is NOT flat is the normal
 * "LP is carrying the imbalance" state: neither alerts. No growth block -> no-op.
 *
 * Inputs: the SDK's growth helpers (`decodeAssetGrowthV19`, `usersSideOiQ`, `nCapQ`,
 * `utilizationBps`, `conservativeEquity`), the asset's engine OI and effective price from the
 * market account, and the bound vault LP portfolio (capital, pnl, fee credits, its ADL-effective
 * leg = `basis * A_side / a_basis`, floor: exact to +-1 unit, irrelevant at a few-percent
 * threshold).
 *
 * v2.2 (G8 / controller / continuous leverage, percolator-prog e699d7da): on a v2.2 market the
 * capacity is the program's `n_cap_g8_q_dials`, computed by the SDK exactly as the gate does
 * (`growthCeilingView` -> clamp, tier, cap depth and the continuous-curve dials κ / λ_depth at
 * min(venue, book) depth; then `nCapG8Q`). That needs the market's `band_bps` and the read slot,
 * which `evaluateHedgedLockouts` takes from the market bytes and the RPC context slot. Without
 * them (a v2.1 market) a controller-written record still fails closed (`r3-unsupported`).
 */
import type { Connection } from "@solana/web3.js";
import {
  STRESS_NONE,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  conservativeEquity,
  decodeAssetGrowthV19,
  growthCeilingView,
  nCapG8Q,
  nCapQ,
  parsePortfolioV17,
  usersSideOiQ,
  utilizationBps,
} from "@percolatorct/sdk";
import type { AssetGrowthV19, PortfolioV17 } from "@percolatorct/sdk";
import { decodeAdlState, isV18MarketHeader } from "./adl-state.ts";
import type { Alert } from "./alerting.ts";
import { detectLayout, engineSlotBase } from "./market-layout.ts";
import { V22_CONFIG_OFF } from "./v22/market.ts";
import { readU64 } from "./p2b-markets.ts";
import type { VaultMarketSnapshot } from "./p2b-markets.ts";

const ASSET_WRAPPER_LEN = 1024;
const AS_EFFECTIVE_PRICE = 25;

export interface HedgedLockoutThresholds {
  /** Each side's users OI / N_cap must be at least this (bps). */
  utilBps: number;
  /** |lp_net| / N_cap must be at most this (bps). */
  flatBps: number;
}

export const DEFAULT_HEDGED_LOCKOUT_THRESHOLDS: HedgedLockoutThresholds = { utilBps: 9_000, flatBps: 300 };

type Env = Readonly<Record<string, string | undefined>>;

/** HEDGED_LOCKOUT_UTIL_BPS (9000), HEDGED_LOCKOUT_FLAT_BPS (300). Throws on garbage. */
export function hedgedLockoutThresholdsFromEnv(env: Env): HedgedLockoutThresholds {
  const get = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}="${raw}" must be an integer in [${min}, ${max}]`);
    return n;
  };
  return {
    utilBps: get("HEDGED_LOCKOUT_UTIL_BPS", DEFAULT_HEDGED_LOCKOUT_THRESHOLDS.utilBps, 1, 20_000),
    flatBps: get("HEDGED_LOCKOUT_FLAT_BPS", DEFAULT_HEDGED_LOCKOUT_THRESHOLDS.flatBps, 0, 10_000),
  };
}

export interface HedgedLockoutInput {
  growth: AssetGrowthV19 | null;
  /** The bound vault LP's conservative equity C_m (`conservativeEquity`). */
  cM: bigint;
  /** The asset's effective price (e6). */
  priceE6: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  /** The vault LP's ADL-effective signed position (Q; positive = long). */
  lpEffQ: bigint;
  /**
   * v2.2: the market's engine `band_bps` and the slot of the read. Given, N_cap is the program's G8 capacity on the continuous
   * curve (`growthCeilingView` + `nCapG8Q`, SDK); omitted (v2.1), the growth-1 `nCapQ(C_m, lambda)` and a controller (R3)
   * record fails closed.
   */
  v22?: { bandBps: number; nowSlot: bigint };
}

/**
 * "r3-unsupported": the growth record is controller-written (flags bit 0, R3 layout) and the input carries no `v22` band / slot
 * state. `lambdaBps` is then no longer the effective capacity (G8/controller: `n_cap_g8_q_dials` = min(nCapQ(C_m, min(lambda,
 * lambda_depth)), depth cap at kappa), with tier, curve dials and the sticky cap depth read from band, slot and depth state), so
 * `nCapQ(cM, lambdaBps)` would OVERESTIMATE it and under-report utilisation. Fail closed: no verdict, no alert. With `v22`
 * state the exact G8 capacity is used instead (never this status).
 */
export type HedgedLockoutStatus = "no-growth" | "no-capacity" | "r3-unsupported" | "ok" | "alert";

export interface HedgedLockoutVerdict {
  status: HedgedLockoutStatus;
  nCapQ: bigint | null;
  usersLongQ: bigint | null;
  usersShortQ: bigint | null;
  /** floor(users OI * 1e4 / N_cap) per side. */
  utilLongBps: bigint | null;
  utilShortBps: bigint | null;
  /** floor(|lp| * 1e4 / N_cap). */
  lpNetBps: bigint | null;
}

const NONE: HedgedLockoutVerdict = { status: "no-growth", nCapQ: null, usersLongQ: null, usersShortQ: null, utilLongBps: null, utilShortBps: null, lpNetBps: null };

/** The truth table. Pure. */
export function evaluateHedgedLockout(i: HedgedLockoutInput, t: HedgedLockoutThresholds): HedgedLockoutVerdict {
  if (i.growth === null) return NONE;
  if (i.growth.r3Layout && i.v22 === undefined) return { ...NONE, status: "r3-unsupported" };
  const nCap = i.v22 === undefined ? nCapQ(i.cM, i.growth.lambdaBps, i.priceE6) : g8NCapQ(i.growth, i.v22.bandBps, i.v22.nowSlot, i.cM, i.priceE6);
  if (nCap === null || nCap === 0n) return { ...NONE, status: "no-capacity", nCapQ: nCap };
  const usersLong = usersSideOiQ(i.oiEffLongQ, i.lpEffQ, true);
  const usersShort = usersSideOiQ(i.oiEffShortQ, i.lpEffQ, false);
  const uL = utilizationBps(usersLong, nCap);
  const uS = utilizationBps(usersShort, nCap);
  const lpAbs = i.lpEffQ < 0n ? -i.lpEffQ : i.lpEffQ;
  const lpBps = utilizationBps(lpAbs, nCap);
  const alert = uL !== null && uS !== null && lpBps !== null && uL >= BigInt(t.utilBps) && uS >= BigInt(t.utilBps) && lpBps <= BigInt(t.flatBps);
  return { status: alert ? "alert" : "ok", nCapQ: nCap, usersLongQ: usersLong, usersShortQ: usersShort, utilLongBps: uL, utilShortBps: uS, lpNetBps: lpBps };
}

/**
 * The program's G8 `N_cap` (Q) of a growth asset: `growthCeilingView` (clamp from band / r_gap, usable and cap depth at
 * `nowSlot`, tier = min(venue, book), the continuous-curve dials at min(venue, book) depth) then `nCapG8Q` with those dials,
 * i.e. `n_cap_g8_q_dials` as the gate, the TradeCpi clip and the rent snapshot read it. Stress does not enter N_cap. Pure.
 */
export function g8NCapQ(growth: AssetGrowthV19, bandBps: number, nowSlot: bigint, cM: bigint, priceE6: bigint): bigint | null {
  const view = growthCeilingView(growth, bandBps, nowSlot, cM, STRESS_NONE);
  return nCapG8Q({ clamp: view.clampEnforced, cM, lambdaBps: growth.lambdaBps, tier: view.tier, capDepth: view.capDepthE6, priceE6, dials: view.dials });
}

/** The vault LP's ADL-effective signed position on `assetIndex` (`basis * A_side / a_basis`, floor; 0 when flat). Pure. */
export function vaultLpEffectivePositionQ(p: Pick<PortfolioV17, "legs">, assetIndex: number, adl: { aLong: bigint; aShort: bigint }): bigint {
  let net = 0n;
  for (const leg of p.legs) {
    if (!leg.active || leg.assetIndex !== assetIndex) continue;
    const abs = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
    const a = leg.side === 0 ? adl.aLong : adl.aShort;
    const eff = leg.aBasis > 0n ? (abs * a) / leg.aBasis : abs;
    net += leg.side === 0 ? eff : -eff;
  }
  return net;
}

export interface HedgedLockoutRecord {
  market: string;
  label: string;
  verdict: HedgedLockoutVerdict;
}

/**
 * Where the asset state lives and, on v2.2, the band / slot state for the G8 N_cap. v2.1 (VERSION 18): the fixed v2.1 geometry, no
 * `v22`. A known v2.2 layout: `engineSlotBase` of the detected layout, `band_bps` from the config, `nowSlot` = the read's context
 * slot. Anything else (not a market, unknown layout, a v17 market): null, not evaluated. Pure.
 */
export function hedgedLockoutPlacement(data: Uint8Array, assetIndex: number, readSlot: number): { assetStateOff: number; v22?: { bandBps: number; nowSlot: bigint } } | null {
  if (isV18MarketHeader(data)) {
    return { assetStateOff: V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN + ASSET_WRAPPER_LEN };
  }
  const det = detectLayout(data);
  if (!det.known || det.layout.wrapperVersion < 19) return null;
  const l = det.layout;
  const off = engineSlotBase(l, assetIndex);
  const bandOff = l.groupOff + V22_CONFIG_OFF.bandBps;
  if (data.length < off + AS_EFFECTIVE_PRICE + 8 || data.length < bandOff + 8) return null;
  const band = readU64(data, bandOff);
  return { assetStateOff: off, v22: { bandBps: band > 0xffff_ffffn ? Number.MAX_SAFE_INTEGER : Number(band), nowSlot: BigInt(readSlot) } };
}

/** Markets already logged as r3-unsupported (one line per market per process). */
const r3Logged = new Set<string>();

export type HedgedLockoutConnection = Pick<Connection, "getAccountInfo">;

/**
 * Evaluate every snapshot that has a growth block on a bound market. A market without one costs
 * no RPC. Returns the ACTIVE alerts (feed them to `sink.reconcile` so a cleared condition fires
 * its RESOLVED line) and the per-market records. Never throws.
 */
export async function evaluateHedgedLockouts(
  conn: HedgedLockoutConnection,
  snaps: Iterable<VaultMarketSnapshot>,
  t: HedgedLockoutThresholds,
): Promise<{ alerts: Alert[]; records: HedgedLockoutRecord[] }> {
  const alerts: Alert[] = [];
  const records: HedgedLockoutRecord[] = [];
  for (const s of snaps) {
    try {
      if (!s.bound || !s.vaultLp || !s.marketData) continue;
      const growth = decodeAssetGrowthV19(s.marketData, s.ref.assetIndex);
      if (growth === null) continue;
      // v2.1 (VERSION 18): the fixed v2.1 offsets and growth-1 N_cap. v2.2: the asset state through the detected layout (the
      // AssetStateV16Account prefix, effective price @25, is unchanged; K-9) and the G8 N_cap on the continuous curve.
      const place = hedgedLockoutPlacement(s.marketData, s.ref.assetIndex, s.slot);
      if (place === null) continue;
      const adl = decodeAdlState(s.marketData, s.ref.assetIndex);
      if (!adl) continue;
      const info = await conn.getAccountInfo(s.vaultLp.lpPortfolio, "confirmed");
      if (!info) continue;
      const lp = parsePortfolioV17(new Uint8Array(info.data));
      const a = place.assetStateOff;
      const verdict = evaluateHedgedLockout(
        {
          growth,
          cM: conservativeEquity(lp.capital, lp.pnl, lp.feeCredits),
          priceE6: readU64(s.marketData, a + AS_EFFECTIVE_PRICE),
          oiEffLongQ: adl.oiEffLong,
          oiEffShortQ: adl.oiEffShort,
          lpEffQ: vaultLpEffectivePositionQ(lp, s.ref.assetIndex, adl),
          ...(place.v22 === undefined ? {} : { v22: place.v22 }),
        },
        t,
      );
      records.push({ market: s.ref.marketAddress, label: s.ref.label, verdict });
      if (verdict.status === "r3-unsupported" && !r3Logged.has(s.ref.marketAddress)) {
        r3Logged.add(s.ref.marketAddress);
        console.warn(`[hedged-lockout] ${s.ref.label} (${s.ref.marketAddress}): controller (R3) growth record, lambda_bps is not the effective N_cap; hedged-lockout decision SKIPPED (fail closed)`);
      }
      if (verdict.status === "alert") alerts.push(hedgedLockoutAlert(s.ref.marketAddress, s.ref.label, verdict, t));
    } catch {
      // a market that cannot be read this tick is simply not evaluated
    }
  }
  return { alerts, records };
}

function pct(bps: bigint | null): string {
  return bps === null ? "?" : `${Number(bps) / 100}%`;
}

export function hedgedLockoutAlert(market: string, label: string, v: HedgedLockoutVerdict, t: HedgedLockoutThresholds): Alert {
  return {
    kind: "hedged-lockout",
    severity: "warn",
    subject: label,
    message:
      `both sides of the growth asset are at capacity (users long ${pct(v.utilLongBps)}, users short ${pct(v.utilShortBps)} of N_cap; ` +
      `threshold ${t.utilBps / 100}%) while the vault LP is near flat (|net| ${pct(v.lpNetBps)} of N_cap, flat <= ${t.flatBps / 100}%): ` +
      "hedged longs and shorts are locking fresh users out of BOTH sides although the LP carries almost no risk. " +
      "Closes are always allowed; opens reopen as the hedged positions close or C_m grows.",
    data: {
      market,
      utilLongBps: v.utilLongBps === null ? null : Number(v.utilLongBps),
      utilShortBps: v.utilShortBps === null ? null : Number(v.utilShortBps),
      lpNetBps: v.lpNetBps === null ? null : Number(v.lpNetBps),
      nCapQ: v.nCapQ === null ? null : v.nCapQ.toString(),
    },
  };
}
