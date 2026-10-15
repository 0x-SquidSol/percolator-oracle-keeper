/**
 * cross-cluster/push-deadline.ts
 *
 * R3.24 (2026-10-15, swordcat / swordcat-c4 resolved by BandPinExpired after the Mac mini reboot): what the push loop
 * must know about a market's on-chain FAIL-CLOSED DEADLINES before it decides to withhold a push, and whether the
 * market is terminal at all.
 *
 * THE TWO DEADLINES (wrapper 153c62fc / engine release/v22, read-only):
 *
 *   1. Stale resolve (tag 39). `now_slot - config.last_good_oracle_slot >= permissionless_resolve_stale_slots`
 *      (market-state.ts staleResolveWindow). Every landed PushAuthMark advances `last_good_oracle_slot`, so a PUSH
 *      RESETS THIS CLOCK. Once it has matured, the wrapper also refuses every crank on the Live market with
 *      OracleStale(27) (`reject_permissionless_resolve_matured_live_view`, v16_program.rs:13545-13552), so the keeper
 *      cannot accrue, certify or re-anchor anything until a push lands.
 *
 *   2. Band pin (v2.2, recovery_reason 8 BandPinExpired). `now_slot - asset.band_pin_since_slot > band_max_pin_slots`
 *      for any Active/DrainOnly band asset (engine v16.rs:17523-17545), evaluated at CRANK ENTRY (v16.rs:17672) by
 *      anyone's crank. The pin clock is stamped from `asset.slot_last` when an accrual cannot follow its target
 *      (v16.rs:16848-16867) and cleared only by an ACCRUAL that is no longer pinned: the anchor advanced after every
 *      positioned leg was certified this epoch (kernel_band_reanchor_ready, v16.rs:1613), or the target is back
 *      inside the band. A push does NOT touch `band_pin_since_slot`; it only (a) moves the target, which can end an
 *      edge pin at the next accrual, and (b) keeps the oracle fresh so the cranks that certify / re-anchor are not
 *      refused (deadline 1).
 *
 * So withholding a push is safe only while neither deadline is close. When one is, every withheld cycle is a cycle the
 * keeper cannot spend saving the market, and the cost of publishing a short-window median (bounded by the circuit
 * breaker, the band itself and the engine's per-slot step cap) is strictly smaller than an irreversible resolve at a
 * stale price. `urgent` below is that test; the push loop bypasses the smoother's priming gate when it is true.
 *
 * Pure decode + a small per-market cache. The cache is fed by the recovery cranker's per-cycle market read (which
 * also runs once at boot BEFORE the push loop's first cycle) and, for a market the smoother would withhold without a
 * fresh entry, by a targeted read in the push loop itself.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { decodeTerminalState, marketMode, staleResolveWindow } from "./market-state.ts";
import { detectLayout, engineSlotBase } from "./market-layout.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";
import { V22_ASSET_BAND_OFF, V22_CONFIG_OFF } from "./v22/market.ts";

const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;

/**
 * A deadline is "close" once HALF of its budget is gone. Half, not a small margin: the keeper needs several push and
 * crank cycles (and, for a pin, a full certification sweep of up to 2 x 256 legs plus an accrual) to act, RPC trouble
 * can eat many of them, and the smoother's priming at the live 15 s window costs only ~5 cycles anyway. Matches the
 * `half` level band.ts already reports for a pin.
 */
export const URGENT_FRACTION_NUM = 1n;
export const URGENT_FRACTION_DEN = 2n;

export type TerminalKind = "resolved" | "closed" | "recovery";

export interface PushDeadline {
  /**
   * Not Live, so never pushed again: Resolved, a CloseSlab tombstone, or Recovery (mode 2, which only steps forward to
   * Resolved; PushAuthMark is refused there). No push, no smoothing, no push / pin alert.
   */
  terminal: TerminalKind | null;
  /** Slot of the read the numbers below are relative to. */
  readSlot: bigint;
  /** Stale-resolve window; null when disabled or not a Live market. */
  stale: { staleSlots: bigint; lastGoodOracleSlot: bigint; remaining: bigint; matured: boolean } | null;
  /** The LONGEST-running pin among the market's Active / DrainOnly band assets; null when none is pinned (or no band). */
  pin: { assetIndex: number; sinceSlot: bigint; durationSlots: bigint; maxPinSlots: bigint; remaining: bigint; expired: boolean } | null;
  /** True when withholding a push risks one of the two deadlines (see the module comment). */
  urgent: boolean;
  /** Why `urgent` (for the log line and /health); null when not urgent. */
  urgentReason: string | null;
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}

function closeTo(remaining: bigint, budget: bigint): boolean {
  if (budget <= 0n) return false;
  // remaining <= budget * (1 - num/den)  <=>  elapsed >= budget * num/den
  return remaining * URGENT_FRACTION_DEN <= budget * (URGENT_FRACTION_DEN - URGENT_FRACTION_NUM);
}

/**
 * The pin of every configured Active / DrainOnly band asset (`band_epoch != 0 && band_pin_since_slot != 0`), the one
 * closest to expiry first. Empty for a non-band market or a layout this keeper does not decode (never a guess).
 */
export function decodeBandPins(d: Uint8Array, readSlot: bigint): Array<NonNullable<PushDeadline["pin"]>> {
  const det = detectLayout(d);
  if (!det.known || det.layout.id !== "v2.2-b") return [];
  const layout = det.layout;
  const g = layout.groupOff;
  const bandBps = u64(d, g + V22_CONFIG_OFF.bandBps);
  if (bandBps === 0n) return [];
  const maxPinSlots = u64(d, g + V22_CONFIG_OFF.bandMaxPinSlots);
  const out: Array<NonNullable<PushDeadline["pin"]>> = [];
  for (let i = 0; i < det.slots; i++) {
    const lifecycle = decodeMarketRefreshState(d, i).lifecycle;
    if (lifecycle !== LIFECYCLE_ACTIVE && lifecycle !== LIFECYCLE_DRAIN_ONLY) continue;
    const e = engineSlotBase(layout, i);
    if (u64(d, e + V22_ASSET_BAND_OFF.epoch) === 0n) continue;
    const sinceSlot = u64(d, e + V22_ASSET_BAND_OFF.pinSinceSlot);
    if (sinceSlot === 0n) continue;
    const durationSlots = readSlot > sinceSlot ? readSlot - sinceSlot : 0n;
    // engine: expired iff now - since > max_pin
    const expired = durationSlots > maxPinSlots;
    const remaining = expired ? 0n : maxPinSlots - durationSlots;
    out.push({ assetIndex: i, sinceSlot, durationSlots, maxPinSlots, remaining, expired });
  }
  return out.sort((a, b) => (a.remaining < b.remaining ? -1 : a.remaining > b.remaining ? 1 : 0));
}

/** Where a market stands against its fail-closed deadlines at `readSlot`. null = not a wrapper market this keeper decodes. */
export function pushDeadlineOf(d: Uint8Array, readSlot: bigint): PushDeadline | null {
  const t = decodeTerminalState(d);
  if (t === null) return null;
  if (t.kind !== "live") return { terminal: t.kind, readSlot, stale: null, pin: null, urgent: false, urgentReason: null };
  if (marketMode(d) === 2) return { terminal: "recovery", readSlot, stale: null, pin: null, urgent: false, urgentReason: null };
  const w = staleResolveWindow(d, readSlot);
  const stale = w && w.enabled ? { staleSlots: w.staleSlots, lastGoodOracleSlot: w.lastGoodOracleSlot, remaining: w.remaining, matured: w.matured } : null;
  let pin: PushDeadline["pin"] = null;
  try {
    pin = decodeBandPins(d, readSlot)[0] ?? null;
  } catch {
    pin = null; // a short / odd account: the stale window alone decides
  }
  const reasons: string[] = [];
  if (stale && closeTo(stale.remaining, stale.staleSlots)) {
    reasons.push(stale.matured ? `stale-resolve window MATURED (oracle ${readSlot - stale.lastGoodOracleSlot} slots old)` : `stale-resolve window ${stale.remaining}/${stale.staleSlots} slots left`);
  }
  if (pin && closeTo(pin.remaining, pin.maxPinSlots)) {
    reasons.push(pin.expired ? `band pin EXPIRED on asset ${pin.assetIndex} (${pin.durationSlots} > ${pin.maxPinSlots} slots)` : `band pin on asset ${pin.assetIndex} ${pin.remaining}/${pin.maxPinSlots} slots left`);
  }
  return { terminal: null, readSlot, stale, pin, urgent: reasons.length > 0, urgentReason: reasons.length > 0 ? reasons.join("; ") : null };
}

// ── Per-market cache ────────────────────────────────────────────────────────────────────────────────────────────────

interface CachedDeadline {
  deadline: PushDeadline;
  atMs: number;
}
const byMarket = new Map<string, CachedDeadline>();

/** A cache entry older than this is not trusted to decide a withhold (the push loop re-reads the market). */
export const DEADLINE_FRESH_MS = 30_000;

/** Record a market read (cranker / push loop). Never throws. A market once seen terminal stays terminal (one-way). */
export function recordPushDeadline(marketAddress: string, data: Uint8Array, readSlot: bigint, atMs: number = Date.now()): PushDeadline | null {
  try {
    const prev = byMarket.get(marketAddress);
    if (prev?.deadline.terminal) return prev.deadline;
    const d = pushDeadlineOf(data, readSlot);
    if (d) byMarket.set(marketAddress, { deadline: d, atMs });
    return d;
  } catch {
    return null;
  }
}

/** The cached deadline, or undefined. `maxAgeMs` (default: any age) bounds how old a LIVE entry may be; terminal never ages. */
export function getPushDeadline(marketAddress: string, nowMs: number = Date.now(), maxAgeMs = Number.POSITIVE_INFINITY): PushDeadline | undefined {
  const c = byMarket.get(marketAddress);
  if (!c) return undefined;
  if (c.deadline.terminal) return c.deadline;
  return nowMs - c.atMs <= maxAgeMs ? c.deadline : undefined;
}

/** True once the market was seen Resolved / closed. */
export function isKnownTerminal(marketAddress: string): boolean {
  return byMarket.get(marketAddress)?.deadline.terminal != null;
}

/** Mark a market terminal from another signal (the pusher's B20 read). */
export function markTerminal(marketAddress: string, kind: TerminalKind = "resolved", atMs: number = Date.now()): void {
  const prev = byMarket.get(marketAddress);
  if (prev?.deadline.terminal) return;
  byMarket.set(marketAddress, { deadline: { terminal: kind, readSlot: prev?.deadline.readSlot ?? 0n, stale: null, pin: null, urgent: false, urgentReason: null }, atMs });
}

/**
 * Read `markets` in ONE getMultipleAccounts and record each (the push loop calls this only for markets it is about to
 * withhold without a fresh cache entry, i.e. during smoother priming). Never throws; a failed read leaves the cache.
 */
export async function refreshPushDeadlines(
  conn: Pick<Connection, "getMultipleAccountsInfoAndContext">,
  markets: readonly string[],
  atMs: number = Date.now(),
): Promise<void> {
  if (markets.length === 0) return;
  try {
    const res = await conn.getMultipleAccountsInfoAndContext(markets.map((m) => new PublicKey(m)), "processed");
    const slot = BigInt(res.context.slot);
    res.value.forEach((info, i) => {
      if (info) recordPushDeadline(markets[i], new Uint8Array(info.data), slot, atMs);
    });
  } catch (err) {
    console.warn(`[loop] deadline read failed (${markets.length} market(s)); the smoother keeps its priming gate this cycle: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
  }
}

/** Drop markets no longer registered. */
export function prunePushDeadlines(keep: ReadonlySet<string>): void {
  for (const m of [...byMarket.keys()]) if (!keep.has(m)) byMarket.delete(m);
}

/** Test hook. */
export function resetPushDeadlines(): void {
  byMarket.clear();
}
