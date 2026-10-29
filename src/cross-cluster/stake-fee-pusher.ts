/**
 * cross-cluster/stake-fee-pusher.ts
 *
 * Pushes each market's insurance/staker fee leg (16% of every trade fee) to
 * its stake pool and books it into the share price, in ONE transaction:
 *
 *   [0] ComputeBudget
 *   [1] wrapper tag 87 WithdrawInsuranceReserveToStake  (market vault -> pool.vault)
 *   [2] stake   tag 12 AccrueFees (+ trailing pool.slab)  (books it: total_fees_earned += Δ)
 *
 * Why (fee-flow audit 2026-09-29, F2): `insurance_reserve_withdrawn_atoms = 0`
 * on all 19 live markets — nothing in the keeper or the app ever called tag 87,
 * so $0 of the staker leg had ever reached stakers. Anything still unpushed
 * when a market resolves is burned at CloseSlab (F4), because tag 87 is
 * Live-only.
 *
 * The real-staker gate (F3). Stake AccrueFees books a mode-0 payout whenever
 * `total_lp_supply > 0` (percolator-stake@e62aa4a processor.rs:2668), and
 * `total_lp_supply` INCLUDES the 1,000 N7 dead shares minted to nobody at
 * genesis (`state::MINIMUM_LIQUIDITY`, state.rs:25; `apply_minimum_liquidity_lock`,
 * processor.rs:2497). A pool whose real stakers have all exited holds exactly
 * those 1,000 — PENGU, JUP, TRUMP, BURNIE, Percolator and Murphy do today —
 * and fees booked there are permanently unredeemable. So this job pushes ONLY
 * when `real_lp_supply() > 0` (legacy / pre-fix pools: `total_lp_supply > MINIMUM_LIQUIDITY`;
 * tranche pools on the v2.2 stake program can hold 2,000 dead shares, see the floor-flag mirror below). Pushing tag 87 alone into such a
 * pool does not help either: every later Deposit pre-accrues the unbooked
 * surplus against the same dead supply before minting (#136 guard), so the
 * atoms would still land on the dead shares. They are safest left in the
 * market vault until a real staker exists.
 *
 * The gate is a RATIO, not "one real share" (security review K-1): booking a
 * backlog F against supply 1000 + X gives the dead shares F·1000/(1000+X). With
 * a one-share gate a dust deposit made the keeper book ~99.9% of the backlog
 * onto dead shares (griefing). So the job pushes only when the dead shares'
 * cut is at most `maxDeadShareBps` (default 100 bps = 1%, i.e. total supply of
 * at least 100,000 shares), plus an optional absolute `minRealShares` floor.
 *
 * Not closed by the keeper, by design: a backlog that accrued while a pool had
 * no real stakers goes to whoever is staked when it is pushed, so a large
 * first depositor captures it (F5 for stakers). Only a program-side change
 * (P1 F3/F5: route pre-staker backlog to insurance) removes that.
 *
 * Residual race (documented, not closable client-side): the last real staker
 * can withdraw between this job's read and the transaction landing. The
 * durable fix is the stake-side guard (P1 fee fixes, F3).
 *
 * Wire layouts, verified against the deployed sources:
 *   tag 87  wrapper deploy/v18.2@6377376a v16_program.rs:17071 — 7 accounts:
 *           cranker(s), market(w), stakePool, stakeVault(w), vaultToken(w),
 *           vaultAuthority, tokenProgram  (= SDK ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE)
 *   tag 12  stake deploy/v18.2@e62aa4a processor.rs:2761 — caller(s), pool(w),
 *           vault, clock, slab. The trailing slab is REQUIRED for mode 0
 *           (#290); SDK 6.0.0's accrueFeesAccounts predates it, so the metas
 *           are built here.
 *
 * Wrapper error codes (v16_program.rs:869 enum order, verified): 21
 * EngineLockActive (market not Live), 53 NoInsuranceReserveToClaim, 54
 * StakePoolNotBound, 55 OwnerMismatch, 56 AuthorityMismatch, 57 MarketMismatch,
 * 58 WrapperMismatch, 59 ModeMismatch, 60 StakeProgramNotPinned.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE,
  buildAccountMetas,
  deriveMarketVaultAccounts,
  deriveStakePool,
  encodeStakeAccrueFees,
  encodeWithdrawInsuranceReserveToStake,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import { decodeStakePoolAnyVersion } from "./stake-pool-decode.ts";
import { STAKE_PROGRAM_ID, WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import { chainSlotOrNull, describeProgramError, formatWrapperCode, ORACLE_STALE, staleResolveWait } from "./fee-error.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import { isLiveMarket } from "./market-state.ts";
import {
  FLOOR_JUNIOR,
  FLOOR_SENIOR,
  STAKE_FLOOR_FLAGS_RESERVED_INDEX,
  STAKE_MINIMUM_LIQUIDITY as SDK_STAKE_MINIMUM_LIQUIDITY,
  stakeRealLpSupply,
} from "@percolatorct/sdk";
import { addKeeperPriorityFee } from "./priority-fee.ts";

/**
 * Per-sub-pool dead-share floors (percolator-stake fix/v22-stake-last-junior-residual @ aebbff6,
 * state.rs `dead_lp` / `real_lp_supply` / `has_real_lp_holders`). A tranche pool can carry 0, 1,000
 * or 2,000 dead shares, recorded in `StakePool._reserved[61]` (FLOOR_SENIOR 0x01, FLOOR_JUNIOR 0x02).
 * A byte of 0 is a LEGACY pool (every pool on the currently deployed pre-fix stake program), which
 * keeps the old rule: one floor, `total_lp_supply - 1000` (saturating).
 *
 * The constants and `real_lp_supply` come from the SDK (`stake-dead-lp`, @percolatorct/sdk a18c199e);
 * the former local mirror (TODO(repin)) is gone. Only the raw-byte flag read stays here, because the
 * fee pusher reads the flags byte straight off the account data without decoding the whole pool.
 */
export const STAKE_MINIMUM_LIQUIDITY: bigint = SDK_STAKE_MINIMUM_LIQUIDITY;
export const STAKE_FLOOR_SENIOR: number = FLOOR_SENIOR;
export const STAKE_FLOOR_JUNIOR: number = FLOOR_JUNIOR;

/** Raw floor-flags byte of a pool account (0 when absent / legacy). `_reserved` starts at 320 on v2+ pools (state.rs `offset_of!(_reserved) == 320`), 288 on v1. */
export function readStakeFloorFlags(data: Uint8Array): number {
  const reservedStart = data.length >= 384 ? 320 : 288;
  return data[reservedStart + STAKE_FLOOR_FLAGS_RESERVED_INDEX] ?? 0;
}

const COMPUTE_UNIT_LIMIT = 200_000;

/** Wrapper codes tag 87 returns, by meaning. */
export const TAG87_NO_RESERVE = 53;
export const TAG87_NOT_LIVE = 21;
const TAG87_BLOCKED: Record<number, string> = {
  54: "StakePoolNotBound — asset-0 insurance_authority is not a stake pool; operator must run stake tag 19 BindInsuranceAuthority",
  55: "StakePoolOwnerMismatch — pool account not owned by the wrapper's pinned stake program",
  56: "StakePoolAuthorityMismatch — asset-0 insurance_authority is not this pool's vault_auth; operator must run stake tag 19 BindInsuranceAuthority",
  57: "StakePoolMarketMismatch — pool.slab is a different market",
  58: "StakePoolWrapperMismatch — pool.percolator_program is a different wrapper",
  59: "StakePoolModeMismatch — pool is not mode 0 (insurance)",
  60: "StakeProgramNotPinned — this wrapper build has no stake program (non-devnet build)",
};

export interface StakeFeeConfig {
  wrapperProgramId: PublicKey;
  stakeProgramId: PublicKey;
  /**
   * Real (non-dead) shares required before pushing. A pool must hold MORE
   * than MINIMUM_LIQUIDITY + this. Default 0: any real share qualifies.
   */
  minRealShares: bigint;
  /**
   * Max share of a push the 1,000 dead shares may take, in bps:
   * push only if MINIMUM_LIQUIDITY·10_000 ≤ maxDeadShareBps·total_lp_supply.
   */
  maxDeadShareBps: bigint;
  /** Do not spend a transaction on less than this many atoms. */
  minPushAtoms: bigint;
  confirm?: ConfirmOptions;
}

export function stakeFeeConfigFromEnv(env: Readonly<Record<string, string | undefined>>): StakeFeeConfig {
  const big = (name: string, fallback: bigint): bigint => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^\d+$/.test(raw.trim())) throw new Error(`${name}="${raw}" must be a non-negative integer`);
    return BigInt(raw.trim());
  };
  return {
    wrapperProgramId: WRAPPER_PROGRAM_ID,
    stakeProgramId: STAKE_PROGRAM_ID,
    minRealShares: big("STAKE_FEE_MIN_REAL_SHARES", 0n),
    maxDeadShareBps: (() => {
      const v = big("STAKE_FEE_MAX_DEAD_SHARE_BPS", 100n);
      if (v <= 0n || v > 10_000n) throw new Error("STAKE_FEE_MAX_DEAD_SHARE_BPS must be in 1..10000");
      return v;
    })(),
    minPushAtoms: big("STAKE_FEE_MIN_PUSH_ATOMS", 1n),
  };
}

/** The pure part of the decision: given decoded state, what should happen. */
export type StakeFeeDecision =
  | { action: "push"; owed: bigint; realShares: bigint }
  | { action: "nothing"; owed: bigint }
  | { action: "skip"; reason: string }
  | { action: "blocked"; reason: string };

export interface StakeFeeState {
  market: PublicKey;
  owed: bigint;
  pool: null | {
    slab: PublicKey;
    poolMode: number;
    /** v5 `risk_mode` (1 FIRST_LOSS, 2 FEE_ONLY); undefined on pre-v5 pools. */
    riskMode?: number;
    totalLpSupply: bigint;
    /** Raw `_reserved[61]` floor flags; omitted / 0 = legacy pool (total - 1000). */
    floorFlags?: number;
    isInitialized: boolean;
    percolatorProgram: PublicKey;
  };
}

export function decideStakeFeePush(s: StakeFeeState, cfg: Pick<StakeFeeConfig, "minRealShares" | "maxDeadShareBps" | "minPushAtoms" | "wrapperProgramId">): StakeFeeDecision {
  if (s.owed <= 0n) return { action: "nothing", owed: 0n };
  if (s.owed < cfg.minPushAtoms) return { action: "nothing", owed: s.owed };
  if (!s.pool) return { action: "skip", reason: "no stake pool for this market" };
  if (!s.pool.isInitialized) return { action: "skip", reason: "stake pool not initialized" };
  if (!s.pool.slab.equals(s.market)) return { action: "blocked", reason: "pool.slab is a different market" };
  if (!s.pool.percolatorProgram.equals(cfg.wrapperProgramId)) {
    return { action: "blocked", reason: `pool.percolator_program ${s.pool.percolatorProgram.toBase58()} is not the configured wrapper` };
  }
  if (s.pool.poolMode !== 0) return { action: "skip", reason: `pool mode ${s.pool.poolMode} is not an insurance pool` };
  // Wrapper tag 87 pays the staker leg to FIRST_LOSS pools only (`owed_staker_leg`, v16_program.rs:24xxx): any other v5
  // pool answers StakePoolModeMismatch (Custom(59)) every cycle (PENGU, audit 2026-10-17 S2-2). Same pattern as the
  // 91bd33e stake-sync filter. A pool with no risk_mode (pre-v5) is left to the program's own answer.
  if (s.pool.riskMode !== undefined && s.pool.riskMode !== 1) {
    return { action: "skip", reason: `risk mode ${s.pool.riskMode} is not FIRST_LOSS — the wrapper pays the staker fee leg to FIRST_LOSS pools only` };
  }
  const total = s.pool.totalLpSupply;
  const realShares = stakeRealLpSupply({ totalLpSupply: total, floorFlags: s.pool.floorFlags ?? 0 });
  // Dead shares = everything that is not real (1,000 legacy / non-tranche; up to 2,000 on a tranche pool).
  const deadShares = total - realShares;
  if (realShares > cfg.minRealShares && deadShares * 10_000n > cfg.maxDeadShareBps * total) {
    const deadBps = (deadShares * 10_000n + total - 1n) / total;
    return {
      action: "skip",
      reason: `too few real stakers: the ${deadShares} dead shares would take ~${deadBps} bps of the push (max ${cfg.maxDeadShareBps}; total_lp_supply=${total}) — ${s.owed} atoms held in the market vault (K-1/F3)`,
    };
  }
  if (realShares <= cfg.minRealShares) {
    return {
      action: "skip",
      reason: `no real stakers (total_lp_supply=${total}, real_lp_supply=${realShares}, dead ${deadShares}) — ${s.owed} atoms held in the market vault (F3)`,
    };
  }
  return { action: "push", owed: s.owed, realShares };
}

export function buildWithdrawInsuranceReserveToStakeIx(p: {
  wrapperProgramId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  stakePool: PublicKey;
  stakeVault: PublicKey;
  collateralMint: PublicKey;
}): TransactionInstruction {
  const v = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, p.collateralMint);
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE_RESERVE_TO_STAKE, {
      cranker: p.cranker,
      market: p.market,
      stakePool: p.stakePool,
      stakeVault: p.stakeVault,
      vaultToken: v.vaultToken,
      vaultAuthority: v.vaultAuthority,
      tokenProgram: v.tokenProgram,
    }),
    data: Buffer.from(encodeWithdrawInsuranceReserveToStake()),
  });
}

export function buildStakeAccrueFeesIx(p: {
  stakeProgramId: PublicKey;
  caller: PublicKey;
  pool: PublicKey;
  vault: PublicKey;
  slab: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.stakeProgramId,
    keys: [
      { pubkey: p.caller, isSigner: true, isWritable: false },
      { pubkey: p.pool, isSigner: false, isWritable: true },
      { pubkey: p.vault, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: p.slab, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeStakeAccrueFees()),
  });
}

/**
 * Classify a failed simulation of [CU, 87, 12]. `staleWait` is the reason from `staleResolveWait` when the market's
 * stale-resolve window is confirmed matured: tag 87 calls the same `reject_permissionless_resolve_matured_live_view`
 * as tag 78, so OracleStale (27) there is the wait for the next mark push (R3.20), never otherwise.
 */
export function classifyStakeFeeError(err: unknown, logs: string[] | null, staleWait: string | null = null): FeeJobOutcome {
  const ie = parseInstructionError(err);
  const code = ie?.custom ?? null;
  if (ie && ie.index === 1 && code !== null) {
    if (code === ORACLE_STALE && staleWait) return { kind: "waiting", reason: `tag 87 ${staleWait}` };
    if (code === TAG87_NO_RESERVE) return { kind: "nothing", detail: "no insurance reserve available (Custom(53))" };
    if (code === TAG87_NOT_LIVE) return { kind: "skipped", reason: "market not Live (Custom(21)) — tag 87 is Live-only" };
    const blocked = TAG87_BLOCKED[code];
    if (blocked) return { kind: "blocked", reason: `Custom(${code}) ${blocked}` };
  }
  const where = ie ? (ie.index === 1 ? "tag 87" : ie.index === 2 ? "stake AccrueFees" : `ix ${ie.index}`) : "tx";
  const tail = logs?.filter((l) => /Error|failed|#290|AccrueFees/i.test(l)).slice(-2).join(" / ") ?? "";
  const codeText = code === null ? JSON.stringify(err) : ie?.index === 2 ? `Custom(${code})` : formatWrapperCode(code);
  return { kind: "failed", error: `${where} ${codeText}${tail ? ` — ${tail}` : ""}` };
}

/** Parse "AccrueFees: accrued N fees" out of simulation/transaction logs. */
export function accruedFromLogs(logs: string[] | null): bigint | null {
  for (const l of logs ?? []) {
    const m = l.match(/AccrueFees: accrued (\d+) fees/);
    if (m) return BigInt(m[1]);
  }
  return null;
}

/** The Connection surface this job uses (stubbable in tests). */
export type StakeFeeConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "getBlockHeight" | "getSignatureStatuses"
> &
  /** Read only when tag 87 answers OracleStale, to confirm the stale-resolve wait (R3.20). */
  Partial<Pick<Connection, "getSlot">>;

/** One market. Never throws. */
export async function pushStakeFeesOnce(
  conn: StakeFeeConnection,
  keeper: Keypair,
  marketAddress: string,
  dryRun: boolean,
  cfg: StakeFeeConfig,
): Promise<FeeJobOutcome> {
  let market: PublicKey;
  try {
    market = new PublicKey(marketAddress);
  } catch {
    return { kind: "failed", error: "unparseable market address" };
  }
  const [poolPda] = deriveStakePool(market, cfg.stakeProgramId);

  let marketData: Uint8Array;
  let state: StakeFeeState;
  let poolVault: PublicKey | null = null;
  let collateralMint: PublicKey;
  try {
    const [mi, pi] = await conn.getMultipleAccountsInfo([market, poolPda], "confirmed");
    if (!mi) return { kind: "failed", error: "market account not found" };
    if (!mi.owner.equals(cfg.wrapperProgramId)) {
      return { kind: "skipped", reason: `market owned by ${mi.owner.toBase58()}, not the configured wrapper` };
    }
    marketData = new Uint8Array(mi.data);
    // B13: tag 87 is Live-only. A Resolved market / tombstone is the
    // terminal-insurance job's; skip locally (a tombstone does not even parse).
    if (!isLiveMarket(marketData)) return { kind: "skipped", reason: "market not Live (Recovery/Resolved/closed) — tag 87 is Live-only (see terminal-insurance job)" };
    const wc = parseWrapperConfigV17(marketData);
    collateralMint = wc.collateralMint;
    const owed = wc.insuranceReserveAccruedAtoms - wc.insuranceReserveWithdrawnAtoms;
    let pool: StakeFeeState["pool"] = null;
    if (pi && pi.owner.equals(cfg.stakeProgramId)) {
      const p = decodeStakePoolAnyVersion(new Uint8Array(pi.data)); // K-4: v5 (v2.2) pools too
      pool = {
        slab: p.slab,
        poolMode: p.poolMode,
        riskMode: p.riskMode,
        totalLpSupply: p.totalLpSupply,
        floorFlags: readStakeFloorFlags(new Uint8Array(pi.data)),
        isInitialized: p.isInitialized,
        percolatorProgram: p.percolatorProgram,
      };
      poolVault = p.vault;
    }
    state = { market, owed, pool };
  } catch (err) {
    return { kind: "failed", error: `account read/decode failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }

  const decision = decideStakeFeePush(state, cfg);
  if (decision.action === "nothing") return { kind: "nothing" };
  if (decision.action === "skip") return { kind: "skipped", reason: decision.reason };
  if (decision.action === "blocked") return { kind: "blocked", reason: decision.reason };
  if (!poolVault) return { kind: "failed", error: "pool decoded without a vault" };

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
  tx.add(
    buildWithdrawInsuranceReserveToStakeIx({
      wrapperProgramId: cfg.wrapperProgramId,
      cranker: keeper.publicKey,
      market,
      stakePool: poolPda,
      stakeVault: poolVault,
      collateralMint,
    }),
  );
  tx.add(
    buildStakeAccrueFeesIx({
      stakeProgramId: cfg.stakeProgramId,
      caller: keeper.publicKey,
      pool: poolPda,
      vault: poolVault,
      slab: market,
    }),
  );

  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    addKeeperPriorityFee(tx); // S3-A2: optional CU price, appended last (OFF by default)
    tx.sign(keeper);

    // Simulate first: the codes tell "not bound" (operator work) apart from
    // "nothing to push" and from real failures, per instruction index.
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      sigVerify: false,
      commitment: "confirmed",
    });
    if (sim.value.err) {
      return classifyStakeFeeError(sim.value.err, sim.value.logs ?? null, await staleWaitFor(conn, sim.value.err, marketData));
    }
    const simAccrued = accruedFromLogs(sim.value.logs ?? null);

    if (dryRun) {
      return { kind: "skipped", reason: `DRY-RUN: would push ${decision.owed} atoms (sim accrued ${simAccrued ?? "?"})` };
    }

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm);
    if (c.status === "landed") {
      return {
        kind: "done",
        detail: `pushed ${decision.owed} atoms to stakers (${decision.realShares} real shares; sim accrued ${simAccrued ?? "?"}) sig=${sig.slice(0, 16)}… [${c.via}]`,
        signature: sig,
      };
    }
    if (c.status === "failed") {
      return classifyStakeFeeError(c.err, null, await staleWaitFor(conn, c.err, marketData));
    }
    // Not landed: blockhash expired without a status. Retried next cycle; the
    // counters make a double push impossible (Custom(53) once drained).
    return { kind: "failed", error: `not landed: ${c.reason}` };
  } catch (err) {
    return { kind: "failed", error: describeProgramError("stake-fee", err, 140) };
  }
}

/** `staleResolveWait` for a tag 87 refusal at instruction 1 (the slot is read only for a 27). */
async function staleWaitFor(conn: StakeFeeConnection, err: unknown, marketData: Uint8Array): Promise<string | null> {
  const ie = parseInstructionError(err);
  if (!ie || ie.index !== 1 || ie.custom !== ORACLE_STALE) return null;
  return staleResolveWait(ie.custom, marketData, await chainSlotOrNull(conn));
}

export function makeStakeFeeJob(cfg: StakeFeeConfig): FeeJob {
  return {
    name: "stake-fee",
    run: (ctx, m) => pushStakeFeesOnce(ctx.conn, ctx.keeper, m.marketAddress, ctx.dryRun, cfg),
  };
}
