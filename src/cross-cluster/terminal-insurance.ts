/**
 * cross-cluster/terminal-insurance.ts
 *
 * Wind-down for stake-BOUND markets after resolve (stake F-9,
 * ledger stake-f9-fix-2026-09-30.md, draft percolator-stake#301 @ f9b9190).
 *
 * After BindInsuranceAuthority (stake tag 19) the asset-0 insurance authority
 * is the stake pool's `vault_auth` PDA, and the only Live exit (stake tag 23)
 * dies at resolve. Pre-F-9 the market's insurance budget was stranded and
 * CloseSlab refused with 21. F-9 adds permissionless stake tag 29
 * `RecoverTerminalInsurance { amount: u64 }`:
 *
 *   1. amount = asset-0 insurance budget  -> wrapper tag 41 CPI into pool.vault,
 *      booked to stakers. Custom(21) = insurance-withdraw cooldown (or capacity):
 *      retry on a later cycle.
 *   2. amount = 0 -> book anything a third party already pushed via the
 *      PERMISSIONLESS wrapper tag 41, and sweep a stray vault_auth-owned token
 *      account passed at index 9. Custom(31) NothingToRecover = done.
 *   3. A resolved stake-bound market that still holds a budget after N cycles
 *      raises `terminal-budget-unbooked`.
 *
 * Gated on the DEPLOYED stake program supporting tag 29: until the upgrade it
 * is a no-op (the stranded-budget alert still fires — that is exactly F-9).
 * The probe simulates `[29][0u64]`. The deployed stake (e62aa4a) parses the
 * tag in `StakeInstruction::unpack` before reading any account
 * (processor.rs:371, instruction.rs:909 `_ => InvalidInstructionData`), so
 * an old program answers `InvalidInstructionData` at the stake instruction;
 * an upgraded one gets past unpack and answers anything else (Custom(30)
 * MarketNotTerminal on a Live market).
 *
 * Layout (engine 35ddd692 `MarketGroupV16HeaderAccount`, offsets computed from
 * the struct source; also the stake program's own gate):
 *   header kind @10 (1 = market, 8 = closed-market tombstone,
 *     wrapper v16_program.rs:73/:647); VERSION 18 only
 *   group @ V17_MARKET_GROUP_OFF (592); mode u8 @+626 (abs 1218; 0 Live,
 *     1 Resolved); insurance_domain_budget_remaining_total u128 @+461.
 * Registry markets are single-asset, where that total IS the asset-0 domain
 * budget sum the stake doc prescribes as the tag-41 amount.
 *
 * Tag 29 accounts (stake f9b9190 processor.rs:3708): 0 caller (no signer
 * check), 1 pool (w), 2 pool.vault (w), 3 vault_auth, 4 market (w),
 * 5 wrapper vault (w), 6 wrapper vault authority, 7 SPL Token,
 * 8 wrapper program, 9 optional stray (w).
 */
import { parseSeniorDrawLogs, seniorDrawAlerts } from "./vault-lp-crank.ts";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  deriveInsuranceUnitsV22,
  deriveMarketVaultAccounts,
  deriveStakePool,
  deriveStakeVaultAuth,
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
  V17_ASSET_ORACLE_PROFILE_LEN,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
} from "@percolatorct/sdk";
import { decodeStakePoolAnyVersion } from "./stake-pool-decode.ts";
import type { StakePoolView } from "./stake-pool-decode.ts";
import { STAKE_PROGRAM_ID, WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import type { Alert } from "./alerting.ts";
import { CleanupState, cleanupResolvedPortfolios, closeFinalizedReceiptPortfolios } from "./resolved-portfolio-cleanup.ts";
import { crankLpFeesOnce } from "./lp-fee-cranker.ts";
import type { CleanupConfig, CleanupConnection, CleanupResult } from "./resolved-portfolio-cleanup.ts";
import { NFT_PROGRAM_ID } from "../program-ids.ts";

export const STAKE_TAG_RECOVER_TERMINAL_INSURANCE = 29;
export const STAKE_ERR_MARKET_NOT_TERMINAL = 30;
export const STAKE_ERR_NOTHING_TO_RECOVER = 31;
/** Stake `InvalidAccount`: what the pre-S1 program answers to an unexpected extra account (the v5 shape). */
export const STAKE_ERR_INVALID_ACCOUNT = 16;
/** Stake S1: the terminal settlement owes the creator and no creator token account was passed. */
export const STAKE_ERR_CREATOR_ACCOUNT_REQUIRED = 46;
/** Creator-ATA create attempts allowed per market per process, and the first backoff (doubles per attempt). */
export const CREATOR_ATA_MAX_ATTEMPTS = 3;
export const CREATOR_ATA_BACKOFF_MS = 10 * 60_000;

/** An initialized classic-token account of `mint` owned by `owner`: what the program accepts as the creator account. */
export function isCreatorTokenAccount(ai: { owner: PublicKey; data: Uint8Array } | null | undefined, mint: PublicKey, owner: PublicKey): boolean {
  return !!ai && ai.owner.equals(TOKEN_PROGRAM) && ai.data.length >= 165 && ai.data[108] === 1
    && Buffer.from(ai.data.subarray(0, 32)).equals(mint.toBuffer()) && Buffer.from(ai.data.subarray(32, 64)).equals(owner.toBuffer());
}
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** pool.admin's classic-token collateral ATA (SDK `creatorCollateralAtaV5`). */
export function creatorCollateralAta(admin: PublicKey, collateralMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([admin.toBuffer(), TOKEN_PROGRAM.toBuffer(), collateralMint.toBuffer()], ATA_PROGRAM)[0];
}
/**
 * Associated-token-account program `CreateIdempotent` (data `[1]`): creates `pool.admin`'s collateral ATA when it is missing
 * and is a no-op when it exists. Permissionless; the keeper pays the rent. Tag 29 on a v5 pool needs the creator account at
 * `[9]`/`[10]` (FIRST_LOSS: NotEnoughAccountKeys without it; FEE_ONLY: Custom 46 when the settlement owes the creator).
 */
export function buildCreateCreatorAtaIx(payer: PublicKey, admin: PublicKey, collateralMint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: creatorCollateralAta(admin, collateralMint), isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: false, isWritable: false },
      { pubkey: collateralMint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
/** Wrapper EngineLockActive, surfaced through the tag-41 CPI: cooldown or capacity. */
export const WRAPPER_ERR_LOCK_ACTIVE = 21;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const COMPUTE_UNIT_LIMIT = 120_000; // stake doc: 47,198 CU with the CPI, 15,809 book-only

export { decodeTerminalState, isTerminalFlat, isTerminalMarket } from "./market-state.ts";
export type { TerminalState } from "./market-state.ts";
import { decodeTerminalState, isTerminalFlat } from "./market-state.ts";
import type { TerminalState } from "./market-state.ts";
import { addKeeperPriorityFee } from "./priority-fee.ts";

/** Asset-0 insurance authority, via the VERSION-gated profile offset. null if unreadable. */
export function asset0InsuranceAuthority(d: Uint8Array): PublicKey | null {
  const g = selectMarketGroupOffset(d);
  if (!g.ok) return null;
  const off = assetSlotOffset(g, 0); // K-9 sweep: per-VERSION group length (806 on v2.2), not the v2.1 758
  if (d.length < off + V17_ASSET_ORACLE_PROFILE_LEN) return null;
  return parseAssetOracleProfileV17(d, off).insuranceAuthority;
}

export function encodeRecoverTerminalInsurance(amount: bigint): Buffer {
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error("amount must be a u64");
  const b = Buffer.alloc(9);
  b[0] = STAKE_TAG_RECOVER_TERMINAL_INSURANCE;
  b.writeBigUInt64LE(amount, 1);
  return b;
}

export function buildRecoverTerminalInsuranceIx(p: {
  stakeProgramId: PublicKey;
  wrapperProgramId: PublicKey;
  caller: PublicKey;
  market: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  stray?: PublicKey;
  /**
   * S1 shape (upgraded stake only; the deployed program refuses it with 16). Mirrors the SDK
   * `recoverTerminalInsuranceAccounts`: FIRST_LOSS (`insuranceUnits` set) -> `[9] units, [10] creator, [11] stray?`;
   * FEE_ONLY -> `[stray?, creator]`. Absent = today's `[0..8] + stray?`.
   */
  v5?: { insuranceUnits?: PublicKey; creatorToken: PublicKey };
}): TransactionInstruction {
  const [vaultAuth] = deriveStakeVaultAuth(p.pool, p.stakeProgramId);
  const w = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, p.collateralMint);
  const keys = [
    { pubkey: p.caller, isSigner: false, isWritable: false },
    { pubkey: p.pool, isSigner: false, isWritable: true },
    { pubkey: p.poolVault, isSigner: false, isWritable: true },
    { pubkey: vaultAuth, isSigner: false, isWritable: false },
    { pubkey: p.market, isSigner: false, isWritable: true },
    { pubkey: w.vaultToken, isSigner: false, isWritable: true },
    { pubkey: w.vaultAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: p.wrapperProgramId, isSigner: false, isWritable: false },
  ];
  const wr = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  if (p.v5?.insuranceUnits) {
    keys.push(wr(p.v5.insuranceUnits), wr(p.v5.creatorToken));
    if (p.stray) keys.push(wr(p.stray));
  } else {
    if (p.stray) keys.push(wr(p.stray));
    if (p.v5) keys.push(wr(p.v5.creatorToken));
  }
  return new TransactionInstruction({ programId: p.stakeProgramId, keys, data: encodeRecoverTerminalInsurance(p.amount) });
}

/** Classification of a simulated tag-29 probe. */
export type Tag29Support = "supported" | "unsupported" | "unknown";

/**
 * `unsupported` ONLY for the exact pre-F-9 signature: InvalidInstructionData
 * at the stake instruction (index 1, after the compute-budget ix). An RPC or
 * any other shape is `unknown` (treated as not-supported for this cycle, and
 * re-probed), never promoted to `supported` by accident.
 */
export function classifyTag29Probe(err: unknown, simOk: boolean): Tag29Support {
  if (simOk) return "supported";
  if (err && typeof err === "object" && "InstructionError" in err) {
    const ie = (err as { InstructionError: unknown }).InstructionError;
    if (Array.isArray(ie) && ie[0] === 1) {
      if (ie[1] === "InvalidInstructionData") return "unsupported";
      return "supported"; // the program got past unpack: it knows tag 29
    }
  }
  return "unknown";
}

export interface TerminalInsuranceConfig {
  wrapperProgramId: PublicKey;
  stakeProgramId: PublicKey;
  /** Cycles a resolved stake-bound market may hold a budget before alerting. */
  unbookedAlertCycles: number;
  /** Re-probe tag-29 support this often, so an upgrade is picked up without a restart. */
  probeTtlMs: number;
  confirm?: ConfirmOptions;
  now?: () => number;
  /** B12 cleanup (P3 b2b2559e permissionless CloseResolved + ClosePortfolio); undefined = off. */
  cleanup?: CleanupConfig;
  /**
   * Late-finalize cleanup (gate-100 on bd4fe5f8): tag 8 every receipt-only portfolio (receipt
   * finalized, empty claim) on ANY Resolved market, then 78 once terminal-flat, so the junior's 102 is
   * not refused with 21. Default on (needs `cleanup`); TERMINAL_RECEIPT_CLEANUP_ENABLED=false disables.
   */
  receiptCleanup?: boolean;
}

export function terminalInsuranceConfigFromEnv(env: Readonly<Record<string, string | undefined>>): TerminalInsuranceConfig {
  const raw = env.ALERT_TERMINAL_BUDGET_CYCLES;
  const n = raw === undefined || raw.trim() === "" ? 3 : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`ALERT_TERMINAL_BUDGET_CYCLES="${raw}" must be a positive integer`);
  const cleanupOn = env.TERMINAL_CLEANUP_ENABLED !== "false";
  const receiptCleanupOn = env.TERMINAL_RECEIPT_CLEANUP_ENABLED !== "false";
  const graceRaw = env.TERMINAL_PDA_GRACE_SLOTS;
  if (graceRaw !== undefined && graceRaw.trim() !== "" && !/^\d+$/.test(graceRaw.trim())) {
    throw new Error(`TERMINAL_PDA_GRACE_SLOTS="${graceRaw}" must be a non-negative integer`);
  }
  const graceSlots = graceRaw === undefined || graceRaw.trim() === "" ? 216_000n : BigInt(graceRaw.trim());
  return {
    wrapperProgramId: WRAPPER_PROGRAM_ID,
    stakeProgramId: STAKE_PROGRAM_ID,
    unbookedAlertCycles: n,
    probeTtlMs: 60 * 60_000,
    receiptCleanup: receiptCleanupOn,
    cleanup: cleanupOn
      ? {
          wrapperProgramId: WRAPPER_PROGRAM_ID,
          nftProgramId: NFT_PROGRAM_ID,
          maxPerCycle: 8,
          maxAtaCreatesPerCycle: 4,
          pdaGraceSlots: graceSlots,
          probeTtlMs: 60 * 60_000,
        }
      : undefined,
  };
}

export type TerminalConnection = Pick<
  Connection,
  | "getMultipleAccountsInfo"
  | "getLatestBlockhash"
  | "simulateTransaction"
  | "sendRawTransaction"
  | "confirmTransaction"
  | "getSignatureStatuses"
  | "getTokenAccountsByOwner"
  | "getProgramAccounts"
  | "getAccountInfo"
  | "getSlot"
>;

/** Per-process state: probe cache, finished markets, unbooked-budget streaks. */
export class TerminalInsuranceState {
  support: { value: Tag29Support; at: number } | null = null;
  readonly done = new Set<string>();
  readonly unbookedStreak = new Map<string, number>();
  readonly cleanup = new CleanupState();
  /** Does the deployed stake accept the S1 account shape? Cached for probeTtlMs; "legacy" is re-probed so an upgrade is picked up. */
  shape: { value: "v5" | "legacy"; at: number } | null = null;
  /** Markets already logged for stake error 46 (log once, not per cycle). */
  readonly creatorWarned = new Set<string>();
  /** Markets whose tag 29 was refused for want of the creator account (46, or NotEnoughAccountKeys on the legacy list of a v5 pool). Only these get an ATA create. */
  readonly creatorAtaNeeded = new Set<string>();
  /** Per-market ATA-create attempts, bounded: a hostile pool.admin that closes its 0-balance ATA every cycle must not drain the keeper (~0.002 SOL a time). */
  readonly creatorAtaAttempts = new Map<string, { n: number; nextAtMs: number }>();
}

/**
 * True for the exact signature of the PRE-S1 stake program refusing the extra creator/units account:
 * InstructionError at the stake ix (index 1) = Custom(16) InvalidAccount or NotEnoughAccountKeys.
 */
export function isLegacyShapeRefusal(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return false;
  const ie = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie[0] !== 1) return false;
  const e = ie[1];
  if (e === "NotEnoughAccountKeys") return true;
  return !!e && typeof e === "object" && "Custom" in e && (e as { Custom: unknown }).Custom === STAKE_ERR_INVALID_ACCOUNT;
}

function mkTx(keeper: Keypair, blockhash: string, ix: TransactionInstruction): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
  tx.add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = keeper.publicKey;
  addKeeperPriorityFee(tx); // S3-A2: optional CU price, appended last (OFF by default)
  tx.sign(keeper);
  return tx;
}

async function simulate(conn: TerminalConnection, tx: Transaction) {
  const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
  return { err: sim.value.err, logs: sim.value.logs ?? null };
}

/** Probe (cached for probeTtlMs) whether the deployed stake program knows tag 29. */
export async function tag29Support(
  conn: TerminalConnection,
  keeper: Keypair,
  probeIx: TransactionInstruction,
  st: TerminalInsuranceState,
  cfg: TerminalInsuranceConfig,
): Promise<Tag29Support> {
  const now = (cfg.now ?? Date.now)();
  if (st.support && st.support.value !== "unknown" && now - st.support.at < cfg.probeTtlMs) return st.support.value;
  let value: Tag29Support = "unknown";
  try {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const r = await simulate(conn, mkTx(keeper, blockhash, probeIx));
    value = classifyTag29Probe(r.err, !r.err);
  } catch {
    value = "unknown";
  }
  st.support = { value, at: now };
  return value;
}

export interface WindDownStep {
  amount: bigint;
  outcome: "sent" | "nothing" | "cooldown" | "not-terminal" | "creator-required" | "failed" | "dry-run";
  detail: string;
}

/**
 * One wind-down pass for one market. Never throws. Returns a fee-job outcome
 * (for the loop) plus the individual tag-29 steps (for the pre-resolve CLI).
 */
export async function windDownOnce(
  conn: TerminalConnection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
  cfg: TerminalInsuranceConfig,
  st: TerminalInsuranceState,
): Promise<{ outcome: FeeJobOutcome; steps: WindDownStep[]; state: TerminalState | null; budget: bigint | null; stakeBound: boolean; support: Tag29Support | null }> {
  const steps: WindDownStep[] = [];
  const events: Alert[] = [];
  const res = (outcome: FeeJobOutcome, extra: Partial<{ state: TerminalState | null; budget: bigint | null; stakeBound: boolean; support: Tag29Support | null }> = {}) => ({
    outcome: events.length ? { ...outcome, events: [...(outcome.events ?? []), ...events] } : outcome,
    steps, state: null, budget: null, stakeBound: false, support: null, ...extra,
  });
  if (st.done.has(marketAddress)) return res({ kind: "nothing", detail: "wind-down already complete" });

  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return res({ kind: "failed", error: "unparseable market address" });
  }
  const [pool] = deriveStakePool(market, cfg.stakeProgramId);

  let data: Uint8Array;
  let poolState: StakePoolView | null = null;
  try {
    const [mi, pi] = await conn.getMultipleAccountsInfo([market, pool], "confirmed");
    if (!mi) return res({ kind: "failed", error: "market account not found" });
    if (!mi.owner.equals(cfg.wrapperProgramId)) return res({ kind: "skipped", reason: "market not owned by the configured wrapper" });
    data = new Uint8Array(mi.data);
    if (pi && pi.owner.equals(cfg.stakeProgramId)) poolState = decodeStakePoolAnyVersion(new Uint8Array(pi.data));
  } catch (err) {
    return res({ kind: "failed", error: `account read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` });
  }

  let state = decodeTerminalState(data);
  if (!state) return res({ kind: "skipped", reason: "not a v18 market header" });
  if (state.kind === "live") {
    st.unbookedStreak.delete(marketAddress);
    return res({ kind: "nothing", detail: "market is Live (wind-down applies after resolve)" }, { state });
  }
  // Late-finalize cleanup — every Resolved market, stake-bound or not, every cycle: a portfolio left
  // materialized by a late receipt finalize (46 / repeat CloseResolved: capital 0, pnl 0, receipt
  // finalized) keeps the market off terminal-flat, so 78 is skipped and the junior's 102 = 21. Close
  // each with the permissionless tag 8 ([3] = owner), re-read, then 78 once terminal-flat.
  let lateNote = "";
  if (cfg.receiptCleanup !== false && cfg.cleanup && state.kind === "resolved" && state.materializedPortfolios > 0n) {
    const lc = await closeFinalizedReceiptPortfolios(conn as CleanupConnection, keeper, market, dryRun, cfg.cleanup);
    for (const f of lc.failed) console.warn(`[terminal-insurance] ${marketAddress.slice(0, 8)}…: receipt-only portfolio ${f.portfolio} not closed: ${f.reason}`);
    if (lc.closed.length > 0) {
      console.log(`[terminal-insurance] ${marketAddress.slice(0, 8)}…: closed ${lc.closed.length} receipt-only portfolio(s) (tag 8 after a late receipt finalize): ${lc.closed.join(", ")}`);
      lateNote = ` Late-finalize cleanup: tag 8 closed ${lc.closed.length} receipt-only portfolio(s).`;
      if (!dryRun) {
        try {
          const [mi2] = await conn.getMultipleAccountsInfo([market], "confirmed");
          const s2 = mi2 ? decodeTerminalState(new Uint8Array(mi2.data)) : null;
          if (s2) state = s2;
        } catch {
          // keep the pre-cleanup view
        }
      }
      if (state.kind === "resolved" && isTerminalFlat(state)) {
        const h = await crankLpFeesOnce(conn, keeper, marketAddress, dryRun, cfg.confirm);
        lateNote += h === "cranked" ? " Tag 78 harvested (terminal-flat): the junior's 102 is unblocked."
          : h === "no-fees" || h === "skipped" ? " Terminal-flat: the junior's 102 is unblocked."
            : ` Tag 78 harvest failed: ${h.error}.`;
      }
    }
  }
  if (!poolState || !poolState.slab.equals(market) || !poolState.percolatorProgram.equals(cfg.wrapperProgramId)) {
    if (lateNote) return res({ kind: "done", detail: lateNote.trim() }, { state });
    return res({ kind: "skipped", reason: "no stake pool bound to this market" }, { state });
  }
  const [vaultAuth] = deriveStakeVaultAuth(pool, cfg.stakeProgramId);
  // A tombstone has no profile left; the pool binding above stands in for it.
  const stakeBound = state.kind === "closed" ? true : !!asset0InsuranceAuthority(data)?.equals(vaultAuth);
  let budget = state.kind === "resolved" ? state.budget : 0n;
  if (!stakeBound) {
    return res({ kind: "skipped", reason: "asset-0 insurance authority is not this pool's vault_auth (not stake-bound)" }, { state, budget });
  }

  // Unbooked-budget streak (item 3) — counted whether or not tag 29 exists yet.
  const streak = budget > 0n ? (st.unbookedStreak.get(marketAddress) ?? 0) + 1 : 0;
  if (streak > 0) st.unbookedStreak.set(marketAddress, streak);
  else st.unbookedStreak.delete(marketAddress);
  const unbookedAlert = (why: string): FeeJobOutcome | null =>
    streak >= cfg.unbookedAlertCycles
      ? {
          kind: "blocked",
          alertKind: "terminal-budget-unbooked",
          reason: `resolved stake-bound market still holds ${budget} atoms of unbooked insurance budget after ${streak} cycles (${why}) — stakers' money is stranded until stake tag 29 books it (F-9)`,
        }
      : null;

  const collateralMint = parseWrapperConfigV17(data).collateralMint;

  // B12 cleanup before tag 29: close every materialized portfolio (payout and
  // rent to each owner; PDA owners skipped) so wrapper tag 41 can release the
  // budget. Gated on the wrapper supporting it (no-op on 6377376a).
  let cleanup: CleanupResult | null = null;
  if (cfg.cleanup && state.kind === "resolved" && state.materializedPortfolios > 0n) {
    let nowSlot = 0n;
    try {
      nowSlot = BigInt(await conn.getSlot("confirmed"));
    } catch {
      nowSlot = 0n; // unknown clock => pdaGraceLeft keeps the full grace (fail safe for holders)
    }
    cleanup = await cleanupResolvedPortfolios(conn as CleanupConnection, keeper, market, collateralMint, dryRun, cfg.cleanup, st.cleanup, {
      nowSlot,
      resolvedSlot: state.resolvedSlot,
    });
    for (const a of seniorDrawAlerts(marketAddress, marketAddress, parseSeniorDrawLogs(cleanup.seniorDrawLogs))) events.push(a);
    for (const v of cleanup.vaultLpClosed) {
      console.log(`[terminal-insurance] ${marketAddress.slice(0, 8)}…: closed vault-LP portfolio ${v} (tag 101 then tag 8; rent to the LP-vault registry, expected)`);
    }
    for (const c of cleanup.pdaClosed) {
      events.push({
        kind: "terminal-pda-portfolio-closed",
        severity: "warn",
        subject: marketAddress,
        message:
          `closed EMPTY NFT-escrowed portfolio ${c.portfolio} after the ${cfg.cleanup!.pdaGraceSlots}-slot grace period so stake tag 29 can recover the insurance budget; ` +
          `${c.rentLamports} lamports of rent went to its PDA owner ${c.owner}`,
        data: { portfolio: c.portfolio, owner: c.owner, pdaKind: c.kind, rentLamports: c.rentLamports },
      });
      console.warn(
        `[terminal-insurance] ${marketAddress.slice(0, 8)}…: closed ${c.kind} PDA-owned portfolio ${c.portfolio} after the grace period — ` +
          `${c.rentLamports} lamports of rent went to its PDA owner ${c.owner}`,
      );
    }
    if (cleanup.closed > 0 && !dryRun) {
      try {
        const [mi2] = await conn.getMultipleAccountsInfo([market], "confirmed");
        const s2 = mi2 ? decodeTerminalState(new Uint8Array(mi2.data)) : null;
        if (s2 && s2.kind === "resolved") {
          state = s2;
          budget = s2.budget;
        }
      } catch {
        // keep the pre-cleanup view; tag 29 decides
      }
    }
  }
  // P3 07a1d0eb: once terminal-flat, harvest the pending LP fee leg (tag 78) into
  // the seniors BEFORE tag 29, so bound Earn redemption (77, needs H == 0) unlocks.
  // Wrappers before 07a1d0eb answer EngineLockActive (21) in preflight -> a quiet
  // skip; on 6377376a no vault is ever bound, so this never sends there.
  let harvestNote = "";
  if (state.kind === "resolved" && isTerminalFlat(state)) {
    const h = await crankLpFeesOnce(conn, keeper, marketAddress, dryRun, cfg.confirm);
    harvestNote =
      h === "cranked" ? " Tag 78 harvested the LP fee leg into the seniors (Earn redemption unlocked)."
        : h === "no-fees" ? " Tag 78: no LP fees pending."
          : h === "skipped" ? ""
            : ` Tag 78 harvest failed: ${h.error}.`;
    if (h === "cranked") console.log(`[terminal-insurance] ${marketAddress.slice(0, 8)}…: resolved terminal-flat LP fee harvest (tag 78) landed`);
  }

  const cleanupNote = cleanup
    ? ` Cleanup: support=${cleanup.support}, closed ${cleanup.closed}, progressed ${cleanup.progressed}, ${cleanup.remaining.length} left` +
      (cleanup.remaining.length ? ` [${cleanup.remaining.slice(0, 3).map((r) => `${r.portfolio.slice(0, 8)}…: ${r.reason}`).join("; ")}${cleanup.remaining.length > 3 ? "; …" : ""}]` : "") + "."
    : "";

  // S1 account shape. Only a v5 pool has a creator account; it needs the creator's collateral ATA to EXIST (an
  // uninitialised one would read as 16 and look like an old program). Whether the DEPLOYED stake accepts the shape is
  // decided below by simulating it (see resolveShape).
  let v5Plan: { insuranceUnits?: PublicKey; creatorToken: PublicKey } | null = null;
  if (poolState.version === 5 && poolState.riskMode !== undefined) {
    const ata = creatorCollateralAta(poolState.admin, poolState.collateralMint);
    // Mint AND owner are checked: an ATA reassigned (SetAuthority) to someone else is refused on chain by tag 29 forever.
    const ready = (ai: Awaited<ReturnType<TerminalConnection["getAccountInfo"]>>): boolean =>
      isCreatorTokenAccount(ai, poolState!.collateralMint, poolState!.admin);
    try {
      const existing = await conn.getAccountInfo(ata, "confirmed");
      let ok = ready(existing);
      const nowMs0 = (cfg.now ?? Date.now)();
      const tries = st.creatorAtaAttempts.get(marketAddress);
      // An account already at the ATA address that is not usable (reassigned owner, wrong mint, frozen) cannot be fixed by a create.
      if (!ok && !existing && !dryRun && state.kind === "resolved" && st.creatorAtaNeeded.has(marketAddress)
        && (!tries || (tries.n < CREATOR_ATA_MAX_ATTEMPTS && nowMs0 >= tries.nextAtMs))) {
        // Only after the program REFUSED for want of the creator account (see creatorAtaNeeded), never pre-emptively, and bounded
        // per market with backoff. Anyone may create the ATA; the keeper pays the rent.
        const n = (tries?.n ?? 0) + 1;
        st.creatorAtaAttempts.set(marketAddress, { n, nextAtMs: nowMs0 + CREATOR_ATA_BACKOFF_MS * 2 ** (n - 1) });
        try {
          const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
          const tx = mkTx(keeper, blockhash, buildCreateCreatorAtaIx(keeper.publicKey, poolState.admin, poolState.collateralMint));
          const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
          const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm);
          if (c.status === "landed") {
            console.log(`[terminal-insurance] ${marketAddress.slice(0, 8)}…: created the creator collateral ATA ${ata.toBase58()} (needed by stake tag 29 on a v5 pool)`);
            ok = ready(await conn.getAccountInfo(ata, "confirmed"));
          }
        } catch {
          ok = false;
        }
      }
      if (ok) {
        v5Plan = { creatorToken: ata, ...(poolState.riskMode === 1 ? { insuranceUnits: deriveInsuranceUnitsV22(cfg.wrapperProgramId, market)[0] } : {}) };
      }
    } catch {
      v5Plan = null;
    }
  }
  let useV5 = false;
  const build = (amount: bigint, stray?: PublicKey, v5?: typeof v5Plan) =>
    buildRecoverTerminalInsuranceIx({
      stakeProgramId: cfg.stakeProgramId, wrapperProgramId: cfg.wrapperProgramId, caller: keeper.publicKey,
      market, pool, poolVault: poolState!.vault, collateralMint, amount, stray, ...(v5 ? { v5 } : {}),
    });

  const support = await tag29Support(conn, keeper, build(0n), st, cfg);
  if (support !== "supported") {
    const why = support === "unsupported" ? "deployed stake has no tag 29 yet (pre-F-9): no-op" : "tag-29 support unknown this cycle (probe failed)";
    return res(unbookedAlert(why) ?? { kind: "skipped", reason: why }, { state, budget, stakeBound, support });
  }

  // Shape gate: simulate the S1 shape (amount 0). Only the pre-S1 program's exact refusal (16 / NotEnoughAccountKeys at
  // the stake ix) keeps the legacy shape; any other answer (31, 30, 21, ok, 46) means the program parsed the extra
  // accounts, i.e. it is upgraded. RPC failure = legacy this cycle, not cached. Re-probed after probeTtlMs.
  if (v5Plan) {
    const nowMs = (cfg.now ?? Date.now)();
    if (st.shape && nowMs - st.shape.at < cfg.probeTtlMs) {
      useV5 = st.shape.value === "v5";
    } else {
      try {
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        const r = await simulate(conn, mkTx(keeper, blockhash, build(0n, undefined, v5Plan)));
        const value = r.err && isLegacyShapeRefusal(r.err) ? "legacy" : "v5";
        st.shape = { value, at: nowMs };
        useV5 = value === "v5";
      } catch {
        useV5 = false;
      }
    }
  }

  // Stake error 46 CreatorAccountRequired: retryable once the creator's collateral ATA exists / the S1 shape is used. Logged
  // once per market (not per cycle) and never an alert by itself; the unbooked-budget streak still escalates if it persists.
  const creatorRequired = (amount: bigint): WindDownStep => {
    if (poolState!.version === 5) st.creatorAtaNeeded.add(marketAddress);
    if (!st.creatorWarned.has(marketAddress)) {
      st.creatorWarned.add(marketAddress);
      console.warn(`[terminal-insurance] ${marketAddress.slice(0, 8)}…: stake Custom(46) CreatorAccountRequired — the terminal settlement owes the creator; ${v5Plan ? "retrying with the creator ATA" : `create ${poolState!.version === 5 ? creatorCollateralAta(poolState!.admin, poolState!.collateralMint).toBase58() : "pool.admin's collateral ATA"} (pool.admin's collateral ATA) to unblock`}`);
    }
    st.shape = null; // re-decide the account shape next cycle
    return { amount, outcome: "creator-required", detail: "Custom(46) CreatorAccountRequired: creator collateral ATA missing or shape not accepted — retry next cycle" };
  };

  // One tag-29 call: simulate, classify, send.
  const call = async (amount: bigint, stray?: PublicKey): Promise<WindDownStep> => {
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = mkTx(keeper, blockhash, build(amount, stray, useV5 ? v5Plan : null));
      const sim = await simulate(conn, tx);
      if (sim.err) {
        const ie = parseInstructionError(sim.err);
        const code = ie && ie.index === 1 ? ie.custom : null;
        if (code === STAKE_ERR_NOTHING_TO_RECOVER) return { amount, outcome: "nothing", detail: "Custom(31) NothingToRecover" };
        if (code === WRAPPER_ERR_LOCK_ACTIVE) return { amount, outcome: "cooldown", detail: "Custom(21): insurance-withdraw cooldown or capacity — retry later" };
        if (code === STAKE_ERR_MARKET_NOT_TERMINAL) return { amount, outcome: "not-terminal", detail: "Custom(30) MarketNotTerminal" };
        if (code === STAKE_ERR_CREATOR_ACCOUNT_REQUIRED) return creatorRequired(amount);
        // FIRST_LOSS pool without the creator ATA: the legacy 9-account list answers NotEnoughAccountKeys at the stake ix.
        if (!(useV5 && v5Plan) && poolState!.version === 5 && isLegacyShapeRefusal(sim.err) && !(typeof ie?.custom === "number")) return creatorRequired(amount);
        return { amount, outcome: "failed", detail: `sim ${JSON.stringify(sim.err)} ${(sim.logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-1).join("")}`.slice(0, 200) };
      }
      if (dryRun) return { amount, outcome: "dry-run", detail: "simulated clean; not sent" };
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm);
      if (c.status === "landed") return { amount, outcome: "sent", detail: `sig=${sig.slice(0, 16)}… [${c.via}]` };
      if (c.status === "failed" && c.code === STAKE_ERR_NOTHING_TO_RECOVER) return { amount, outcome: "nothing", detail: "Custom(31) on chain" };
      if (c.status === "failed" && c.code === STAKE_ERR_CREATOR_ACCOUNT_REQUIRED) return creatorRequired(amount);
      return { amount, outcome: "failed", detail: c.status === "failed" ? `landed but failed ${JSON.stringify(c.err)}` : `not landed: ${c.reason}` };
    } catch (err) {
      return { amount, outcome: "failed", detail: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
    }
  };

  // Step 1: recover the budget (Resolved only).
  let recovered: WindDownStep | null = null;
  if (budget > 0n) {
    const s1 = await call(budget);
    steps.push(s1);
    if (s1.outcome === "sent") {
      // B14: never stop here — step 2 (amount 0) still has to book any
      // third-party tag-41 push / stray account. Done is decided by 31 only.
      st.unbookedStreak.delete(marketAddress);
      recovered = s1;
    } else if (s1.outcome === "cooldown" && state.kind === "resolved" && state.materializedPortfolios > 0n) {
      // B12: wrapper tag 41 on a Resolved market needs materialized_portfolio_count == 0.
      // CloseResolved empties a portfolio without dematerializing it and only the
      // owner can ClosePortfolio (tag 8), so this 21 is not a cooldown: it lasts
      // until every owner closes, or the P3 wrapper fix lands.
      // C-7: the chunked wind-down made progress this cycle but is not done — continue next
      // cycle; that is not the B12 "blocked" condition (which is: nothing can make progress).
      if (cleanup && cleanup.progressed > 0 && cleanup.waitingOnHolder.length === 0) {
        return res({
          kind: "skipped",
          reason: `resolved-portfolio cleanup in progress (${cleanup.progressed} chunk call(s) this cycle, ${state.materializedPortfolios} portfolio(s) still materialized); continues next cycle.` + cleanupNote,
        }, { state, budget, stakeBound, support });
      }
      if (cleanup && cleanup.waitingOnHolder.length > 0) {
        const w = cleanup.waitingOnHolder;
        return res({
          kind: "blocked",
          alertKind: "terminal-waiting-nft-holder",
          reason:
            `stake insurance recovery (tag 29, ${budget} atoms) is waiting on NFT holder(s): ` +
            w.map((x) => `${x.holder ?? "?"} (portfolio ${x.portfolio}, NFT mint ${x.nftMint ?? "?"}, claim capital ${x.capital} / pnl ${x.pnl} / reserved ${x.reservedPnl}, ${x.activeLegs} leg(s))`).join("; ") +
            `. Only the holder can settle an escrowed payout (GH#496) — accepted devnet limitation; ${state.materializedPortfolios} materialized portfolio(s) remain.` +
            cleanupNote,
        }, { state, budget, stakeBound, support });
      }
      return res({
        kind: "blocked",
        alertKind: "terminal-recovery-blocked-portfolios",
        reason:
          `stake tag 29(${budget}) -> Custom(21): ${state.materializedPortfolios} materialized portfolio(s) remain on this Resolved market; ` +
          "wrapper tag 41 requires 0. The keeper closes them permissionlessly on the P3 wrapper (b2b2559e); what is left needs the owner or its own path (E2E B12)." +
          cleanupNote,
      }, { state, budget, stakeBound, support });
    } else if (s1.outcome !== "nothing") {
      return res(unbookedAlert(s1.detail) ?? (s1.outcome === "failed" ? { kind: "failed", error: `tag 29(${budget}): ${s1.detail}` } : { kind: "skipped", reason: `tag 29(${budget}): ${s1.detail}` }), { state, budget, stakeBound, support });
    }
  }

  // Step 2: amount = 0 — book third-party tag-41 pushes, sweep a stray.
  let stray: PublicKey | undefined;
  try {
    const accs = await conn.getTokenAccountsByOwner(vaultAuth, { mint: poolState.collateralMint }, "confirmed");
    stray = accs.value.map((a) => a.pubkey).find((k) => !k.equals(poolState!.vault));
  } catch {
    stray = undefined;
  }
  const s2 = await call(0n, stray);
  steps.push(s2);
  const recoveredNote = (lateNote ? `${lateNote.trim()} ` : "") + (harvestNote ? `${harvestNote.trim()} ` : "") + (recovered ? `tag 29 recovered ${budget} atoms of terminal insurance into the stake pool ${recovered.detail}; ` : "");
  if (s2.outcome === "nothing") {
    // Done ONLY on 31 from the amount-0 step (B14).
    st.done.add(marketAddress);
    return res(
      recovered
        ? { kind: "done", detail: `${recoveredNote}tag 29(0) -> Custom(31): wind-down complete` }
        : { kind: "nothing", detail: "Custom(31): nothing left to book — wind-down complete" },
      { state, budget, stakeBound, support },
    );
  }
  if (s2.outcome === "sent") {
    return res({ kind: "done", detail: `${recoveredNote}tag 29(0) booked pushed/stray insurance into the stake pool${stray ? ` (swept ${stray.toBase58().slice(0, 8)}…)` : ""} ${s2.detail}` }, { state, budget, stakeBound, support });
  }
  if (recovered) {
    // The budget landed; the booking step did not finish this pass. Report the
    // recovery, and let the next cycle run step 2 again (not marked done).
    return res({ kind: "done", detail: `${recoveredNote}tag 29(0) not finished (${s2.outcome}: ${s2.detail}) — retried next cycle` }, { state, budget, stakeBound, support });
  }
  if (s2.outcome === "dry-run") return res({ kind: "skipped", reason: `DRY-RUN: tag 29(0) would book${stray ? " + sweep" : ""}` }, { state, budget, stakeBound, support });
  return res(s2.outcome === "failed" ? { kind: "failed", error: `tag 29(0): ${s2.detail}` } : { kind: "skipped", reason: `tag 29(0): ${s2.detail}` }, { state, budget, stakeBound, support });
}

/**
 * Pre-resolve view of a LIVE market: is it stake-bound, what budget would
 * tag 29 have to recover after resolve, and does the deployed stake support
 * tag 29 at all? Never throws; null fields mean "could not tell".
 */
export async function inspectStakeBoundBudget(
  conn: TerminalConnection,
  keeper: Keypair,
  marketAddress: string,
  cfg: TerminalInsuranceConfig,
  st: TerminalInsuranceState,
): Promise<{ state: TerminalState | null; stakeBound: boolean; budget: bigint | null; support: Tag29Support | null }> {
  try {
    const market = new PublicKey(marketAddress);
    const [pool] = deriveStakePool(market, cfg.stakeProgramId);
    const [mi, pi] = await conn.getMultipleAccountsInfo([market, pool], "confirmed");
    if (!mi) return { state: null, stakeBound: false, budget: null, support: null };
    const data = new Uint8Array(mi.data);
    const state = decodeTerminalState(data);
    const budget = state && state.kind !== "closed" ? state.budget : null;
    if (!pi || !pi.owner.equals(cfg.stakeProgramId)) return { state, stakeBound: false, budget, support: null };
    const p = decodeStakePoolAnyVersion(new Uint8Array(pi.data));
    const [vaultAuth] = deriveStakeVaultAuth(pool, cfg.stakeProgramId);
    const stakeBound = p.slab.equals(market) && !!asset0InsuranceAuthority(data)?.equals(vaultAuth);
    if (!stakeBound) return { state, stakeBound, budget, support: null };
    const probe = buildRecoverTerminalInsuranceIx({
      stakeProgramId: cfg.stakeProgramId, wrapperProgramId: cfg.wrapperProgramId, caller: keeper.publicKey,
      market, pool, poolVault: p.vault, collateralMint: parseWrapperConfigV17(data).collateralMint, amount: 0n,
    });
    return { state, stakeBound, budget, support: await tag29Support(conn, keeper, probe, st, cfg) };
  } catch {
    return { state: null, stakeBound: false, budget: null, support: null };
  }
}

export function makeTerminalInsuranceJob(cfg: TerminalInsuranceConfig, st = new TerminalInsuranceState()): FeeJob {
  return {
    name: "terminal-insurance",
    run: async (ctx, m) => (await windDownOnce(ctx.conn, ctx.keeper, m.marketAddress, ctx.dryRun, cfg, st)).outcome,
  };
}
