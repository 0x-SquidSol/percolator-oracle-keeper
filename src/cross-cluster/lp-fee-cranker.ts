/**
 * cross-cluster/lp-fee-cranker.ts
 *
 * Distributes accrued LP trading fees into each market's LP vault.
 *
 * Why this exists (verified on-chain 2026-07-28):
 *   Every trade splits its fee four ways into counters stored on the SLAB —
 *   `protocol_fee_accrued_atoms`, `lp_fee_accrued_atoms`,
 *   `insurance_reserve_accrued_atoms` and `creator_fee_claimable_atoms`. On a
 *   fresh market a 500-notional round trip at 30 bps produced exactly
 *   600000 / 1440000 / 480000 / 480000 (20% / 48% / 16% / 16%), so the split
 *   itself is correct and the LP's share is NOT lost.
 *
 *   But `lp_fee_accrued_atoms` only becomes LP-vault value when someone calls
 *   `LpVaultCrankFees`, and NOTHING called it. The keeper sent PushAuthMark and
 *   PermissionlessCrank and nothing else, so the counter grew forever and every
 *   LP depositor saw 0% APY no matter how much the market traded. That is the
 *   whole reason the Earn page still advertises 0%.
 *
 * What it does:
 *   Every `intervalMs`, for each registry market: derive the LP vault registry
 *   and the domain-0 backing ledger, and fire one `LpVaultCrankFees`.
 *
 * Two conditions make the crank a guaranteed no-op, and both are NORMAL rather
 * than faults — they are skipped locally so the loop costs nothing:
 *
 *   1. No LP vault registry. The market's creator never ran CreateLpVault.
 *   2. No backing ledger. The ledger PDA is created LAZILY by the first
 *      `DepositToLpVault` — it does not exist at market creation. Cranking
 *      without it fails `IncorrectProgramId` (the runtime rejects the
 *      System-owned placeholder), which looks alarming in logs but only ever
 *      means "nobody has deposited into this LP vault yet".
 *
 * `Custom(38)` (`LpVaultNoFeesToCrank`) is likewise expected, not an error: it
 * is the healthy answer whenever no new fees accrued since the last crank. It
 * is counted but never logged as a failure, or a quiet market would page
 * someone every cycle.
 *
 * Deliberately separate from the oracle push loop, for the same reasons
 * recovery-cranker.ts is: independent interval, isolated errors, and one
 * instruction per transaction.
 */
import { parseSeniorDrawLogs, seniorDrawAlerts } from "./vault-lp-crank.ts";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  encodeLpVaultCrankFees,
  ACCOUNTS_LP_VAULT_CRANK_FEES,
  buildAccountMetas,
  deriveLpVaultRegistry,
  deriveLpBackingLedger,
  parseLpVaultRegistry,
  deriveVaultLpExtP2b,
  withCrankFeesBoundTailP2b,
  deriveBondTrancheV22,
  withBondTailV22,
} from "@percolatorct/sdk";
import { SystemProgram } from "@solana/web3.js";
import type { Registry } from "./registry.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { confirmBySignature, customCodeOf } from "./tx-confirm.ts";
import { chainSlotOrNull, describeProgramError, formatWrapperCode, ORACLE_STALE, staleResolveWait } from "./fee-error.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import { decodeTerminalState, isTerminalFlat, marketMode } from "./market-state.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { isP2bSupported } from "./p2b-feature.ts";
import { bondFeeDelegated } from "./v22/delegation.ts";
import { lpVaultRegistryBondFlag } from "./v22/market.ts";

import { lpVaultRegistryBound, lpVaultRegistryExtFlag } from "./registry-flags.ts";
export { LP_VAULT_REGISTRY_BOUND_FLAG_OFF, lpVaultRegistryBound } from "./registry-flags.ts";

/**
 * Fallback only. v17 vaults are DUAL-DOMAIN: the vault serves both pots of its
 * asset and its own pot is `registry.domain`, which is NOT always 0 (a market
 * that appends an asset binds the vault to that asset's domain). We read the
 * real value off the registry below and only fall back to this if the account
 * cannot be parsed.
 */
const LP_VAULT_DOMAIN_FALLBACK = 0;

// P3: tag 78 also books any pending senior draw into both pot ledgers; 120k is not enough
// headroom once a draw is pending (security review of dfa4559b measured +1.3k..20k CU per ix).
const COMPUTE_UNIT_LIMIT = 400_000;

/** Engine code for "no new fees to distribute" — expected, not a failure. */
const NO_FEES_TO_CRANK = 38;
/** EngineLockActive: what a pre-07a1d0eb wrapper answers to tag 78 on a Resolved market. */
const RESOLVED_HARVEST_UNSUPPORTED = 21;

export interface LpFeeCrankResult {
  /** Markets whose fees were actually distributed. */
  cranked: string[];
  /** Markets with nothing to distribute (Custom(38)) — healthy. */
  noFees: string[];
  /** Markets with no LP vault or no ledger yet — nothing to do. */
  skipped: string[];
  /** Markets refused with a code the keeper itself is about to clear (R3.20: OracleStale before the first push). */
  waiting: Array<{ market: string; reason: string }>;
  /** Markets that failed for a reason worth looking at. */
  failed: Array<{ market: string; error: string }>;
}

/**
 * Outcome of one market's tag 78. `{ error, waiting: true }` = a refusal the keeper itself is about to clear (see
 * fee-error.ts `staleResolveWait`): the fee job reports it as "waiting" (retry next cycle), and callers that only know
 * `{ error }` still see the reason, code first.
 */
export type LpFeeOutcome = "cranked" | "no-fees" | "skipped" | { error: string; waiting?: true };

function extractErrorCode(err: unknown): number | null {
  return customCodeOf(err instanceof Error ? err.message : err);
}

/** The Connection surface the LP-fee crank uses (stubbable in tests). */
export type LpFeeConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses" | "simulateTransaction"
> &
  /** Read only when tag 78 answers OracleStale, to confirm the stale-resolve wait (R3.20). */
  Partial<Pick<Connection, "getSlot">>;

/**
 * Crank one market's LP fees. Never throws — every outcome is reported.
 */
export async function crankLpFeesOnce(
  devnetConn: LpFeeConnection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
  confirmOpts?: ConfirmOptions,
  /** Receives the `p3_senior_draw*` log lines of the simulated send (bound vaults only). */
  observe?: { seniorDrawLogs: string[] },
): Promise<LpFeeOutcome> {
  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return { error: "unparseable market address" };
  }

  const [registry] = deriveLpVaultRegistry(WRAPPER_PROGRAM_ID, market);

  // ONE round trip, as before. Dual-domain changed WHICH signal tells us not to
  // bother sending: the ledger's existence used to stand in for "has a depositor",
  // but the program now creates the target ledger on first use, so a missing
  // ledger is no longer a reason to skip. The registry's own share count is the
  // direct signal and costs no extra read — it is also exactly what the program
  // checks (it rejects LpVaultZeroSharesMinted when no share can claim the atoms).
  let infos: Array<{ data: Buffer } | null>;
  try {
    infos = (await devnetConn.getMultipleAccountsInfo([registry, market], "confirmed")) as Array<
      { data: Buffer } | null
    >;
  } catch (err) {
    return { error: `account read failed: ${(err as Error).message.slice(0, 100)}` };
  }
  const [registryInfo, marketInfo] = infos;
  // B13: a tombstone is never cranked, and a Resolved market only in the one case
  // P3 07a1d0eb allows: a BOUND vault on a TERMINAL-FLAT market (checked below).
  const terminal = marketInfo ? decodeTerminalState(new Uint8Array(marketInfo.data)) : null;
  if (terminal && terminal.kind === "closed") return "skipped";
  // Recovery (mode 2; e.g. after the expired-bankrupt-close valve): tag 78 is refused there.
  if (marketInfo && marketMode(new Uint8Array(marketInfo.data)) === 2) return "skipped";
  const resolvedHarvest = terminal !== null && terminal.kind === "resolved";
  if (resolvedHarvest && !isTerminalFlat(terminal)) return "skipped";

  // No vault -> nothing to distribute. Skipping locally keeps a market with no
  // LP vault from costing a transaction every single cycle.
  if (!registryInfo) return "skipped";

  // P3 (ported from rehearsal/p0a-feeloop-sdk8@5b5d14a, re-implemented without SDK 8):
  // on a vault-owned-LP market tag 78 REQUIRES the bound-vault tail [6] vault_lp_state
  // (writable) — handle_lp_vault_crank_fees -> load_bound_vault_lp_tail(idx 6, need_lp =
  // false), b2b2559e. Without it every cycle fails NotEnoughAccountKeys and the LP fee leg
  // never reaches senior NAV. Unbound vaults (all v18.2 markets) are unchanged.
  let bound: boolean;
  try {
    bound = lpVaultRegistryBound(new Uint8Array(registryInfo.data));
  } catch (err) {
    return { error: (err as Error).message };
  }
  // v2.2 (KEEPER_V22_FEE_CRANK_BOND): once the v2.2 fee job owns tag 78 on BOND markets, this job steps aside for a
  // bond-flagged registry (it would send the pre-bond account list, which the program refuses). Nothing is delegated
  // unless the flag is on, so with it off this line never fires.
  if (bondFeeDelegated() && lpVaultRegistryBondFlag(new Uint8Array(registryInfo.data))) return "skipped";
  // Resolved + terminal-flat is harvestable only through the bound-vault path.
  if (resolvedHarvest && !bound) return "skipped";
  let domainIdx = LP_VAULT_DOMAIN_FALLBACK;
  try {
    const parsed = parseLpVaultRegistry(new Uint8Array(registryInfo.data));
    domainIdx = Number(parsed.domain);
    // Live: no share can claim the atoms (the program refuses LpVaultZeroSharesMinted). On a
    // terminal Resolved harvest 78 can still absorb the claim-free residual for the junior (102),
    // so it is not skipped there — the simulation gate below decides.
    // d119eebd: a BOUND vault is not skipped at 0 shares — tag 78 there still books a
    // pending senior draw (P3-L1: the junior is the claimant), and preflight answers 38
    // for free when there is nothing to do.
    if (parsed.totalLpSharesOutstanding === 0n && !resolvedHarvest && !bound) return "skipped";
  } catch {
    // Unparseable registry: fall back rather than skip, so a layout change does
    // not silently stop fee cranking on every market at once.
  }

  const [ledger] = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, domainIdx);
  const [siblingLedger] = deriveLpBackingLedger(WRAPPER_PROGRAM_ID, market, domainIdx ^ 1);

  if (dryRun) {
    console.log(`[lp-fee] [DRY-RUN] LpVaultCrankFees ${marketAddress.slice(0, 8)}…`);
    return "skipped";
  }

  // P2b (#526): once the registry's ext flag (byte 161) is set, a BOUND vault's tag 78 REQUIRES the
  // tail [7] vault_lp_ext (w) and [8] vault LP portfolio (w) (fail closed). The flag is 0 on every
  // pre-P2b program, so for them `ext` stays null and the transaction is byte-identical to before.
  let ext: BoundExtTail | null = null;
  if (bound && lpVaultRegistryExtFlag(new Uint8Array(registryInfo.data))) {
    const t = await resolveExtTail(devnetConn, market, lpVaultRegistryBondFlag(new Uint8Array(registryInfo.data)));
    if ("error" in t) return { error: t.error };
    ext = t;
  }

  const attempt = (tail: BoundExtTail | null) =>
    sendCrankFeesOnce(devnetConn, keeper, { market, registry, ledger, siblingLedger, domainIdx, bound, resolvedHarvest, tail, marketData: marketInfo ? new Uint8Array(marketInfo.data) : null }, marketAddress, confirmOpts, observe);
  let out = await attempt(ext);
  // Race: a tag 103 (this keeper's, or anyone's: it is permissionless) can create the ext and raise
  // the flag between our registry read and our send. The program then refuses the old 7-account
  // shape. Only on a failure, and only where the P2b program is known (the gate), re-read the
  // registry fresh and retry once with the tail. On today's programs this branch never runs.
  if (typeof out === "object" && !out.waiting && bound && ext === null && isP2bSupported()) {
    try {
      const [fresh] = (await devnetConn.getMultipleAccountsInfo([registry], "confirmed")) as Array<{ data: Buffer } | null>;
      if (fresh && lpVaultRegistryExtFlag(new Uint8Array(fresh.data))) {
        const t = await resolveExtTail(devnetConn, market, lpVaultRegistryBondFlag(new Uint8Array(fresh.data)));
        if (!("error" in t)) out = await attempt(t);
      }
    } catch {
      // keep the first outcome
    }
  }
  return out;
}

/** The tag-78 ext tail of a bound vault once the registry ext flag is set. */
export interface BoundExtTail {
  vaultLpExt: PublicKey;
  lpPortfolio: PublicKey;
  /**
   * EARN-10 / SDK table: on a BOND market (registry byte 162) with the ext, tag 78 also REQUIRES the bond tranche at [9]
   * (writable). Absent = no bond tranche (the 9-account list). The v22 bond fee job adds the tranche itself and leaves this unset.
   */
  bondTranche?: PublicKey;
}

/** Derive the ext PDA and read the vault LP portfolio from `vault_lp_state`. One extra read, only when the ext flag is set. */
async function resolveExtTail(
  conn: Pick<LpFeeConnection, "getMultipleAccountsInfo">,
  market: PublicKey,
  bond = false,
): Promise<BoundExtTail | { error: string }> {
  try {
    const [si] = (await conn.getMultipleAccountsInfo([deriveVaultLpState(WRAPPER_PROGRAM_ID, market)], "confirmed")) as Array<{ data: Buffer } | null>;
    const st = si ? decodeVaultLpState(new Uint8Array(si.data)) : null;
    if (!st) return { error: "ext tail: vault_lp_state unreadable (cannot resolve the vault LP portfolio for tag 78 [8])" };
    return {
      vaultLpExt: deriveVaultLpExtP2b(WRAPPER_PROGRAM_ID, market)[0],
      lpPortfolio: st.lpPortfolio,
      ...(bond ? { bondTranche: deriveBondTrancheV22(WRAPPER_PROGRAM_ID, market)[0] } : {}),
    };
  } catch (err) {
    return { error: `ext tail read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` };
  }
}

/** The tag-78 instruction for one market (exported for the account-list tests). */
export function buildCrankFeesIx(p: {
  keeper: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  ledger: PublicKey;
  siblingLedger: PublicKey;
  domainIdx: number;
  bound: boolean;
  tail: BoundExtTail | null;
}): TransactionInstruction {
  const base = new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_LP_VAULT_CRANK_FEES, {
      cranker: p.keeper,
      market: p.market,
      registry: p.registry,
      ledger: p.ledger,
      siblingLedger: p.siblingLedger,
      systemProgram: SystemProgram.programId,
    }).concat(p.bound ? [{ pubkey: deriveVaultLpState(WRAPPER_PROGRAM_ID, p.market), isSigner: false, isWritable: true }] : []),
    data: Buffer.from(encodeLpVaultCrankFees({ domain: p.domainIdx })),
  });
  if (!p.bound || !p.tail) return base;
  // The SDK helper takes the 6-account base and appends [6] state, [7] ext, [8] vault LP.
  const six = new TransactionInstruction({ programId: base.programId, keys: base.keys.slice(0, 6), data: base.data });
  const withExt = withCrankFeesBoundTailP2b(six, {
    programId: WRAPPER_PROGRAM_ID,
    market: p.market,
    registryDomain: p.domainIdx,
    lpPortfolio: p.tail.lpPortfolio,
    vaultLpExt: p.tail.vaultLpExt,
  });
  return p.tail.bondTranche ? withBondTailV22(withExt, p.tail.bondTranche) : withExt;
}

async function sendCrankFeesOnce(
  devnetConn: LpFeeConnection,
  keeper: Keypair,
  p: {
    market: PublicKey;
    registry: PublicKey;
    ledger: PublicKey;
    siblingLedger: PublicKey;
    domainIdx: number;
    bound: boolean;
    resolvedHarvest: boolean;
    tail: BoundExtTail | null;
    /** The market bytes read this cycle (for the stale-resolve wait check). */
    marketData?: Uint8Array | null;
  },
  marketAddress: string,
  confirmOpts?: ConfirmOptions,
  observe?: { seniorDrawLogs: string[] },
): Promise<LpFeeOutcome> {
  const { market, ledger, bound, resolvedHarvest } = p;
  // R3.20: OracleStale (27) on a LIVE market whose stale-resolve window has matured is the wait for this keeper's
  // own next mark push (boot after an outage, or a market just added to the registry), not a failure. Confirmed from
  // the market bytes + cluster slot; any other 27, or no slot, stays a failure.
  const waitFor = async (code: number | null): Promise<{ error: string; waiting: true } | null> => {
    if (resolvedHarvest || code !== ORACLE_STALE) return null;
    const reason = staleResolveWait(code, p.marketData ?? null, await chainSlotOrNull(devnetConn));
    return reason ? { error: `tag 78 ${reason}`, waiting: true } : null;
  };
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
  tx.add(buildCrankFeesIx({ keeper: keeper.publicKey, market, registry: p.registry, ledger, siblingLedger: p.siblingLedger, domainIdx: p.domainIdx, bound, tail: p.tail }));

  try {
    const { blockhash, lastValidBlockHeight } = await devnetConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    if (resolvedHarvest) {
      // P3 FINAL 58e379f1: a terminal harvest with nothing pending is a no-op SUCCESS (no
      // longer Custom(38)), and what it may absorb (the claim-free terminal residual) is
      // computed inside the engine. So simulate and send only if the market or the vault's
      // own ledger would change; otherwise this would spend a tx every cycle forever.
      const gate = await resolvedHarvestChangesState(devnetConn, tx, market, ledger, observe);
      if (gate === "unsupported") return "skipped";
      if (gate === "no-change") return "no-fees";
      if (typeof gate === "object") return { error: gate.error };
    } else if (bound && observe) {
      // P3 senior draw (d119eebd): on a bound vault tag 78 BOOKS any pending senior draw
      // into C before the harvest (vault_lp_draw_then_book, both ledgers writable). The
      // send's own logs are not returned, so simulate first to see the booking lines.
      const sim = await devnetConn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
      for (const l of sim.value.logs ?? []) if (l.includes("p3_senior_draw")) observe.seniorDrawLogs.push(l);
      if (sim.value.err && extractErrorCode(JSON.stringify(sim.value.err)) === NO_FEES_TO_CRANK) return "no-fees";
      if (sim.value.err) {
        const w = await waitFor(extractErrorCode(JSON.stringify(sim.value.err)));
        if (w) return w;
      }
    }
    const sig = await devnetConn.sendRawTransaction(tx.serialize(), { maxRetries: 2, skipPreflight: resolvedHarvest });
    // F6 (fee-flow audit 2026-09-29): the signature STATUS decides, not whether
    // confirmTransaction returned before its block-height deadline. SOLCAT
    // 5xq4yAXH… and ANSEM 4RJv6kJt… were logged as "block height exceeded"
    // failures but had landed. A confirmation that carries value.err (landed but
    // failed on chain) is a failure, not a success, too.
    const c = await confirmBySignature(devnetConn, sig, blockhash, lastValidBlockHeight, confirmOpts);
    if (c.status === "failed") {
      if (c.code === NO_FEES_TO_CRANK) return "no-fees";
      const w = await waitFor(c.code);
      if (w) return w;
      return { error: `${describeProgramError("tag 78 landed but failed on chain:", c.err)} sig=${sig.slice(0, 16)}…` };
    }
    if (c.status === "not-landed") {
      return { error: `not landed (retry next cycle): ${c.reason} sig=${sig.slice(0, 16)}…` };
    }
    console.log(`[lp-fee] distributed ${marketAddress.slice(0, 8)}… sig=${sig.slice(0, 16)}… [${c.via}]`);
    return "cranked";
  } catch (err) {
    if (extractErrorCode(err) === NO_FEES_TO_CRANK) return "no-fees";
    // Version gate: a wrapper before P3 07a1d0eb refuses tag 78 on a Resolved
    // market with EngineLockActive (21) — in preflight, so nothing is spent.
    if (resolvedHarvest && extractErrorCode(err) === RESOLVED_HARVEST_UNSUPPORTED) return "skipped";
    const w = await waitFor(extractErrorCode(err));
    if (w) return w;
    // The code first and never clipped (R3.20: `.slice(0, 140)` cut "custom program error: 0x1b" to "custom p").
    return { error: describeProgramError("tag 78", err, 120) };
  }
}

/** One sweep over every registry market. Never throws. */
export async function crankAllLpFeesOnce(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  dryRun: boolean,
): Promise<LpFeeCrankResult> {
  const result: LpFeeCrankResult = { cranked: [], noFees: [], skipped: [], waiting: [], failed: [] };

  await Promise.allSettled(
    registry.markets.map(async (m) => {
      const outcome = await crankLpFeesOnce(devnetConn, keeper, m.marketAddress, dryRun);
      if (outcome === "cranked") result.cranked.push(m.marketAddress);
      else if (outcome === "no-fees") result.noFees.push(m.marketAddress);
      else if (outcome === "skipped") result.skipped.push(m.marketAddress);
      else if (outcome.waiting) result.waiting.push({ market: m.marketAddress, reason: outcome.error });
      else result.failed.push({ market: m.marketAddress, error: outcome.error });
    }),
  );

  if (result.failed.length > 0) {
    console.error(
      `[lp-fee] ${result.failed.length} market(s) failed — ` +
        result.failed.map((f) => `${f.market.slice(0, 8)}…: ${f.error}`).join(" | "),
    );
  }
  return result;
}

/**
 * Simulate the resolved-harvest tx and compare the market + own-ledger bytes with
 * their current state. "changes" = worth sending. Never throws.
 */
export async function resolvedHarvestChangesState(
  conn: Pick<LpFeeConnection, "simulateTransaction" | "getMultipleAccountsInfo">,
  tx: Transaction,
  market: PublicKey,
  ledger: PublicKey,
  observe?: { seniorDrawLogs: string[] },
): Promise<"changes" | "no-change" | "unsupported" | { error: string }> {
  try {
    const [pre] = [await conn.getMultipleAccountsInfo([market, ledger], "confirmed")];
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      sigVerify: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [market.toBase58(), ledger.toBase58()] },
    });
    if (observe && !sim.value.err) for (const l of sim.value.logs ?? []) if (l.includes("p3_senior_draw")) observe.seniorDrawLogs.push(l);
    if (sim.value.err) {
      const code = extractErrorCode(JSON.stringify(sim.value.err));
      if (code === RESOLVED_HARVEST_UNSUPPORTED) return "unsupported";
      if (code === NO_FEES_TO_CRANK) return "no-change";
      const c = extractErrorCode(JSON.stringify(sim.value.err));
      return { error: `resolved harvest sim: ${c === null ? JSON.stringify(sim.value.err).slice(0, 100) : `${formatWrapperCode(c)} ${JSON.stringify(sim.value.err)}`}` };
    }
    const post = sim.value.accounts ?? [];
    const same = (i: number): boolean => {
      const a = pre[i];
      const b = post[i];
      if (!a || !b) return !a && !b;
      return Buffer.from(b.data[0], "base64").equals(Buffer.from(a.data));
    };
    return same(0) && same(1) ? "no-change" : "changes";
  } catch (err) {
    return { error: `resolved harvest sim failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` };
  }
}

/**
 * The LP-fee crank as a fee job (see fee-jobs.ts), so it runs in the shared
 * fee loop next to the stake-fee push and inherits its health/alerting.
 */
export function makeLpFeeJob(confirmOpts?: ConfirmOptions): FeeJob {
  return {
    name: "lp-fee",
    async run(ctx, m): Promise<FeeJobOutcome> {
      const observe = { seniorDrawLogs: [] as string[] };
      const o = await crankLpFeesOnce(ctx.conn, ctx.keeper, m.marketAddress, ctx.dryRun, confirmOpts, observe);
      // "Earn absorbed X": only a booking that LANDED (the tx was sent and confirmed).
      const events = o === "cranked" ? seniorDrawAlerts(m.marketAddress, m.label, parseSeniorDrawLogs(observe.seniorDrawLogs)) : [];
      if (o === "cranked") return { kind: "done", detail: "LP fees distributed into the LP vault", ...(events.length ? { events } : {}) };
      if (o === "no-fees") return { kind: "nothing", detail: "no new LP fees (Custom(38))" };
      if (o === "skipped") return { kind: "skipped", reason: "no LP vault, or no depositors yet" };
      if (o.waiting) return { kind: "waiting", reason: o.error };
      return { kind: "failed", error: o.error };
    },
  };
}
