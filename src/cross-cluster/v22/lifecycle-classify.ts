/**
 * cross-cluster/v22/lifecycle-classify.ts
 *
 * The dead-market classifier (plan v22-market-lifecycle-plan-2026-10-25 section 1). PURE: market bytes + a few facts in,
 * a classification out. No RPC, no clock, nothing sent. Run every tick on every v2.2 market the keeper looks at.
 *
 * CLASSES (a market can carry several; `classes` lists them, worst first):
 *
 *   never-connected      A Live market whose price is not advancing AND this keeper has no push path to it:
 *                          no-registry-row        the keeper's registry has no row (found by the discovery scan), or
 *                          not-oracle-authority   the row exists but asset 0's oracle_authority is not this keeper's key
 *                                                 (#3661: the wizard co-signed the hand-off to the wrong key), or
 *                          no-accepted-push       registered, keeper IS the authority, yet no push of this keeper has
 *                                                 landed since boot although the keeper has been observing for the grace
 *                                                 period and the on-chain price is older than the grace.
 *                        ON-CHAIN LIMIT: the wrapper keeps no "created at" slot. InitMarket sets last_good_oracle_slot to
 *                        the init slot, so "never advanced" is not provable from the account alone; the class therefore
 *                        means "never connected as far as THIS keeper can tell", and it needs the price age to be at
 *                        least `neverConnectedGraceSlots` so a market that is merely new, or pushed by another operator
 *                        a moment ago, is never named. It is a label for alerts and for the resolve guard that a market
 *                        with no push path needs no "source unavailable" evidence; it never overrides maturity.
 *   dead-price-warn      Live, permissionless_resolve_stale_slots != 0, price age >= 50% of it (and not yet matured).
 *   dead-price-matured   age >= 100% of it: tag 39 can be sent by anyone (market-state.ts staleResolveWindow, the same
 *                        arithmetic as the program's permissionless_stale_matured).
 *   dead-interest        Live, price fresh (below the warn band), open interest 0 on every Active/DrainOnly asset, and no
 *                        trading observed for `deadInterestMs`. CLASSIFY + ALERT ONLY: retiring such a market is the admin
 *                        path and out of scope for the keeper.
 *                        LAST-TRADE SIGNAL: there is none on chain. The wrapper stores no last-trade slot, and the engine
 *                        keeps no fill counter. What the keeper can observe is the trade-fee accrual counters in the
 *                        wrapper config (protocol + LP + insurance-reserve accrued atoms; monotonic, bumped by trades), so
 *                        "quiet" = those counters unchanged and OI = 0 since the keeper first saw it that way. In memory only,
 *                        the clock restarts at every boot (it under-counts). With KEEPER_V22_LIFECYCLE_STATE_FILE it spans
 *                        keeper downtime: that is still right because the first observation after a restart compares the
 *                        counters with the persisted ones, so any trade-fee accrual during the downtime restarts the clock.
 *                        What neither mode can see is a trade that paid no fee (trade_fee_base_bps = 0), and an OI that
 *                        opened and closed with no fee accrual: such a market can read "quiet" while it is not. That is why
 *                        DEAD-INTEREST only alerts.
 *   no-resolve-window    Live with permissionless_resolve_stale_slots == 0: nobody can resolve it permissionlessly.
 *   terminal             Resolved / Recovery / closed: not classified further.
 *   healthy              none of the above.
 */
import { parseAssetOracleProfileV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import type { PublicKey } from "@solana/web3.js";
import { decodeAdlState } from "../adl-state.ts";
import { assetSlotsOff, detectLayout, engineSlotBase } from "../market-layout.ts";
import { decodeTerminalState, marketMode, staleResolveWindow } from "../market-state.ts";

export type LifecycleClass = "never-connected" | "dead-price-matured" | "dead-price-warn" | "dead-interest" | "no-resolve-window" | "terminal" | "healthy";

export type NeverConnectedReason = "no-registry-row" | "not-oracle-authority" | "no-accepted-push";

/** Warn at this fraction (of 10,000) of permissionless_resolve_stale_slots. The plan fixes it at 50%. */
export const WARN_BAND_BPS = 5_000n;

export type PriceBand =
  | { kind: "fresh"; ageSlots: bigint; staleSlots: bigint; pctBps: number }
  | { kind: "warn"; ageSlots: bigint; staleSlots: bigint; pctBps: number; remainingSlots: bigint }
  | { kind: "matured"; ageSlots: bigint; staleSlots: bigint; pctBps: number; lastGoodOracleSlot: bigint }
  | { kind: "no-window"; ageSlots: bigint }
  | { kind: "not-live" };

export interface MarketLifecycle {
  terminal: "resolved" | "closed" | "recovery" | null;
  price: PriceBand;
  lastGoodOracleSlot: bigint | null;
  neverConnected: NeverConnectedReason | null;
  /** Registered and the keeper is asset 0's oracle authority: the keeper can push this market. */
  keeperCanPush: boolean;
  /** The keeper is asset 0's oracle authority, registered or not. */
  keeperIsAuthority: boolean;
  /** The market has a registry row NOW. */
  registered: boolean;
  /** null = could not be read. */
  oiZero: boolean | null;
  /** ms the market has been observed quiet (OI 0, trade-fee counters unchanged); 0 when not quiet or unknown. */
  quietMs: number;
  deadInterest: boolean;
  classes: LifecycleClass[];
}

export interface ClassifyInput {
  data: Uint8Array;
  /** Slot of the read the price age is measured at. */
  readSlot: bigint;
  /** The keeper's registry has a row for this market. */
  registered: boolean;
  keeper: PublicKey;
  /** Did a push of this keeper land since this process booted? */
  keeperLandedPush: boolean;
  /** ms this keeper has been continuously observing (ledger.continuousMs). */
  keeperObservedMs: number;
  neverConnectedGraceSlots: bigint;
  /** ms the market has been observed quiet (see `QuietTracker`); 0 when unknown. */
  quietMs: number;
  deadInterestMs: number;
}

/** Slot time used to turn the grace in slots into the observation time the keeper must have accumulated (400 ms). */
const SLOT_MS = 400;

/** True when every Active / DrainOnly asset has zero effective OI on both sides; null when any asset cannot be decoded. */
export function openInterestIsZero(data: Uint8Array): boolean | null {
  try {
    const det = detectLayout(data);
    if (!det.known) return null;
    let sawAsset = false;
    for (let i = 0; i < det.slots; i++) {
      const lifecycle = data[engineSlotBase(det.layout, i) + det.layout.asset.lifecycle];
      if (lifecycle !== 2 && lifecycle !== 3) continue; // Active / DrainOnly only
      const a = decodeAdlState(data, i);
      if (!a) return null;
      sawAsset = true;
      if (a.oiEffLong !== 0n || a.oiEffShort !== 0n) return false;
    }
    return sawAsset ? true : null;
  } catch {
    return null;
  }
}

/** Sum of the wrapper config's monotonic trade-fee accrual counters (protocol + LP + insurance reserve), or null when unreadable. */
export function tradeFeeAccrualSum(data: Uint8Array): bigint | null {
  try {
    const c = parseWrapperConfigV17(data);
    return c.protocolFeeAccruedAtoms + c.lpFeeAccruedAtoms + c.insuranceReserveAccruedAtoms;
  } catch {
    return null;
  }
}

/** asset 0's oracle_authority as raw bytes' PublicKey, or null when the layout does not decode. */
export function assetZeroOracleAuthority(data: Uint8Array): PublicKey | null {
  try {
    const det = detectLayout(data);
    if (!det.known) return null;
    return parseAssetOracleProfileV17(data, assetSlotsOff(det.layout)).oracleAuthority;
  } catch {
    return null;
  }
}

/** Where a LIVE market's price stands against its stale-resolve window at `readSlot`. */
export function priceBandOf(data: Uint8Array, readSlot: bigint): PriceBand {
  const w = staleResolveWindow(data, readSlot);
  if (!w) return { kind: "not-live" };
  const age = readSlot > w.lastGoodOracleSlot ? readSlot - w.lastGoodOracleSlot : 0n;
  if (!w.enabled) return { kind: "no-window", ageSlots: age };
  const pctBps = Number((age * 10_000n) / w.staleSlots);
  // Same inequality as the program: matured iff age >= stale_slots (staleResolveWindow computes it).
  if (w.matured) return { kind: "matured", ageSlots: age, staleSlots: w.staleSlots, pctBps, lastGoodOracleSlot: w.lastGoodOracleSlot };
  if (age * 10_000n >= w.staleSlots * WARN_BAND_BPS) return { kind: "warn", ageSlots: age, staleSlots: w.staleSlots, pctBps, remainingSlots: w.remaining };
  return { kind: "fresh", ageSlots: age, staleSlots: w.staleSlots, pctBps };
}

export function classifyMarket(i: ClassifyInput): MarketLifecycle {
  const t = decodeTerminalState(i.data);
  const mode = marketMode(i.data);
  const terminal: MarketLifecycle["terminal"] = t === null ? null : t.kind !== "live" ? t.kind : mode === 2 ? "recovery" : null;
  if (terminal !== null || t === null) {
    return { terminal, price: { kind: "not-live" }, lastGoodOracleSlot: null, neverConnected: null, keeperCanPush: false, keeperIsAuthority: false, registered: i.registered, oiZero: null, quietMs: 0, deadInterest: false, classes: ["terminal"] };
  }
  const price = priceBandOf(i.data, i.readSlot);
  const lastGood = price.kind === "matured" ? price.lastGoodOracleSlot : price.kind === "not-live" ? null : i.readSlot - price.ageSlots;
  const authority = assetZeroOracleAuthority(i.data);
  const keeperIsAuthority = authority !== null && authority.equals(i.keeper);
  const keeperCanPush = i.registered && keeperIsAuthority;

  let neverConnected: NeverConnectedReason | null = null;
  const age = price.kind === "not-live" ? 0n : price.ageSlots;
  if (age >= i.neverConnectedGraceSlots) {
    if (!i.registered) neverConnected = "no-registry-row";
    else if (authority !== null && !keeperIsAuthority) neverConnected = "not-oracle-authority";
    else if (keeperIsAuthority && !i.keeperLandedPush && i.keeperObservedMs >= Number(i.neverConnectedGraceSlots) * SLOT_MS) neverConnected = "no-accepted-push";
  }

  const oiZero = openInterestIsZero(i.data);
  const deadInterest = price.kind === "fresh" && oiZero === true && i.quietMs >= i.deadInterestMs;

  const classes: LifecycleClass[] = [];
  if (neverConnected) classes.push("never-connected");
  if (price.kind === "matured") classes.push("dead-price-matured");
  if (price.kind === "warn") classes.push("dead-price-warn");
  if (deadInterest) classes.push("dead-interest");
  if (price.kind === "no-window") classes.push("no-resolve-window");
  if (classes.length === 0) classes.push("healthy");
  return { terminal: null, price, lastGoodOracleSlot: lastGood, neverConnected, keeperCanPush, keeperIsAuthority, registered: i.registered, oiZero, quietMs: i.quietMs, deadInterest, classes };
}

// ── DEAD-INTEREST quiet clock ───────────────────────────────────────────────────────────────────────────────────────

export interface QuietEntry {
  /** ms since which the market has been observed with OI 0 and unchanged trade-fee counters. */
  quietSinceMs: number;
  /** The accrual-counter sum at the last observation (decimal string, u128-safe). */
  feeSum: string;
}

/**
 * Track how long a market has been quiet. A market is quiet while OI is 0 and the trade-fee accrual sum has not moved.
 * Any observation that is not quiet (OI > 0, OI unknown, a counter change) restarts the clock at `nowMs`.
 * `prev` undefined = first sight: the clock starts now.
 */
export function observeQuiet(prev: QuietEntry | undefined, o: { oiZero: boolean | null; feeSum: bigint | null; nowMs: number }): QuietEntry {
  const feeSum = o.feeSum === null ? (prev?.feeSum ?? "0") : o.feeSum.toString();
  if (prev === undefined) return { quietSinceMs: o.nowMs, feeSum };
  if (o.oiZero !== true || o.feeSum === null || o.feeSum.toString() !== prev.feeSum) return { quietSinceMs: o.nowMs, feeSum };
  return { quietSinceMs: prev.quietSinceMs, feeSum };
}

export function quietMsOf(e: QuietEntry | undefined, nowMs: number): number {
  return e === undefined ? 0 : Math.max(0, nowMs - e.quietSinceMs);
}
