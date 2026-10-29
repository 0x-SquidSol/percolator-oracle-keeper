/**
 * cross-cluster/v22/lifecycle-resolve.ts   (KEEPER_V22_STALE_RESOLVE = off | dry | on, DEFAULT off)
 *
 * The permissionless stale resolve: wrapper tag 39 `ResolveStalePermissionless`, sent at maturity. Plan
 * v22-market-lifecycle-plan-2026-10-25 section 2, option C (decided 2026-10-25): tag 39 is the always-on backstop and the
 * keeper fires it; the admin resolve is for deliberate retirements and is NOT done here.
 *
 * WHY THIS FILE IS PARANOID. A resolve is irreversible and settles every position at the market's LAST EFFECTIVE (stale)
 * price (engine resolve_market_not_atomic takes no price input). Resolving a market whose price source is healthy, or
 * resolving the whole board because the keeper itself was down, would transfer real value for no reason. So the decision
 * is an ordered list of independent GUARDS, each one named and each one tested with a negative control (the test removes
 * that single guard from the list and shows the unsafe input now gets through):
 *
 *   mode-enabled         KEEPER_V22_STALE_RESOLVE is not off.
 *   market-live          the market is Live (never re-resolve, never touch Recovery).
 *   window-enabled       permissionless_resolve_stale_slots != 0 (otherwise the program would refuse anyway).
 *   matured              age >= permissionless_resolve_stale_slots, the program's own inequality.
 *   keeper-continuity    BOTH keeper loops have observed continuously for >= minObservationMs: a keeper that was down,
 *                        RPC-failing, stalled, or has just booted never resolves anything (the Helius outage guard).
 *   mass-maturity        at most `massThreshold` OUTAGE-SHAPED matured markets (see ResolveInput.maturedCount: markets the keeper
 *                        could push and was not without a source for). More is an outage: resolve none, alert. Foreign-authority /
 *                        unregistered / genuinely source-dead markets are not outage evidence and never trip it.
 *   keeper-authority-unregistered  a market whose oracle authority IS this keeper but that has no registry row (never added, lagging
 *                        registration, or a hot-reload that pruned the row) is a market the keeper may be able to revive: it is HELD
 *                        with an alert ("register or resolve: operator decision") unless its address is in
 *                        KEEPER_V22_STALE_RESOLVE_UNREGISTERED_ALLOW. A market that was registered earlier in this process is not
 *                        special: unregistered now + keeper authority = held. Only FOREIGN-authority markets resolve without source evidence.
 *   source-health        a keeper-side price-reader regression looks like many "source dead" markets while continuity holds. If more
 *                        than sourceLossMax, or more than sourceLossPct percent (and at least 2), of the markets the keeper can push
 *                        lack a usable source at the same moment, no PUSHABLE market is resolved.
 *   source-group-loss    correlation hold: if all (or GROUP_LOSS_PCT percent, at least 2) of the pushable markets that share one DEX type lack a
 *                        usable source at once, resolves of that group are held (one DEX / quote asset failing in the price reader).
 *   source-unavailable   (b) a market this keeper CAN push (registry row and asset 0 oracle authority = this keeper) is resolved only
 *                        when its source price has been unavailable for >= minObservationMs inside the continuous window.
 *                        If the keeper has a usable source it must PUSH (which re-advances last_good_oracle_slot), not resolve.
 *                        A market the keeper has no push path to (no row / foreign oracle authority) is NOT subject to this rule: whether
 *                        the keeper has a usable price is irrelevant when it can never push, so only maturity + continuity apply.
 *   not-attempted        (e) one resolve per market: never again after a landed one, and not within `resolveRetryMs` of any attempt.
 *   cycle-bound          (e) at most `maxResolvesPerCycle` per tick.
 *
 * and, immediately before the send, `PRE_SEND_CHECKS` (d) on a FRESH read of the account: still owned by the wrapper, mode
 * still Live, still matured at the current cluster slot, and last_good_oracle_slot has not moved since the decision. The
 * program re-checks maturity itself (27 OracleStale otherwise), so these checks are what stops a stale DECISION from
 * becoming a send, not what protects the chain.
 *
 * `dry` runs everything, including the simulation, logs "would resolve" and sends nothing. A global DRY_RUN / KEEPER_V22_DRY_RUN
 * forces `dry`.
 *
 * Encoding (verified against the deployed wrapper, percolator-prog aca02ba6 src/v16_program.rs): decode `39 =>
 * ResolveStalePermissionless { now_slot: read_u64 }` (line 9735), encode `out.push(39); push_u64(now_slot)`, so the wire is
 * exactly [39, now_slot u64 LE], 9 bytes; handler `handle_resolve_stale_permissionless` (line 27625) takes ONE account,
 * accounts[0] = market (writable, wrapper-owned), no signer is checked (the fee payer suffices). The program reads the
 * Clock, so `now_slot` is only a fallback. Refusals in order: mode != Live -> 21, Clock < header.current_slot -> 19, not
 * matured -> 27. The SDK builder (`buildResolveStalePermissionlessIxV22`) produces exactly this; lifecycle.test.ts pins it.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildResolveStalePermissionlessIxV22 } from "@percolatorct/sdk";
import type { LifecycleConfig, StaleResolveMode } from "./flags.ts";
import type { MarketLifecycle } from "./lifecycle-classify.ts";
import { marketMode, staleResolveWindow } from "../market-state.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";

/** Wrapper tag of ResolveStalePermissionless. */
export const TAG_RESOLVE_STALE_PERMISSIONLESS = 39;

/** Wrapper errors that are EXPECTED answers to tag 39: 19 EngineStale, 21 EngineLockActive (already resolved), 27 OracleStale (not matured). */
export const RESOLVE_EXPECTED_CODES: ReadonlySet<number> = new Set([19, 21, 27]);

/** Compute-unit limit of the tag-39 transaction (the engine resolve walks the asset slots; the old job used the same). */
export const RESOLVE_UNITS = 400_000;

export function buildStaleResolveIx(programId: PublicKey, market: PublicKey, clusterSlot: bigint): TransactionInstruction {
  return buildResolveStalePermissionlessIxV22(programId, market, clusterSlot);
}

// ── Decision (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

export type GuardName =
  | "mode-enabled"
  | "market-live"
  | "window-enabled"
  | "matured"
  | "keeper-continuity"
  | "mass-maturity"
  | "keeper-authority-unregistered"
  | "source-health"
  | "source-group-loss"
  | "source-unavailable"
  | "not-attempted"
  | "cycle-bound";

export interface AttemptRecord {
  atMs: number;
  /** true once a tag 39 of ours landed (the market is resolved: never again). */
  landed: boolean;
}

export interface ResolveInput {
  mode: StaleResolveMode;
  lc: MarketLifecycle;
  /** ledger.continuousMs(now) */
  continuousMs: number;
  /** ledger.sourceUnavailableMs(market, now) */
  sourceUnavailableMs: number;
  /**
   * OUTAGE-SHAPED matured markets: matured, Live, window enabled, whose oracle authority IS this keeper, and either (a) PRUNED:
   * registered earlier in this process and not registered now, and not allowlisted (a shrinking registry), or (b) registered with a
   * usable source within minObservationMs. Those are markets the keeper was supposed to keep alive and did not: the signature of a
   * keeper outage or a registry wipe. NOT counted: foreign-authority markets (the live backlog), pushable markets whose source really is
   * dead, allowlisted markets, and markets that were never registered (a standing set, held individually and alerted separately), so a
   * legitimate backlog never blocks itself; the per-tick bound drains it gradually.
   */
  maturedCount: number;
  /** The address is in KEEPER_V22_STALE_RESOLVE_UNREGISTERED_ALLOW. */
  allowlisted: boolean;
  /** Global source-health hold (see the source-health guard). */
  sourceLossHold: boolean;
  /** This market's DEX-type group is source-lost together (see the source-group-loss guard). */
  groupLossHold: boolean;
  /** Resolves already started this tick. */
  resolvedThisCycle: number;
  attempt: AttemptRecord | undefined;
  nowMs: number;
  cfg: Pick<LifecycleConfig, "minObservationMs" | "massThreshold" | "maxResolvesPerCycle" | "resolveRetryMs">;
}

export interface Guard {
  name: GuardName;
  /** null = pass; a string = the reason to hold. */
  check(i: ResolveInput): string | null;
}

export const RESOLVE_GUARDS: ReadonlyArray<Guard> = [
  { name: "mode-enabled", check: (i) => (i.mode === "off" ? "KEEPER_V22_STALE_RESOLVE is off" : null) },
  { name: "market-live", check: (i) => (i.lc.terminal !== null || i.lc.price.kind === "not-live" ? "market is not Live" : null) },
  { name: "window-enabled", check: (i) => (i.lc.price.kind === "no-window" ? "permissionless_resolve_stale_slots = 0: no permissionless resolve on this market" : null) },
  { name: "matured", check: (i) => (i.lc.price.kind === "matured" ? null : "not matured") },
  {
    name: "keeper-continuity",
    check: (i) =>
      i.continuousMs >= i.cfg.minObservationMs
        ? null
        : `keeper has not observed continuously for ${i.cfg.minObservationMs} ms (observed ${i.continuousMs} ms: just booted, a failed read, or a stalled loop)`,
  },
  {
    name: "mass-maturity",
    check: (i) => (i.maturedCount > i.cfg.massThreshold ? `${i.maturedCount} pushable markets matured with a usable source (> ${i.cfg.massThreshold}): outage-shaped, resolving none` : null),
  },
  {
    name: "keeper-authority-unregistered",
    check: (i) => (i.lc.keeperIsAuthority && !i.lc.registered && !i.allowlisted ? "oracle authority is THIS keeper but the market has no registry row: register it or resolve it by operator decision (KEEPER_V22_STALE_RESOLVE_UNREGISTERED_ALLOW)" : null),
  },
  {
    name: "source-health",
    check: (i) => (i.lc.keeperCanPush && i.sourceLossHold ? "many pushable markets lack a source price at once (price-reader regression?): not resolving pushable markets" : null),
  },
  {
    name: "source-group-loss",
    check: (i) => (i.lc.keeperCanPush && i.groupLossHold ? "every (or nearly every) pushable market of this market's DEX type lacks a source at once (price-reader regression for that DEX?): not resolving this group" : null),
  },
  {
    name: "source-unavailable",
    check: (i) => {
      // A market the keeper has no push path to (no registry row / another oracle authority) has no keeper source to wait for.
      if (!i.lc.keeperCanPush) return null;
      return i.sourceUnavailableMs >= i.cfg.minObservationMs
        ? null
        : `the keeper has (or had ${i.sourceUnavailableMs} ms ago) a usable source price for this market: push, do not resolve (needs ${i.cfg.minObservationMs} ms without one)`;
    },
  },
  {
    name: "not-attempted",
    check: (i) => {
      if (!i.attempt) return null;
      if (i.attempt.landed) return "already resolved by this keeper";
      return i.nowMs - i.attempt.atMs < i.cfg.resolveRetryMs ? `attempted ${i.nowMs - i.attempt.atMs} ms ago (retry after ${i.cfg.resolveRetryMs} ms)` : null;
    },
  },
  { name: "cycle-bound", check: (i) => (i.resolvedThisCycle >= i.cfg.maxResolvesPerCycle ? `already ${i.resolvedThisCycle} resolve(s) this tick (bound ${i.cfg.maxResolvesPerCycle})` : null) },
];

export type ResolveDecision = { action: "resolve" } | { action: "hold"; guard: GuardName; reason: string };

/** First failing guard wins. Production always passes RESOLVE_GUARDS; tests pass a list with one guard removed (the negative control). */
export function decideResolve(i: ResolveInput, guards: ReadonlyArray<Guard> = RESOLVE_GUARDS): ResolveDecision {
  for (const g of guards) {
    const why = g.check(i);
    if (why !== null) return { action: "hold", guard: g.name, reason: why };
  }
  return { action: "resolve" };
}

// ── Pre-send re-verification (d) ────────────────────────────────────────────────────────────────────────────────────

export interface PreSendInput {
  /** The decision's view: last_good_oracle_slot at decision time. */
  expectedLastGoodOracleSlot: bigint;
  /** Fresh account bytes, or null when the account could not be read. */
  fresh: Uint8Array | null;
  freshOwnerIsWrapper: boolean;
  /** Fresh cluster slot, or null when it could not be read. */
  clusterSlot: bigint | null;
}

export interface PreSendCheck {
  name: "readable" | "owner" | "still-live" | "still-matured" | "price-not-advanced";
  check(i: PreSendInput): string | null;
}

export const PRE_SEND_CHECKS: ReadonlyArray<PreSendCheck> = [
  { name: "readable", check: (i) => (i.fresh === null || i.clusterSlot === null ? "could not re-read the market / the cluster slot" : null) },
  { name: "owner", check: (i) => (i.freshOwnerIsWrapper ? null : "market account is not owned by the configured wrapper") },
  { name: "still-live", check: (i) => (i.fresh !== null && marketMode(i.fresh) === 0 ? null : "re-read: mode is no longer Live (already resolved, or in Recovery)") },
  {
    name: "still-matured",
    check: (i) => {
      if (i.fresh === null || i.clusterSlot === null) return "unreadable";
      const w = staleResolveWindow(i.fresh, i.clusterSlot);
      return w && w.enabled && w.matured ? null : "re-read: no longer matured at the current slot (a push landed, or the window changed)";
    },
  },
  {
    name: "price-not-advanced",
    check: (i) => {
      if (i.fresh === null || i.clusterSlot === null) return "unreadable";
      const w = staleResolveWindow(i.fresh, i.clusterSlot);
      return w && w.lastGoodOracleSlot === i.expectedLastGoodOracleSlot ? null : "re-read: last_good_oracle_slot moved since the decision";
    },
  },
];

/** First failing pre-send check, or null. Tests pass a list with one check removed. */
export function preSendVerdict(i: PreSendInput, checks: ReadonlyArray<PreSendCheck> = PRE_SEND_CHECKS): string | null {
  for (const c of checks) {
    const why = c.check(i);
    if (why !== null) return why;
  }
  return null;
}

// ── Execution ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolveConnection {
  getAccountInfo(pk: PublicKey, commitment?: "confirmed" | "processed"): Promise<{ data: Buffer | Uint8Array; owner: PublicKey } | null>;
  getSlot(commitment?: "confirmed" | "processed"): Promise<number>;
}

export type ResolveResult =
  | { kind: "held"; reason: string }
  | { kind: "dry-run"; detail: string }
  | { kind: "refused"; name: string; expected: boolean }
  | { kind: "sent"; landed: "landed" | "failed" | "not-landed"; signature: string }
  | { kind: "failed"; error: string };

/**
 * Re-read, re-verify, then send tag 39 for one market (the caller already took the decision and marked the attempt).
 * `reguard` is evaluated again after the clean simulation and right before the send with FRESH ledger numbers, so a loop that
 * stalled during the simulation cannot send. Never throws.
 */
export async function resolveStaleOnce(
  d: {
    conn: ResolveConnection & ExecContext["conn"];
    exec: ExecContext;
    programId: PublicKey;
    market: PublicKey;
    label: string;
    mode: Exclude<StaleResolveMode, "off">;
    expectedLastGoodOracleSlot: bigint;
    reguard: () => string | null;
    checks?: ReadonlyArray<PreSendCheck>;
    log: (s: string) => void;
  },
): Promise<ResolveResult> {
  let fresh: Uint8Array | null = null;
  let owner = false;
  let slot: bigint | null = null;
  try {
    const info = await d.conn.getAccountInfo(d.market, "confirmed");
    if (info) {
      fresh = new Uint8Array(info.data);
      owner = info.owner.equals(d.programId);
    }
    slot = BigInt(await d.conn.getSlot("confirmed"));
  } catch {
    // leave null: the "readable" check refuses
  }
  const why = preSendVerdict({ expectedLastGoodOracleSlot: d.expectedLastGoodOracleSlot, fresh, freshOwnerIsWrapper: owner, clusterSlot: slot }, d.checks);
  if (why !== null) return { kind: "held", reason: why };
  const ix = buildStaleResolveIx(d.programId, d.market, slot as bigint);
  const out: ExecOutcome = await simulateAndSend(
    { ...d.exec, dryRun: d.exec.dryRun || d.mode === "dry" },
    [ix],
    { job: "lifecycle-resolve", label: d.label, units: RESOLVE_UNITS, expected: RESOLVE_EXPECTED_CODES, beforeSend: d.reguard },
  );
  switch (out.kind) {
    case "dry-run":
      return { kind: "dry-run", detail: `would resolve ${d.label} (tag 39, simulated ok, units ${out.unitsConsumed ?? "n/a"})` };
    case "held":
      return { kind: "held", reason: out.reason };
    case "refused":
      return { kind: "refused", name: out.name, expected: out.expected };
    case "failed":
      return { kind: "failed", error: out.error };
    case "sent":
      return { kind: "sent", landed: out.landed, signature: out.signature };
  }
}
