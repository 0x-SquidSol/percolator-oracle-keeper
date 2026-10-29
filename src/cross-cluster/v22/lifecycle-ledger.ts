/**
 * cross-cluster/v22/lifecycle-ledger.ts
 *
 * What this keeper has OBSERVED about itself and about each market's price source, kept in memory only. It is the
 * evidence the permissionless stale resolve (lifecycle-resolve.ts) needs before it may fire, because an irreversible
 * resolve must never follow from the keeper's own outage.
 *
 * THE FAILURE THIS GUARDS (a past Helius outage stalled the keeper for about 9 h): every market's `last_good_oracle_slot`
 * ages while the keeper cannot push, so on recovery every market looks "matured" at the same instant even though the
 * price source is perfectly healthy. The ledger answers two questions the chain cannot:
 *
 *   continuousMs(now)          how long have BOTH of this keeper's loops been observing without a failure or a gap?
 *                              0 right after boot, after any failed tick / failed push-cycle read, and while either loop
 *                              has gone quiet for longer than `maxGapMs` (a stalled event loop, a laptop sleep, an RPC hang).
 *   sourceUnavailableMs(m)     how long has market `m` had NO usable source price, counted only inside the continuous
 *                              window? `now - max(last usable source time, start of the continuous window)`.
 *
 * "Usable source" = the push loop read a positive price for the market's pool this cycle (or the market has a fixed source).
 * It is deliberately generous: a price that was read but then withheld by the priming gate or the circuit breaker still
 * counts as usable, because that is a market the keeper can (and must) keep alive rather than resolve.
 *
 * Fed by two call sites only: V22Loop.tick (`noteTick`) and the push loop in keeper-loop.ts (`noteSourceCycle`,
 * `recordSource`, `recordPushLanded`). All of them are cheap and never throw.
 */

export type LedgerKind = "tick" | "source";

interface Stream {
  /** Start of the current unbroken run of good notes (ms); null = no good note yet / broken. */
  since: number | null;
  /** Time of the last note of any kind (ms). */
  last: number | null;
}

export class ObservationLedger {
  private readonly streams: Record<LedgerKind, Stream> = { tick: { since: null, last: null }, source: { since: null, last: null } };
  private readonly usableAt = new Map<string, number>();
  private readonly pushLandedAt = new Map<string, number>();
  private pushesLanded = 0;

  constructor(private maxGapMs: number) {}

  setMaxGapMs(ms: number): void {
    this.maxGapMs = ms;
  }

  /** One loop pass finished: `ok` = every read it needed worked. A failure or a long gap restarts the continuous run. */
  note(kind: LedgerKind, ok: boolean, nowMs: number): void {
    const s = this.streams[kind];
    const gap = s.last === null ? Number.POSITIVE_INFINITY : nowMs - s.last;
    s.last = nowMs;
    if (!ok) {
      s.since = null;
      return;
    }
    if (s.since === null || gap > this.maxGapMs) s.since = nowMs;
  }

  noteTick(ok: boolean, nowMs: number): void {
    this.note("tick", ok, nowMs);
  }

  noteSourceCycle(ok: boolean, nowMs: number): void {
    this.note("source", ok, nowMs);
  }

  /** The push loop's verdict on a market's price source this cycle. Several assets of one market: any usable asset counts. */
  recordSource(market: string, usable: boolean, nowMs: number): void {
    if (usable) this.usableAt.set(market, nowMs);
  }

  /** A mark push for the market LANDED (accepted by the program). */
  recordPushLanded(market: string, nowMs: number): void {
    this.pushLandedAt.set(market, nowMs);
    this.pushesLanded++;
  }

  private streamStart(kind: LedgerKind, nowMs: number): number | null {
    const s = this.streams[kind];
    if (s.since === null || s.last === null) return null;
    // A loop that has gone quiet is not observing NOW, whatever it did before.
    if (nowMs - s.last > this.maxGapMs) return null;
    return s.since;
  }

  /** Start of the window in which BOTH loops have been observing continuously, or null when either is not. */
  continuousSince(nowMs: number): number | null {
    const a = this.streamStart("tick", nowMs);
    const b = this.streamStart("source", nowMs);
    if (a === null || b === null) return null;
    return Math.max(a, b);
  }

  continuousMs(nowMs: number): number {
    const since = this.continuousSince(nowMs);
    return since === null ? 0 : Math.max(0, nowMs - since);
  }

  /** ms with no usable source price for `market`, inside the continuous window (0 when not continuously observed). */
  sourceUnavailableMs(market: string, nowMs: number): number {
    const since = this.continuousSince(nowMs);
    if (since === null) return 0;
    const usable = this.usableAt.get(market);
    const start = usable === undefined ? since : Math.max(since, usable);
    return Math.max(0, nowMs - start);
  }

  /** ms since a usable source price was last seen for `market`; Infinity when never seen by this process. */
  sourceAgeMs(market: string, nowMs: number): number {
    const t = this.usableAt.get(market);
    return t === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - t);
  }

  lastUsableSourceAt(market: string): number | null {
    return this.usableAt.get(market) ?? null;
  }

  /** Did a push of this market land since this process started? */
  pushLandedSinceBoot(market: string): boolean {
    return this.pushLandedAt.has(market);
  }

  /** /health view. */
  snapshot(nowMs: number): { continuousMs: number; tickRunMs: number | null; sourceRunMs: number | null; pushesLandedSinceBoot: number; maxGapMs: number } {
    const run = (k: LedgerKind): number | null => {
      const s = this.streamStart(k, nowMs);
      return s === null ? null : Math.max(0, nowMs - s);
    };
    return { continuousMs: this.continuousMs(nowMs), tickRunMs: run("tick"), sourceRunMs: run("source"), pushesLandedSinceBoot: this.pushesLanded, maxGapMs: this.maxGapMs };
  }

  /** Drop markets no longer of interest. */
  prune(keep: ReadonlySet<string>): void {
    for (const m of [...this.usableAt.keys()]) if (!keep.has(m)) this.usableAt.delete(m);
    for (const m of [...this.pushLandedAt.keys()]) if (!keep.has(m)) this.pushLandedAt.delete(m);
  }
}

/**
 * The process-wide ledger the push loop writes to. The V22 lifecycle engine reads this same instance (it is never
 * replaced, only reset by tests), so the two loops need no wiring between them.
 */
export const lifecycleLedger = new ObservationLedger(120_000);

export function resetLifecycleLedgerForTests(maxGapMs = 120_000): void {
  const fresh = new ObservationLedger(maxGapMs);
  Object.assign(lifecycleLedger, fresh);
}
