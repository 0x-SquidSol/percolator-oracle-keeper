/**
 * cross-cluster/v22/stake-commit-target.ts   (KEEPER_V22_STAKE_COMMIT_TARGET, DEFAULT OFF)
 *
 * Stake v5 `CommitDeployTarget` (stake tag 33). `ProposeDeployTarget` (tag 32) parks a new deploy target on the pool; it only
 * takes effect once someone commits it, and the commit is PERMISSIONLESS after `pending_target_slot + max(cooldown_slots,
 * DEPLOY_TARGET_TIMELOCK_MIN_SLOTS = 216,000)` (stake processor.rs process_commit_deploy_target). No app UI proposes or commits and
 * nobody else calls tag 33, so a proposed target (an admin LOWER, or a protocol RAISE) would stay pending for ever.
 *
 * This job is safe to run unattended:
 *   - it is a pure state change on the pool (no token moves, no CPI), signed by the keeper only as the fee payer;
 *   - the program itself is the gate (40 NoPendingDeployTarget until the timelock has elapsed), and the job pre-checks the same
 *     predicate from the pool bytes, so nothing is simulated or sent before the timelock has passed;
 *   - after a commit the pending fields are zeroed, so a repeat is skipped locally (pendingTargetSlot == 0);
 *   - it applies a target somebody with authority already proposed; it never proposes one.
 *
 *   40 NoPendingDeployTarget   quiet: a race with another committer, or the pre-check read a slot behind. Backed off one tick.
 *   other                      counted as a refusal by the executor, backed off one minute of slots.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_STAKE_COMMIT_DEPLOY_TARGET_V5,
  DEPLOY_TARGET_TIMELOCK_MIN_SLOTS_V5,
  decodeStakePoolV5,
  deriveStakePool,
  encodeStakeCommitDeployTargetV5,
  stakeMetasV5,
} from "@percolatorct/sdk";
import type { StakePoolV5 } from "@percolatorct/sdk";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecContext, ExecOutcome } from "./exec.ts";
import type { V22MarketCtx } from "./market.ts";

/** Stake 40 NoPendingDeployTarget: nothing pending, or the timelock has not elapsed. */
export const STAKE_NO_PENDING_DEPLOY_TARGET = 40;
export const STAKE_COMMIT_TARGET_UNITS = 60_000;
/** Slots to wait after a refusal before the same pool is tried again (~1 minute). */
export const COMMIT_TARGET_BACKOFF_SLOTS = 150n;

export interface StakeCommitTargetState {
  /** pool base58 -> slot before which the keeper does not try again. */
  backoffUntil: Map<string, bigint>;
  committed: number;
}
export const freshStakeCommitTargetState = (): StakeCommitTargetState => ({ backoffUntil: new Map(), committed: 0 });

/** The slot from which `CommitDeployTarget` is accepted: `pending_target_slot + max(cooldown_slots, 216,000)`. */
export function commitDueSlot(pool: Pick<StakePoolV5, "pendingTargetSlot" | "cooldownSlots">): bigint {
  const lock = pool.cooldownSlots > DEPLOY_TARGET_TIMELOCK_MIN_SLOTS_V5 ? pool.cooldownSlots : DEPLOY_TARGET_TIMELOCK_MIN_SLOTS_V5;
  return pool.pendingTargetSlot + lock;
}

export function buildStakeCommitTargetIx(p: { caller: PublicKey; pool: PublicKey; stakeProgramId: PublicKey }): TransactionInstruction {
  const keys = stakeMetasV5(ACCOUNTS_STAKE_COMMIT_DEPLOY_TARGET_V5, { anyone: p.caller, pool: p.pool });
  return new TransactionInstruction({ programId: p.stakeProgramId, keys, data: Buffer.from(encodeStakeCommitDeployTargetV5()) });
}

export type StakeCommitTargetResult =
  | { kind: "skipped"; reason: string }
  | { kind: "backoff"; untilSlot: bigint }
  | { kind: "waiting"; dueSlot: bigint }
  | { kind: "quiet"; code: number }
  | { kind: "sent" | "dry-run" | "refused" | "failed"; outcome: ExecOutcome };

export async function stakeCommitTargetOnce(
  exec: ExecContext,
  ctx: V22MarketCtx,
  poolData: Uint8Array | null,
  st: StakeCommitTargetState,
  p: { stakeProgramId?: PublicKey } = {},
): Promise<StakeCommitTargetResult> {
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
  if (decoded.pendingTargetSlot === 0n) return { kind: "skipped", reason: "no pending deploy target" };
  const nowSlot = BigInt(ctx.readSlot);
  const until = st.backoffUntil.get(key);
  if (until !== undefined && nowSlot < until) return { kind: "backoff", untilSlot: until };
  const due = commitDueSlot(decoded);
  if (nowSlot < due) return { kind: "waiting", dueSlot: due };
  const ix = buildStakeCommitTargetIx({ caller: exec.keeper.publicKey, pool, stakeProgramId });
  const expected = new Set<number>([STAKE_NO_PENDING_DEPLOY_TARGET]);
  const outcome = await simulateAndSend(exec, [ix], { job: "stake-commit-target", label: ctx.label, units: STAKE_COMMIT_TARGET_UNITS, program: "stake", expected });
  if (outcome.kind === "refused") {
    st.backoffUntil.set(key, nowSlot + COMMIT_TARGET_BACKOFF_SLOTS);
    if (outcome.code === STAKE_NO_PENDING_DEPLOY_TARGET) return { kind: "quiet", code: outcome.code };
    return { kind: "refused", outcome };
  }
  if (outcome.kind === "failed") {
    st.backoffUntil.set(key, nowSlot + COMMIT_TARGET_BACKOFF_SLOTS);
    return { kind: "failed", outcome };
  }
  if (outcome.kind === "sent") st.committed++;
  return { kind: outcome.kind === "sent" ? "sent" : "dry-run", outcome };
}
