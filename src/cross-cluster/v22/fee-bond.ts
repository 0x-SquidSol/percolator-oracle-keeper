/**
 * cross-cluster/v22/fee-bond.ts   (KEEPER_V22_FEE_CRANK_BOND)
 *
 * Tag 78 (LpVaultCrankFees) on a BOND market. Once the registry's bond flag (struct byte 146) is set, 78 REQUIRES
 *   [7] vault_lp_ext (w)   [8] the vault LP portfolio (WRITABLE: it is re-certified before the bonds are valued)
 *   [9] the bond tranche PDA (w)
 * and fails closed without them (Wave C review N-1). 78 also fails closed when the LP cannot be refreshed, so the
 * LP is cranked (tag 5) FIRST, in the same transaction.
 *
 * RUNS AT THE END OF A PAIRED SWEEP ROUND when the sweep is on (shape `after-round`: the LP was just settled with its
 * counterparties, so 78 goes alone); the timer path below is used when the sweep is off.
 *
 * SETTLE_PAIRING: that LP crank settles the LP. Under the pairing policy the tx is
 *   [LP crank, refresh <every counterparty>, 78]   when LP + counterparties + 78 fit the weight budget (paired), else
 *   prefer: [LP crank, 78]  (counted as an unpaired LP settle)        strict: [78] alone if its simulation passes,
 *   otherwise the fee crank is DEFERRED (fees can wait; the sweep settles the LP paired).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { deriveBondTrancheV22, deriveLpBackingLedger, deriveLpVaultRegistry, deriveVaultLpExtP2b, withBondTailV22 } from "@percolatorct/sdk";
import { buildCrankFeesIx } from "../lp-fee-cranker.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import type { ExecOutcome } from "./exec.ts";
import { crankOracleAccounts } from "./market.ts";
import type { V22MarketCtx } from "./market.ts";
import { buildSweepTxIxs, pairingStats, runPlannedTx } from "./sweep.ts";
import type { SweepDeps } from "./sweep.ts";
import type { V22Positioned } from "./positioned.ts";
import { portfolioWeight } from "./settle-pairing.ts";
import type { PlannedTx } from "./settle-pairing.ts";
import type { PairingMode } from "./flags.ts";

/** Engine "no new fees to distribute": healthy no-op. */
export const NO_FEES_TO_CRANK = 38;
/** Weight of the tag-78 instruction (about 400k CU at 35k per weight unit). */
export const FEE_78_WEIGHT = 12;

export type BondFeeSkip = "not-bond" | "no-ext" | "no-lp" | "not-bound" | "program-mismatch";

/** The tag-78 instruction of a bond market (exported for the account-list tests). */
export function buildBondCrankFeesIx(ctx: V22MarketCtx, keeper: PublicKey): TransactionInstruction {
  if (!ctx.lpPortfolio) throw new Error("bond tag 78 needs the vault LP portfolio");
  const [registry] = deriveLpVaultRegistry(ctx.programId, ctx.market);
  const [ledger] = deriveLpBackingLedger(ctx.programId, ctx.market, ctx.registryDomain);
  const [siblingLedger] = deriveLpBackingLedger(ctx.programId, ctx.market, ctx.registryDomain ^ 1);
  const base = buildCrankFeesIx({
    keeper,
    market: ctx.market,
    registry,
    ledger,
    siblingLedger,
    domainIdx: ctx.registryDomain,
    bound: true,
    tail: { vaultLpExt: deriveVaultLpExtP2b(ctx.programId, ctx.market)[0], lpPortfolio: ctx.lpPortfolio },
  });
  return withBondTailV22(base, deriveBondTrancheV22(ctx.programId, ctx.market)[0]);
}

export function bondFeeSkipReason(ctx: V22MarketCtx): BondFeeSkip | null {
  if (!ctx.bond) return "not-bond";
  if (!ctx.bound) return "not-bound";
  if (!ctx.ext) return "no-ext";
  if (!ctx.lpPortfolio) return "no-lp";
  if (!ctx.programId.equals(WRAPPER_PROGRAM_ID)) return "program-mismatch";
  return null;
}

export type BondFeeShape = "paired" | "lp-only-unpaired" | "fee-only" | "after-round" | "deferred";

export interface BondFeePlan {
  shape: BondFeeShape;
  /** The instructions in send order (before any prune). */
  ixs: TransactionInstruction[];
  /** The same tx as a PlannedTx + tail, for the prune loop. */
  tx: PlannedTx;
  tail: TransactionInstruction[];
  note: string;
}

/** Choose the tx shape for the pairing mode. Pure. */
export function planBondFee(
  ctx: V22MarketCtx,
  keeper: PublicKey,
  positioned: V22Positioned | null,
  mode: PairingMode,
  weightBudget: number,
  opts: { afterRound?: boolean; oracleAccounts?: ReadonlyArray<PublicKey> } = {},
): BondFeePlan {
  const fee = buildBondCrankFeesIx(ctx, keeper);
  const lp = ctx.lpPortfolio as PublicKey;
  const oracle = opts.oracleAccounts ?? crankOracleAccounts(ctx);
  const mk = (shape: BondFeeShape, accrue: PlannedTx["accrue"], refresh: PositionedPortfolio[], note: string): BondFeePlan => {
    const tx: PlannedTx = { index: 0, accrue, accrueTarget: accrue === "none" ? null : lp, refresh, settlesLp: accrue === "lp", weight: 0 };
    const ixs = buildSweepTxIxs(keeper, ctx.market, { accrue, accrueTarget: tx.accrueTarget, refresh, oracleAccounts: oracle, tail: [fee] });
    return { shape, ixs, tx, tail: [fee], note };
  };
  // The LP was just settled, paired, by this round: 78 alone (it re-certifies the LP itself, [8] writable).
  if (opts.afterRound) return mk("after-round", "none", [], "78 at the end of a paired round: the LP was just settled with its counterparties");
  if (mode === "off") return mk("lp-only-unpaired", "lp", [], "pairing off: [LP crank, 78]");
  const cps = positioned?.counterparties ?? [];
  const lpW = positioned?.lp ? portfolioWeight(positioned.lp) : 3;
  const w = cps.reduce((n, p) => n + portfolioWeight(p), 0) + lpW + FEE_78_WEIGHT;
  if (positioned && w <= weightBudget) {
    const ordered = [...cps].sort((a, b) => portfolioWeight(b) - portfolioWeight(a));
    return mk("paired", "lp", ordered, `paired: LP + ${cps.length} counterparties + 78 (weight ${w}/${weightBudget})`);
  }
  if (mode === "prefer") return mk("lp-only-unpaired", "lp", [], `prefer: weight ${w} > ${weightBudget}, LP settled without all counterparties (COUNTED)`);
  return mk("fee-only", "none", [], `strict: weight ${w} > ${weightBudget}; 78 alone if its simulation passes, else deferred`);
}

export type BondFeeResult = { kind: "skipped"; reason: BondFeeSkip } | { kind: "nothing"; detail: string } | { kind: "deferred"; detail: string } | { kind: "sent" | "dry-run"; shape: BondFeeShape; outcome: ExecOutcome } | { kind: "refused"; outcome: ExecOutcome; shape: BondFeeShape } | { kind: "failed"; error: string };

/**
 * Crank 78 once. The paired shape goes through the SAME prune / isolate loop as the sweep (a non-stale counterparty
 * no longer fails the whole tx). An unpaired LP settle (`lp-only-unpaired`) is COUNTED in the pairing stats.
 */
export async function crankBondFee(
  deps: SweepDeps,
  ctx: V22MarketCtx,
  positioned: V22Positioned | null,
  p: { mode: PairingMode; weightBudget: number; afterRound?: boolean },
): Promise<BondFeeResult> {
  const skip = bondFeeSkipReason(ctx);
  if (skip) return { kind: "skipped", reason: skip };
  try {
    const plan = planBondFee(ctx, deps.exec.keeper.publicKey, positioned, p.mode, p.weightBudget, { afterRound: p.afterRound });
    const run = await runPlannedTx(deps, { market: ctx.market, label: ctx.label }, plan.tx, {
      oracleAccounts: crankOracleAccounts(ctx),
      tail: plan.tail,
      expected: new Set([NO_FEES_TO_CRANK]),
      job: "fee-78",
    });
    const out = run.outcome;
    if (out.kind === "refused") {
      if (out.code === NO_FEES_TO_CRANK) return { kind: "nothing", detail: "no new LP fees (38)" };
      if (plan.shape === "fee-only" || plan.shape === "after-round") return { kind: "deferred", detail: `${plan.shape}: 78 refused (${out.name}); deferred` };
      return { kind: "refused", outcome: out, shape: plan.shape };
    }
    if (out.kind === "failed") return { kind: "failed", error: out.error };
    if (out.kind === "held") return { kind: "deferred", detail: out.reason };
    // Sent but not landed clean: nothing settled or cranked (the tx is atomic), so nothing is counted (as runSettleRound's okRun).
    if (out.kind === "sent" && out.landed !== "landed") {
      if (out.landed === "failed" && out.failCode === NO_FEES_TO_CRANK) return { kind: "nothing", detail: "no new LP fees (38, on chain: cranked between the simulation and the landing)" };
      return { kind: "failed", error: `tag 78 (${plan.shape}) ${out.landed === "failed" ? `landed but failed on chain (code ${out.failCode ?? "none"})` : "not landed"} sig=${out.signature.slice(0, 16)}…` };
    }
    if (plan.shape === "lp-only-unpaired") {
      pairingStats.unpairedLpSettles++;
      pairingStats.feeUnpairedLpSettles++;
    }
    if (plan.shape === "after-round") pairingStats.feeAfterRound++;
    return { kind: out.kind === "sent" ? "sent" : "dry-run", shape: plan.shape, outcome: out };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
