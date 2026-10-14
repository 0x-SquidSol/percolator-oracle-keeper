/**
 * cross-cluster/v22/settle-pairing.ts   (policy name: SETTLE_PAIRING)
 *
 * WHY. Measured engine bug (coordinator read-only analysis of the live keeper): `PermissionlessCrank` (tag 5) on a
 * portfolio settles ONLY that portfolio to the previously stored K, then accrues the market to the new mark. A loss
 * is booked as backing at once; the counterparties' gains are not credited until they are settled themselves.
 * Settling the vault LP alone at a price peak therefore strands value. Two keeper patterns do exactly that:
 *   - VaultLpCranker.onPushLanded: a LONE LP observation crank 1.5 s after every landed push whose mark moved;
 *   - the #147 sweep: an LP accrue+settle in EVERY sweep tx, settling each counterparty once per round, so a
 *     counterparty's stale interval is about ceil(P / 10) cycles (P = positioned count) against at most 20 s on the
 *     legacy path.
 * An engine-side fix is designed separately. This policy is DEFENCE IN DEPTH, not the fix.
 *
 * THE POLICY. The LP is never settled in a transaction that does not also settle every counterparty of that asset
 * that fits; the round is ordered so the LP's settle lands in the LAST transaction of the round; every
 * transaction of a round targets the same slot where possible.
 *
 *   off      today's #147 shape: [LP crank, refresh xN] in every tx (no pairing claim).
 *   prefer   (default) pair whenever the round can be completed inside the tx budget; otherwise degrade to the
 *            legacy shape for the overflow and COUNT it (`unpairedLpSettles`, /health).
 *   strict   never settle the LP unpaired: a round that cannot be completed is refused for the LP (counterparties
 *            are still refreshed), the market is reported `pairing-blocked` and the LP waits for the next round.
 *
 * ROUND SHAPES (W = weight budget per tx, a refresh weighs 3 + legs, the LP crank weighs 3 + LP legs):
 *   1. everything fits one tx  -> ONE tx [LP crank (accrue + settle LP), refresh all]. Atomic: same slot. paired.
 *   2. otherwise, N+1 txs, heaviest stale weight first:
 *        tx 1..N   [observation crank on the tx's FIRST counterparty (accrue, settles that counterparty), refresh rest]
 *                  (accrue-only form: see ACCRUE-ONLY below)
 *        tx N+1    [LP crank (accrue + settle LP), refresh the remaining (lightest) counterparties]   <- LP LAST
 *      Phase 1 (tx 1..N) is sent in parallel with one blockhash; phase 2 (the LP tx) is sent only after phase 1
 *      landed, and only if the slot gap is within `maxGapSlots` (else the round is abandoned and re-planned).
 *      Pushes are held for the round so the mark does not move between the phases.
 *
 * ACCRUE-ONLY (the coordinator asked: does a crank exist that accrues WITHOUT settling the LP?)
 *   - The no-observation (refresh) form does NOT accrue: it is accepted only when the asset is already accrued in
 *     the current slot, else EngineNonProgress (Custom(22)). So it is not an accrue-only crank.
 *   - A PermissionlessCrank WITH an observation accrues the market through WHICHEVER portfolio it targets: the wire
 *     (`handle_permissionless_crank_zero_copy`, wrapper release/v22-wrapper-rem) takes `portfolio` as any
 *     market-bound portfolio, not only the LP. So accrue-only exists in two forms:
 *       (a) target a FLAT portfolio (the "anchor"): settles nothing of value. Optional; supplied by
 *           KEEPER_V22_ACCRUE_ANCHORS or discovered (a zero-leg, non-LP portfolio of the market).
 *       (b) target the tx's first COUNTERPARTY: the accrue settles that counterparty, never the LP. Always
 *           available when the tx has a counterparty. This is the default; it also saves that counterparty's
 *           separate refresh.
 *   - NOT VERIFIED without a live v2.2 market: that the engine returns success (not Custom(22)) when the target of
 *     an observation crank is a flat portfolio. The executor simulates first, so a refusal degrades to (b).
 *
 * WHAT THIS CANNOT GUARANTEE (also in the PR body):
 *   1. Multi-tx rounds are not atomic. Between phase 1 landing and the LP tx landing there are g slots
 *      (expected 1-4 slots, about 0.4-1.6 s; hard cap `maxGapSlots`, default 8). Funding / rent keep accruing for
 *      g slots, and any mark push by ANOTHER writer in that window moves K. Our own pushes are held.
 *   2. A single tx round (<= W) is the only exactly-atomic case.
 *   3. Anyone (not the keeper) can still crank the LP alone: tag 5 is permissionless.
 *   4. The positioned set is a read; a portfolio that opens or closes during the round is missed until the next one.
 *   5. If P exceeds `maxTxsPerRound` txs, `prefer` settles the LP with part of the book unvisited (counted),
 *      `strict` does not settle the LP that round.
 *   6. It does not repair the engine bug; it narrows the keeper's own exposure.
 */
import { PublicKey } from "@solana/web3.js";
import { V22_CU_PER_WEIGHT, V22_LEG_COST } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { PairingMode } from "./flags.ts";

/** Per-weight-unit CU measured from the Wave A refresh CU (8 single-leg 1,016,434; 2 x 14-leg 1,199,659). One source: positioned-refresh.ts. */
export const CU_PER_WEIGHT = V22_CU_PER_WEIGHT;
export const MAX_TX_CU_V22 = 1_400_000;
export const DEFAULT_WEIGHT_BUDGET = 32;
export const DEFAULT_MAX_TXS_PER_ROUND = 16;
/** Slots allowed between the last counterparty tx landing and the LP tx landing. */
export const DEFAULT_MAX_GAP_SLOTS = 8;
export const FLAT_ANCHOR_WEIGHT = 3;

/**
 * Weight of a SOLO portfolio (3+ legs, see V22_LEG_COST): heavier than any transaction budget, so it can only ride
 * alone. Finite on purpose (health rows and JSON carry it).
 */
export const SOLO_WEIGHT = 1_000;

/**
 * Weight of one refreshed / settled portfolio: 3 + its active legs (Wave A "A6"). The legs are ALL of the portfolio's
 * active legs (`activeLegs`, every asset: a refresh settles them all), never fewer than the legs on the asset. An
 * account at or above V22_SOLO_MIN_LEGS legs weighs SOLO_WEIGHT: its worst settle measured 1,013,864 CU at the 4-leg
 * cap, which leaves no room for another account beside it (positioned-refresh.ts has the numbers).
 */
export function portfolioWeight(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs" | "liqWeight">): number {
  return V22_LEG_COST.isSolo(p) ? SOLO_WEIGHT : 3 + V22_LEG_COST.legs(p) + (p.liqWeight ?? 0);
}

/** The weight budget a tx of `maxCu` compute units supports once the accrue crank and headroom are paid. */
export function weightBudgetFor(maxCu = MAX_TX_CU_V22, accrueCu = 200_000, headroomCu = 60_000, cuPerWeight = CU_PER_WEIGHT): number {
  return Math.max(1, Math.floor((maxCu - accrueCu - headroomCu) / cuPerWeight));
}

/**
 * Compute-unit limit for a SINGLE-instruction transaction that settles `p` as part of its work (rent 106, dust 118): the
 * instruction's own `baseUnits` (600k, sized on one leg), raised for a solo account to its worst settle plus 200k headroom
 * (a 4-leg account: 1,213,864). A limit is a cap, not a charge; the simulation still decides whether the call is sent.
 */
export function legAwareTxUnits(p: Pick<PositionedPortfolio, "longLegs" | "shortLegs" | "activeLegs">, baseUnits: number): number {
  return V22_LEG_COST.isSolo(p) ? Math.min(MAX_TX_CU_V22, Math.max(baseUnits, V22_LEG_COST.worstRefreshCu(p) + 200_000)) : baseUnits;
}

export type AccrueSource = "lp" | "anchor" | "counterparty" | "none";

export interface PlannedTx {
  index: number;
  /** Which portfolio the observation (accrue) crank targets; `none` = refresh-only (already accrued this slot). */
  accrue: AccrueSource;
  /** Portfolio the accrue crank targets (LP, the anchor, or the first counterparty). */
  accrueTarget: PublicKey | null;
  /** Refreshes after the accrue crank, heaviest first. Never contains the accrue target. */
  refresh: PositionedPortfolio[];
  /** True when this tx settles the LP (accrue on the LP, or a refresh of it). */
  settlesLp: boolean;
  weight: number;
}

export interface RoundPlan {
  mode: PairingMode;
  txs: PlannedTx[];
  /** Index of the tx that settles the LP, or null when this round does not settle it. */
  lpTxIndex: number | null;
  /**
   * True when the LP settle is paired: it shares a tx with all counterparties (single-tx round) or sits in the
   * LAST tx of a round that visits every counterparty. Always false for mode `off` multi-tx rounds.
   */
  paired: boolean;
  /** Counterparties not covered by any tx of this plan. */
  unvisited: PositionedPortfolio[];
  /** LP settled while `unvisited` is non-empty (prefer's counted degradation). */
  unpairedLpSettle: boolean;
  /** strict: the LP was left out of the round. */
  lpDeferred: boolean;
  /** Phase 1 = every tx before the LP tx (sent in parallel); phase 2 = the LP tx (after phase 1 landed). */
  phases: number[][];
  /** Counterparty txs are sent with a push hold, and the LP tx only within the gap. */
  needsPushHold: boolean;
  notes: string[];
}

export interface PlanInput {
  mode: PairingMode;
  lp: PublicKey;
  /** Weight of the LP's own settle (3 + its legs); 3 when unknown. */
  lpWeight?: number;
  /** Non-LP positioned portfolios of the asset. */
  counterparties: ReadonlyArray<PositionedPortfolio>;
  /** A flat portfolio that can take the accrue crank (optional). */
  anchor?: PublicKey | null;
  weightBudget?: number;
  maxTxsPerRound?: number;
}

function heaviestFirst(xs: ReadonlyArray<PositionedPortfolio>): PositionedPortfolio[] {
  return [...xs].sort((a, b) => {
    const wa = portfolioWeight(a);
    const wb = portfolioWeight(b);
    if (wa !== wb) return wb - wa;
    const la = a.lossWeight ?? 0n;
    const lb = b.lossWeight ?? 0n;
    if (la !== lb) return la > lb ? -1 : 1;
    const ka = a.pubkey.toBase58();
    const kb = b.pubkey.toBase58();
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Greedy pack, in the given order, into a tx with `cap` weight units for refreshes. Skips nothing that fits. A SOLO
 * portfolio (heavier than any budget) is taken ALONE when it is the first thing taken and `cap` is positive (the tx
 * has an accrue crank of its own beside it, never a second account): `cap <= 0` means the tx's other occupant
 * (a heavy LP) already uses the whole budget, so nothing rides.
 */
function takeUpTo(list: PositionedPortfolio[], cap: number): { taken: PositionedPortfolio[]; rest: PositionedPortfolio[] } {
  const taken: PositionedPortfolio[] = [];
  const rest: PositionedPortfolio[] = [];
  let used = 0;
  for (const p of list) {
    const w = portfolioWeight(p);
    if (used + w <= cap) {
      taken.push(p);
      used += w;
    } else if (taken.length === 0 && cap > 0 && V22_LEG_COST.isSolo(p)) {
      taken.push(p);
      used = Number.POSITIVE_INFINITY;
    } else rest.push(p);
  }
  return { taken, rest };
}

const sumW = (xs: ReadonlyArray<PositionedPortfolio>): number => xs.reduce((n, p) => n + portfolioWeight(p), 0);

/**
 * Plan one round. Pure. `counterparties` is the whole positioned set of the asset minus the LP (the caller passes
 * every counterparty, not just the stale ones: a non-stale refresh is pruned by simulation later, but the pairing
 * rule is about the SET).
 */
export function planSettleRound(i: PlanInput): RoundPlan {
  const W = i.weightBudget ?? DEFAULT_WEIGHT_BUDGET;
  const maxTxs = i.maxTxsPerRound ?? DEFAULT_MAX_TXS_PER_ROUND;
  const lpW = i.lpWeight ?? 3;
  const C = heaviestFirst(i.counterparties);
  const notes: string[] = [];
  const base = { mode: i.mode, needsPushHold: false, notes };

  const lpTx = (index: number, refresh: PositionedPortfolio[]): PlannedTx => ({
    index,
    accrue: "lp",
    accrueTarget: i.lp,
    refresh,
    settlesLp: true,
    weight: lpW + sumW(refresh),
  });

  // ── mode off, or a round that fits one tx: the shapes coincide for the single-tx case.
  if (C.length === 0 || sumW(C) + lpW <= W) {
    const tx = lpTx(0, C);
    return { ...base, txs: [tx], lpTxIndex: 0, paired: true, unvisited: [], unpairedLpSettle: false, lpDeferred: false, phases: [[0]] };
  }

  if (i.mode === "off") {
    // Legacy #147 shape: LP crank in every tx, chunks of counterparties.
    const txs: PlannedTx[] = [];
    let rest = C;
    while (rest.length > 0 && txs.length < maxTxs) {
      const { taken, rest: r } = takeUpTo(rest, W - lpW);
      if (taken.length === 0) break;
      txs.push(lpTx(txs.length, taken));
      rest = r;
    }
    notes.push("pairing off: the LP is settled in every tx (legacy #147 shape)");
    return { ...base, txs, lpTxIndex: txs.length > 0 ? txs.length - 1 : null, paired: false, unvisited: rest, unpairedLpSettle: true, lpDeferred: false, phases: [txs.map((t) => t.index)] };
  }

  // ── multi-tx paired round: counterparty txs first (accrue NOT on the LP), the LP tx last.
  const anchorW = i.anchor ? FLAT_ANCHOR_WEIGHT : 0;
  const cpTxs: PlannedTx[] = [];
  let remaining = C;
  // Phase 1: fill txs from the heaviest until what is left fits the LP tx's capacity.
  while (sumW(remaining) > W - lpW && cpTxs.length < maxTxs - 1) {
    let taken: PositionedPortfolio[];
    let rest: PositionedPortfolio[];
    if (i.anchor) {
      ({ taken, rest } = takeUpTo(remaining, W - anchorW));
      if (taken.length === 0) break;
      cpTxs.push({ index: cpTxs.length, accrue: "anchor", accrueTarget: i.anchor, refresh: taken, settlesLp: false, weight: anchorW + sumW(taken) });
    } else {
      // accrue through the first counterparty (its settle IS the accrue crank): it costs its own weight once.
      ({ taken, rest } = takeUpTo(remaining, W));
      if (taken.length === 0) break;
      const [first, ...others] = taken;
      cpTxs.push({ index: cpTxs.length, accrue: "counterparty", accrueTarget: first.pubkey, refresh: others, settlesLp: false, weight: sumW(taken) });
    }
    remaining = rest;
  }
  const lpCap = W - lpW;
  const { taken: lpTaken, rest: unvisited } = takeUpTo(remaining, lpCap);
  const lastIdx = cpTxs.length;

  if (unvisited.length > 0) {
    // The round cannot complete inside maxTxs.
    if (i.mode === "strict") {
      notes.push(`strict: ${unvisited.length} counterparties do not fit ${maxTxs} txs; the LP is NOT settled this round`);
      // The remaining counterparties that fit still go out so the sweep keeps moving; the LP waits.
      const txs = [...cpTxs];
      if (lpTaken.length > 0) {
        const [first, ...others] = lpTaken;
        txs.push({ index: txs.length, accrue: i.anchor ? "anchor" : "counterparty", accrueTarget: i.anchor ?? first.pubkey, refresh: i.anchor ? lpTaken : others, settlesLp: false, weight: sumW(lpTaken) + anchorW });
      }
      return { ...base, needsPushHold: false, txs, lpTxIndex: null, paired: false, unvisited, unpairedLpSettle: false, lpDeferred: true, phases: [txs.map((t) => t.index)] };
    }
    notes.push(`prefer: ${unvisited.length} counterparties do not fit ${maxTxs} txs; the LP settles with them unvisited (counted)`);
    const txs = [...cpTxs, lpTx(lastIdx, lpTaken)];
    return { ...base, needsPushHold: cpTxs.length > 0, txs, lpTxIndex: lastIdx, paired: false, unvisited, unpairedLpSettle: true, lpDeferred: false, phases: [cpTxs.map((t) => t.index), [lastIdx]] };
  }

  const txs = [...cpTxs, lpTx(lastIdx, lpTaken)];
  notes.push(`paired: ${cpTxs.length} counterparty tx(s) then the LP tx (last); accrue via ${i.anchor ? "a flat anchor" : "the first counterparty of each tx"}`);
  return { ...base, needsPushHold: true, txs, lpTxIndex: lastIdx, paired: true, unvisited: [], unpairedLpSettle: false, lpDeferred: false, phases: cpTxs.length > 0 ? [cpTxs.map((t) => t.index), [lastIdx]] : [[lastIdx]] };
}

/**
 * Does the pairing policy suppress the lone vault-LP crank after a landed push on this market?
 * Only on v2.2 markets, only while the sweep + pairing are on (the sweep replaces the lone crank's job: it settles
 * the LP together with the counterparties). `VAULT_LP_LONE_CRANK=off` suppresses everywhere, independently.
 */
export function loneLpCrankSuppressed(p: { loneLpCrankFlag: boolean; pairingActive: boolean; isV22Market: boolean }): boolean {
  if (!p.loneLpCrankFlag) return true;
  return p.pairingActive && p.isV22Market;
}

/** v2.2 markets the V22 loop has seen (variant B). Consulted by the vault-LP cranker's suppress hook. */
const v22Markets = new Set<string>();
export function markV22Market(marketAddress: string): void {
  v22Markets.add(marketAddress);
}
export function isKnownV22Market(marketAddress: string): boolean {
  return v22Markets.has(marketAddress);
}
export function resetKnownV22Markets(): void {
  v22Markets.clear();
}
