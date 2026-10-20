/**
 * Test support: priority-fee-aware instruction views for the recording fakes. Not a test file (the glob only runs *.test.ts).
 *
 * With KEEPER_PRIORITY_FEE_MICROLAMPORTS set, every keeper tx carries one extra SetComputeUnitPrice instruction (S3-A2),
 * appended LAST. A fake that decodes "every instruction after the prelude" as a push/crank would then read that price
 * instruction as a payload. These helpers drop every ComputeBudget instruction so a fake sees the same payload list with
 * the fee on or off.
 */
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";

const CB: PublicKey = ComputeBudgetProgram.programId;

/** Instructions that are not ComputeBudget (heap frame / CU limit / CU price), in order. For `Transaction.instructions`. */
export function nonComputeBudget<T extends { programId: PublicKey }>(ixs: readonly T[]): T[] {
  return ixs.filter((ix) => !ix.programId.equals(CB));
}

/** Same for compiled instructions, resolved against the message's static account keys. */
export function nonComputeBudgetCompiled<T extends { programIdIndex: number }>(ixs: readonly T[], staticAccountKeys: readonly PublicKey[]): T[] {
  return ixs.filter((ix) => !staticAccountKeys[ix.programIdIndex].equals(CB));
}
