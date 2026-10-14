/**
 * cross-cluster/alerting.ts
 *
 * Structured health lines and alerts for the keeper (ops track, master plan
 * 2026-09-29).
 *
 * Why: "keeper healthy" used to be inferred from successful price pushes, and
 * that hid a 3.5-day engine-clock freeze (2026-09-25 -> 09-28): pushes kept
 * landing while every crank reverted. The signals that actually say a market
 * is alive are the ones this module watches:
 *
 *   - slot lag       chain slot − engine `header.current_slot` (the engine clock)
 *   - crank ok/rev   consecutive crank reverts per market
 *   - pushes/cycle   price pushes landed in each push cycle
 *   - lapsed buckets Fresh backing buckets past expiry (block one side)
 *   - bankrupt       positioned accounts with equity <= 0 not liquidated
 *   - fee jobs       fee legs that cannot be pushed (e.g. stake pool unbound)
 *   - market no-push  one market lands no push for N cycles while the board
 *                    is otherwise fine (K-1: BOME failed 46,623/46,623 cycles
 *                    while /health said ok)
 *   - mark lagging    the breaker has kept the published mark away from the
 *                    source price for a sustained period (K-3: Agency trailed
 *                    its pool by 40–160% for ~3h45m and the LP was emptied)
 *   - source frozen   the raw pool price has not changed for hours (dead pool
 *                    or a DLMM active bin that never moves)
 *   - hedged lockout  (P2b v2.1, p2b-hedged-lockout.ts) both sides of a growth asset at >= 90%
 *                    of N_cap while the vault LP is near flat
 *   - earn par-E3 gap (P2b v2.1, p2b-earn-gap.ts) a non-bound Earn vault exits priced > N bps
 *                    below its entry price for several cycles (R3-M1)
 *   - ADL reduce-only  a_long/a_short != ADL_ONE (F-3/R2): opens revert
 *                    Custom(21) (Custom(120) on the P2b program) until one whole side exits; reported with the
 *                    observed duration and both sides' OI so an abandoned
 *                    position is visible
 *
 * Output:
 *   `[health] {json}`  one line per sample batch, machine-parseable
 *   `[ALERT] {json}`   when a condition crosses its threshold, then at most
 *                      once per cooldown while it persists, and one
 *                      `[ALERT-RESOLVED] {json}` when it clears.
 *   Optional webhook:  KEEPER_ALERT_WEBHOOK_URL (https only). The body is
 *                      `{ text, alert }` — `text` works for Slack/Discord
 *                      incoming webhooks as-is. Delivery failures are logged
 *                      and never thrown: alerting must not take down a loop.
 *   Optional Telegram: KEEPER_ALERT_TELEGRAM_BOT_TOKEN + KEEPER_ALERT_TELEGRAM_CHAT_ID
 *                      (both or neither). Telegram's sendMessage needs `chat_id`,
 *                      which the webhook body does not carry, so it is its own
 *                      delivery. The token is part of the URL: never logged.
 *
 * Evaluation is a pure function of (sample, thresholds, previous state) so it
 * is unit-testable without RPC; the sink owns dedupe/cooldown and delivery.
 */

export type AlertSeverity = "warn" | "critical";

export type AlertKind =
  | "slot-lag"
  | "crank-reverts"
  | "zero-pushes"
  | "market-no-push"
  | "mark-lagging"
  | "source-frozen"
  | "lapsed-bucket"
  | "bankrupt-unliquidated"
  | "fee-leg-blocked"
  | "fee-job-failed"
  | "adl-reduce-only"
  | "loss-stale"
  | "loss-stale-prolonged"
  | "market-layout"
  | "terminal-budget-unbooked"
  | "terminal-recovery-blocked-portfolios"
  | "terminal-pda-portfolio-closed"
  | "terminal-waiting-nft-holder"
  | "vault-lp-junior-release-pending"
  | "bankrupt-close-expiring"
  | "p3-senior-draw"
  | "p3-senior-backing-exhausted"
  | "hedged-lockout"
  | "earn-par-e3-gap"
  | "pusher-takeover";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** Market label or address; "*" for keeper-wide conditions. */
  subject: string;
  message: string;
  data?: Record<string, string | number | boolean | null>;
  /**
   * Distinguishes one-shot events that must not be swallowed by the fire() cooldown
   * (e.g. two separate senior-draw bookings on the same market within the cooldown).
   */
  dedupe?: string;
}

export interface AlertThresholds {
  /** Slots the engine clock may trail the chain before alerting. */
  slotLagWarn: number;
  /** ... and before the alert is critical (the accrue-staleness cliff is ~475 slots). */
  slotLagCritical: number;
  /** Consecutive crank reverts on one market before alerting. */
  crankConsecutiveReverts: number;
  /** Consecutive push cycles that landed zero pushes (with markets registered). */
  zeroPushCycles: number;
  /** Consecutive crank cycles a lapsed bucket persists (repairs should clear it in one). */
  lapsedBucketCycles: number;
  /** Consecutive crank cycles a bankrupt account persists un-liquidated. */
  bankruptCycles: number;
  /** Minimum ms between repeats of the same (kind, subject) alert. */
  cooldownMs: number;
  /** Slots a market may stay ADL reduce-only before the alert turns critical (R2). */
  adlReduceOnlyCriticalSlots: number;
  /** Consecutive crank cycles a market may END loss-stale (stale count > 0 after the keeper's refreshes). */
  lossStaleCycles: number;
  /**
   * ms a market may stay loss-stale CONTINUOUSLY before a loud "loss-stale-prolonged" alert. Cycle counts
   * (lossStaleCycles) are cadence-dependent; this is the wall-clock bound (opens revert Custom(21) the whole time).
   */
  lossStaleProlongedMs: number;
  /** K-1: consecutive push cycles ONE market may go without a landed push. */
  marketNoPushCycles: number;
  /** K-3: ms the breaker may keep the mark away from the source before alerting. */
  markLagMs: number;
  /** K-3: ... only when the source is at least this far (percent) from the mark. */
  markLagPct: number;
  /** K-3: ms the raw pool price may stay bit-identical before a source-frozen warning. */
  sourceFrozenMs: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  slotLagWarn: 300,
  slotLagCritical: 450,
  crankConsecutiveReverts: 3,
  zeroPushCycles: 10,
  lapsedBucketCycles: 3,
  bankruptCycles: 2,
  cooldownMs: 15 * 60_000,
  adlReduceOnlyCriticalSlots: 9_000, // ~1 hour
  lossStaleCycles: 3,
  lossStaleProlongedMs: 5 * 60_000,
  marketNoPushCycles: 40, // ~1 min at the 1.5 s push cadence
  markLagMs: 120_000,
  markLagPct: 10,
  sourceFrozenMs: 2 * 3_600_000,
};

type Env = Readonly<Record<string, string | undefined>>;

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${name}="${raw}" must be a positive integer`);
  }
  return n;
}

/** Thresholds from env (ALERT_*), falling back to DEFAULT_THRESHOLDS. Throws on garbage. */
export function thresholdsFromEnv(env: Env): AlertThresholds {
  const t: AlertThresholds = {
    slotLagWarn: envInt(env, "ALERT_SLOT_LAG_WARN", DEFAULT_THRESHOLDS.slotLagWarn),
    slotLagCritical: envInt(env, "ALERT_SLOT_LAG_CRITICAL", DEFAULT_THRESHOLDS.slotLagCritical),
    crankConsecutiveReverts: envInt(env, "ALERT_CRANK_REVERTS", DEFAULT_THRESHOLDS.crankConsecutiveReverts),
    zeroPushCycles: envInt(env, "ALERT_ZERO_PUSH_CYCLES", DEFAULT_THRESHOLDS.zeroPushCycles),
    lapsedBucketCycles: envInt(env, "ALERT_LAPSED_BUCKET_CYCLES", DEFAULT_THRESHOLDS.lapsedBucketCycles),
    bankruptCycles: envInt(env, "ALERT_BANKRUPT_CYCLES", DEFAULT_THRESHOLDS.bankruptCycles),
    cooldownMs: envInt(env, "ALERT_COOLDOWN_MS", DEFAULT_THRESHOLDS.cooldownMs),
    adlReduceOnlyCriticalSlots: envInt(env, "ALERT_ADL_REDUCE_ONLY_CRITICAL_SLOTS", DEFAULT_THRESHOLDS.adlReduceOnlyCriticalSlots),
    lossStaleCycles: envInt(env, "ALERT_LOSS_STALE_CYCLES", DEFAULT_THRESHOLDS.lossStaleCycles),
    lossStaleProlongedMs: envInt(env, "ALERT_LOSS_STALE_PROLONGED_MS", DEFAULT_THRESHOLDS.lossStaleProlongedMs),
    marketNoPushCycles: envInt(env, "ALERT_MARKET_NO_PUSH_CYCLES", DEFAULT_THRESHOLDS.marketNoPushCycles),
    markLagMs: envInt(env, "ALERT_MARK_LAG_MS", DEFAULT_THRESHOLDS.markLagMs),
    markLagPct: envInt(env, "ALERT_MARK_LAG_PCT", DEFAULT_THRESHOLDS.markLagPct),
    sourceFrozenMs: envInt(env, "ALERT_SOURCE_FROZEN_MS", DEFAULT_THRESHOLDS.sourceFrozenMs),
  };
  if (t.slotLagCritical < t.slotLagWarn) {
    throw new Error("ALERT_SLOT_LAG_CRITICAL must be >= ALERT_SLOT_LAG_WARN");
  }
  return t;
}

// ── Per-market crank health ──────────────────────────────────────────────────

/** What the recovery cranker observed for one market in one cycle. */
export interface CrankHealthSample {
  label: string;
  market: string;
  /** Slot the market account was read at. */
  chainSlot: bigint;
  /** Engine `header.current_slot` in that read; null when the header did not decode. */
  engineSlot: bigint | null;
  /** Crank landed clean this cycle (preflight ok + sent). */
  crankOk: boolean;
  /** Crank reverted in preflight this cycle. */
  crankReverted: boolean;
  totalOk: number;
  totalReverts: number;
  consecutiveReverts: number;
  lastRevertCode: number | null;
  /** Fresh backing buckets past expiry at read time. */
  lapsedBuckets: number;
  /** Bankrupt positioned accounts found in simulation this cycle. */
  bankruptFound: number;
  /** ... of which a liquidate crank was included in the landed tx. */
  bankruptLiquidated: number;
  /** ADL side factors + effective OI (adl-state.ts); null when not a v18 market header. */
  adl?: { aLong: bigint; aShort: bigint; oiEffLong: bigint; oiEffShort: bigint; reduceOnly: boolean } | null;
  /** stale_account_count_long/short at the pre-crank read (null/undefined: unknown). */
  staleLong?: number | null;
  staleShort?: number | null;
  /** Positioned portfolios targeted, refreshes that overflowed the accrual tx, and how many of those landed. */
  positioned?: number;
  overflow?: number;
  overflowRefreshed?: number;
  /** Consecutive cycles the market ENDED loss-stale (Custom(21) for every open while it lasts). */
  lossStaleCycles?: number;
  /** Layout verdict of the market account (market-layout.ts); `problem` non-null = the keeper cannot read it. */
  layout?: { id: string; problem: string | null; kind: string; accountLen: number; provisional: boolean; hasPositions: boolean | null };
  /** Drift-layout markets: continuous-sweep coverage (positioned-sweep.ts). */
  sweep?: {
    coverageRatio: number | null;
    covered: boolean;
    blocksRiskIncrease: boolean;
    laggardLong: number;
    laggardShort: number;
    pace: string;
    k: number;
    txsSent: number;
  };
}

/** Streak counters carried between cycles, per market. */
export interface CrankHealthStreaks {
  lapsedCycles: number;
  bankruptCycles: number;
  /**
   * First observation of the current reduce-only episode: chain slot + wall ms.
   * The chain keeps no "entered reduce-only at", so this is "observed since"
   * (reset by a keeper restart); `sinceBoot` flags that caveat in the alert.
   */
  reduceOnlySince: { slot: bigint; ms: number; sinceBoot: boolean } | null;
  /** True once any sample with a decoded ADL state was seen for this market. */
  adlObserved: boolean;
  /**
   * Wall ms of the first cycle of the current CONTINUOUS loss-stale episode (null = not loss-stale).
   * "Observed since": a keeper restart resets it. Optional so older literals still type-check.
   */
  lossStaleSince?: number | null;
}

export function freshStreaks(): CrankHealthStreaks {
  return { lapsedCycles: 0, bankruptCycles: 0, reduceOnlySince: null, adlObserved: false, lossStaleSince: null };
}

const ADL_ONE_ = 1_000_000_000_000_000n;
function frac(a: bigint): string {
  const x = (a * 1_000_000n) / ADL_ONE_;
  return `${x / 1_000_000n}.${(x % 1_000_000n).toString().padStart(6, "0")}`;
}

export function slotLag(s: Pick<CrankHealthSample, "chainSlot" | "engineSlot">): number | null {
  if (s.engineSlot === null) return null;
  const lag = s.chainSlot - s.engineSlot;
  return Number(lag < 0n ? 0n : lag);
}

/**
 * Evaluate one market sample. Returns the alerts that are ACTIVE now and the
 * updated streaks. Pure.
 */
export function evaluateCrankHealth(
  s: CrankHealthSample,
  prev: CrankHealthStreaks,
  t: AlertThresholds,
  nowMs: number = Date.now(),
): { active: Alert[]; streaks: CrankHealthStreaks } {
  const active: Alert[] = [];
  // ADL reduce-only (F-3/R2). Unknown (null/undefined) never alerts and never
  // resets an episode: a single undecodable read is not evidence it ended.
  let reduceOnlySince = prev.reduceOnlySince;
  if (s.adl) {
    if (!s.adl.reduceOnly) {
      reduceOnlySince = null;
    } else {
      reduceOnlySince = reduceOnlySince ?? { slot: s.chainSlot, ms: nowMs, sinceBoot: !prev.adlObserved };
      const slots = s.chainSlot > reduceOnlySince.slot ? s.chainSlot - reduceOnlySince.slot : 0n;
      const minutes = Math.floor((nowMs - reduceOnlySince.ms) / 60_000);
      const { aLong, aShort, oiEffLong, oiEffShort } = s.adl;
      const oneSideEmpty = oiEffLong === 0n || oiEffShort === 0n;
      active.push({
        kind: "adl-reduce-only",
        severity: slots >= BigInt(t.adlReduceOnlyCriticalSlots) ? "critical" : "warn",
        subject: s.label,
        message:
          `ADL reduce-only for >= ${slots} slots (~${minutes} min observed${reduceOnlySince.sinceBoot ? ", since keeper boot" : ""}): ` +
          `a_long=${frac(aLong)} a_short=${frac(aShort)} x ADL_ONE; OI long ${oiEffLong} / short ${oiEffShort}. ` +
          "Opens revert Custom(21) until one whole side exits; holders exit with tag 44 RebalanceReduce" +
          (oneSideEmpty ? "." : ". Both sides still hold OI — an abandoned position keeps the market reduce-only (R2)."),
        data: {
          market: s.market,
          aLong: aLong.toString(),
          aShort: aShort.toString(),
          oiEffLong: oiEffLong.toString(),
          oiEffShort: oiEffShort.toString(),
          reduceOnlySlots: Number(slots),
          reduceOnlyMinutes: minutes,
          sinceSlot: reduceOnlySince.slot.toString(),
        },
      });
    }
  }
  const lag = slotLag(s);
  if (lag !== null && lag >= t.slotLagWarn) {
    active.push({
      kind: "slot-lag",
      severity: lag >= t.slotLagCritical ? "critical" : "warn",
      subject: s.label,
      message:
        `engine clock ${lag} slots behind chain (engine ${s.engineSlot} vs chain ${s.chainSlot}) — ` +
        "cranks are not advancing this market; risk-increasing trades will revert Custom(21) past the staleness cliff",
      data: { lag, engineSlot: String(s.engineSlot), chainSlot: String(s.chainSlot), market: s.market },
    });
  }
  if (s.consecutiveReverts >= t.crankConsecutiveReverts) {
    active.push({
      kind: "crank-reverts",
      severity: "critical",
      subject: s.label,
      message: `crank reverted ${s.consecutiveReverts}x consecutively (last Custom(${s.lastRevertCode ?? "?"}))`,
      data: { consecutive: s.consecutiveReverts, lastCode: s.lastRevertCode, ok: s.totalOk, rev: s.totalReverts, market: s.market },
    });
  }
  if (s.layout?.problem) {
    // Never silent: the keeper is sending the accrual crank only and refreshing NO portfolio on this
    // market. Critical unless the read proves the market holds no position (then nothing can go stale).
    active.push({
      kind: "market-layout",
      severity: s.layout.hasPositions === false ? "warn" : "critical",
      subject: s.label,
      message:
        `market account layout ${s.layout.kind === "unknown" ? "UNKNOWN" : "unsupported"} (${s.layout.problem}) — ` +
        "positioned portfolios are NOT being refreshed; opens will revert loss-stale once funding accrues. " +
        "Update the layout table (market-layout.ts) / the SDK portfolio parser.",
      data: { market: s.market, layout: s.layout.id, kind: s.layout.kind, accountLen: s.layout.accountLen, hasPositions: s.layout.hasPositions },
    });
  }
  const lsc = s.lossStaleCycles ?? 0;
  if (lsc >= t.lossStaleCycles) {
    active.push({
      kind: "loss-stale",
      severity: "critical",
      subject: s.label,
      message:
        `market still loss-stale after ${lsc} consecutive crank cycles (stale ${s.staleLong ?? "?"}L/${s.staleShort ?? "?"}S, ` +
        `positioned ${s.positioned ?? "?"}, overflow ${s.overflow ?? 0}, follow-up refreshed ${s.overflowRefreshed ?? 0}) — ` +
        "every risk-increasing trade reverts Custom(21) until each positioned portfolio is refreshed",
      data: {
        market: s.market,
        cycles: lsc,
        staleLong: s.staleLong ?? null,
        staleShort: s.staleShort ?? null,
        positioned: s.positioned ?? null,
        overflow: s.overflow ?? 0,
        overflowRefreshed: s.overflowRefreshed ?? 0,
      },
    });
  }
  // Wall-clock bound on a continuous loss-stale episode. Cycles that end loss-stale extend it; the first
  // clean cycle ends it. A loud, critical line so the operator is paged instead of finding out from users.
  const lossStaleSince = lsc > 0 ? (prev.lossStaleSince ?? nowMs) : null;
  if (lossStaleSince !== null && nowMs - lossStaleSince > t.lossStaleProlongedMs) {
    const minutes = Math.floor((nowMs - lossStaleSince) / 60_000);
    active.push({
      kind: "loss-stale-prolonged",
      severity: "critical",
      subject: s.label,
      message:
        `LOSS-STALE for > ${Math.floor(t.lossStaleProlongedMs / 60_000)} min (~${minutes} min observed, ${lsc} consecutive cycles): ` +
        `stale ${s.staleLong ?? "?"}L/${s.staleShort ?? "?"}S, positioned ${s.positioned ?? "?"}, overflow ${s.overflow ?? 0}. ` +
        "Every risk-increasing trade reverts Custom(21) and users are told to wait; it is NOT clearing on its own.",
      data: {
        market: s.market,
        lossStaleMinutes: minutes,
        cycles: lsc,
        staleLong: s.staleLong ?? null,
        staleShort: s.staleShort ?? null,
        positioned: s.positioned ?? null,
        overflow: s.overflow ?? 0,
        sinceMs: lossStaleSince,
      },
    });
  }
  const lapsedCycles = s.lapsedBuckets > 0 ? prev.lapsedCycles + 1 : 0;
  if (lapsedCycles >= t.lapsedBucketCycles) {
    active.push({
      kind: "lapsed-bucket",
      severity: "warn",
      subject: s.label,
      message: `${s.lapsedBuckets} lapsed backing bucket(s) for ${lapsedCycles} cycles — the expiry repair is not landing; one side cannot trade`,
      data: { lapsedBuckets: s.lapsedBuckets, cycles: lapsedCycles, market: s.market },
    });
  }
  const unliquidated = Math.max(0, s.bankruptFound - s.bankruptLiquidated);
  const bankruptCycles = unliquidated > 0 ? prev.bankruptCycles + 1 : 0;
  if (bankruptCycles >= t.bankruptCycles) {
    active.push({
      kind: "bankrupt-unliquidated",
      severity: "critical",
      subject: s.label,
      message: `${unliquidated} bankrupt account(s) not liquidated for ${bankruptCycles} cycles — losses keep growing against the backstop`,
      data: { bankrupt: s.bankruptFound, liquidated: s.bankruptLiquidated, cycles: bankruptCycles, market: s.market },
    });
  }
  return { active, streaks: { lapsedCycles, bankruptCycles, reduceOnlySince, adlObserved: prev.adlObserved || !!s.adl, lossStaleSince } };
}

/** Compact JSON for the `[health]` line. */
export function crankHealthRecord(s: CrankHealthSample): Record<string, string | number | null> {
  return {
    m: s.label,
    lag: slotLag(s),
    ok: s.totalOk,
    rev: s.totalReverts,
    cons: s.consecutiveReverts,
    lapsed: s.lapsedBuckets,
    bankrupt: s.bankruptFound,
    liq: s.bankruptLiquidated,
    ...(s.staleLong != null ? { stL: s.staleLong, stS: s.staleShort ?? null } : {}),
    ...(s.positioned ? { pos: s.positioned } : {}),
    ...(s.overflow ? { ovf: s.overflow, ovfOk: s.overflowRefreshed ?? 0 } : {}),
    lsc: s.lossStaleCycles ?? 0,
    ...(s.layout ? { lay: s.layout.id, ...(s.layout.problem ? { layErr: 1 } : {}) } : {}),
    ...(s.sweep
      ? {
          cov: s.sweep.coverageRatio,
          cvd: Number(s.sweep.covered),
          blk: Number(s.sweep.blocksRiskIncrease),
          lgL: s.sweep.laggardLong,
          lgS: s.sweep.laggardShort,
          pace: s.sweep.pace,
          k: s.sweep.k,
          stx: s.sweep.txsSent,
        }
      : {}),
    ...(s.adl?.reduceOnly
      ? { ro: 1, aL: frac(s.adl.aLong), aS: frac(s.adl.aShort), oiL: s.adl.oiEffLong.toString(), oiS: s.adl.oiEffShort.toString() }
      : {}),
  };
}

// ── Push-cycle health ────────────────────────────────────────────────────────

export interface PushCycleSample {
  cycle: number;
  registered: number;
  attempted: number;
  pushed: number;
}

export function evaluatePushCycle(
  s: PushCycleSample,
  prevZeroStreak: number,
  t: AlertThresholds,
): { active: Alert[]; zeroStreak: number } {
  const zeroStreak = s.registered > 0 && s.pushed === 0 ? prevZeroStreak + 1 : 0;
  const active: Alert[] = [];
  if (zeroStreak >= t.zeroPushCycles) {
    active.push({
      kind: "zero-pushes",
      severity: "critical",
      subject: "*",
      message: `no price push landed for ${zeroStreak} consecutive cycles (${s.registered} markets registered, ${s.attempted} attempted last cycle) — every AuthMark is frozen`,
      data: { zeroStreak, registered: s.registered, attempted: s.attempted },
    });
  }
  return { active, zeroStreak };
}

// ── Per-market push health (K-1, K-3) ───────────────────────────────────────

/** What the push loop knows about one market after a cycle. */
export interface MarketPushSample {
  label: string;
  market: string;
  /** Consecutive cycles without a landed push. */
  noPushCycles: number;
  /** Last push landed at (unix ms); null = never since boot. */
  lastPushAt: number | null;
  lastError: string | null;
  /** The breaker's open gap episode, or null. */
  markGap: { pct: number; ageMs: number; checks: number; dir: 1 | -1 } | null;
  /** Raw pool price unchanged since (unix ms); null = no price read yet. */
  sourceUnchangedSince: number | null;
  /** No push expected (last seen Resolved/closed, or no longer registered): never degraded, never alerted. */
  terminal: boolean;
}

export type MarketPushStatus = "ok" | "no-push" | "mark-lagging";

/**
 * Per-market verdict for /health and the alert set. Pure. "no-push" outranks
 * "mark-lagging": a market that pushes nothing is frozen whatever the gap.
 * source-frozen is a warning only and does not change the status (a quiet
 * pool can legitimately sit on one price).
 */
export function evaluateMarketPush(
  s: MarketPushSample,
  t: AlertThresholds,
  nowMs: number = Date.now(),
): { status: MarketPushStatus; active: Alert[] } {
  if (s.terminal) return { status: "ok", active: [] };
  const active: Alert[] = [];
  let status: MarketPushStatus = "ok";
  if (s.noPushCycles >= t.marketNoPushCycles) {
    status = "no-push";
    const ago = s.lastPushAt === null ? "never since keeper boot" : `${Math.floor((nowMs - s.lastPushAt) / 1000)}s ago`;
    active.push({
      kind: "market-no-push",
      severity: "critical",
      subject: s.label,
      message:
        `no price push landed for ${s.noPushCycles} consecutive cycles (last push ${ago}; last error: ${s.lastError ?? "none"}) — ` +
        "this market's AuthMark is frozen while the rest of the board pushes",
      data: { market: s.market, noPushCycles: s.noPushCycles, lastPushAt: s.lastPushAt, lastError: s.lastError },
    });
  }
  const g = s.markGap;
  if (g && g.ageMs >= t.markLagMs && g.pct >= t.markLagPct) {
    if (status === "ok") status = "mark-lagging";
    active.push({
      kind: "mark-lagging",
      severity: "critical",
      subject: s.label,
      message:
        `the published mark has been held ${g.pct.toFixed(1)}% ${g.dir > 0 ? "BELOW" : "ABOVE"} the source price for ` +
        `${Math.floor(g.ageMs / 1000)}s (${g.checks} checks) by the circuit breaker. The mark can only move toward the source, ` +
        `so a ${g.dir > 0 ? "long" : "short"} opened now is a free option against the LP. Consider pausing the market.`,
      data: { market: s.market, gapPct: Number(g.pct.toFixed(2)), gapAgeMs: g.ageMs, checks: g.checks, dir: g.dir },
    });
  }
  if (s.sourceUnchangedSince !== null && nowMs - s.sourceUnchangedSince >= t.sourceFrozenMs) {
    const mins = Math.floor((nowMs - s.sourceUnchangedSince) / 60_000);
    active.push({
      kind: "source-frozen",
      severity: "warn",
      subject: s.label,
      message:
        `the pool price has not changed for ${mins} min — the pool may be dead or its active bin never moves; ` +
        "the keeper keeps republishing it as a fresh mark",
      data: { market: s.market, unchangedMinutes: mins },
    });
  }
  return { status, active };
}

// ── Sink: dedupe, cooldown, delivery ─────────────────────────────────────────

export type WebhookPoster = (url: string, body: string) => Promise<void>;

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

export interface AlertSinkOptions {
  thresholds: AlertThresholds;
  webhookUrl?: string;
  telegram?: TelegramTarget;
  post?: WebhookPoster;
  now?: () => number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

const defaultPost: WebhookPoster = async (url, body) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Validate the webhook URL. https only: the URL is itself a credential for
 * most webhook providers, and alerts carry market state. Returns the URL, or
 * throws with a message that does NOT echo the URL (it would land in logs).
 */
export function validateWebhookUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("KEEPER_ALERT_WEBHOOK_URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("KEEPER_ALERT_WEBHOOK_URL must use https://");
  return u.toString();
}

/** Telegram Bot API base; tests point it at a local stub. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Telegram target from env. Both or neither: one without the other is a misconfiguration that must stop
 * boot (it would otherwise silently deliver nothing). Errors never echo either value.
 */
export function telegramTargetFromEnv(env: Env): TelegramTarget | undefined {
  const token = env.KEEPER_ALERT_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chat = env.KEEPER_ALERT_TELEGRAM_CHAT_ID?.trim() ?? "";
  if (token === "" && chat === "") return undefined;
  if (token === "" || chat === "") {
    throw new Error("KEEPER_ALERT_TELEGRAM_BOT_TOKEN and KEEPER_ALERT_TELEGRAM_CHAT_ID must be set together");
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("KEEPER_ALERT_TELEGRAM_BOT_TOKEN is not a bot token (<id>:<secret>)");
  if (!/^-?\d+$/.test(chat) && !/^@[A-Za-z0-9_]+$/.test(chat)) throw new Error("KEEPER_ALERT_TELEGRAM_CHAT_ID must be a numeric chat id or @channel");
  return { botToken: token, chatId: chat };
}

/**
 * Telegram is a pager, not a log: only `critical` alerts go there, an active alert re-fires there at most every
 * TELEGRAM_REPEAT_MS (independent of the 15-min cooldown the log/webhook use), and sends never block the loop
 * (one promise chain, at most TELEGRAM_QUEUE_CAP pending; beyond that messages are dropped with one log line).
 */
export const TELEGRAM_REPEAT_MS = 2 * 3_600_000;
export const TELEGRAM_QUEUE_CAP = 20;

/**
 * Boot-safe variant: a typo'd or half-set Telegram config must not crash-loop the live keeper. Logs ONE error (no
 * value echoed: telegramTargetFromEnv's messages never contain it) and starts with Telegram off.
 */
export function telegramTargetOrOff(env: Env, logError: (l: string) => void = (l) => console.error(l)): TelegramTarget | undefined {
  try {
    return telegramTargetFromEnv(env);
  } catch (err) {
    logError(`[alerting] Telegram alerts OFF: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export class AlertSink {
  private tgChain: Promise<void> = Promise.resolve();
  private tgPending = 0;
  private tgDropped = 0;
  /** Telegram-delivered alert key -> when it was last sent there (a RESOLVED goes to Telegram only for these). */
  private readonly tgLastSent = new Map<string, number>();
  /** True while reconcile() is delivering a set that itself contains zero-pushes. */
  private zeroPushesInFlight = false;
  private readonly lastSent = new Map<string, number>();
  /** Active alert key -> the severity it last fired with (echoed on RESOLVED). */
  private readonly activeKeys = new Map<string, AlertSeverity>();
  private readonly opts: Required<Omit<AlertSinkOptions, "webhookUrl" | "telegram">> & { webhookUrl?: string; telegram?: TelegramTarget };

  constructor(opts: AlertSinkOptions) {
    this.opts = {
      thresholds: opts.thresholds,
      webhookUrl: opts.webhookUrl,
      telegram: opts.telegram,
      post: opts.post ?? defaultPost,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((l) => console.log(l)),
      logError: opts.logError ?? ((l) => console.error(l)),
    };
  }

  get thresholds(): AlertThresholds {
    return this.opts.thresholds;
  }

  /** Emit one structured health line. */
  health(scope: string, record: Record<string, unknown>): void {
    this.opts.log(`[health] ${JSON.stringify({ scope, ts: new Date(this.opts.now()).toISOString(), ...record }, bigintSafe)}`);
  }

  /**
   * Report the full set of ACTIVE alerts for one scope (e.g. all markets of a
   * crank cycle). New or cooled-down alerts fire; alerts of this scope that
   * are no longer active fire a single RESOLVED line. Returns what fired.
   */
  async reconcile(scope: string, active: Alert[]): Promise<Alert[]> {
    const now = this.opts.now();
    const fired: Alert[] = [];
    const activeNow = new Set<string>();
    this.zeroPushesInFlight = active.some((a) => a.kind === "zero-pushes");
    for (const a of active) {
      const key = `${scope}|${a.kind}|${a.subject}`;
      activeNow.add(key);
      const last = this.lastSent.get(key);
      if (last === undefined || now - last >= this.opts.thresholds.cooldownMs) {
        this.lastSent.set(key, now);
        fired.push(a);
        await this.deliver("ALERT", a, key);
      }
    }
    this.zeroPushesInFlight = false;
    for (const [key, sev] of [...this.activeKeys]) {
      if (!key.startsWith(`${scope}|`) || activeNow.has(key)) continue;
      this.activeKeys.delete(key);
      this.lastSent.delete(key);
      const [, kind, subject] = key.split("|");
      await this.deliver("ALERT-RESOLVED", {
        kind: kind as AlertKind,
        severity: sev,
        subject,
        message: "condition cleared",
      }, key);
    }
    for (const a of active) this.activeKeys.set(`${scope}|${a.kind}|${a.subject}`, a.severity);
    return fired;
  }

  /** Fire a one-off alert immediately (still subject to the cooldown). */
  async fire(scope: string, a: Alert): Promise<boolean> {
    const key = `${scope}|${a.kind}|${a.subject}|${a.dedupe ?? ""}`;
    const now = this.opts.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.opts.thresholds.cooldownMs) return false;
    this.lastSent.set(key, now);
    await this.deliver("ALERT", a, key);
    return true;
  }

  /** Telegram delivery configured (and valid). */
  get telegramEnabled(): boolean {
    return this.opts.telegram !== undefined;
  }

  /** Resolves once every queued Telegram send has settled (tests; shutdown). */
  flush(): Promise<void> {
    return this.tgChain;
  }

  private zeroPushesActive(): boolean {
    if (this.zeroPushesInFlight) return true;
    for (const k of this.activeKeys.keys()) if (k.split("|")[1] === "zero-pushes") return true;
    return false;
  }

  /** Queue one Telegram message without awaiting it. Never throws, never logs the token. */
  private enqueueTelegram(tag: "ALERT" | "ALERT-RESOLVED", a: Alert, key: string, text: string): void {
    const tg = this.opts.telegram;
    if (!tg) return;
    const now = this.opts.now();
    if (tag === "ALERT") {
      if (a.severity !== "critical") return;
      // A whole-board outage is ONE page (zero-pushes), not one per market.
      if (a.kind === "market-no-push" && this.zeroPushesActive()) return;
      const last = this.tgLastSent.get(key);
      if (last !== undefined && now - last < TELEGRAM_REPEAT_MS) return;
    } else if (!this.tgLastSent.has(key)) {
      return; // never paged: nothing to resolve there
    }
    if (this.tgPending >= TELEGRAM_QUEUE_CAP) {
      if (this.tgDropped++ === 0) {
        this.opts.logError(`[alerting] telegram queue full (${TELEGRAM_QUEUE_CAP} pending): dropping further messages until it drains`);
      }
      return;
    }
    if (tag === "ALERT") this.tgLastSent.set(key, now);
    else this.tgLastSent.delete(key);
    this.tgPending++;
    const { botToken, chatId } = tg;
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
    const body = JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
    this.tgChain = this.tgChain
      .then(() => this.opts.post(url, body))
      .catch((err: unknown) => {
        // The token is in the URL: report the failure without the URL and scrub the token from the message.
        const msg = (err instanceof Error ? err.message : String(err)).split(botToken).join("<token>");
        this.opts.logError(`[alerting] telegram delivery failed: ${msg}`);
      })
      .finally(() => {
        this.tgPending--;
        if (this.tgPending === 0 && this.tgDropped > 0) {
          this.opts.logError(`[alerting] telegram queue drained; ${this.tgDropped} message(s) were dropped while it was full`);
          this.tgDropped = 0;
        }
      });
  }

  private async deliver(tag: "ALERT" | "ALERT-RESOLVED", a: Alert, key: string): Promise<void> {
    const line = `[${tag}] ${JSON.stringify(a, bigintSafe)}`;
    if (tag === "ALERT") this.opts.logError(line);
    else this.opts.log(line);
    if (!this.opts.webhookUrl && !this.opts.telegram) return;
    const text = `${tag === "ALERT" ? `[${a.severity.toUpperCase()}]` : "[RESOLVED]"} percolator-keeper ${a.kind} ${a.subject}: ${a.message}`;
    if (this.opts.webhookUrl) {
      try {
        await this.opts.post(this.opts.webhookUrl, JSON.stringify({ text, alert: a }, bigintSafe));
      } catch (err) {
        // Never echo the URL — it is a credential.
        this.opts.logError(`[alerting] webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.enqueueTelegram(tag, a, key, text);
  }
}

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/**
 * Process-wide sink, configured from env. Lazily created so importing this
 * module in tests has no side effects.
 */
let shared: AlertSink | null = null;
export function getAlertSink(): AlertSink {
  if (!shared) {
    shared = new AlertSink({
      thresholds: thresholdsFromEnv(process.env),
      webhookUrl: validateWebhookUrl(process.env.KEEPER_ALERT_WEBHOOK_URL),
      telegram: telegramTargetOrOff(process.env),
    });
  }
  return shared;
}
