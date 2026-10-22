/**
 * SIMULATION ONLY (never sends): simulate N copies of the observation crank (tag 5, asset 0, no oracle accounts) on
 * <portfolio> and report the market's slot_last / stale counters after the simulated tx, plus CU and logs.
 *   tsx scripts/v22-sim-catchup.ts <market> <portfolio> <n> [hints]     hints: comma list of asset indexes ("" = refresh-only, no observation)
 */
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { decodeMarketRefreshState } from "../src/cross-cluster/positioned-refresh.ts";

const [marketS, pfS, nS, assetS] = process.argv.slice(2);
const conn = new Connection(process.env.DEVNET_RPC_URL!, "processed");
const program = new PublicKey(process.env.WRAPPER_PROGRAM_ID!);
const payer = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");
const market = new PublicKey(marketS);
const pf = new PublicKey(pfS);
const n = Number(nS ?? 1);
const hints = (assetS ?? "0").split(",").filter((x) => x !== "").map(Number);
const asset = hints[0] ?? 0;
// the on-chain bytes: 05 | u64 now_slot = 0 (clock) | u8 n | n x (u16 asset, u8 oracle accounts = 0)
const raw = Buffer.concat([Buffer.from([5]), Buffer.alloc(8), Buffer.from([hints.length]), ...hints.map((a) => Buffer.from([a & 0xff, a >> 8, 0]))]);
const crank = new TransactionInstruction({ programId: program, keys: [
  { pubkey: payer, isSigner: true, isWritable: true },
  { pubkey: market, isSigner: false, isWritable: true },
  { pubkey: pf, isSigner: false, isWritable: true },
], data: raw });
const pre = await conn.getAccountInfoAndContext(market, "processed");
const s0 = decodeMarketRefreshState(pre.value!.data, asset);
console.log(`pre  slot=${pre.context.slot} slotLast=${s0.slotLast} lag=${BigInt(pre.context.slot) - s0.slotLast} maxDt=${s0.maxAccrualDtSlots} stale ${s0.staleLong}L/${s0.staleShort}S kf=${s0.kfEpochLong}`);
const { blockhash } = await conn.getLatestBlockhash();
const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...Array.from({ length: n }, () => crank)];
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: [market.toBase58()] } });
console.log(`sim err=${JSON.stringify(sim.value.err)} CU=${sim.value.unitsConsumed}`);
const post = sim.value.accounts?.[0];
if (post) {
  const s1 = decodeMarketRefreshState(Buffer.from(post.data[0], "base64"), asset);
  console.log(`post slotLast=${s1.slotLast} (+${s1.slotLast - s0.slotLast}) stale ${s1.staleLong}L/${s1.staleShort}S kf=${s1.kfEpochLong} lossStale=${s1.lossStaleActive}`);
}
for (const l of (sim.value.logs ?? []).filter((l) => !l.includes("ComputeBudget")).slice(0, 12)) console.log("  ", l.slice(0, 200));
