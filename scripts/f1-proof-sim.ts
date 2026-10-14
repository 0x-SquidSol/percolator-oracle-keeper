/**
 * F1 proof by simulation on the live v2.2 program: for an account below maintenance, simulate [LP accrue, refresh T] (today's
 * sweep tx) and [LP accrue, refresh T, crank T] (this change) and compare T's POST state. Read-only: simulateTransaction with
 * sigVerify:false, nothing signed or sent. Asserts the devnet genesis hash.
 *
 *   KEEPER_PUBKEY=... DEVNET_RPC_URL=... <program env> node --import tsx/esm scripts/f1-proof-sim.ts <market> <lpPortfolio> <portfolio>
 */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { buildSweepTxSlots } from "../src/cross-cluster/v22/sweep.ts";
import { crankOracleAccounts, loadV22Market } from "../src/cross-cluster/v22/market.ts";
import { readMarginParams, marginOf } from "../src/cross-cluster/v22/liquidation.ts";
import { riskSnapOf } from "../src/cross-cluster/positioned-refresh.ts";
import { WRAPPER_PROGRAM_ID } from "../src/program-ids.ts";

if (!process.env.DEVNET_RPC_URL) throw new Error("DEVNET_RPC_URL not set");
const conn = new Connection(process.env.DEVNET_RPC_URL, "confirmed");
if ((await conn.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
const payer = new PublicKey(process.env.KEEPER_PUBKEY ?? "");
const [marketKey, lpKey, tKey] = process.argv.slice(2).map((s) => new PublicKey(s));
const load = await loadV22Market(conn, { marketAddress: marketKey.toBase58(), label: "proof", lpPortfolio: lpKey.toBase58() }, WRAPPER_PROGRAM_ID);
if (!load.ok) throw new Error(`market: ${load.reason}`);
const ctx = load.ctx;
const T = { pubkey: tKey, longLegs: 1, shortLegs: 0, isLp: false };

async function simulate(label: string, liquidate: boolean) {
  const slots = buildSweepTxSlots(payer, marketKey, { accrue: "lp", accrueTarget: lpKey, refresh: [T], oracleAccounts: crankOracleAccounts(ctx), liquidate: liquidate ? new Set([tKey.toBase58()]) : undefined });
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  slots.forEach((s) => tx.add(s.ix));
  tx.feePayer = payer;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "processed", accounts: { encoding: "base64", addresses: [tKey.toBase58(), marketKey.toBase58()] } });
  const a = r.value.accounts?.[0];
  const m = r.value.accounts?.[1];
  const p = a ? parsePortfolioV17(new Uint8Array(Buffer.from(a.data[0], "base64"))) : null;
  const params = m ? readMarginParams(new Uint8Array(Buffer.from(m.data[0], "base64")), ctx.layout, ctx.slots) : null;
  const mg = p && params ? marginOf(riskSnapOf(p), params) : null;
  console.log(`${label}: ${slots.length} ix, err=${JSON.stringify(r.value.err)} CU=${r.value.unitsConsumed}`);
  if (p) console.log(`   T post: capital=${p.capital} pnl=${p.pnl} feeCredits=${p.feeCredits} activeLegs=${p.legs.filter((l) => l.active).length} basisPosQ=${p.legs.filter((l) => l.active).map((l) => l.basisPosQ).join(",") || "-"} margin=${mg?.ratioBps ?? "-"}bps notional=${mg?.notional}`);
  (r.value.logs ?? []).filter((l) => /liquidat|Liquidat|partial|bankrupt/i.test(l)).slice(0, 6).forEach((l) => console.log("   log: " + l.slice(0, 200)));
}
const before = parsePortfolioV17(new Uint8Array((await conn.getAccountInfo(tKey))!.data));
console.log(`T pre: capital=${before.capital} pnl=${before.pnl} activeLegs=${before.legs.filter((l) => l.active).length} basisPosQ=${before.legs.filter((l) => l.active).map((l) => l.basisPosQ).join(",")}`);
await simulate("today's sweep tx  [accrue, refresh T]        ", false);
await simulate("this change       [accrue, refresh T, crank T]", true);
