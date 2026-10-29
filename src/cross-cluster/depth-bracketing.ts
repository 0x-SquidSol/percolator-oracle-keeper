/**
 * SEC-RC L-3 (ledger v22-release-push-2026-10-20/SEC-RC.md): depth samples can be bracketed around keeper pushes.
 *
 * The wrapper's "time-weighted" depth window only ever sees the pool at a push. Pushes were predictable (a fixed
 * cadence), so an LP could add spot liquidity just before each push and pull it right after (add/remove on a CPMM pays
 * no swap fee), walking the attested depth up to T1 in about 4 h of bracketing. Keeper-side mitigation, two parts:
 *
 * 1. Jitter. The sleep between push cycles is drawn uniformly from `[interval * (1 - pct/100), interval]` with a CSPRNG
 *    (`crypto.randomInt`). Downward-only, so the cadence's UPPER bound is unchanged: liveness and the on-chain
 *    staleness budget are exactly as before, pushes just can no longer be predicted.
 * 2. Min of samples. Every pre-push read and a re-read 1-3 (random) slots AFTER each push go into a short per-pool
 *    window; the reserve the keeper attests is the MIN over that window (and the current read). Liquidity that was
 *    pulled right after a push is therefore seen and attested at the lower level on the next push. A sharp post-push
 *    drop (the bracketing signature) is logged as a structured warning.
 *
 * Applies to the keeper-attested path (G8 depth mode 1), where the keeper chooses the number on the wire. Depth mode 2
 * (the program reads the pinned pool itself) gets the jitter only.
 *
 * Everything is inert unless `KEEPER_PUSH_DEPTH` is on: with depth pushes off there is nothing to bracket, the cadence
 * stays fixed and no extra read is made.
 */
import { randomInt } from "node:crypto";

/** `randomInt(min, max)` contract: an integer in [min, max). Injected in tests. */
export type RandomIntFn = (minInclusive: number, maxExclusive: number) => number;

/** Default downward jitter, as a percentage of the push interval. */
export const DEFAULT_DEPTH_PUSH_JITTER_PCT = 30;
/** Jitter never takes more than this share of the interval (keeps the push rate bounded: at most 2x). */
export const MAX_DEPTH_PUSH_JITTER_PCT = 50;
/** Default short window for the min-of-samples estimate. Several push cycles at the 7 s default cadence. */
export const DEFAULT_DEPTH_MIN_WINDOW_MS = 30_000;
/** Post-push re-read delay, in slots, drawn uniformly from [min, max]. */
export const DEFAULT_DEPTH_REREAD_MIN_SLOTS = 1;
export const DEFAULT_DEPTH_REREAD_MAX_SLOTS = 3;
/** Nominal slot time used to turn the slot delay into a sleep. */
export const SLOT_MS = 400;
/** A post-push read this far (percent) below the pre-push read is the bracketing signature. */
export const DEFAULT_DEPTH_BRACKET_DROP_PCT = 20;
/** Samples kept per pool, whatever the window (bounds memory). */
export const MAX_SAMPLES_PER_POOL = 64;

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * The jitter percentage for this process. 0 when depth pushes are off (nothing to bracket, cadence stays fixed).
 * Otherwise `KEEPER_DEPTH_PUSH_JITTER_PCT` (integer 0..50, 0 disables), default 30. An invalid value falls back to the
 * default rather than to 0: a typo must not silently switch the mitigation off.
 */
export function depthPushJitterPct(depthPushOn: boolean, env: Record<string, string | undefined> = process.env): number {
  if (!depthPushOn) return 0;
  return intEnv(env, "KEEPER_DEPTH_PUSH_JITTER_PCT", DEFAULT_DEPTH_PUSH_JITTER_PCT, 0, MAX_DEPTH_PUSH_JITTER_PCT);
}

/**
 * The jittered push interval: uniform integer in `[intervalMs - floor(intervalMs * pct / 100), intervalMs]`.
 * Never above `intervalMs`, never below half of it. pct 0 (or a non-positive interval) returns `intervalMs` unchanged.
 */
export function jitteredIntervalMs(intervalMs: number, jitterPct: number, rng: RandomIntFn = randomInt): number {
  if (!(intervalMs > 0) || !(jitterPct > 0)) return intervalMs;
  const pct = Math.min(jitterPct, MAX_DEPTH_PUSH_JITTER_PCT);
  const span = Math.floor((Math.floor(intervalMs) * pct) / 100);
  if (span <= 0) return intervalMs;
  const lo = Math.floor(intervalMs) - span;
  const v = rng(lo, Math.floor(intervalMs) + 1);
  // Defensive clamp: an injected RNG that breaks its contract still cannot lengthen the cadence.
  return Math.min(Math.floor(intervalMs), Math.max(lo, v));
}

/** Post-push re-read delay in ms: a uniform slot count in [minSlots, maxSlots], times SLOT_MS. */
export function postPushRereadDelayMs(
  rng: RandomIntFn = randomInt,
  minSlots = DEFAULT_DEPTH_REREAD_MIN_SLOTS,
  maxSlots = DEFAULT_DEPTH_REREAD_MAX_SLOTS,
): number {
  const lo = Math.max(0, Math.min(minSlots, maxSlots));
  const hi = Math.max(lo, maxSlots);
  const slots = Math.min(hi, Math.max(lo, rng(lo, hi + 1)));
  return slots * SLOT_MS;
}

/** `KEEPER_DEPTH_MIN_WINDOW_MS` (integer 1000..600000), default 30 s. */
export function depthMinWindowMs(env: Record<string, string | undefined> = process.env): number {
  return intEnv(env, "KEEPER_DEPTH_MIN_WINDOW_MS", DEFAULT_DEPTH_MIN_WINDOW_MS, 1_000, 600_000);
}

export type DepthSamplePhase = "pre" | "post";
interface Sample {
  atMs: number;
  reserveE6: bigint;
  phase: DepthSamplePhase;
}

/** The bracketing signature: a sharp drop between a pre-push read and the post-push re-read. */
export interface BracketSignal {
  pool: string;
  preReserveE6: bigint;
  postReserveE6: bigint;
  dropPct: number;
}

/**
 * Per-pool short window of quote-reserve samples (USD e6). The attested depth is a monotone function of the reserve
 * (`plus2PctDepthE6`), so the min reserve gives the min depth.
 */
export class DepthSampleWindow {
  private readonly samples = new Map<string, Sample[]>();
  constructor(
    private readonly windowMs = DEFAULT_DEPTH_MIN_WINDOW_MS,
    private readonly dropPct = DEFAULT_DEPTH_BRACKET_DROP_PCT,
  ) {}

  record(pool: string, reserveE6: bigint, phase: DepthSamplePhase, atMs: number): void {
    if (reserveE6 < 0n) return;
    const list = this.samples.get(pool) ?? [];
    list.push({ atMs, reserveE6, phase });
    while (list.length > MAX_SAMPLES_PER_POOL) list.shift();
    this.samples.set(pool, list);
    this.prune(pool, atMs);
  }

  private prune(pool: string, nowMs: number): void {
    const list = this.samples.get(pool);
    if (!list) return;
    const kept = list.filter((s) => nowMs - s.atMs <= this.windowMs);
    if (kept.length === 0) this.samples.delete(pool);
    else this.samples.set(pool, kept);
  }

  /** Min reserve over the window, or undefined when the pool has no sample in it. */
  minReserve(pool: string, nowMs: number): bigint | undefined {
    this.prune(pool, nowMs);
    const list = this.samples.get(pool);
    if (!list || list.length === 0) return undefined;
    return list.reduce((m, s) => (s.reserveE6 < m ? s.reserveE6 : m), list[0].reserveE6);
  }

  /**
   * The conservative reserve to attest: min(current read, every sample in the window). An absent current read stays
   * absent (send no depth; never attest from history alone).
   */
  conservative(pool: string, currentE6: bigint | undefined, nowMs: number): bigint | undefined {
    if (currentE6 === undefined) return undefined;
    const m = this.minReserve(pool, nowMs);
    return m !== undefined && m < currentE6 ? m : currentE6;
  }

  /** The latest pre-push sample for a pool within the window. */
  lastPre(pool: string, nowMs: number): bigint | undefined {
    this.prune(pool, nowMs);
    const list = this.samples.get(pool) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].phase === "pre") return list[i].reserveE6;
    return undefined;
  }

  /** Compare a post-push re-read to the pre-push read; non-null when it dropped by at least `dropPct` percent. */
  detectBracket(pool: string, preE6: bigint, postE6: bigint): BracketSignal | null {
    if (preE6 <= 0n || postE6 >= preE6) return null;
    const dropBps = ((preE6 - postE6) * 10_000n) / preE6;
    if (dropBps < BigInt(this.dropPct * 100)) return null;
    return { pool, preReserveE6: preE6, postReserveE6: postE6, dropPct: Number(dropBps) / 100 };
  }

  /** Test/ops hook. */
  size(pool: string): number {
    return this.samples.get(pool)?.length ?? 0;
  }
}

/**
 * Feed this cycle's pre-push reads into the window and return the conservative reserve map (min over the window), in
 * a NEW map so the caller's reads are untouched. Pools without a current read are absent (no depth this cycle).
 */
export function conservativeReserves(
  window: DepthSampleWindow,
  current: ReadonlyMap<string, bigint>,
  nowMs: number,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [pool, reserve] of current) {
    const c = window.conservative(pool, reserve, nowMs);
    window.record(pool, reserve, "pre", nowMs);
    if (c !== undefined) out.set(pool, c);
  }
  return out;
}

/**
 * Record the post-push re-reads; return the bracketing signals (one per pool whose re-read fell sharply below the
 * pre-push read). The low sample is in the window, so the next push attests it.
 */
export function recordPostPushReads(
  window: DepthSampleWindow,
  post: ReadonlyMap<string, bigint>,
  pools: Iterable<string>,
  nowMs: number,
): BracketSignal[] {
  const signals: BracketSignal[] = [];
  for (const pool of pools) {
    // A pool missing from the re-read adds no sample. Treating absence as zero would let one flaky RPC read zero the
    // attested depth for a whole window; a pool drained below the price reader's liquidity floor is refused for
    // pricing anyway.
    const v = post.get(pool);
    if (v === undefined) continue;
    const pre = window.lastPre(pool, nowMs);
    window.record(pool, v, "post", nowMs);
    if (pre !== undefined) {
      const s = window.detectBracket(pool, pre, v);
      if (s) signals.push(s);
    }
  }
  return signals;
}

/** One structured log line for a bracketing signal. */
export function bracketWarningLine(s: BracketSignal, label: string): string {
  return `[keeper][WARN] depth-bracketing ${JSON.stringify({
    event: "depth_bracketing_suspected",
    finding: "SEC-RC L-3",
    pool: s.pool,
    label,
    preReserveUsdE6: s.preReserveE6.toString(),
    postReserveUsdE6: s.postReserveE6.toString(),
    dropPct: s.dropPct,
    action: "next push attests the lower reserve (min over window)",
  })}`;
}
