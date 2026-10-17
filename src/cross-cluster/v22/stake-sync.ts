/**
 * cross-cluster/v22/stake-sync.ts   (KEEPER_V22_STAKE_SYNC)
 *
 * Stake v5 `SyncInsuranceDeployment` (stake tag 31): permissionless, rate-limited (the pool's
 * `sync_cooldown_slots`, default 150). It moves the pool's deployed share of the insurance toward its target.
 *
 *   37 SyncCooldownActive          quiet: not due yet (also pre-checked locally from `last_sync_slot`)
 *   43 NothingToSync               quiet: already close to target
 *   44 InsuranceReadingsDiverged   REFUSED, not retried: the market's insurance is lent out (G9) so the entry and
 *                                  exit readings differ. The keeper backs off for DIVERGED_BACKOFF_COOLDOWNS
 *                                  cooldowns and counts it; it never retry-spams the program.
 *   21 (wrapper EngineLockActive via the inner tag 57)
 *                                  WAITING, not a failure: the bankruptcy h-lock is latched after an insurance loss, so the recover
 *                                  leg is closed until the lock clears or the market resolves. Counted as expected, backed off one
 *                                  cooldown, never retry-spammed (same spirit as the R3.20 OracleStale wait).
 *   other 33-45                    named in the log, counted, backed off one cooldown.
 *
 * Only FIRST_LOSS pools in insurance mode deploy insurance: the program refuses tag 31 on any other pool with
 * InvalidPoolMode(17) (`!is_first_loss() || pool_mode != 0`), so those pools are skipped before simulating.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_STAKE_SYNC_V5,
  decodeStakePoolV5,
  deriveInsuranceUnitsV22,
  deriveMarketVaultAccounts,
  deriveStakePool,
  deriveStakeVaultAuth,
  encodeStakeSyncInsuranceDeploymentV5,
  parseWrapperConfigV17,
  STAKE_RISK_MODE,
  stakeMetasV5,
} from "@percolatorct/sdk";
import type { StakePoolV5 } from "@percolatorct/sdk";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";
import { STAKE_READINGS_DIVERGED, STAKE_SYNC_QUIET_CODES } from "./errors.ts";

/**
 * Wrapper 21 EngineLockActive surfacing through tag 31's inner wrapper tag 57 (recover leg): the bankruptcy h-lock is latched
 * (E2E-A FCAFL 2026-10-17). The stake program itself never answers 21 on tag 31.
 */
export const STAKE_SYNC_WAITING_ENGINE_LOCK = 21;
export const DIVERGED_BACKOFF_COOLDOWNS = 20n;
export const STAKE_SYNC_UNITS = 600_000;

export interface StakeSyncState {
  /** pool base58 -> slot before which the keeper does not try again. */
  backoffUntil: Map<string, bigint>;
  /** pool base58 -> last wall-clock ms of an attempt (the interval gate). */
  lastAttemptMs: Map<string, number>;
  diverged: number;
}
export const freshStakeSyncState = (): StakeSyncState => ({ backoffUntil: new Map(), lastAttemptMs: new Map(), diverged: 0 });

export function buildStakeSyncIx(p: { caller: PublicKey; pool: PublicKey; poolData: StakePoolV5; market: PublicKey; marketData: Uint8Array; wrapperProgramId: PublicKey; stakeProgramId: PublicKey }): TransactionInstruction {
  const cfg = parseWrapperConfigV17(p.marketData);
  const wv = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, cfg.collateralMint);
  const keys = stakeMetasV5(ACCOUNTS_STAKE_SYNC_V5, {
    caller: p.caller,
    pool: p.pool,
    vault: p.poolData.vault,
    vaultAuthority: deriveStakeVaultAuth(p.pool, p.stakeProgramId)[0],
    market: p.market,
    wrapperVault: wv.vaultToken,
    wrapperVaultAuthority: wv.vaultAuthority,
    insuranceUnits: deriveInsuranceUnitsV22(p.wrapperProgramId, p.market)[0],
    wrapperProgram: p.wrapperProgramId,
  });
  return new TransactionInstruction({ programId: p.stakeProgramId, keys, data: Buffer.from(encodeStakeSyncInsuranceDeploymentV5()) });
}

export type StakeSyncResult =
  | { kind: "skipped"; reason: string }
  | { kind: "backoff"; untilSlot: bigint }
  | { kind: "quiet"; code: number }
  | { kind: "waiting"; code: number; outcome: ExecOutcome; untilSlot: bigint }
  | { kind: "diverged"; outcome: ExecOutcome }
  | { kind: "sent" | "dry-run" | "refused" | "failed"; outcome: ExecOutcome };

export async function stakeSyncOnce(
  exec: ExecContext,
  ctx: V22MarketCtx,
  poolData: Uint8Array | null,
  st: StakeSyncState,
  p: { intervalMs: number; nowMs?: number; stakeProgramId?: PublicKey },
): Promise<StakeSyncResult> {
  const stakeProgramId = p.stakeProgramId ?? STAKE_PROGRAM_ID;
  const [pool] = deriveStakePool(ctx.market, stakeProgramId);
  const key = pool.toBase58();
  if (!poolData) return { kind: "skipped", reason: "no stake pool for this market" };
  let decoded: StakePoolV5;
  try {
    decoded = decodeStakePoolV5(poolData);
  } catch (e) {
    return { kind: "skipped", reason: `pool is not a v5 pool (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})` };
  }
  if (decoded.riskMode !== STAKE_RISK_MODE.FirstLoss || decoded.poolMode !== 0) {
    return { kind: "skipped", reason: `tag 31 is FIRST_LOSS insurance-mode only (risk mode ${decoded.riskMode}, pool mode ${decoded.poolMode})` };
  }
  const nowSlot = BigInt(ctx.readSlot);
  const nowMs = p.nowMs ?? Date.now();
  const until = st.backoffUntil.get(key);
  if (until !== undefined && nowSlot < until) return { kind: "backoff", untilSlot: until };
  const lastMs = st.lastAttemptMs.get(key);
  if (lastMs !== undefined && nowMs - lastMs < p.intervalMs) return { kind: "skipped", reason: "interval" };
  if (decoded.lastSyncSlot !== 0n && nowSlot < decoded.lastSyncSlot + decoded.syncCooldownSlots) {
    return { kind: "quiet", code: 37 };
  }
  st.lastAttemptMs.set(key, nowMs);
  const ix = buildStakeSyncIx({ caller: exec.keeper.publicKey, pool, poolData: decoded, market: ctx.market, marketData: ctx.data, wrapperProgramId: ctx.programId, stakeProgramId });
  const expected = new Set<number>([...STAKE_SYNC_QUIET_CODES, STAKE_READINGS_DIVERGED, STAKE_SYNC_WAITING_ENGINE_LOCK]);
  const outcome = await simulateAndSend(exec, [ix], { job: "stake-sync", label: ctx.label, units: STAKE_SYNC_UNITS, program: "stake", expected });
  if (outcome.kind === "refused" && outcome.code === STAKE_SYNC_WAITING_ENGINE_LOCK) {
    exec.log?.(`[v22][stake-sync] ${ctx.label}: wrapper EngineLockActive(21) on the recover leg: bankruptcy h-lock latched, waiting; not a failure`);
  }
  if (outcome.kind === "refused") {
    if (outcome.code === STAKE_READINGS_DIVERGED) {
      st.diverged++;
      st.backoffUntil.set(key, nowSlot + decoded.syncCooldownSlots * DIVERGED_BACKOFF_COOLDOWNS);
      return { kind: "diverged", outcome };
    }
    if (outcome.code === STAKE_SYNC_WAITING_ENGINE_LOCK) {
      const untilSlot = nowSlot + decoded.syncCooldownSlots;
      st.backoffUntil.set(key, untilSlot);
      return { kind: "waiting", code: outcome.code, outcome, untilSlot };
    }
    if (outcome.code !== null && STAKE_SYNC_QUIET_CODES.has(outcome.code)) return { kind: "quiet", code: outcome.code };
    st.backoffUntil.set(key, nowSlot + decoded.syncCooldownSlots);
    return { kind: "refused", outcome };
  }
  if (outcome.kind === "failed") return { kind: "failed", outcome };
  return { kind: outcome.kind === "sent" ? "sent" : "dry-run", outcome };
}
