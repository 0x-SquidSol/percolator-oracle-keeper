/**
 * cross-cluster/crank-liveness.ts
 *
 * In-process liveness for the recovery crank loop.
 *
 * WHY (audit 2026-10-04, K3): on 2026-10-01 14:39:32Z the crank loop hung for 35.5 min while pushes kept
 * landing. `/health` stayed green, the process stayed up, so nothing restarted it; every engine clock fell
 * ~9.1k slots behind and opens reverted Custom(21) until a human sent SIGTERM at 15:15:00Z. The loop is
 * `await Promise.allSettled(markets.map(crank))` — ONE call that never settles stalls the whole loop, and the
 * per-market try/catch cannot help because nothing throws. Railway restarts a service only when the process
 * exits, so the loop must detect its own silence and exit.
 *
 * Every settled market crank and every finished cycle calls `beat()`. A watchdog timer (unref'd, so it never
 * keeps the process alive) checks the silence; past the limit it logs a loud line and exits non-zero.
 *
 * Limit = max(intervals x intervalMs, minSilenceMs). A restart costs ~30-60 s of pushes, so a slow-but-alive cycle must not trip it. Defaults: 2 intervals, 120 s floor (a devnet/Helius slowdown where every market takes >60 s must not restart a live keeper).
 *   CRANK_LIVENESS_INTERVALS         intervals of silence tolerated (default 2; 0 disables the watchdog)
 *   CRANK_LIVENESS_MIN_SILENCE_MS    floor on the limit (default 120000)
 */

export interface CrankLivenessOptions {
  /** The crank loop's cycle interval. */
  intervalMs: number;
  /** Intervals of silence tolerated before the process exits. 0 disables the watchdog. */
  intervals?: number;
  /** Floor on the silence limit, ms. */
  minSilenceMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** What to do on a stall. Default: log a loud line and `process.exit(1)`. */
  onStall?: (silentMs: number, limitMs: number) => void;
}

export interface CrankLiveness {
  /** The crank loop made progress (a market crank settled, or a cycle finished). */
  beat(): void;
  /** ms since the last beat (or since creation). */
  silentMs(): number;
  /** The silence limit, ms; null when disabled. */
  limitMs(): number | null;
  /** One watchdog check. Returns true when it declared a stall. */
  check(): boolean;
  /** Start the watchdog timer. Returns a stop function. */
  start(): () => void;
}

export const DEFAULT_LIVENESS_INTERVALS = 2;
export const DEFAULT_LIVENESS_MIN_SILENCE_MS = 120_000;

export function createCrankLiveness(opts: CrankLivenessOptions): CrankLiveness {
  // GH#165: validate the value we are HANDED, not just the ones we read from env.
  // `crankLivenessOptsFromEnv` throws on garbage in CRANK_LIVENESS_* so "a typo
  // cannot silently disable the watchdog" -- but `intervalMs` arrives from the
  // caller (CRANK_INTERVAL_MS), which is exactly where the garbage came from: a
  // NaN or 0 made `enabled` false, so `limitMs()` was null and `check()` returned
  // early forever. That is the watchdog turning itself off, silently, which is
  // the failure it exists to catch.
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
    throw new Error(
      `createCrankLiveness: intervalMs must be a finite positive number (got: ${String(opts.intervalMs)}) — ` +
        `a NaN/zero value disables the crank-liveness watchdog`,
    );
  }
  const now = opts.now ?? Date.now;
  const intervals = opts.intervals ?? DEFAULT_LIVENESS_INTERVALS;
  const minSilenceMs = opts.minSilenceMs ?? DEFAULT_LIVENESS_MIN_SILENCE_MS;
  const enabled = intervals > 0 && opts.intervalMs > 0;
  const limit = enabled ? Math.max(intervals * opts.intervalMs, minSilenceMs) : null;
  let last = now();
  let stalled = false;

  const onStall =
    opts.onStall ??
    ((silentMs: number, limitMs: number) => {
      console.error(
        `[cranker][ALERT] CRANK LOOP SILENT for ${Math.round(silentMs / 1000)}s (limit ${Math.round(limitMs / 1000)}s = ` +
          `${intervals} intervals): the loop is hung or dead while pushes may still land. Exiting 1 so the platform restarts it.`,
      );
      // Give the line a moment to flush; the timer is the only thing still running, so exit is safe.
      setTimeout(() => process.exit(1), 250);
    });

  const self: CrankLiveness = {
    beat() {
      last = now();
    },
    silentMs() {
      return now() - last;
    },
    limitMs() {
      return limit;
    },
    check() {
      if (limit === null || stalled) return false;
      const silent = now() - last;
      if (silent <= limit) return false;
      stalled = true; // fire once; the exit is already scheduled
      onStall(silent, limit);
      return true;
    },
    start() {
      if (limit === null) return () => undefined;
      const every = Math.max(1_000, Math.min(10_000, Math.floor(limit / 4)));
      const t = setInterval(() => self.check(), every);
      t.unref();
      return () => clearInterval(t);
    },
  };
  return self;
}

/** Options from env (see the header). Throws on garbage so a typo cannot silently disable the watchdog. */
export function crankLivenessOptsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  intervalMs: number,
): CrankLivenessOptions {
  const int = (name: string, fallback: number, allowZero: boolean): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
      throw new Error(`${name}="${raw}" must be ${allowZero ? "a non-negative" : "a positive"} integer`);
    }
    return n;
  };
  return {
    intervalMs,
    intervals: int("CRANK_LIVENESS_INTERVALS", DEFAULT_LIVENESS_INTERVALS, true),
    minSilenceMs: int("CRANK_LIVENESS_MIN_SILENCE_MS", DEFAULT_LIVENESS_MIN_SILENCE_MS, false),
  };
}
