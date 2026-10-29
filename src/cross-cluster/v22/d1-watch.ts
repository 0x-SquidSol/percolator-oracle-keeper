/**
 * cross-cluster/v22/d1-watch.ts
 *
 * D1 monitoring (decision 2026-10-22, L7 §4): on a v2.2 BAND market every liquidation is an engine unilateral close that
 * scales the opposite side's A below ADL_ONE, and the engine then refuses every risk-increasing change (Custom(120) on
 * the RC) until that side resets. The RC's answer is tag 104 (`handle_adl_wind_down`): once the episode is older than
 * the wind-down bound (default 9,000 slots, about 1 h; `adl_effective_max_episode_slots`) ANYONE may force-close a leg at
 * the mark. Upstream has the identical gate and no relaxation, so the episode is expected behaviour and the wind-down is
 * the exit. This module makes that exit a MONITORED duty. It is READ-ONLY: it sends nothing.
 *
 * What it watches, per band market and asset (decoded with the same K-9 decoder as /health `adl`):
 *   - CLOSE-ONLY: `a_long != ADL_ONE || a_short != ADL_ONE` (the engine's reduce-only predicate). Reported on /health with
 *     the observed episode age; alerted as `adl-close-only` at WARN (the sink logs warns, Telegram takes criticals), so
 *     every episode is visible without paging. Organically this recurs about every 30 min on a volatile 20x market.
 *   - WIND-DOWN OVERDUE: the episode has outlived the bound plus a grace (default 1,500 slots, about 10 min, which covers
 *     the arming call and one crank) and is STILL close-only: no wind-down landed. CRITICAL `adl-wind-down-overdue`.
 *     The message states what the wind-down needs (arming call first, a fresh committed mark, the leg's live
 *     portfolio_id / position_epoch) so the operator can send it or find the blocker. A landed wind-down (or any side
 *     reset) clears the episode and the alert resolves.
 *   - The vault-LP crank (lp-cert-liveness.ts, alert `vault-lp-crank-stale`) is the other half of the same SLA; /health
 *     `v22.d1` rolls both up so one field answers "is anything stuck".
 *
 * EPISODE AGE is OBSERVED, not read from chain: the age counts from the first read in which the keeper saw the market
 * close-only (in-process, per market+asset). A keeper restart inside an episode restarts the count, so the age is a LOWER
 * bound (the alert can only be late, never early) and `/health` says so (`observedSinceSlot`). The engine's own episode
 * start is the arming slot, which only exists once a tag 104 call armed it, so it cannot be used to detect the episodes
 * nobody armed. Unreadable / undecodable reads keep the previous state (a flaky read neither raises nor resolves).
 *
 * Thresholds (boot-safe: garbage logs one error and keeps the default):
 *   ALERT_ADL_WIND_DOWN_BOUND_SLOTS  the tag-104 episode bound to compare against (default 9,000; tighten-only per asset
 *                                    on chain, so a lower on-chain override pages LATE, never early: set it to match)
 *   ALERT_ADL_WIND_DOWN_GRACE_SLOTS  slots past the bound before the wind-down is called overdue (default 1,500)
 */
import type { Alert } from "../alerting.ts";

/** Tag 104's default episode bound (`adl_effective_max_episode_slots`, RC2.2 v16_program.rs, 9,000 slots, about 1 h). */
export const DEFAULT_ADL_WIND_DOWN_BOUND_SLOTS = 9_000n;
/** Slots past the bound before "no wind-down landed" is a critical (arm call + crank + a retry). */
export const DEFAULT_ADL_WIND_DOWN_GRACE_SLOTS = 1_500n;

export const ADL_D1_ALERT_SCOPE = "v22-adl-close-only";

export interface AdlD1Thresholds {
  boundSlots: bigint;
  graceSlots: bigint;
}

export const DEFAULT_ADL_D1_THRESHOLDS: AdlD1Thresholds = {
  boundSlots: DEFAULT_ADL_WIND_DOWN_BOUND_SLOTS,
  graceSlots: DEFAULT_ADL_WIND_DOWN_GRACE_SLOTS,
};

type Env = Readonly<Record<string, string | undefined>>;

/** Boot-safe thresholds from env: an invalid value logs ONE error and the default is kept (never a crash, never off). */
export function adlD1ThresholdsFromEnv(env: Env, logError: (l: string) => void = (l) => console.error(l)): AdlD1Thresholds {
  const slots = (name: string, fallback: bigint): bigint => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^[0-9]+$/.test(raw.trim()) || BigInt(raw.trim()) < 1n || BigInt(raw.trim()) > 10_000_000n) {
      logError(`[v22][d1] ${name}="${raw}" must be an integer number of slots in 1..10,000,000; using the default ${fallback}`);
      return fallback;
    }
    return BigInt(raw.trim());
  };
  return {
    boundSlots: slots("ALERT_ADL_WIND_DOWN_BOUND_SLOTS", DEFAULT_ADL_WIND_DOWN_BOUND_SLOTS),
    graceSlots: slots("ALERT_ADL_WIND_DOWN_GRACE_SLOTS", DEFAULT_ADL_WIND_DOWN_GRACE_SLOTS),
  };
}

/** One asset's close-only state at one read. */
export interface AdlAssetReading {
  assetIndex: number;
  /** `a_long != ADL_ONE || a_short != ADL_ONE`. */
  closeOnly: boolean;
  oiEffLong: bigint;
  oiEffShort: bigint;
  aLong: bigint;
  aShort: bigint;
}

export interface AdlEpisode {
  assetIndex: number;
  /** First slot at which THIS keeper process saw the asset close-only. */
  observedSinceSlot: bigint;
  ageSlots: bigint;
  /** True when the episode was already running at the first read after boot (age is then a lower bound). */
  sinceBoot: boolean;
  level: "close-only" | "wind-down-due" | "overdue";
  /** Slots until the bound (0 once past it). */
  slotsToBound: bigint;
}

/** Pure: level of an episode of `ageSlots` against the thresholds. */
export function adlEpisodeLevel(ageSlots: bigint, t: AdlD1Thresholds): AdlEpisode["level"] {
  if (ageSlots >= t.boundSlots + t.graceSlots) return "overdue";
  if (ageSlots >= t.boundSlots) return "wind-down-due";
  return "close-only";
}

export interface AdlD1Summary {
  /** Assets currently close-only. */
  episodes: AdlEpisode[];
  /** Episodes that ended since boot, and the longest one (slots). */
  endedEpisodes: number;
  longestEndedSlots: string;
  /** Ended episodes that had outlived the bound (a wind-down, or an organic side reset, finished them late). */
  endedPastBound: number;
}

/**
 * Per-market episode tracker. `observe` is fed one reading set per good read; it never throws and a market that was never
 * observed has no episodes. State is in memory (see the header: a restart makes ages lower bounds).
 */
export class AdlEpisodeTracker {
  private readonly since = new Map<number, { slot: bigint; sinceBoot: boolean }>();
  private observedOnce = false;
  private ended = 0;
  private longest = 0n;
  private endedPastBound = 0;

  constructor(private readonly t: AdlD1Thresholds) {}

  observe(readings: ReadonlyArray<AdlAssetReading>, nowSlot: bigint): AdlEpisode[] {
    const first = !this.observedOnce;
    this.observedOnce = true;
    const seen = new Set<number>();
    const out: AdlEpisode[] = [];
    for (const r of readings) {
      seen.add(r.assetIndex);
      if (!r.closeOnly) {
        this.close(r.assetIndex, nowSlot);
        continue;
      }
      let s = this.since.get(r.assetIndex);
      if (!s) {
        s = { slot: nowSlot, sinceBoot: first };
        this.since.set(r.assetIndex, s);
      }
      const age = nowSlot > s.slot ? nowSlot - s.slot : 0n;
      out.push({
        assetIndex: r.assetIndex,
        observedSinceSlot: s.slot,
        ageSlots: age,
        sinceBoot: s.sinceBoot,
        level: adlEpisodeLevel(age, this.t),
        slotsToBound: age >= this.t.boundSlots ? 0n : this.t.boundSlots - age,
      });
    }
    // an asset that vanished from the readings (retired / not in the account) ends its episode
    for (const k of [...this.since.keys()]) if (!seen.has(k)) this.close(k, nowSlot);
    return out;
  }

  /** The market is terminal / not a band market: every episode is over. */
  reset(nowSlot: bigint): void {
    for (const k of [...this.since.keys()]) this.close(k, nowSlot);
  }

  private close(assetIndex: number, nowSlot: bigint): void {
    const s = this.since.get(assetIndex);
    if (!s) return;
    this.since.delete(assetIndex);
    const age = nowSlot > s.slot ? nowSlot - s.slot : 0n;
    this.ended++;
    if (age > this.longest) this.longest = age;
    if (age >= this.t.boundSlots) this.endedPastBound++;
  }

  summary(current: ReadonlyArray<AdlEpisode>): AdlD1Summary {
    return { episodes: [...current], endedEpisodes: this.ended, longestEndedSlots: this.longest.toString(), endedPastBound: this.endedPastBound };
  }
}

export interface AdlD1Sample {
  label: string;
  market: string;
  nowSlot: bigint;
  /** Not Live / not a band market: never alerted. */
  terminal: boolean;
  episodes: ReadonlyArray<AdlEpisode>;
  readings: ReadonlyArray<AdlAssetReading>;
}

/**
 * Alerts for one market: ONE `adl-close-only` WARN per close-only asset episode (the longest first is not needed: one per
 * asset, subject carries the asset) and ONE critical `adl-wind-down-overdue` per overdue asset. Pure.
 */
export function evaluateAdlD1(s: AdlD1Sample, t: AdlD1Thresholds): Alert[] {
  if (s.terminal) return [];
  const out: Alert[] = [];
  for (const ep of s.episodes) {
    const r = s.readings.find((x) => x.assetIndex === ep.assetIndex);
    const subject = `${s.label}#${ep.assetIndex}`;
    const data = {
      market: s.market,
      assetIndex: ep.assetIndex,
      ageSlots: ep.ageSlots.toString(),
      observedSinceSlot: ep.observedSinceSlot.toString(),
      sinceBoot: ep.sinceBoot,
      boundSlots: t.boundSlots.toString(),
      graceSlots: t.graceSlots.toString(),
      nowSlot: s.nowSlot.toString(),
      ...(r ? { oiEffLong: r.oiEffLong.toString(), oiEffShort: r.oiEffShort.toString() } : {}),
    };
    const oi = r ? ` OI long ${r.oiEffLong} / short ${r.oiEffShort}.` : "";
    out.push({
      kind: "adl-close-only",
      severity: "warn",
      subject,
      message:
        `band market close-only (A != 1 after a unilateral close) for >= ${ep.ageSlots} slots${ep.sinceBoot ? " (observed since keeper boot)" : ""}.${oi} ` +
        `Risk-increasing changes revert until one side resets; tag 104 (ADL wind-down) may force-close legs at the mark from ${t.boundSlots} slots ` +
        (ep.slotsToBound > 0n ? `(${ep.slotsToBound} slots from now).` : "(already eligible)."),
      data,
    });
    if (ep.level === "overdue") {
      out.push({
        kind: "adl-wind-down-overdue",
        severity: "critical",
        subject,
        message:
          `band market STILL close-only ${ep.ageSlots} slots after the episode began (wind-down bound ${t.boundSlots} + grace ${t.graceSlots}): no ADL wind-down landed.${oi} ` +
          "Tag 104 needs an arming call first (it closes nothing), then, once the bound has passed, a fresh committed mark (a lagging or pending mark answers 21, " +
          "a mark older than 150 slots answers 27) and the leg's live (portfolio_id, position_epoch) (stale binding answers 16); a deficit account is refused (liquidation owns it). " +
          "Check the mark push and the crank, then send the wind-down for the reduce-only side's holders.",
        data,
      });
    }
  }
  return out;
}
