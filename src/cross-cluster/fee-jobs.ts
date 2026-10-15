/**
 * cross-cluster/fee-jobs.ts
 *
 * One loop for every "move accrued value to where it belongs" job the keeper
 * runs: tag 78 LP-fee crank, tag 87 -> stake AccrueFees push, and whatever
 * later phases add (P3 vault-owned LP: NAV / fee sweeps into the Earn vault).
 *
 * A job is a per-market function returning a classified outcome. The loop
 * owns cadence, bounded concurrency, the cycle summary, the structured
 * `[health]` line and alerting — a new job gets all of that by being added
 * to the array passed to `startFeeJobLoop`.
 *
 * Outcome kinds, and what they mean for alerting:
 *   done     value moved this cycle (logged)
 *   nothing  healthy no-op, e.g. "no new fees" (counted, silent)
 *   skipped  a precondition that is normal (no vault, no real stakers yet)
 *   blocked  needs operator action (e.g. stake pool not bound) -> alert
 *   waiting  a refusal the keeper itself is about to clear (R3.20: OracleStale on a market whose stale-resolve
 *            window matured, cleared by the next mark push). Retried next cycle; warns only if it persists
 *            FEE_JOB_WAITING_ALERT_AFTER cycles (pushes not landing)
 *   failed   unexpected error -> alert after it repeats
 */
import type { Connection, Keypair } from "@solana/web3.js";
import type { MarketEntry, Registry } from "./registry.ts";
import type { Alert, AlertKind, AlertSeverity, AlertSink } from "./alerting.ts";
import { clipKeepingCode } from "./fee-error.ts";

export type FeeJobOutcome = (
  | { kind: "done"; detail: string; signature?: string }
  | { kind: "nothing"; detail?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "blocked"; reason: string; alertKind?: AlertKind; severity?: AlertSeverity }
  | { kind: "waiting"; reason: string }
  | { kind: "failed"; error: string }
) & {
  /** One-shot events worth an alert whatever the outcome (e.g. a PDA-owned portfolio was closed). */
  events?: Alert[];
};

export interface FeeJobContext {
  conn: Connection;
  keeper: Keypair;
  dryRun: boolean;
}

export interface FeeJob {
  /** Short stable id, used in logs and alert subjects ("lp-fee", "stake-fee"). */
  name: string;
  run(ctx: FeeJobContext, market: Pick<MarketEntry, "marketAddress" | "label">): Promise<FeeJobOutcome>;
}

export interface FeeJobSweepResult {
  job: string;
  done: Array<{ market: string; label: string; detail: string }>;
  nothing: number;
  skipped: Array<{ market: string; label: string; reason: string }>;
  blocked: Array<{ market: string; label: string; reason: string; alertKind?: AlertKind; severity?: AlertSeverity }>;
  /** Optional so sweep results built elsewhere (tests, older callers) stay valid; `runFeeJobSweep` always sets it. */
  waiting?: Array<{ market: string; label: string; reason: string }>;
  failed: Array<{ market: string; label: string; error: string }>;
  /** One-shot event alerts raised by the job this sweep. */
  events: Alert[];
}

/** Markets processed in parallel per job — keeps a 19+ market sweep off the RPC rate limit. */
export const FEE_JOB_CONCURRENCY = 4;

/** Consecutive failures of one (job, market) before alerting. */
export const FEE_JOB_FAILURE_ALERT_AFTER = 3;

/**
 * Consecutive "waiting" sweeps of one (job, market) before a warn. A boot after an outage waits ONE cycle (the first
 * push lands within seconds); this many in a row means the mark pushes are not landing, which must not stay silent.
 */
export const FEE_JOB_WAITING_ALERT_AFTER = 6;

async function mapLimited<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** Run one job over every market. Never throws: a throwing job counts as "failed". */
export async function runFeeJobSweep(
  job: FeeJob,
  ctx: FeeJobContext,
  markets: ReadonlyArray<Pick<MarketEntry, "marketAddress" | "label">>,
  concurrency = FEE_JOB_CONCURRENCY,
): Promise<FeeJobSweepResult> {
  const r: FeeJobSweepResult = { job: job.name, done: [], nothing: 0, skipped: [], blocked: [], waiting: [], failed: [], events: [] };
  await mapLimited(markets, concurrency, async (m) => {
    let o: FeeJobOutcome;
    try {
      o = await job.run(ctx, m);
    } catch (err) {
      o = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    const base = { market: m.marketAddress, label: m.label };
    for (const e of o.events ?? []) r.events.push({ ...e, subject: e.subject || m.label });
    switch (o.kind) {
      case "done": r.done.push({ ...base, detail: o.detail }); break;
      case "nothing": r.nothing++; break;
      case "skipped": r.skipped.push({ ...base, reason: o.reason }); break;
      case "blocked": r.blocked.push({ ...base, reason: o.reason, alertKind: o.alertKind, severity: o.severity }); break;
      case "waiting": (r.waiting ??= []).push({ ...base, reason: o.reason }); break;
      case "failed": r.failed.push({ ...base, error: o.error }); break;
    }
  });
  return r;
}

/** Per-(job, market) failure streaks, so one transient RPC error does not page. */
export class FeeJobFailureTracker {
  private readonly streaks = new Map<string, number>();
  private readonly waitStreaks = new Map<string, number>();

  /** Update from a sweep; returns the alerts active after it. */
  alertsFor(r: FeeJobSweepResult): Alert[] {
    const failedNow = new Set(r.failed.map((f) => f.market));
    for (const key of [...this.streaks.keys()]) {
      const [job, market] = key.split("|");
      if (job === r.job && !failedNow.has(market)) this.streaks.delete(key);
    }
    const waitingNow = new Set((r.waiting ?? []).map((w) => w.market));
    for (const key of [...this.waitStreaks.keys()]) {
      const [job, market] = key.split("|");
      if (job === r.job && !waitingNow.has(market)) this.waitStreaks.delete(key);
    }
    const alerts: Alert[] = [];
    for (const w of r.waiting ?? []) {
      const key = `${r.job}|${w.market}`;
      const n = (this.waitStreaks.get(key) ?? 0) + 1;
      this.waitStreaks.set(key, n);
      if (n >= FEE_JOB_WAITING_ALERT_AFTER) {
        alerts.push({
          kind: "fee-job-failed",
          severity: "warn",
          subject: w.label,
          message: `${r.job} still waiting after ${n} consecutive cycles (the refusal the keeper should clear is not clearing): ${clipKeepingCode(w.reason, 200)}`,
          data: { job: r.job, market: w.market, waitingStreak: n },
        });
      }
    }
    for (const f of r.failed) {
      const key = `${r.job}|${f.market}`;
      const n = (this.streaks.get(key) ?? 0) + 1;
      this.streaks.set(key, n);
      if (n >= FEE_JOB_FAILURE_ALERT_AFTER) {
        alerts.push({
          kind: "fee-job-failed",
          severity: "warn",
          subject: f.label,
          message: `${r.job} failed ${n}x consecutively: ${clipKeepingCode(f.error, 160)}`,
          data: { job: r.job, market: f.market, streak: n },
        });
      }
    }
    for (const b of r.blocked) {
      alerts.push({
        kind: b.alertKind ?? "fee-leg-blocked",
        severity: b.severity ?? (b.alertKind === "terminal-budget-unbooked" || b.alertKind === "terminal-recovery-blocked-portfolios" ? "critical" : "warn"), // waiting-nft-holder: warn (accepted devnet limitation)
        subject: b.label,
        message: `${r.job} cannot move this market's fee leg: ${b.reason}`,
        data: { job: r.job, market: b.market },
      });
    }
    return alerts;
  }
}

export function summarizeSweep(r: FeeJobSweepResult): Record<string, number> {
  return {
    done: r.done.length,
    nothing: r.nothing,
    skipped: r.skipped.length,
    blocked: r.blocked.length,
    waiting: (r.waiting ?? []).length,
    failed: r.failed.length,
  };
}

export interface FeeJobLoopConfig {
  intervalMs: number;
  /** Print the per-job summary every N cycles even when nothing moved. */
  summaryEveryCycles?: number;
}

/**
 * Periodic loop over `jobs` (in order) for every registry market. Same shape
 * as the other keeper loops: never awaited by the entrypoint, never throws
 * out, isolated per market.
 */
export async function startFeeJobLoop(
  jobs: ReadonlyArray<FeeJob>,
  ctx: FeeJobContext,
  registry: Registry,
  config: FeeJobLoopConfig,
  sink: AlertSink,
): Promise<void> {
  const names = jobs.map((j) => j.name).join(", ");
  console.log(
    `[fee-jobs] loop starting: jobs=[${names}] ${registry.markets.length} markets, ` +
      `interval=${config.intervalMs}ms, mode=${ctx.dryRun ? "DRY-RUN" : "LIVE"}`,
  );
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  const trackers = new Map<string, FeeJobFailureTracker>(jobs.map((j) => [j.name, new FeeJobFailureTracker()]));
  const every = config.summaryEveryCycles ?? 20;
  let cycle = 0;
  while (!stopping) {
    const start = Date.now();
    for (const job of jobs) {
      try {
        const r = await runFeeJobSweep(job, ctx, registry.markets);
        for (const d of r.done) console.log(`[${job.name}] ${d.label}: ${d.detail}`);
        const summary = summarizeSweep(r);
        const waiting = r.waiting ?? [];
        if (r.done.length > 0 || r.failed.length > 0 || waiting.length > 0 || cycle % every === 0) {
          console.log(
            `[${job.name}] cycle ${cycle}: ${summary.done} moved, ${summary.nothing} nothing-to-do, ` +
              `${summary.skipped} skipped, ${summary.blocked} blocked, ${summary.waiting} waiting, ${summary.failed} failed` +
              (r.failed.length ? ` — ${r.failed.map((f) => `${f.label}: ${clipKeepingCode(f.error, 100)}`).join(" | ")}` : "") +
              (waiting.length ? ` — waiting: ${waiting.map((w) => `${w.label}: ${clipKeepingCode(w.reason, 100)}`).join(" | ")}` : ""),
          );
        }
        sink.health(`fee-jobs:${job.name}`, {
          cycle,
          ...summary,
          blockedMarkets: r.blocked.map((b) => b.label),
          waitingMarkets: waiting.map((w) => w.label),
          failedMarkets: r.failed.map((f) => f.label),
        });
        await sink.reconcile(`fee-jobs:${job.name}`, trackers.get(job.name)!.alertsFor(r));
        for (const e of r.events) await sink.fire(`fee-jobs:${job.name}:events`, e);
      } catch (err) {
        console.error(`[${job.name}] sweep error — ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
    }
    cycle++;
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, Math.max(1000, config.intervalMs - elapsed)));
  }
}
