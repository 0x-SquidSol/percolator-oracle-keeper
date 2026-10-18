/**
 * cross-cluster/mark-smoother.ts — robust AuthMark from noisy spot readings.
 *
 * WHY THIS EXISTS (2026-07-31, the CATE LP drain — part 2)
 * --------------------------------------------------------
 * The slot watermark (price-reader.ts) removed stale-RPC flapping — and the
 * two-level ±1.6% oscillation on CATE SURVIVED it. Direct mainnet sampling at
 * strictly increasing slots proved the pool itself oscillates: the token was
 * being bot-churned (25 swaps/second; +0.66% moves within 4 slots), with
 * round-trips flipping the spot between two levels for runs of 30–60s.
 *
 * Publishing raw instantaneous spot as the settlement mark feeds that
 * oscillation straight into the engine, which ratchets it into permanent LP
 * losses (losses realize in full; gains for an underwater account are
 * support-gated to zero). Real bot churn is normal for a trending memecoin,
 * so the mark — not the market — has to absorb it.
 *
 * THE ESTIMATOR: per-pool median over a trailing time window (default 90s at
 * the keeper's ~7s cadence ≈ 12 samples).
 *   - A ping-pong where one level holds a majority of the window: the median
 *     sits ON the majority level and never flips.
 *   - A perfectly balanced ping-pong: the median sits between the two levels —
 *     which IS the fair price of a round-tripping pool.
 *   - A genuine sustained move: the median follows with ~half-window lag
 *     (~45s), which the engine's own 4 bps/slot absorption clamp makes
 *     irrelevant.
 *   - An EWMA was rejected: it never fully rejects the transient level (every
 *     excursion drags the mean), and it is not robust to a single wild
 *     outlier. The median ignores both until they hold a majority.
 *
 * Cold start / gaps: below `minSamples` readings the smoother withholds the
 * mark instead of publishing raw spot. This keeps a freshly listed market and a
 * post-outage / post-eviction pool from using a single unfiltered reading as the
 * settlement mark.
 */

interface Sample {
  t: number;
  px: bigint;
}

export interface MarkSmootherOptions {
  /** Trailing window the median is computed over (ms). */
  windowMs?: number;
  /** Below this many samples in the window, withhold instead of publishing raw. */
  minSamples?: number;
  /**
   * #92 — minimum TIME SPAN the window must cover before a mark is published.
   *
   * A sample COUNT alone does not defeat a timed churn attack. At the 7s default
   * cycle, minSamples=3 publishes after 21 seconds — and the CATE runs this
   * smoother was built for lasted 30-70 seconds. The first three samples would
   * therefore sit entirely inside the attack, and the median of three
   * manipulated readings is manipulated. The count gate delays publication; it
   * does not filter.
   *
   * A span gate is what the window's own reasoning already implies: "a window
   * must comfortably exceed 2x the longest churn run". That has to hold at cold
   * start too, not only in steady state.
   */
  minSpanMs?: number;
}

/**
 * 180s, not 90s: live measurement after the first deploy (2026-07-31) showed
 * CATE's churn runs stretch to 50–70s, so a 90s window still let the median's
 * majority flip about once a minute (half-gap steps of ~36 units). A window
 * must comfortably exceed 2× the longest churn run to pin the majority level;
 * 180s fully suppresses runs up to ~90s. The cost — genuine regime shifts
 * surface with ~90s lag — is immaterial: the engine only absorbs 4 bps/slot,
 * so a 160 bps move takes minutes to settle in regardless.
 */
const DEFAULT_WINDOW_MS = 180_000;
export const DEFAULT_MIN_SAMPLES = 3;
/**
 * 5/6 of the window (150s at the 180s default): comfortably beyond 2x the longest
 * observed CATE churn run (70s), matching the reasoning behind DEFAULT_WINDOW_MS,
 * and a little under the window itself so a pool that has just filled it is not
 * held back by rounding.
 *
 * Cost: after a restart a pool withholds for ~150s instead of ~21s. That is the
 * right trade — withholding leaves the previous on-chain mark in place, which is
 * stale but TRUSTED, whereas publishing early substitutes an attacker-chosen one.
 * The smoother's own note already accepts ~90s of lag as immaterial, because the
 * engine absorbs only 4 bps/slot.
 */
export const DEFAULT_MIN_SPAN_FRACTION = 5 / 6;
/** Hard per-pool cap so a misbehaving caller cannot grow memory unbounded. */
const MAX_SAMPLES_PER_POOL = 64;

/**
 * Push-cycle cadence vs the smoother window (runbook fresh-id-redeploy-plan §8
 * "keeper cadence footgun"). Samples older than `windowMs` are evicted, so with
 * a push period p the largest span the window can hold is floor(W / p) * p, and
 * it holds floor(W / p) + 1 samples. The smoother publishes only when the span
 * reaches floor(W * 5/6) AND there are >= 3 samples. With the default 15 s
 * window, CC_INTERVAL_MS of 4 s or 6 s tops out at a 12 s span (< 12.5 s):
 * the keeper NEVER pushes. 5 s only works with zero jitter — a 5.001 s cycle
 * already drops to a 10 s span.
 *
 *   never   — cannot publish even at the exact configured period (refuse to boot)
 *   fragile — publishes at the exact period but not if cycles run 2% slower (warn)
 *   ok      — robust to that jitter
 */
export type CadenceVerdict = "ok" | "fragile" | "never";

export function markCadenceCheck(
  intervalMs: number,
  windowMs: number,
  opts: { minSpanFraction?: number; minSamples?: number; jitterFraction?: number } = {},
): { verdict: CadenceVerdict; detail: string } {
  const frac = opts.minSpanFraction ?? DEFAULT_MIN_SPAN_FRACTION;
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const jitter = opts.jitterFraction ?? 0.02;
  const minSpan = Math.floor(windowMs * frac);
  const reach = (p: number) => {
    const k = Math.floor(windowMs / p);
    return { span: k * p, samples: k + 1 };
  };
  const works = (p: number) => {
    const r = reach(p);
    return r.span >= minSpan && r.samples >= minSamples;
  };
  const exact = reach(intervalMs);
  const slow = reach(intervalMs * (1 + jitter));
  const detail =
    `CC_INTERVAL_MS=${intervalMs} with CC_MARK_WINDOW_MS=${windowMs}: max span ${exact.span} ms / ${exact.samples} samples ` +
    `(needs >= ${minSpan} ms and >= ${minSamples}); at +${Math.round(jitter * 100)}% cycle time ${Math.round(slow.span)} ms / ${slow.samples}`;
  if (!works(intervalMs)) return { verdict: "never", detail };
  if (!works(intervalMs * (1 + jitter))) return { verdict: "fragile", detail };
  return { verdict: "ok", detail };
}

export interface MarkSmoother {
  /**
   * Record `priceE6` for `poolAddress` at `nowMs`.
   *
   * Returns the smoothed mark to publish this cycle, or `null` while the pool
   * is still priming/re-priming and publishing would require a raw passthrough.
   */
  smooth(poolAddress: string, priceE6: bigint, nowMs: number): bigint | null;
  /**
   * R3.24 deadline bypass: the median of the samples ALREADY in the pool's window (no new sample, no SPAN gate), or
   * null while the window holds fewer than `minSamples` readings. Only for a market whose on-chain fail-closed deadline
   * is close (push-deadline.ts): there, withholding is no longer "stale but trusted", it is an irreversible resolve at a
   * stale price.
   *
   * S3-B6 (audit 2026-10-17): the COUNT gate is NOT waived. After a restart the circuit breaker is unseeded
   * (lastPrice 0 accepts any price), so a one-read median would be bounded by nothing but the band and the engine's
   * step cap; one manipulated read could become the first published mark. The bypass therefore needs the same
   * multi-read confirmation as a normal push (minSamples, default 3 cycles); only the span requirement is relaxed.
   * Same even-count rule as `smooth`.
   */
  peek(poolAddress: string): bigint | null;
  /**
   * What the priming gate is waiting for (for /health): the samples and span the pool's window holds now, and what it
   * needs. Read-only.
   */
  status(poolAddress: string): { samples: number; spanMs: number; minSamples: number; minSpanMs: number };
  /** Drop every window (tests / registry rebuilds). */
  reset(): void;
}

/** Median of a non-empty list; even lengths average the two middles. */
function medianE6(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

export function createMarkSmoother(opts: MarkSmootherOptions = {}): MarkSmoother {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  // Derived from the window rather than absolute: the requirement is "the window
  // is substantially full", which has to scale with whatever window a caller
  // configures. 5/6 of the 180s default is 150s — comfortably beyond 2x the
  // longest observed churn run (70s), matching the window's own reasoning.
  const minSpanMs = opts.minSpanMs ?? Math.floor(windowMs * DEFAULT_MIN_SPAN_FRACTION);
  const windows = new Map<string, Sample[]>();

  return {
    smooth(poolAddress: string, priceE6: bigint, nowMs: number): bigint | null {
      let win = windows.get(poolAddress);
      if (!win) {
        win = [];
        windows.set(poolAddress, win);
      }
      win.push({ t: nowMs, px: priceE6 });
      // Evict by age, then by count (oldest first — the array is append-only
      // in time order; a caller stepping time backwards just evicts nothing).
      const cutoff = nowMs - windowMs;
      let firstLive = 0;
      while (firstLive < win.length && win[firstLive].t < cutoff) firstLive++;
      if (firstLive > 0) win.splice(0, firstLive);
      if (win.length > MAX_SAMPLES_PER_POOL) win.splice(0, win.length - MAX_SAMPLES_PER_POOL);

      if (win.length < minSamples) {
        // Do not publish a raw single/few-sample spot. This covers both first
        // listing and steady-state re-prime after a liveness gap fully evicts
        // the window.
        return null;
      }
      // #92 — a sample COUNT is not a filter against a TIMED attack. At the 7s
      // default cycle, minSamples=3 is satisfied 21 seconds after a restart, and
      // the CATE churn runs this module was built for lasted 30-70 seconds: the
      // first three samples would sit entirely inside the attack, and a median of
      // three manipulated readings is manipulated. Require the window to actually
      // SPAN the period it claims to smooth over before trusting it.
      //
      // Withholding here leaves the previously published on-chain mark in place —
      // stale, but trusted — which is strictly better than substituting one an
      // attacker chose.
      const span = win[win.length - 1].t - win[0].t;
      if (span < minSpanMs) return null;
      // Compute over an EVEN count (drop the single oldest sample when odd):
      // an odd-count median flips by parity under a balanced two-level
      // ping-pong (7:6 → level A, then 6:7 → level B every push) — the exact
      // oscillation this module exists to remove. An even count averages the
      // two middles: majority churn still pins to the majority level, and
      // balanced churn yields the stable midpoint (the fair price of a pool a
      // bot round-trips symmetrically).
      // (A single-sample window has nothing older to drop — use it as-is.)
      const usable = win.length % 2 === 0 || win.length === 1 ? win : win.slice(1);
      return medianE6(usable.map((s) => s.px));
    },
    status(poolAddress: string): { samples: number; spanMs: number; minSamples: number; minSpanMs: number } {
      const win = windows.get(poolAddress) ?? [];
      const spanMs = win.length > 1 ? win[win.length - 1].t - win[0].t : 0;
      return { samples: win.length, spanMs, minSamples, minSpanMs };
    },
    peek(poolAddress: string): bigint | null {
      const win = windows.get(poolAddress);
      // S3-B6: never a single (or few) read median, even under an urgent deadline.
      if (!win || win.length === 0 || win.length < minSamples) return null;
      const usable = win.length % 2 === 0 || win.length === 1 ? win : win.slice(1);
      return medianE6(usable.map((s) => s.px));
    },
    reset(): void {
      windows.clear();
    },
  };
}
