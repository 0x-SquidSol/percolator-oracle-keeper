/**
 * cross-cluster/priority-fee.ts   (audit S3-A2, 2026-10-18)
 *
 * Optional compute-unit price (priority fee) for every keeper transaction.
 *
 *   KEEPER_PRIORITY_FEE_MICROLAMPORTS   micro-lamports per CU. Unset, empty, 0 or invalid = OFF (no instruction is
 *                                       added, so every transaction is byte-identical to before). Values above
 *                                       MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS are clamped to it.
 *
 * The SetComputeUnitPrice instruction is APPENDED as the LAST instruction. The runtime reads compute-budget
 * instructions wherever they sit in the message, and appending keeps every program instruction at the index it had,
 * so the keeper's InstructionError index -> crank / leg / market mappings (recovery-cranker, stake-fee-pusher,
 * resolved-portfolio-cleanup, v22 exec/sweep, ...) are untouched.
 *
 * Cost bound at the cap: 1,400,000 CU x 100,000 uL/CU = 140,000 lamports (0.00014 SOL) per transaction, on top of
 * the base signature fee.
 */
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import type { Transaction, TransactionInstruction } from "@solana/web3.js";

export const KEEPER_PRIORITY_FEE_ENV = "KEEPER_PRIORITY_FEE_MICROLAMPORTS";
/** Hard ceiling on the configured price (micro-lamports per CU). */
export const MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS = 100_000;

/**
 * Parse the env value. Anything that is not a non-negative whole number in decimal is OFF (0): a typo must never
 * turn into a large fee. Above the cap it is clamped, never rejected, so a too-large value still gets a bounded fee.
 */
export function parseKeeperPriorityFee(raw: string | undefined): { microLamports: number; note: string | null } {
  if (raw === undefined || raw.trim() === "") return { microLamports: 0, note: null };
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { microLamports: 0, note: `${KEEPER_PRIORITY_FEE_ENV}=${JSON.stringify(raw)} is not a whole number; priority fee OFF` };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n > MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS) {
    return { microLamports: MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS, note: `${KEEPER_PRIORITY_FEE_ENV}=${t} is above the cap; clamped to ${MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS}` };
  }
  return { microLamports: n, note: null };
}

let cached: number | null = null;

/** The configured price, read from the env once per process (and once warned about). */
export function keeperPriorityFeeMicroLamports(env: NodeJS.ProcessEnv = process.env): number {
  if (cached !== null && env === process.env) return cached;
  const { microLamports, note } = parseKeeperPriorityFee(env[KEEPER_PRIORITY_FEE_ENV]);
  if (env === process.env) {
    cached = microLamports;
    if (note) console.warn(`[priority-fee] ${note}`);
    if (microLamports > 0) console.log(`[priority-fee] keeper transactions carry ${microLamports} micro-lamports/CU`);
  }
  return microLamports;
}

/** Test hook: forget the cached env read. */
export function resetKeeperPriorityFeeCache(): void {
  cached = null;
}

/** [] when OFF, else the single SetComputeUnitPrice instruction. */
export function keeperPriorityFeeIxs(microLamports: number = keeperPriorityFeeMicroLamports()): TransactionInstruction[] {
  return microLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })] : [];
}

const SET_COMPUTE_UNIT_PRICE_TAG = 3;

function hasComputeUnitPrice(tx: Transaction): boolean {
  const cb: PublicKey = ComputeBudgetProgram.programId;
  return tx.instructions.some((ix) => ix.programId.equals(cb) && ix.data.length > 0 && ix.data[0] === SET_COMPUTE_UNIT_PRICE_TAG);
}

/**
 * Append the configured priority fee as the LAST instruction (a no-op when OFF, or when the tx already sets a
 * price: a second SetComputeUnitPrice makes the whole transaction fail with DuplicateInstruction). Call it after
 * every program instruction is added and before signing.
 */
export function addKeeperPriorityFee<T extends Transaction>(tx: T, microLamports: number = keeperPriorityFeeMicroLamports()): T {
  if (microLamports > 0 && !hasComputeUnitPrice(tx)) tx.add(...keeperPriorityFeeIxs(microLamports));
  return tx;
}
