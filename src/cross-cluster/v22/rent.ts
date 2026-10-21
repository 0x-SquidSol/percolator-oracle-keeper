/**
 * cross-cluster/v22/rent.ts   (KEEPER_V22_HOLDING_RENT)
 *
 * Tag 106 SettleHoldingRent on rent markets (rent_max_e9_per_slot != 0), at a configurable cadence per portfolio.
 * Rent is exact regardless of timing (a carry keeps the total identical: ten one-slot settles charged the same as
 * one over the same index delta, Wave B review), so the cadence only bounds how much rent sits un-routed.
 *
 * Tag 106 is crank-equivalent (it ACCRUES the market, then refreshes ONE portfolio). A lone 106 on a counterparty is
 * therefore a counterparty-alone settle plus an accrual outside any round, so:
 *   - with the sweep + pairing ON, rent settles do NOT run from this module's timer: the sweep round sends the
 *     tag 106 IN PLACE OF that portfolio's plain refresh, in the same tx (sweep.ts `RentPlanInput`);
 *   - the LP is never rent-settled under pairing (its settle belongs to the LP tx; rent is index-based and
 *     timing-invariant, so an LP rent settle that waits for pairing off loses nothing);
 *   - with the sweep OFF (no pairing exists) this module's timer path is the only rent settler, as before.
 * Band expected states (104/111/112/113) are counted, not failures.
 */
import { buildSettleHoldingRentIxV22 } from "@percolatorct/sdk";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";
import type { V22Positioned } from "./positioned.ts";
import { legAwareTxUnits, portfolioWeight } from "./settle-pairing.ts";
import { catchupCrankCount } from "../positioned-refresh.ts";

export interface RentState {
  /** `market|portfolio` -> slot of the last settle (landed or dry-run). */
  last: Map<string, bigint>;
}
export const freshRentState = (): RentState => ({ last: new Map() });

export const RENT_TX_UNITS = 600_000;

/** Record rent settles that landed inside a round (the round, not this module, sent them). */
export function markRentSettled(st: RentState, ctx: Pick<V22MarketCtx, "marketAddress" | "readSlot">, keys: ReadonlyArray<string>): void {
  for (const k of keys) st.last.set(`${ctx.marketAddress}|${k}`, BigInt(ctx.readSlot));
}

export interface RentPlan {
  due: Array<{ portfolio: string; weight: number; ageSlots: bigint | null }>;
  skippedLp: boolean;
}

/**
 * AUD-S1-4 follow-up. Tag 106 accrues ONE rent-bearing capped segment (max_accrual_dt_slots) per call, then refreshes the
 * portfolio pinned to the slot that segment reached (wrapper 48d762ca). While the asset lags by a full window or more, a lone
 * 106 cannot reach the read slot: it settles a little less per call. Rent is index-based and nothing is lost, but the rent
 * round should run only after the crank catch-up has brought `slot_last` to within one window of the read slot, which is
 * exactly when `catchupCrankCount` is 0 (the same threshold loop.ts uses to send catch-up cranks first). Pure.
 */
export function rentHeldForCatchup(ctx: Pick<V22MarketCtx, "readSlot" | "refresh">): boolean {
  return catchupCrankCount(BigInt(ctx.readSlot) - ctx.refresh.slotLast, ctx.refresh.maxAccrualDtSlots) > 0;
}

/** Portfolios due for a rent settle: never settled, or older than the cadence; heaviest first. Empty while the asset lags (see rentHeldForCatchup). Pure. */
export function planRentSettles(ctx: V22MarketCtx, positioned: V22Positioned, st: RentState, cadenceSlots: number, pairingActive: boolean, maxPerTick: number): RentPlan {
  if (rentHeldForCatchup(ctx)) return { due: [], skippedLp: false };
  const now = BigInt(ctx.readSlot);
  const rows: RentPlan["due"] = [];
  let skippedLp = false;
  for (const p of positioned.all) {
    if (p.isLp && pairingActive) {
      skippedLp = true;
      continue;
    }
    const key = `${ctx.marketAddress}|${p.pubkey.toBase58()}`;
    const last = st.last.get(key);
    const age = last === undefined ? null : now - last;
    if (age === null || age >= BigInt(cadenceSlots)) rows.push({ portfolio: p.pubkey.toBase58(), weight: portfolioWeight(p), ageSlots: age });
  }
  rows.sort((a, b) => {
    // never settled first, then oldest, then heaviest
    if ((a.ageSlots === null) !== (b.ageSlots === null)) return a.ageSlots === null ? -1 : 1;
    if (a.ageSlots !== null && b.ageSlots !== null && a.ageSlots !== b.ageSlots) return a.ageSlots > b.ageSlots ? -1 : 1;
    return b.weight - a.weight || (a.portfolio < b.portfolio ? -1 : 1);
  });
  return { due: rows.slice(0, maxPerTick), skippedLp };
}

export async function settleRentOnce(
  exec: ExecContext,
  ctx: V22MarketCtx,
  positioned: V22Positioned,
  st: RentState,
  p: { cadenceSlots: number; pairingActive: boolean; maxPerTick?: number },
): Promise<{ plan: RentPlan; outcomes: Array<{ portfolio: string; outcome: ExecOutcome }> }> {
  if (!ctx.isRent || !ctx.lpPortfolio) return { plan: { due: [], skippedLp: false }, outcomes: [] };
  const plan = planRentSettles(ctx, positioned, st, p.cadenceSlots, p.pairingActive, p.maxPerTick ?? 4);
  const outcomes: Array<{ portfolio: string; outcome: ExecOutcome }> = [];
  const oracleAccounts = ctx.oracleMode === 1 ? ctx.oracleLegFeeds : [];
  for (const d of plan.due) {
    const portfolio = positioned.all.find((x) => x.pubkey.toBase58() === d.portfolio);
    if (!portfolio) continue;
    const ix = buildSettleHoldingRentIxV22(ctx.sdk, exec.keeper.publicKey, portfolio.pubkey, 0, BigInt(ctx.readSlot), oracleAccounts);
    const outcome = await simulateAndSend(exec, [ix], { job: "rent-106", label: `${ctx.label} ${d.portfolio.slice(0, 6)}`, units: legAwareTxUnits(portfolio, RENT_TX_UNITS) });
    outcomes.push({ portfolio: d.portfolio, outcome });
    if ((outcome.kind === "sent" && outcome.landed === "landed") || outcome.kind === "dry-run" || (outcome.kind === "refused" && outcome.expected)) {
      // an expected band state still counts as "visited": retry at the cadence, not every tick
      st.last.set(`${ctx.marketAddress}|${d.portfolio}`, BigInt(ctx.readSlot));
    }
  }
  return { plan, outcomes };
}
