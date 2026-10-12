/**
 * cross-cluster/adl-state.ts
 *
 * Detect the ADL reduce-only state (F-3 / R1–R2, ledger
 * f3-market-freeze-triage-2026-09-30.md). After a bankruptcy ADL the engine
 * keeps an asset REDUCE-ONLY while `a_long != ADL_ONE || a_short != ADL_ONE`:
 * every risk-increasing leg change reverts Custom(21), so the market looks
 * frozen for opens. It reopens only once one whole side has exited (the
 * zero-OI reset). R2: a single abandoned position per side keeps it that way
 * indefinitely, so the alert carries the duration and both sides' OI.
 *
 * Layout, verified against engine 35ddd692 `AssetStateV16Account` (v16.rs:7371,
 * packed POD): market_id u64 @0, retired_slot u64 @8, lifecycle u8 @16,
 * raw_oracle_target_price @17, effective_price @25, fund_px_last @33,
 * slot_last @41, a_long u128 @49, a_short u128 @65. OI effective long/short
 * u128 @289/@305 (the same offsets positioned-refresh.ts already uses).
 * ADL_ONE = 1e15 (engine lib.rs:16). The frontend reaches the same offsets via
 * offset_of! (wt-app-limits app/lib/limits/constants.ts).
 *
 * K-9 (2026-10-12): the asset slot is located through the market's detected layout (market-layout.ts, per VERSION
 * and length), so v2.2 (VERSION 19: group 806, stride 2,661, engine slot 592 + 806 + 1,024 = 2,422) is read at its own
 * offsets. Inside the engine slot the AssetStateV16Account PREFIX is unchanged in v2.2 (the band / rent words are
 * appended after mode_short; engine 3ce4cbd1), so a_long @49 / a_short @65 / OI @289/@305 hold on both.
 * A non-market account (wrong magic or kind) returns null; a market account whose layout the keeper does not know
 * (v17, an unknown VERSION, a truncated / odd length) THROWS — never decoded at a guessed offset (a v17 slab reads
 * a_long = a_short = 0 at these offsets, which would look like the reduce-only state).
 */
import { describeUnknownLayout, detectLayout, engineSlotBase } from "./market-layout.ts";

export const ADL_ONE = 1_000_000_000_000_000n;

const WRAPPER_MAGIC = 0x5045_5243_5631_3600n;
const WRAPPER_VERSION_V18 = 18;
const HEADER_KIND_OFF = 10;
const KIND_MARKET_ACCOUNT = 1;

const AS_A_LONG = 49;
const AS_A_SHORT = 65;
const AS_OI_EFF_LONG = 289;
const AS_OI_EFF_SHORT = 305;

export interface AdlState {
  aLong: bigint;
  aShort: bigint;
  oiEffLong: bigint;
  oiEffShort: bigint;
  reduceOnly: boolean;
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}
function u128(d: Uint8Array, off: number): bigint {
  return u64(d, off) | (u64(d, off + 8) << 64n);
}

export function isV18MarketHeader(d: Uint8Array): boolean {
  if (d.length < 16) return false;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(0, true) === WRAPPER_MAGIC && v.getUint16(8, true) === WRAPPER_VERSION_V18 && d[HEADER_KIND_OFF] === KIND_MARKET_ACCOUNT;
}

/** Wrapper magic + kind 1 (a market account), any VERSION. */
export function isWrapperMarketHeader(d: Uint8Array): boolean {
  if (d.length < 16) return false;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(0, true) === WRAPPER_MAGIC && d[HEADER_KIND_OFF] === KIND_MARKET_ACCOUNT;
}

/** null for a non-market account; throws for a market of unknown layout (never a guess). */
export function decodeAdlState(d: Uint8Array, assetIndex = 0): AdlState | null {
  if (!isWrapperMarketHeader(d)) return null;
  const det = detectLayout(d);
  if (!det.known) throw new Error(`decodeAdlState: ${describeUnknownLayout(det)}`);
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex >= det.slots) throw new RangeError(`decodeAdlState: asset ${assetIndex} not present`);
  const a = engineSlotBase(det.layout, assetIndex);
  if (d.length < a + AS_OI_EFF_SHORT + 16) throw new Error("decodeAdlState: account too short for the asset state");
  const aLong = u128(d, a + AS_A_LONG);
  const aShort = u128(d, a + AS_A_SHORT);
  return {
    aLong,
    aShort,
    oiEffLong: u128(d, a + AS_OI_EFF_LONG),
    oiEffShort: u128(d, a + AS_OI_EFF_SHORT),
    reduceOnly: aLong !== ADL_ONE || aShort !== ADL_ONE,
  };
}

/** A as a decimal fraction of ADL_ONE, e.g. "0.861700". */
export function adlFraction(a: bigint): string {
  const scaled = (a * 1_000_000n) / ADL_ONE;
  return `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, "0")}`;
}

/** The /health shape of an ADL state (refresh-coordination.ts `CrankRefreshHealth.adl`). */
export function adlHealth(s: AdlState): { reduceOnly: boolean; aLong: string; aShort: string; oiEffLong: string; oiEffShort: string } {
  return { reduceOnly: s.reduceOnly, aLong: adlFraction(s.aLong), aShort: adlFraction(s.aShort), oiEffLong: s.oiEffLong.toString(), oiEffShort: s.oiEffShort.toString() };
}

/** `{ adl }` for a market account's bytes, or `{}` when it cannot be decoded (non-market / unknown layout): never a guess. */
export function adlHealthOf(data: Uint8Array, assetIndex = 0): { adl?: ReturnType<typeof adlHealth> } {
  try {
    const s = decodeAdlState(data, assetIndex);
    return s ? { adl: adlHealth(s) } : {};
  } catch {
    return {};
  }
}
