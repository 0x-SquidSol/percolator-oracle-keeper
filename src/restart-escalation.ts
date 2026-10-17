/**
 * restart-escalation.ts - make a launchd/Railway crash loop LOUD.
 *
 * 2026-10-17: the v2.2 keeper restarted ~486 times and nothing said so; only the err log's tail showed it. Every
 * launch (the launcher's preflight, and the keeper itself when it was started without one) appends a timestamp
 * to a small JSON file; N launches within M minutes is "escalated":
 *   - the preflight prints an `[ALERT] {json}` line and POSTs the same text to KEEPER_ALERT_WEBHOOK_URL (https),
 *     at most once per window so a loop does not become a webhook flood;
 *   - the keeper's /health carries `restarts` {launchesInWindow, threshold, windowMin, escalated} and reports
 *     status `restart-loop` when escalated.
 * No URL, key or token is ever written to the file or logged.
 */
import fs from "node:fs";

export interface RestartRecord {
  launches: number[]; // epoch ms, pruned to the window
  lastAlertAt?: number;
}
export interface RestartHealth {
  launchesInWindow: number;
  threshold: number;
  windowMin: number;
  escalated: boolean;
  lastLaunchAgoSec: number | null;
}

export function restartConfig(env: Readonly<Record<string, string | undefined>>): { path: string | null; threshold: number; windowMs: number } {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const explicit = env.KEEPER_RESTART_LOG?.trim();
  const health = env.KEEPER_HEALTH_FILE?.trim();
  return {
    path: explicit || (health ? `${health}.restarts.json` : null),
    threshold: num(env.KEEPER_RESTART_ALERT_N, 5),
    windowMs: num(env.KEEPER_RESTART_ALERT_WINDOW_MIN, 15) * 60_000,
  };
}

function load(path: string): RestartRecord {
  try {
    const j = JSON.parse(fs.readFileSync(path, "utf8")) as RestartRecord;
    return { launches: Array.isArray(j.launches) ? j.launches.filter((n) => Number.isFinite(n)) : [], lastAlertAt: j.lastAlertAt };
  } catch {
    return { launches: [] };
  }
}

/** Append a launch. Pure but for the file. Returns the health view and whether an alert is due now. */
export function recordLaunch(
  path: string,
  now: number,
  threshold: number,
  windowMs: number,
): { health: RestartHealth; alertDue: boolean } {
  const rec = load(path);
  rec.launches = [...rec.launches.filter((t) => now - t < windowMs), now];
  const escalated = rec.launches.length >= threshold;
  const alertDue = escalated && (rec.lastAlertAt === undefined || now - rec.lastAlertAt >= windowMs);
  if (alertDue) rec.lastAlertAt = now;
  try {
    fs.writeFileSync(path, JSON.stringify(rec));
  } catch {
    /* read-only location: escalation degrades to in-memory only */
  }
  return { health: view(rec.launches, now, threshold, windowMs), alertDue };
}

export function readHealth(path: string, now: number, threshold: number, windowMs: number): RestartHealth {
  const rec = load(path);
  return view(rec.launches.filter((t) => now - t < windowMs), now, threshold, windowMs);
}

function view(launches: number[], now: number, threshold: number, windowMs: number): RestartHealth {
  const last = launches.length ? Math.max(...launches) : null;
  return {
    launchesInWindow: launches.length,
    threshold,
    windowMin: Math.round(windowMs / 60_000),
    escalated: launches.length >= threshold,
    lastLaunchAgoSec: last === null ? null : Math.round((now - last) / 1000),
  };
}

/** For /health. null when no restart log is configured. */
export function restartHealth(env: Readonly<Record<string, string | undefined>> = process.env, now: number = Date.now()): RestartHealth | null {
  const c = restartConfig(env);
  return c.path ? readHealth(c.path, now, c.threshold, c.windowMs) : null;
}

/** The text of the alert (also the webhook body). Contains no secrets. */
export function alertText(h: RestartHealth, who: string): string {
  return `[ALERT] ${who} restarted ${h.launchesInWindow}x in ${h.windowMin}min (threshold ${h.threshold}); crash loop?`;
}
