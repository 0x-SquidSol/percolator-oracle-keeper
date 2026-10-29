/**
 * cross-cluster/v22/sweep.ts
 *
 * The positioned-refresh sweep for v2.2 markets (KEEPER_V22_SWEEP). A round is planned by settle-pairing.ts
 * (`planSettleRound`): txs shaped [accrue crank, refresh xN], heaviest stale weight first, budgeted by LEG WEIGHT
 * (a refresh weighs 3 + legs), the LP's settle paired with its counterparties (SETTLE_PAIRING).
 *
 * WHAT "PAIRED" MEANS HERE (security review of #148, items 1-9): the round tracks which counterparties ACTUALLY
 * settled (landed refresh, or the engine said "already current" = Custom(22)). The LP tx goes only if
 *   - every positioned counterparty settled in this round, or
 *   - `prefer` and the only misses are portfolios the program REFUSED (band 104/111/112/113, hard refusal): those
 *     cannot be settled by any keeper action, so waiting would freeze the LP; the miss is counted in
 *     `unpairedLpSettles`. `strict` holds the LP instead.
 * A counterparty tx that did not LAND (any reason) is never a reason to settle the LP alone: the LP waits (no
 * "force after N skipped rounds" exists any more). The one exception is a PROTECTIVE round (the LP itself is near
 * liquidation or a senior draw is pending): the LP then goes in the legacy full recovery shape, last in a tx with
 * the counterparties that fit, never alone.
 *
 * Execution of a tx: simulate first; a refresh refused at a known index is PRUNED (Custom(22) = current, band
 * code = expected state, anything else = hard refusal), the rest re-simulated and sent (bounded); hard and band
 * refusals put the portfolio on a cool-down (`quarantine`) ONLY when the refusal carries a program Custom code; an error with
 * no code (compute exhaustion, account in use, blockhash, RPC) shrinks the tx instead and counts as an unsettled
 * counterparty that holds the LP in BOTH modes. Rent (tag 106) is sent AFTER the LP tx, sequentially, for portfolios the
 * plain refresh already settled (106 forces the Refresh action and write-locks the LP). A landed tx that
 * failed with Custom(22) on its accrue crank (a parallel tx accrued the same slot) is treated as "already
 * accrued" and re-sent refresh-only.
 */
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { buildObservationCrankIx, buildRefreshCrankIx, parseInstructionError, riskSnapOf } from "../positioned-refresh.ts";
import { isMultiAssetMarket } from "../multi-asset.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { MarketLayout } from "../market-layout.ts";
import {
  DEFAULT_LIQ_EXACT_PAD_BPS, DEFAULT_LIQ_MAX_PER_TX, DEFAULT_LIQ_PAD_BPS, atOrBelowMaintenance, estimateBaseCu, fitLiquidations,
  MIN_PROGRESS_BPS, markLiquidationCandidates, marginOf, readMarginParams, fitToPacket, liquidationMadeNoProgress, noteLiquidationLanded,
} from "./liquidation.ts";
import type { FlaggedAccount, MarginParams } from "./liquidation.ts";
import { holdPushes as realHold, releasePushes as realRelease } from "../refresh-coordination.ts";
import { BAND_EXPECTED_CODES } from "./errors.ts";
import { COMPUTE_IX_COUNT, simulateAndSend, simulateOnly } from "./exec.ts";
import { addKeeperPriorityFee } from "../priority-fee.ts";
import type { ExecContext, ExecOptions, ExecOutcome } from "./exec.ts";
import { DEFAULT_MAX_GAP_SLOTS, DEFAULT_MAX_TXS_PER_ROUND, DEFAULT_WEIGHT_BUDGET, legAwareTxUnits, planSettleRound } from "./settle-pairing.ts";
import type { PlannedTx, RoundPlan } from "./settle-pairing.ts";
import type { PairingMode } from "./flags.ts";

const NON_PROGRESS = 22;
export const SWEEP_TX_UNITS = 1_400_000;
export const SWEEP_MAX_PRUNES = 8;
/**
 * Cool-down ladder (slots) after a PROGRAM refusal (a Custom code) of a refresh: the first is short; a longer one applies
 * only when the SAME portfolio repeats the SAME code. At most MAX_QUARANTINES_PER_ROUND portfolios are quarantined per
 * round unless each carries a distinct code (one bad code must not quarantine a whole book).
 */
export const QUARANTINE_LADDER: readonly number[] = [150, 450, 1_500];
export const MAX_QUARANTINES_PER_ROUND = 2;
export const QUARANTINE_FIRST_SLOTS = QUARANTINE_LADDER[0];
/**
 * A portfolio whose refresh fails WITHOUT a program code this many rounds in a row is treated as program-refused for pairing
 * (quarantined DEFERRAL_ESCALATION_SLOTS, counted, WARN, named in /health), so `prefer` can proceed; `strict` keeps holding
 * and surfaces the same alert. Without this a portfolio that always overruns / fails by itself would hold the LP forever.
 */
export const DEFERRAL_ESCALATION_AFTER = 3;
export const DEFERRAL_ESCALATION_SLOTS = 450;
/** Most single-refresh probe simulations per tx when looking for a portfolio that fails by itself without a code. */
export const MAX_PROBES = 12;
/**
 * Rent (tag 106) settles per round: 1. Each 106 accrues and settles ONE counterparty to a K newer than the LP's (the LP tx came
 * first), and the LP stays behind until the NEXT round's LP tx. With N per round the mirror window is N sequential txs; with 1 it is
 * one portfolio for one cycle. Rent is index-based and timing-invariant, so a slower rent cadence costs nothing: 1 per round
 * (a 20 s cycle) still settles 180 portfolios per default cadence (9,000 slots = 1 h), and a larger book simply settles each
 * portfolio less often than the cadence, which the program does not care about.
 */
export const RENT_SETTLES_PER_ROUND = 1;
/** Rounds skipped after a gap-exceeded round: 1, then 2 (capped: the engine clock must not go unaccrued for long). */
export const MAX_GAP_BACKOFF_ROUNDS = 2;

export interface SweepRoundConfig {
  pairing: PairingMode;
  weightBudget: number;
  maxTxsPerRound: number;
  maxGapSlots: number;
  /** How long the market's pushes are held during a multi-tx round. */
  holdMs: number;
}

export const DEFAULT_SWEEP_ROUND_CONFIG: SweepRoundConfig = {
  pairing: "prefer",
  weightBudget: DEFAULT_WEIGHT_BUDGET,
  maxTxsPerRound: DEFAULT_MAX_TXS_PER_ROUND,
  maxGapSlots: DEFAULT_MAX_GAP_SLOTS,
  holdMs: 12_000,
};

export interface SweepDeps {
  exec: ExecContext;
  getSlot: () => Promise<number>;
  hold?: (market: string, ms: number) => void;
  release?: (market: string) => void;
}

/** Pairing health, process-lifetime, exported through /health (health.ts). */
export interface PairingStats {
  rounds: number;
  singleTxRounds: number;
  multiTxRounds: number;
  pairedLpSettles: number;
  /** LP settled while counterparties were unvisited / refused (prefer's counted degradation, and mode off's legacy shape). */
  unpairedLpSettles: number;
  lpDeferredStrict: number;
  /** LP held because a counterparty tx did not land (never forced). */
  lpHeldPhase1Unlanded: number;
  /** LP held (strict) because a counterparty was refused. */
  lpHeldCounterpartyMiss: number;
  gapExceeded: number;
  gapBackoffRounds: number;
  consecutiveGapExceeded: number;
  lastGapSlots: number | null;
  maxGapSlots: number;
  bandExpected: number;
  prunedCurrent: number;
  hardRefusals: number;
  quarantinedNow: number;
  anchorAccrues: number;
  /** The anchor accrue was refused by the program: that tx fell back to the counterparty form. */
  anchorFallbacks: number;
  /** Quarantines skipped because the per-round cap was reached. */
  quarantineCapped: number;
  /** Portfolios escalated after repeated no-code deferrals (their own metric). */
  deferralEscalations: number;
  /** Rounds forced because the LP had not been settled by the keeper for lpMaxUnsettledMs. */
  lpTimeBoundRounds: number;
  /** Accrue went through a counterparty because the market had no keeper-owned flat anchor. */
  counterpartyAccrues: number;
  accrueAlreadyDone: number;
  protectiveRounds: number;
  rentSettlesInRound: number;
  /** A compute / runtime error (no program code) shrank a tx: nobody was blamed or quarantined. */
  shrinkDeferrals: number;
  feeAfterRound: number;
  feeUnpairedLpSettles: number;
  /** F1: liquidation cranks added to a sweep tx (included in a simulated tx), landed, dropped because the engine had nothing to do (22) or refused, and deferred (tx budget). */
  liqIncluded: number;
  liqLanded: number;
  liqNothingToDo: number;
  liqRefused: number;
  liqDeferred: number;
  /** F1: the extended tx failed as a whole (compute, an unrelated refusal, a landed failure): liquidation was skipped and the plain refresh went out. */
  liqSkipped: number;
  /** MERGED_ROUND: multi-asset rounds sent as ONE atomic tx; rounds that fell back to the phased plan; cranks dropped as already current (22). */
  mergedRounds: number;
  mergedFallbacks: number;
  mergedDroppedCurrent: number;
  /** LF: cycles the v2.2 layer declined while the lone LP crank is suppressed: the legacy fallback ran without its LP accrual crank (includes every cycle of a market whose asset 0 is not Active / DrainOnly). */
  declinedClockOnly: number;
}

const zeroStats = (): PairingStats => ({
  rounds: 0, singleTxRounds: 0, multiTxRounds: 0, pairedLpSettles: 0, unpairedLpSettles: 0, lpDeferredStrict: 0,
  lpHeldPhase1Unlanded: 0, lpHeldCounterpartyMiss: 0, gapExceeded: 0, gapBackoffRounds: 0, consecutiveGapExceeded: 0,
  lastGapSlots: null, maxGapSlots: 0, bandExpected: 0, prunedCurrent: 0, hardRefusals: 0, quarantinedNow: 0,
  anchorAccrues: 0, anchorFallbacks: 0, quarantineCapped: 0, deferralEscalations: 0, lpTimeBoundRounds: 0, counterpartyAccrues: 0, accrueAlreadyDone: 0, protectiveRounds: 0, rentSettlesInRound: 0, shrinkDeferrals: 0,
  feeAfterRound: 0, feeUnpairedLpSettles: 0, liqIncluded: 0, liqLanded: 0, liqNothingToDo: 0, liqRefused: 0, liqDeferred: 0, liqSkipped: 0,
  mergedRounds: 0, mergedFallbacks: 0, mergedDroppedCurrent: 0, declinedClockOnly: 0,
});

export const pairingStats: PairingStats = zeroStats();

export function resetPairingStats(): void {
  Object.assign(pairingStats, zeroStats());
}

/** Per-market gap backoff state (a round abandoned for a gap > maxGapSlots). */
export interface GapBackoff {
  level: number;
  skipRounds: number;
}
export const freshGapBackoff = (): GapBackoff => ({ level: 0, skipRounds: 0 });

/**
 * Rent settles (tag 106) are NOT substituted for a refresh (106 forces the Refresh action, so a liquidatable counterparty
 * would not be liquidated, and every 106 write-locks the LP, which would serialise the parallel phase-1 txs). They run
 * AFTER the LP tx of a round, sequentially, one tx per portfolio, only for portfolios the round already refreshed with
 * the plain crank, and only when the LP settled.
 */
export interface RentPlanInput {
  /** base58 portfolio keys whose rent is due this round. */
  due: ReadonlySet<string>;
  build: (p: PositionedPortfolio) => TransactionInstruction;
  /** Most rent settles per round (default RENT_SETTLES_PER_ROUND = 1). */
  max?: number;
}

export interface RoundInput {
  lp: PublicKey;
  lpWeight?: number;
  counterparties: ReadonlyArray<PositionedPortfolio>;
  /** The keeper's OWN flat portfolio (accrue-only target). */
  anchor?: PublicKey | null;
  /** Oracle leg accounts for the observation crank (Hybrid); [] for AUTH_MARK. */
  oracleAccounts?: ReadonlyArray<PublicKey>;
  /** base58 -> slot until which a refused portfolio is not retried. */
  quarantine?: Map<string, bigint>;
  /** base58 -> last program code + ladder level (a longer cool-down only on a repeat of the same code). */
  quarantineHistory?: Map<string, { code: number; level: number }>;
  /** base58 -> consecutive rounds the portfolio's refresh failed WITHOUT a program code (reset when it settles). */
  deferrals?: Map<string, number>;
  nowSlot?: number;
  gapBackoff?: GapBackoff;
  rent?: RentPlanInput;
  /** The LP itself needs a crank now: legacy full recovery shape, never alone, no gap / phase-1 hold. */
  protective?: boolean;
  /** F1: liquidation cranks in the sweep tx (KEEPER_V22_LIQUIDATE). Absent = today's tx shape, byte for byte. */
  liq?: LiqRoundInput;
}

/** F1 settings of one market's round. `params` null = the market's margin parameters were unreadable: no candidates. */
export interface LiqRoundInput {
  layout: MarketLayout;
  slots: number;
  params: MarginParams | null;
  padBps?: number;
  exactPadBps?: number;
  maxPerTx?: number;
}

/** One liquidation-crank attempt, for the `[liq]` log line, /health and the tests. */
export interface LiqRecord {
  key: string;
  result: "landed" | "simulated" | "nothing-to-do" | "refused" | "skipped" | "deferred";
  code: number | null;
  note: string;
}

/** current = Custom 22 (already settled); band = expected band state; hard = any other PROGRAM code; deferred = no program code (compute / runtime). */
export type PruneReason = "current" | "band" | "hard" | "deferred";

export interface RoundResult {
  plan: RoundPlan;
  txsSent: number;
  /** Counterparties that settled (landed or already current). */
  settled: string[];
  /** Counterparties not settled this round, with why. */
  missing: Array<{ key: string; why: "quarantined" | PruneReason | "unlanded" | "unplanned" }>;
  rentSettled: string[];
  /** The round was skipped for a gap backoff: nothing ran (the loop then sends one accrue-only crank, never on the LP). */
  backedOff: boolean;
  /** The program refused an anchor accrue this round (the caller drops the anchor for a while). */
  anchorRefused: boolean;
  /** Portfolios escalated this round after DEFERRAL_ESCALATION_AFTER consecutive no-code failures. */
  escalated: string[];
  pruned: number;
  lpSettled: boolean;
  gapSlots: number | null;
  abandoned: string | null;
  /** The round went out as ONE merged tx (MERGED_ROUND); `plan` still describes the phased plan it replaced. */
  merged?: boolean;
  outcomes: ExecOutcome[];
  /** F1: every liquidation-crank attempt of the round. */
  liq: LiqRecord[];
}

export interface BuildTxArgs {
  accrue: PlannedTx["accrue"];
  accrueTarget: PublicKey | null;
  refresh: ReadonlyArray<PositionedPortfolio>;
  oracleAccounts?: ReadonlyArray<PublicKey>;
  tail?: ReadonlyArray<TransactionInstruction>;
  /**
   * F1: base58 keys of portfolios that get a SECOND no-observation crank (the liquidation crank) immediately after their
   * first crank (the refresh, or the observation crank when the portfolio is the tx's accrue target). The engine liquidates
   * only on a second crank on the account in the SAME tx. A key that is neither refreshed nor the accrue target is ignored.
   */
  liquidate?: ReadonlySet<string>;
}

/** What each instruction of a sweep tx is (the simulation reports a refusal by instruction index). */
export interface SweepSlot {
  ix: TransactionInstruction;
  kind: "accrue" | "refresh" | "liq" | "tail";
  key: string | null;
}

/** The slots of one planned tx: accrue crank first, then each refresh (followed by its liquidation crank when asked), then a tail. */
export function buildSweepTxSlots(owner: PublicKey, market: PublicKey, tx: BuildTxArgs): SweepSlot[] {
  const slots: SweepSlot[] = [];
  const liq = tx.liquidate ?? new Set<string>();
  if (tx.accrue !== "none" && tx.accrueTarget) {
    const k = tx.accrueTarget.toBase58();
    slots.push({ ix: buildObservationCrankIx(owner, market, tx.accrueTarget, tx.oracleAccounts ?? []), kind: "accrue", key: k });
    if (tx.accrue === "counterparty" && liq.has(k)) slots.push({ ix: buildRefreshCrankIx(owner, market, tx.accrueTarget), kind: "liq", key: k });
  }
  // MULTI-ASSET: a hint-less crank is valid ONLY in the same tx/slot as an observing crank. In a LATER slot it accrues just the
  // portfolio's first leg's asset and advances the market clock, which makes every other exposed asset loss-stale. So an
  // `accrue: "none"` tx (the "accrue answered 22, re-send refresh-only" path) never starts with a hint-less crank on a multi-asset
  // market: its FIRST crank is an observing one carrying a hint for every listed asset. Single-asset markets are unchanged.
  const firstObserves = tx.accrue === "none" && isMultiAssetMarket(market.toBase58());
  let first = true;
  for (const p of tx.refresh) {
    const k = p.pubkey.toBase58();
    const observe = firstObserves && first;
    first = false;
    slots.push({ ix: observe ? buildObservationCrankIx(owner, market, p.pubkey, tx.oracleAccounts ?? []) : buildRefreshCrankIx(owner, market, p.pubkey), kind: "refresh", key: k });
    if (liq.has(k)) slots.push({ ix: buildRefreshCrankIx(owner, market, p.pubkey), kind: "liq", key: k });
  }
  for (const t of tx.tail ?? []) slots.push({ ix: t, kind: "tail", key: null });
  return slots;
}

/** The instruction list of one planned tx (accrue crank first, then the refreshes, then a tail). */
export function buildSweepTxIxs(owner: PublicKey, market: PublicKey, tx: BuildTxArgs): TransactionInstruction[] {
  return buildSweepTxSlots(owner, market, tx).map((s) => s.ix);
}

interface TxRun {
  outcome: ExecOutcome;
  /** counterparties settled by this tx (empty unless it landed / dry-ran). */
  settled: string[];
  pruned: Array<{ key: string; reason: PruneReason; code: number | null; culprit?: boolean }>;
  /** refreshes of this tx that did not settle because the tx did not land. */
  unlanded: string[];
  /** Portfolios whose refresh failed WITHOUT a program code in this tx (cut tail + a tx that failed with no code). */
  noCodeKeys: string[];
  droppedAccrue: boolean;
  anchorRefused: boolean;
  /** F1: liquidation-crank attempts of this tx. */
  liq: LiqRecord[];
}

/** F1 settings of one planned tx. `candidates` are the Stage A candidates of the round (liquidation.ts). */
export interface LiqTxOptions {
  layout: MarketLayout;
  slots: number;
  candidates: ReadonlyMap<string, PositionedPortfolio>;
  exactPadBps: number;
  maxPerTx: number;
}

export interface RunTxOptions {
  liq?: LiqTxOptions;
  oracleAccounts?: ReadonlyArray<PublicKey>;
  tail?: ReadonlyArray<TransactionInstruction>;
  /** Codes at the tail instruction that are expected (e.g. 38 for tag 78). */
  tailExpected?: ReadonlySet<number>;
  job?: string;
  /** Extra expected codes for this tx (the tail's, e.g. 38 for tag 78). */
  expected?: ReadonlySet<number>;
  /** LP tx gate: given the keys pruned for a reason other than "current" so far, a reason to hold the send. */
  lpGate?: (prunedNotSettled: Array<{ key: string; reason: PruneReason; culprit?: boolean }>) => string | null;
}

/** Run one planned tx with simulate-prune-isolate. Exported for the tag-78 job. */
export async function runPlannedTx(deps: SweepDeps, ctx: { market: PublicKey; label: string }, t: PlannedTx, o: RunTxOptions = {}): Promise<TxRun> {
  const owner = deps.exec.keeper.publicKey;
  let accrue: PlannedTx["accrue"] = t.accrue;
  let target = t.accrueTarget;
  let refresh = [...t.refresh];
  const pruned: TxRun["pruned"] = [];
  let droppedAccrue = false;
  let anchorRefused = false;
  let shrinks = 0;
  let probed = false;
  /** Portfolios proven (by single-refresh probe simulation) to fail BY THEMSELVES without a program code. */
  const culprits = new Set<string>();
  // F1: liquidation cranks (liquidation.ts). Decided per attempt from the simulation of the plain tx, never before it.
  const liqCfg = o.liq;
  const excluded = new Set<string>();
  const liqLog: LiqRecord[] = [];
  let chosen = new Map<string, FlaggedAccount>();
  let activeSlots: SweepSlot[] = [];
  const emit = deps.exec.log ?? ((l: string) => console.log(l));
  const liqNote = (key: string, result: LiqRecord["result"], code: number | null, note: string) => {
    liqLog.push({ key, result, code, note });
    emit(`[liq] ${ctx.label} ${key} ${result}${code !== null ? ` code=${code}` : ""}: ${note}`);
  };
  const candidatesIn = (): PositionedPortfolio[] => {
    if (!liqCfg) return [];
    const out: PositionedPortfolio[] = [];
    const seen = new Set<string>();
    const add = (k: string) => {
      const c = liqCfg.candidates.get(k);
      if (c && !excluded.has(k) && !seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    };
    if (accrue === "counterparty" && target) add(target.toBase58());
    for (const p of refresh) add(p.pubkey.toBase58());
    return out;
  };
  const budget = SWEEP_MAX_PRUNES + 3 + (liqCfg ? Math.min(candidatesIn().length, 16) + 1 : 0);
  const settledKeys = (): string[] => {
    // the first counterparty is settled by its own accrue crank when the accrue went through it
    const ks = refresh.map((p) => p.pubkey.toBase58());
    if (accrue === "counterparty" && target) ks.unshift(target.toBase58());
    return ks;
  };
  const fail = (outcome: ExecOutcome): TxRun => ({
    outcome,
    settled: [],
    pruned,
    unlanded: settledKeys(),
    noCodeKeys: [...culprits],
    droppedAccrue,
    anchorRefused,
    liq: liqLog,
  });
  for (let attempt = 0; attempt <= budget; attempt++) {
    const hasAccrue = accrue !== "none" && target !== null;
    const plainArgs: BuildTxArgs = { accrue, accrueTarget: target, refresh, oracleAccounts: o.oracleAccounts, tail: o.tail };
    activeSlots = buildSweepTxSlots(owner, ctx.market, plainArgs);
    const ixs = activeSlots.map((sl) => sl.ix);
    chosen = new Map();
    if (ixs.length === 0) return { outcome: { kind: "dry-run", unitsConsumed: null, logs: [], ixCount: 0 }, settled: [], pruned, unlanded: [], noCodeKeys: [...culprits], droppedAccrue, anchorRefused, liq: liqLog };
    const cands = candidatesIn();
    /** Stage B: from the post-refresh state the plain simulation returned, the extended instruction list (or null: send the plain tx). */
    const extendWithLiquidations = (post: ReadonlyArray<Uint8Array | null>, cs: ReadonlyArray<PositionedPortfolio>): TransactionInstruction[] | null => {
      if (!liqCfg) return null;
      const marketPost = post[0];
      const params = marketPost ? readMarginParams(marketPost, liqCfg.layout, liqCfg.slots) : null;
      if (!params) {
        liqNote(cs[0].pubkey.toBase58(), "skipped", null, "post-refresh market state unavailable; no liquidation crank this tx");
        pairingStats.liqSkipped++;
        return null;
      }
      const flagged: FlaggedAccount[] = [];
      cs.forEach((c, i) => {
        const d = post[i + 1];
        if (!d) return;
        let parsed;
        try {
          parsed = parsePortfolioV17(d);
        } catch {
          return;
        }
        const m = marginOf(riskSnapOf(parsed), params);
        if (m.ratioBps !== null && atOrBelowMaintenance(m, liqCfg.exactPadBps)) {
          if (liquidationMadeNoProgress(c.pubkey.toBase58(), m)) {
            liqNote(c.pubkey.toBase58(), "skipped", null, "state unchanged since the last landed liquidation crank (no progress); not cranked again until it changes");
            pairingStats.liqSkipped++;
            return;
          }
          flagged.push({ portfolio: c, ratioBps: m.ratioBps, margin: m });
        }
      });
      if (flagged.length === 0) return null;
      const fit = fitLiquidations({ flagged, baseCu: estimateBaseCu(accrue !== "none", refresh) + (accrue === "counterparty" ? 114_000 : 0), maxPerTx: liqCfg.maxPerTx });
      for (const d of fit.deferred) {
        pairingStats.liqDeferred++;
        liqNote(d.account.portfolio.pubkey.toBase58(), "deferred", null, `at or below maintenance (${d.account.ratioBps} bps of notional) but not added to this tx: ${d.why}`);
      }
      const packed = fitToPacket(
        fit.chosen,
        (kept) => buildSweepTxSlots(owner, ctx.market, { ...plainArgs, liquidate: new Set(kept.map((f) => f.portfolio.pubkey.toBase58())) }).map((sl) => sl.ix),
        owner,
      );
      for (const d of packed.dropped) {
        pairingStats.liqDeferred++;
        liqNote(d.portfolio.pubkey.toBase58(), "deferred", null, "at or below maintenance but the tx would exceed 1,232 bytes");
      }
      const take = packed.kept;
      if (take.length === 0) return null;
      activeSlots = buildSweepTxSlots(owner, ctx.market, { ...plainArgs, liquidate: new Set(take.map((f) => f.portfolio.pubkey.toBase58())) });
      const list = activeSlots.map((sl) => sl.ix);
      chosen = new Map(take.map((f) => [f.portfolio.pubkey.toBase58(), f]));
      return list;
    };
    /**
     * Stage B check on the EXTENDED simulation: a liquidation that does not move the position is not sent. An account the engine
     * keeps leaving a hair under its requirement (funding / fee drag between rounds) makes each crank a dust action (measured on
     * PENGU 7Jbxvq 2026-10-14: -3,237,984 atoms for the real liquidation, then 13 cranks of -60..-83 atoms each). Progress =
     * the account's notional falls by at least MIN_PROGRESS_BPS of its pre-liquidation notional; else the plain tx goes out and the
     * state is remembered (liquidationMadeNoProgress) until it changes.
     */
    const verifyLiquidations = (post: ReadonlyArray<Uint8Array | null>): string | null => {
      if (!liqCfg || chosen.size === 0) return null;
      const marketPost = post[0];
      const params = marketPost ? readMarginParams(marketPost, liqCfg.layout, liqCfg.slots) : null;
      if (!params) return null;
      const noProgress: string[] = [];
      cands.forEach((c, i) => {
        const k = c.pubkey.toBase58();
        const f = chosen.get(k);
        const d = post[i + 1];
        if (!f || !f.margin || !d) return;
        let parsed;
        try {
          parsed = parsePortfolioV17(d);
        } catch {
          return;
        }
        const after = marginOf(riskSnapOf(parsed), params);
        const dropped = f.margin.notional - after.notional;
        if (dropped * 10_000n < f.margin.notional * BigInt(MIN_PROGRESS_BPS)) {
          noProgress.push(k);
          noteLiquidationLanded(k, f.margin);
          pairingStats.liqSkipped++;
          liqNote(k, "skipped", null, `the liquidation crank would not reduce the position (notional ${f.margin.notional} -> ${after.notional}): a dust action, not sent; plain refresh sent`);
        }
      });
      if (noProgress.length === 0) return null;
      // all-or-nothing keeps the tx simple: the plain tx (already simulated clean) is sent, the others are retried next round
      chosen = new Map();
      return `no progress on ${noProgress.length} account(s)`;
    };
    const liqOpts: Pick<ExecOptions, "accounts" | "extend" | "verifyExtended"> =
      liqCfg && cands.length > 0
        ? {
            accounts: [ctx.market.toBase58(), ...cands.map((c) => c.pubkey.toBase58())],
            extend: (post) => {
              const ext = extendWithLiquidations(post, cands);
              return ext;
            },
            verifyExtended: verifyLiquidations,
          }
        : {};
    const outcome = await simulateAndSend(deps.exec, ixs, {
      ...liqOpts,
      job: o.job ?? "sweep",
      label: ctx.label,
      units: SWEEP_TX_UNITS,
      expected: o.expected ? new Set([...BAND_EXPECTED_CODES, ...o.expected]) : BAND_EXPECTED_CODES,
      beforeSend: () => (t.settlesLp && o.lpGate ? o.lpGate(pruned.filter((p) => p.reason !== "current")) : null),
    });
    const landed = outcome.kind === "sent" && outcome.landed === "landed";
    if (landed || outcome.kind === "dry-run") {
      for (const [k, f] of chosen) {
        pairingStats.liqIncluded++;
        if (landed) {
          pairingStats.liqLanded++;
          if (f.margin) noteLiquidationLanded(k, f.margin);
        }
        liqNote(k, landed ? "landed" : "simulated", null, `${landed ? "liquidation crank landed" : "liquidation crank simulated OK (dry-run: not sent)"} with the refresh in one tx; margin ${f.ratioBps} bps of notional after the refresh`);
      }
      return { outcome, settled: settledKeys(), pruned, unlanded: [], noCodeKeys: [...culprits], droppedAccrue, anchorRefused, liq: liqLog };
    }
    // F1: a tx WITH liquidation cranks landed but failed. The code cannot say which crank failed, so never reason about it:
    // drop every liquidation crank and re-send the plain refresh (the price push and the refresh must never wait on a liquidation).
    if (chosen.size > 0 && outcome.kind === "sent" && outcome.landed === "failed") {
      for (const k of chosen.keys()) {
        excluded.add(k);
        pairingStats.liqSkipped++;
        liqNote(k, "skipped", outcome.failCode, "the tx with the liquidation crank landed but failed; re-sending the plain refresh");
      }
      continue;
    }
    // A landed tx that failed on its accrue crank with Custom(22): another tx accrued this slot. Continue refresh-only.
    if (outcome.kind === "sent" && outcome.landed === "failed" && outcome.failCode === NON_PROGRESS && hasAccrue && !droppedAccrue) {
      pairingStats.accrueAlreadyDone++;
      ({ accrue, target, refresh } = dropAccrue(t, accrue, target, refresh));
      droppedAccrue = true;
      continue;
    }
    if (outcome.kind === "sent" || outcome.kind === "held" || outcome.kind === "failed") return fail(outcome);
    // refused in simulation
    const refused = outcome as Extract<ExecOutcome, { kind: "refused" }>;
    // F1: the refusal came from the EXTENDED simulation (the plain one was clean). A liquidation crank the engine refuses is
    // dropped on its own: Custom(22) = nothing to liquidate (healthy, or already liquidated: the program-side fix makes the
    // refresh itself liquidate, so the second crank has nothing left), any other code = refused. A refusal anywhere else, or
    // one without a program code (compute exhaustion), drops every liquidation crank of the tx. The plain tx is then simulated
    // again and goes out: a liquidation never blocks the refresh.
    if (chosen.size > 0) {
      const sl = refused.index !== null ? activeSlots[refused.index] : undefined;
      if (sl && sl.kind === "liq" && sl.key && refused.code !== null) {
        excluded.add(sl.key);
        pairingStats.liqIncluded++;
        if (refused.code === NON_PROGRESS) {
          pairingStats.liqNothingToDo++;
          liqNote(sl.key, "nothing-to-do", refused.code, "the engine had nothing to liquidate (healthy, or already liquidated); plain refresh sent");
        } else {
          pairingStats.liqRefused++;
          liqNote(sl.key, "refused", refused.code, `${refused.name}; plain refresh sent`);
        }
      } else {
        for (const k of chosen.keys()) {
          excluded.add(k);
          pairingStats.liqSkipped++;
          liqNote(k, "skipped", refused.code, `the tx with liquidation cranks was refused at ${sl?.kind ?? "an unknown instruction"} (${refused.name}); plain refresh sent`);
        }
      }
      continue;
    }
    // NOT a program refusal (no Custom code): compute exhaustion, account in use, blockhash, RPC. Nobody is blamed and nothing
    // is quarantined: shrink the tx (cut the TAIL), the cut refreshes are "deferred" = unsettled, which holds the LP in both modes.
    if (refused.code === null) {
      // Which portfolio (if any) fails BY ITSELF? Probe each refresh alone with the same accrue (read-only simulations, capped).
      // A refresh that fails alone with no code is a CULPRIT: dropped, counted toward the deferral escalation. If the accrue
      // crank alone already fails, nobody is blamed. If nothing fails alone the tx is simply too heavy (the weight model):
      // cut the tail, count nobody.
      if (!probed && hasAccrue && refresh.length > 0) {
        probed = true;
        const accrueOnly = buildSweepTxIxs(owner, ctx.market, { accrue, accrueTarget: target, refresh: [], oracleAccounts: o.oracleAccounts });
        const base = await simulateOnly(deps.exec, accrueOnly, { units: SWEEP_TX_UNITS });
        if (base.err !== null && base.code === null) return fail(outcome); // the accrue itself fails: no blame
        const bad: PositionedPortfolio[] = [];
        for (const p of refresh.slice(0, MAX_PROBES)) {
          const probe = await simulateOnly(deps.exec, buildSweepTxIxs(owner, ctx.market, { accrue, accrueTarget: target, refresh: [p], oracleAccounts: o.oracleAccounts }), { units: SWEEP_TX_UNITS });
          if (probe.err !== null && probe.code === null) bad.push(p);
        }
        if (bad.length > 0) {
          const badKeys = new Set(bad.map((p) => p.pubkey.toBase58()));
          for (const k of badKeys) {
            culprits.add(k);
            pruned.push({ key: k, reason: "deferred", code: null, culprit: true });
          }
          pairingStats.shrinkDeferrals++;
          refresh = refresh.filter((p) => !badKeys.has(p.pubkey.toBase58()));
          continue;
        }
      }
      if (refresh.length > 1 && shrinks < 3) {
        shrinks++;
        pairingStats.shrinkDeferrals++;
        const cut = Math.max(1, Math.ceil(refresh.length / 4));
        for (const p of refresh.slice(-cut)) pruned.push({ key: p.pubkey.toBase58(), reason: "deferred", code: null });
        refresh = refresh.slice(0, -cut);
        continue;
      }
      return fail(outcome);
    }
    const idx = refused.index;
    if (idx === null) return fail(outcome);
    if (hasAccrue && idx === 0) {
      if (refused.code === NON_PROGRESS && !droppedAccrue) {
        pairingStats.accrueAlreadyDone++;
        ({ accrue, target, refresh } = dropAccrue(t, accrue, target, refresh));
        droppedAccrue = true;
        continue;
      }
      // The program refused the ANCHOR accrue (closed, filled, wrong): fall back to the counterparty form for this tx.
      if (accrue === "anchor" && refresh.length > 0 && refused.code !== NON_PROGRESS) {
        anchorRefused = true;
        pairingStats.anchorFallbacks++;
        accrue = "counterparty";
        target = refresh[0].pubkey;
        refresh = refresh.slice(1);
        continue;
      }
      // Accrue through a COUNTERPARTY the program refuses: isolate THAT portfolio and accrue through the next one.
      if (accrue === "counterparty" && target && refresh.length > 0) {
        const reason: PruneReason = refused.expected ? "band" : "hard";
        if (reason === "band") pairingStats.bandExpected++;
        else pairingStats.hardRefusals++;
        pruned.push({ key: target.toBase58(), reason, code: refused.code });
        target = refresh[0].pubkey;
        refresh = refresh.slice(1);
        continue;
      }
      return fail(outcome);
    }
    // Multi-asset refresh-only tx: its first crank observes (see buildSweepTxSlots). Custom(22) there means the market clock is
    // already current in this slot, NOT that the portfolio is current: nothing is pruned or counted settled; try next tick.
    if (!hasAccrue && idx === 0 && refused.code === NON_PROGRESS && isMultiAssetMarket(ctx.market.toBase58())) return fail(outcome);
    const refreshIdx = hasAccrue ? idx - 1 : idx;
    const victim = refresh[refreshIdx];
    if (!victim) return fail(outcome); // a refusal on the tail instruction (e.g. 78): the caller classifies it
    const reason: PruneReason = refused.code === NON_PROGRESS ? "current" : refused.expected ? "band" : "hard";
    if (reason === "current") pairingStats.prunedCurrent++;
    else if (reason === "band") pairingStats.bandExpected++;
    else pairingStats.hardRefusals++;
    pruned.push({ key: victim.pubkey.toBase58(), reason, code: refused.code });
    refresh = refresh.filter((_, i) => i !== refreshIdx);
  }
  return fail({ kind: "failed", error: "prune budget exhausted" });
}

function dropAccrue(t: PlannedTx, accrue: PlannedTx["accrue"], target: PublicKey | null, refresh: PositionedPortfolio[]) {
  // refresh-only: the accrue target that was also a SETTLE (LP, counterparty) becomes a plain refresh
  let r = refresh;
  if (target && (accrue === "lp" || accrue === "counterparty")) r = [{ pubkey: target, longLegs: 0, shortLegs: 0, isLp: accrue === "lp" }, ...refresh];
  void t;
  return { accrue: "none" as PlannedTx["accrue"], target: null as PublicKey | null, refresh: r };
}

// ── MERGED_ROUND (multi-asset markets) ─────────────────────────────────────────────────────────────────────────────
/**
 * On a multi-asset market every observing crank accrues EVERY listed asset; when a mark moved, the accrual re-stales every
 * positioned portfolio. Two txs a few slots apart (counterparty obs, then LP obs) therefore leave the market almost never
 * all-settled: tx B's accrual re-stales what tx A settled, and a fresh open is refused Custom(121) EngineLossStale. The paired
 * round is thus sent as ONE atomic tx when it fits:
 *   [ObsCrank(first counterparty, hints = every listed asset), refresh-only crank(each other counterparty), refresh-only crank(LP) LAST]
 * Refresh-only is valid because it shares the tx/slot with the observing crank. The LP (>= 3 legs needs a health cert at the
 * current risk epoch) is refreshed last. Accepted only if the simulation is clean and <= MERGED_MAX_CU (the F1 10% line below
 * the 1.4M limit); a crank refused Custom(22) (already current) is dropped and the tx re-simulated; anything else falls back to the
 * unchanged phased plan. Measured on a LiteSVM clone of 2xhs: [GV86 obs all 385,907 + LP refresh-only 549,894] = 936,149 CU.
 */
export const MERGED_MAX_CU = 1_260_000;
const PACKET_LIMIT = 1_232;

export interface MergedSlot {
  ix: TransactionInstruction;
  key: string;
  role: "observe" | "refresh" | "lp";
}

/** [observing crank on cps[0], hint-less refresh of cps[1..], hint-less refresh of the LP LAST]. `cps` must not be empty. */
export function buildMergedRoundSlots(owner: PublicKey, market: PublicKey, cps: ReadonlyArray<PublicKey>, lp: PublicKey, oracleAccounts: ReadonlyArray<PublicKey> = []): MergedSlot[] {
  const slots: MergedSlot[] = [];
  cps.forEach((c, i) => {
    slots.push(i === 0 ? { ix: buildObservationCrankIx(owner, market, c, oracleAccounts), key: c.toBase58(), role: "observe" } : { ix: buildRefreshCrankIx(owner, market, c), key: c.toBase58(), role: "refresh" });
  });
  slots.push({ ix: buildRefreshCrankIx(owner, market, lp), key: lp.toBase58(), role: "lp" });
  return slots;
}

type MergedResult =
  | { kind: "done"; outcome: ExecOutcome; settled: string[]; lpSettled: boolean }
  | { kind: "unlanded"; outcome: ExecOutcome }
  | { kind: "fallback"; why: string };

function packetFits(owner: PublicKey, ixs: ReadonlyArray<TransactionInstruction>): boolean {
  try {
    const t = new Transaction({ feePayer: owner, recentBlockhash: "11111111111111111111111111111111" });
    t.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }), ComputeBudgetProgram.setComputeUnitLimit({ units: SWEEP_TX_UNITS }));
    for (const i of ixs) t.add(i);
    addKeeperPriorityFee(t); // S3-A2: the executor appends it when configured; size it in
    return t.serialize({ requireAllSignatures: false, verifySignatures: false }).length + 64 <= PACKET_LIMIT;
  } catch {
    return false;
  }
}

/** Simulate (dropping Custom(22) cranks), gate on CU and size, then send. Never throws. Nothing is sent unless it returns `done` / `unlanded`. */
async function runMergedRound(deps: SweepDeps, ctx: { market: PublicKey; label: string }, cps: ReadonlyArray<PublicKey>, lp: PublicKey, oracleAccounts: ReadonlyArray<PublicKey> | undefined): Promise<MergedResult> {
  const owner = deps.exec.keeper.publicKey;
  try {
    let slots = buildMergedRoundSlots(owner, ctx.market, cps, lp, oracleAccounts ?? []);
    const dropped: string[] = [];
    for (let attempt = 0; attempt <= SWEEP_MAX_PRUNES; attempt++) {
      const ixs = slots.map((s) => s.ix);
      if (!packetFits(owner, ixs)) return { kind: "fallback", why: `${ixs.length} cranks do not fit one packet` };
      const sim = await simulateOnly(deps.exec, ixs, { units: SWEEP_TX_UNITS });
      if (sim.err) {
        const ie = parseInstructionError(sim.err);
        const idx = ie ? ie.index - COMPUTE_IX_COUNT : -1;
        // Custom(22) on a non-observing crank = that portfolio is already current: drop it, re-simulate. On the observing crank
        // (idx 0) it means the clock is already current this slot: the phased plan handles that (never a hint-less lone crank).
        if (sim.code === NON_PROGRESS && idx > 0 && idx < slots.length) {
          dropped.push(slots[idx].key);
          pairingStats.mergedDroppedCurrent++;
          slots = slots.filter((_, i) => i !== idx);
          continue;
        }
        return { kind: "fallback", why: `simulation refused (${sim.code !== null ? `Custom(${sim.code})` : "no program code"}) at crank ${idx}` };
      }
      if (sim.unitsConsumed === null || sim.unitsConsumed > MERGED_MAX_CU) return { kind: "fallback", why: `simulated ${sim.unitsConsumed ?? "n/a"} CU > ${MERGED_MAX_CU}` };
      const out = await simulateAndSend(deps.exec, ixs, { job: "sweep", label: ctx.label, units: SWEEP_TX_UNITS, expected: BAND_EXPECTED_CODES });
      if (out.kind === "refused" || out.kind === "failed" || out.kind === "held") return { kind: "fallback", why: `send-time simulation: ${out.kind}` };
      if ((out.kind === "sent" && out.landed === "landed") || out.kind === "dry-run") {
        return { kind: "done", outcome: out, settled: [...slots.map((s) => s.key), ...dropped], lpSettled: slots.some((s) => s.role === "lp") || dropped.includes(lp.toBase58()) };
      }
      return { kind: "unlanded", outcome: out };
    }
    return { kind: "fallback", why: "prune budget exhausted" };
  } catch (err) {
    return { kind: "fallback", why: `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120) };
  }
}

/** Debug line when a multi-asset market skips the merged path: at most one per market per 60 s (and again at once when the reason changes). */
const mergedSkipLog = new Map<string, { at: number; why: string }>();
export const MERGED_SKIP_LOG_MS = 60_000;
export function resetMergedSkipLog(): void {
  mergedSkipLog.clear();
}
function logMergedSkip(deps: SweepDeps, market: string, label: string, why: string, now: number = Date.now()): void {
  const prev = mergedSkipLog.get(market);
  if (prev && prev.why === why && now - prev.at < MERGED_SKIP_LOG_MS) return;
  mergedSkipLog.set(market, { at: now, why });
  (deps.exec.log ?? ((l: string) => console.log(l)))(`[v22][merged] ${label}: merged round skipped, phased plan: ${why}`);
}

/**
 * Plan and execute one round for one market. `counterparties` excludes the LP. Never throws.
 */
export async function runSettleRound(
  deps: SweepDeps,
  ctx: { market: PublicKey; label: string },
  input: RoundInput,
  cfg: SweepRoundConfig = DEFAULT_SWEEP_ROUND_CONFIG,
): Promise<RoundResult> {
  const hold = deps.hold ?? realHold;
  const release = deps.release ?? realRelease;
  const nowSlot = BigInt(input.nowSlot ?? 0);
  const quarantine = input.quarantine ?? new Map<string, bigint>();
  const history = input.quarantineHistory ?? new Map<string, { code: number; level: number }>();
  const backoff = input.gapBackoff;
  const protective = input.protective === true;
  const emptyRes = (plan: RoundPlan, abandoned: string | null, backedOff: boolean): RoundResult => ({ plan, txsSent: 0, settled: [], missing: [], rentSettled: [], backedOff, anchorRefused: false, escalated: [], pruned: 0, lpSettled: false, gapSlots: null, abandoned, outcomes: [], liq: [] });

  // Gap backoff: after a round abandoned for a gap > maxGapSlots, skip a few rounds instead of re-sending phase 1 every tick.
  if (backoff && backoff.skipRounds > 0 && !protective) {
    backoff.skipRounds--;
    pairingStats.gapBackoffRounds++;
    return emptyRes(planSettleRound({ mode: cfg.pairing, lp: input.lp, counterparties: [] }), `gap backoff: ${backoff.skipRounds} more round(s) skipped`, true);
  }

  // Quarantined counterparties are not planned but are MISSING for the pairing decision.
  const missing: RoundResult["missing"] = [];
  const planned: PositionedPortfolio[] = [];
  for (const c of input.counterparties) {
    const k = c.pubkey.toBase58();
    const until = quarantine.get(k);
    if (until !== undefined && until > nowSlot) missing.push({ key: k, why: "quarantined" });
    else {
      if (until !== undefined) quarantine.delete(k);
      planned.push(c);
    }
  }
  pairingStats.quarantinedNow = [...quarantine.values()].filter((u) => u > nowSlot).length;

  // F1 stage A: counterparties within the pad of maintenance weigh more (their liquidation crank), so the planner makes room.
  const stageA = markLiquidationCandidates(planned, input.liq?.params ? { params: input.liq.params, padBps: input.liq.padBps ?? DEFAULT_LIQ_PAD_BPS } : null);
  const plan = planSettleRound({ mode: cfg.pairing, lp: input.lp, lpWeight: input.lpWeight, counterparties: stageA.marked, anchor: input.anchor ?? null, weightBudget: cfg.weightBudget, maxTxsPerRound: cfg.maxTxsPerRound });
  const res: RoundResult = { plan, txsSent: 0, settled: [], missing, rentSettled: [], backedOff: false, anchorRefused: false, escalated: [], pruned: 0, lpSettled: false, gapSlots: null, abandoned: null, outcomes: [], liq: [] };
  pairingStats.rounds++;
  if (protective) pairingStats.protectiveRounds++;
  if (plan.txs.length <= 1) pairingStats.singleTxRounds++;
  else pairingStats.multiTxRounds++;
  if (plan.lpDeferred) pairingStats.lpDeferredStrict++;
  for (const t of plan.txs) {
    if (t.accrue === "anchor") pairingStats.anchorAccrues++;
    if (t.accrue === "counterparty") pairingStats.counterpartyAccrues++;
  }
  for (const u of plan.unvisited) res.missing.push({ key: u.pubkey.toBase58(), why: "unplanned" });

  const marketKey = ctx.market.toBase58();
  const holding = plan.needsPushHold && cfg.pairing !== "off";
  if (holding) hold(marketKey, cfg.holdMs);
  // Quarantine a program-refused portfolio: ladder by REPEAT of the same code; capped per round unless each code is distinct.
  const deferrals = input.deferrals ?? new Map<string, number>();
  const quarantinedThisRound = new Set<number>();
  let quarantinedCount = 0;
  const q = (key: string, code: number | null) => {
    if (code === null) return;
    if (quarantinedCount >= MAX_QUARANTINES_PER_ROUND && quarantinedThisRound.has(code)) {
      pairingStats.quarantineCapped++;
      return;
    }
    quarantinedCount++;
    quarantinedThisRound.add(code);
    const h = history.get(key);
    const level = h && h.code === code ? Math.min(h.level + 1, QUARANTINE_LADDER.length - 1) : 0;
    history.set(key, { code, level });
    quarantine.set(key, nowSlot + BigInt(QUARANTINE_LADDER[level]));
  };
  try {
    const [phase1, phase2] = plan.phases.length > 1 ? [plan.phases[0], plan.phases[1]] : [plan.phases[0] ?? [], [] as number[]];
    const liqTx: LiqTxOptions | undefined =
      input.liq && stageA.candidates.size > 0
        ? { layout: input.liq.layout, slots: input.liq.slots, candidates: stageA.candidates, exactPadBps: input.liq.exactPadBps ?? DEFAULT_LIQ_EXACT_PAD_BPS, maxPerTx: input.liq.maxPerTx ?? DEFAULT_LIQ_MAX_PER_TX }
        : undefined;
    const runOpts = (isLp: boolean): RunTxOptions => ({
      liq: liqTx,
      oracleAccounts: input.oracleAccounts,
      lpGate: isLp
        ? (prunedNotSettled) =>
            // a culprit about to be escalated (this would be its DEFERRAL_ESCALATION_AFTER-th no-code failure in a row) is a
            // program-refused miss for pairing, not a deferral: the gate must agree with what record() will do next
            lpHold(prunedNotSettled.map((p) => (p.reason === "deferred" && !(p.culprit && (deferrals.get(p.key) ?? 0) + 1 >= DEFERRAL_ESCALATION_AFTER) ? "deferred" : p.key)))
        : undefined,
    });
    /**
     * Reason to hold the LP tx now, or null. A counterparty that did NOT land or was DEFERRED (no program code: compute /
     * runtime) always holds the LP. Only a REAL program refusal (band / hard) may be waived, by `prefer`, with the miss counted.
     */
    const lpHold = (extra: string[]): string | null => {
      if (protective) return null;
      const unlanded = res.missing.some((m) => m.why === "unlanded" || m.why === "deferred") || extra.includes("deferred");
      if (unlanded) return "a counterparty tx did not land or was deferred (no program refusal): the LP is not settled alone";
      const miss = res.missing.filter((m) => m.why !== "current").map((m) => m.key).concat(extra);
      if (miss.length > 0 && cfg.pairing === "strict") return `strict: ${miss.length} counterparties were refused or skipped; the LP waits`;
      return null;
    };
    const record = (r: TxRun) => {
      res.outcomes.push(r.outcome);
      res.liq.push(...r.liq);
      res.pruned += r.pruned.length;
      if (r.outcome.kind === "sent") res.txsSent++;
      if (r.anchorRefused) res.anchorRefused = true;
      res.settled.push(...r.settled);
      for (const k of r.settled) deferrals.delete(k);
      // Memory for no-code failures: after DEFERRAL_ESCALATION_AFTER in a row the portfolio is treated as program-refused
      // for pairing (so `prefer` proceeds; `strict` still holds on it), quarantined, counted, and named for the alert.
      const escalatedNow = new Set<string>();
      for (const k of new Set(r.noCodeKeys)) {
        const n = (deferrals.get(k) ?? 0) + 1;
        deferrals.set(k, n);
        if (n >= DEFERRAL_ESCALATION_AFTER) escalatedNow.add(k);
      }
      const escalate = (k: string) => {
        if (res.escalated.includes(k)) return;
        res.escalated.push(k);
        pairingStats.deferralEscalations++;
        quarantine.set(k, nowSlot + BigInt(DEFERRAL_ESCALATION_SLOTS));
        res.missing.push({ key: k, why: "hard" });
      };
      for (const p of r.pruned) {
        if (p.reason === "current") res.settled.push(p.key);
        else if (p.reason === "deferred" && escalatedNow.has(p.key)) escalate(p.key);
        else {
          res.missing.push({ key: p.key, why: p.reason });
          if (p.reason === "band" || p.reason === "hard") q(p.key, p.code);
        }
      }
      for (const k of r.unlanded) {
        if (escalatedNow.has(k)) escalate(k);
        else res.missing.push({ key: k, why: "unlanded" });
      }
    };
    const runRent = async (): Promise<void> => {
      // Phase 3: rent. Only after the LP settled, only for portfolios this round already refreshed with the PLAIN crank
      // (so a liquidatable / B-stale counterparty was handled by the engine's own action choice), one tx each, sequentially
      // (tag 106 write-locks the LP, so these must not run in parallel with anything else).
      if (res.lpSettled && input.rent && input.rent.due.size > 0) {
        const settled = new Set(res.settled);
        let n = 0;
        for (const c of input.counterparties) {
          const k = c.pubkey.toBase58();
          if (n >= (input.rent.max ?? RENT_SETTLES_PER_ROUND)) break;
          if (!input.rent.due.has(k) || !settled.has(k)) continue;
          n++;
          const out = await simulateAndSend(deps.exec, [input.rent.build(c)], { job: "rent-106", label: ctx.label, units: legAwareTxUnits(c, 600_000), expected: BAND_EXPECTED_CODES });
          res.outcomes.push(out);
          if ((out.kind === "sent" && out.landed === "landed") || out.kind === "dry-run") {
            res.rentSettled.push(k);
            pairingStats.rentSettlesInRound++;
          }
        }
      }
    };
    // MERGED_ROUND: a multi-asset paired round goes out as ONE atomic tx when it fits (see runMergedRound); else the phased plan below.
    const mergedSkip = (): string | null => {
      if (!isMultiAssetMarket(marketKey)) return null; // single-asset: not a merge candidate, never logged
      if (plan.txs.length <= 1) return null; // already one tx
      if (cfg.pairing === "off") return "pairing off";
      if (protective) return "protective round";
      if (!plan.paired || plan.lpDeferred || plan.unvisited.length > 0) return `plan not fully paired (${plan.unvisited.length} unvisited${plan.lpDeferred ? ", LP deferred" : ""})`;
      if (plan.lpTxIndex === null || plan.lpTxIndex !== plan.txs.length - 1) return "LP is not the last planned tx";
      if (stageA.candidates.size > 0) return `${stageA.candidates.size} liquidation candidate(s) in the round`;
      const h = lpHold([]);
      if (h) return `LP hold: ${h}`;
      return null;
    };
    const skip = mergedSkip();
    if (skip !== null) logMergedSkip(deps, marketKey, ctx.label, skip);
    if (isMultiAssetMarket(marketKey) && plan.txs.length > 1 && skip === null) {
      const cpKeys: PublicKey[] = [];
      for (const t of plan.txs) {
        if (t.accrue === "counterparty" && t.accrueTarget) cpKeys.push(t.accrueTarget);
        for (const r of t.refresh) cpKeys.push(r.pubkey);
      }
      if (cpKeys.length > 0) {
        const m = await runMergedRound(deps, ctx, cpKeys, input.lp, input.oracleAccounts);
        if (m.kind === "done") {
          res.outcomes.push(m.outcome);
          if (m.outcome.kind === "sent") res.txsSent++;
          res.settled.push(...m.settled);
          for (const k of m.settled) deferrals.delete(k);
          res.lpSettled = m.lpSettled;
          res.merged = true;
          pairingStats.mergedRounds++;
          if (m.lpSettled) {
            pairingStats.pairedLpSettles++;
            pairingStats.consecutiveGapExceeded = 0;
            if (backoff) backoff.level = 0;
          }
          await runRent();
          return res;
        }
        if (m.kind === "unlanded") {
          // sent but not confirmed landed: it may still land, so the phased plan is NOT also sent
          res.outcomes.push(m.outcome);
          res.txsSent++;
          res.abandoned = "merged round tx did not land";
          return res;
        }
        pairingStats.mergedFallbacks++;
        logMergedSkip(deps, marketKey, ctx.label, m.why);
      }
    }
    const lpIsInPhase1 = plan.lpTxIndex !== null && phase1.includes(plan.lpTxIndex);
    const run = (i: number) => runPlannedTx(deps, ctx, plan.txs[i], runOpts(plan.txs[i].settlesLp));

    const p1 = await Promise.all(phase1.map(run));
    p1.forEach(record);
    const okRun = (r: TxRun) => (r.outcome.kind === "sent" && r.outcome.landed === "landed") || r.outcome.kind === "dry-run";
    const lastLanded = Math.max(0, ...p1.map((r) => (r.outcome.kind === "sent" ? r.outcome.landedSlot ?? 0 : 0)));
    const noteLp = (landedOk: boolean) => {
      res.lpSettled = landedOk;
      if (!landedOk) return;
      const misses = res.missing.filter((m) => m.why !== "current");
      if (plan.paired && misses.length === 0) pairingStats.pairedLpSettles++;
      else pairingStats.unpairedLpSettles++;
    };

    if (lpIsInPhase1) {
      const lpRun = p1[phase1.indexOf(plan.lpTxIndex as number)];
      noteLp(okRun(lpRun));
      if (lpRun.outcome.kind === "held") {
        if (lpRun.outcome.reason.startsWith("strict")) pairingStats.lpHeldCounterpartyMiss++;
        else pairingStats.lpHeldPhase1Unlanded++;
        res.abandoned = lpRun.outcome.reason;
      }
    }

    if (phase2.length > 0) {
      const hold1 = lpHold([]);
      if (hold1) {
        if (hold1.startsWith("a counterparty")) pairingStats.lpHeldPhase1Unlanded++;
        else pairingStats.lpHeldCounterpartyMiss++;
        res.abandoned = hold1;
        return res;
      }
      if (!protective && lastLanded > 0) {
        const now = await deps.getSlot();
        const gap = now - lastLanded;
        res.gapSlots = gap;
        pairingStats.lastGapSlots = gap;
        pairingStats.maxGapSlots = Math.max(pairingStats.maxGapSlots, gap);
        if (gap > cfg.maxGapSlots) {
          pairingStats.gapExceeded++;
          pairingStats.consecutiveGapExceeded++;
          if (backoff) {
            backoff.level = Math.min(backoff.level + 1, MAX_GAP_BACKOFF_ROUNDS);
            backoff.skipRounds = backoff.level;
          }
          res.abandoned = `slot gap ${gap} > ${cfg.maxGapSlots} between the counterparty txs and the LP tx; backing off ${backoff?.skipRounds ?? 0} round(s)`;
          return res;
        }
      }
      const lpRun = await runPlannedTx(deps, ctx, plan.txs[phase2[0]], runOpts(true));
      record(lpRun);
      noteLp(okRun(lpRun));
      if (lpRun.outcome.kind === "held") {
        if (lpRun.outcome.reason.startsWith("strict")) pairingStats.lpHeldCounterpartyMiss++;
        else pairingStats.lpHeldPhase1Unlanded++;
        res.abandoned = lpRun.outcome.reason;
      }
      if (res.lpSettled) {
        pairingStats.consecutiveGapExceeded = 0;
        if (backoff) backoff.level = 0;
        if (lpRun.outcome.kind === "sent" && lpRun.outcome.landedSlot !== null && lastLanded > 0) {
          res.gapSlots = lpRun.outcome.landedSlot - lastLanded;
          pairingStats.lastGapSlots = res.gapSlots;
          pairingStats.maxGapSlots = Math.max(pairingStats.maxGapSlots, res.gapSlots);
        }
      }
    } else if (res.lpSettled && backoff) {
      backoff.level = 0;
    }

    await runRent();
    return res;
  } catch (err) {
    res.abandoned = `round failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160);
    return res;
  } finally {
    if (holding) release(marketKey);
  }
}
