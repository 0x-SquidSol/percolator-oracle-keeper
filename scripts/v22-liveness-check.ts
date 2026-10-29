/**
 * Read-only + SIMULATION ONLY (never sends): every asset's liveness repairs (lapsed Fresh backing buckets, finalizable
 * ResetPending sides); with a <portfolio>, also simulate [repairs..., refresh crank(portfolio)] to show whether the
 * repairs unblock that portfolio's settle.
 *   tsx scripts/v22-liveness-check.ts <market> [portfolio]
 */
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { detectLayout } from "../src/cross-cluster/market-layout.ts";
import { buildLivenessRepairIx, decodeLivenessState, describeRepair, planLivenessRepairs } from "../src/cross-cluster/liveness-repair.ts";
import type { LivenessRepair } from "../src/cross-cluster/liveness-repair.ts";

const [marketS, pfS] = process.argv.slice(2);
const conn = new Connection(process.env.DEVNET_RPC_URL!, "processed");
const market = new PublicKey(marketS);
const ai = await conn.getAccountInfoAndContext(market, "processed");
const data = ai.value!.data;
const det = detectLayout(data);
if (!det.known) throw new Error("unknown layout");
const slot = BigInt(ai.context.slot);
const all: LivenessRepair[] = [];
for (let i = 0; i < det.slots; i++) {
  const s = decodeLivenessState(data, i);
  const r = planLivenessRepairs(s, slot);
  console.log(`asset ${i}: buckets ${s.buckets.map((b) => `d${b.domain} status=${b.status} expiry=${b.expirySlot} (${b.expirySlot < slot ? "LAPSED" : `+${b.expirySlot - slot}`})`).join(", ")}; sides ${s.sides.map((x) => `mode=${x.mode}`).join("/")} -> ${r.map(describeRepair).join(", ") || "none"}`);
  all.push(...r);
}
if (pfS) {
  const payer = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");
  const program = new PublicKey(process.env.WRAPPER_PROGRAM_ID!);
  const refresh = new TransactionInstruction({ programId: program, keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: market, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pfS), isSigner: false, isWritable: true },
  ], data: Buffer.concat([Buffer.from([5]), Buffer.alloc(8), Buffer.from([0])]) });
  for (const withRepairs of [false, true]) {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...(withRepairs ? all.map((r) => buildLivenessRepairIx(market, r)) : []), refresh];
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
    console.log(`sim refresh ${withRepairs ? `after ${all.length} repair(s)` : "alone"}: err=${JSON.stringify(sim.value.err)} CU=${sim.value.unitsConsumed}`);
  }
}
