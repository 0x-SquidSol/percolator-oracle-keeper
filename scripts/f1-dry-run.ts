/**
 * F1 dry run: builds the REAL sweep txs of the v2.2 keeper's cycle against the live v2.2 devnet markets and SIMULATES them
 * (sigVerify:false). Nothing is signed or sent: the executor is in dry-run, the fee payer is only a public key, and the
 * connection is wrapped so any sendRawTransaction throws.
 *
 *   KEEPER_PUBKEY=<fee payer pubkey> DEVNET_RPC_URL=... WRAPPER_PROGRAM_ID=... (the run-v22fresh.sh program env) \
 *     node --import tsx/esm scripts/f1-dry-run.ts [registry.json]
 *
 * Prints, per market: the plan, the [liq] lines, every simulation (instruction tags and keys), and the same round with the
 * liquidation flag OFF for comparison. Asserts the devnet genesis hash first.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { loadV22Market, crankOracleAccounts } from "../src/cross-cluster/v22/market.ts";
import { loadV22Positioned } from "../src/cross-cluster/v22/positioned.ts";
import { DEFAULT_SWEEP_ROUND_CONFIG, runSettleRound, pairingStats } from "../src/cross-cluster/v22/sweep.ts";
import { readMarginParams, marginOf } from "../src/cross-cluster/v22/liquidation.ts";
import { weightBudgetFor } from "../src/cross-cluster/v22/settle-pairing.ts";
import { WRAPPER_PROGRAM_ID } from "../src/program-ids.ts";
import type { ExecConnection } from "../src/cross-cluster/v22/exec.ts";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const url = process.env.DEVNET_RPC_URL;
if (!url) throw new Error("DEVNET_RPC_URL not set");
const payer = new PublicKey(process.env.KEEPER_PUBKEY ?? "");
const conn = new Connection(url, "confirmed");
if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("not devnet: genesis hash mismatch, refusing");

let sims = 0;
const simLog: string[] = [];
const guarded = {
  getLatestBlockhash: conn.getLatestBlockhash.bind(conn),
  simulateTransaction: async (...a: Parameters<Connection["simulateTransaction"]>) => {
    sims++;
    const r = await (conn.simulateTransaction as (...x: unknown[]) => ReturnType<Connection["simulateTransaction"]>)(...a);
    const msg = a[0] as { message: { compiledInstructions: Array<{ data: Uint8Array; accountKeyIndexes: number[] }>; staticAccountKeys: PublicKey[] } };
    const ixs = msg.message.compiledInstructions.slice(2);
    simLog.push(`    sim#${sims}: ${ixs.length} ix [${ixs.map((i) => `${i.data[0]}:${msg.message.staticAccountKeys[i.accountKeyIndexes[2]]?.toBase58().slice(0, 6)}`).join(" ")}] -> ${r.value.err ? JSON.stringify(r.value.err) : `ok ${r.value.unitsConsumed} CU`}`);
    return r;
  },
  sendRawTransaction: async () => {
    throw new Error("DRY RUN: sendRawTransaction must never be called");
  },
  confirmTransaction: async () => {
    throw new Error("DRY RUN: confirm must never be called");
  },
  getSignatureStatuses: async () => {
    throw new Error("DRY RUN: getSignatureStatuses must never be called");
  },
} as unknown as ExecConnection;

const regPath = process.argv[2] ?? `${process.env.HOME}/wt-v22-fresh/keeper/registry.v22fresh.json`;
const registry = JSON.parse(fs.readFileSync(regPath, "utf8")) as { markets: Array<{ marketAddress: string; label: string; symbol: string; lpPortfolio?: string }> };
const keeper = { publicKey: payer } as unknown as Keypair;

for (const entry of registry.markets) {
  if (entry.label.includes("DO-NOT-USE")) continue;
  const load = await loadV22Market(conn, entry, WRAPPER_PROGRAM_ID);
  if (!load.ok) {
    console.log(`== ${entry.symbol}: not a readable v2.2 market (${load.reason})`);
    continue;
  }
  const ctx = load.ctx;
  const pos = await loadV22Positioned(conn, ctx, null, payer);
  if (!pos || !pos.lp) {
    console.log(`== ${entry.symbol}: no positioned set / LP`);
    continue;
  }
  const params = readMarginParams(ctx.data, ctx.layout, ctx.slots);
  console.log(`== ${entry.symbol} ${ctx.marketAddress} positioned=${pos.all.length} (counterparties ${pos.counterparties.length}) mmr=${params?.mmrBps}bps`);
  for (const p of pos.all) {
    const m = p.risk && params ? marginOf(p.risk, params) : null;
    console.log(`   ${p.pubkey.toBase58().slice(0, 8)} ${p.isLp ? "LP " : "acct"} legs=${p.activeLegs} equity=${p.risk?.equity} notional=${m?.notional} margin=${m?.ratioBps ?? "-"}bps requirement=${m?.requirement}`);
  }
  for (const on of [false, true]) {
    sims = 0;
    simLog.length = 0;
    const lines: string[] = [];
    const before = { ...pairingStats };
    const res = await runSettleRound(
      { exec: { conn: guarded, keeper, dryRun: true, log: (l) => lines.push(l) }, getSlot: () => conn.getSlot("confirmed"), hold: () => {}, release: () => {} },
      { market: ctx.market, label: entry.symbol },
      {
        lp: pos.lp.pubkey,
        counterparties: pos.counterparties,
        anchor: pos.flatAnchor,
        oracleAccounts: crankOracleAccounts(ctx),
        nowSlot: ctx.readSlot,
        liq: on ? { layout: ctx.layout, slots: ctx.slots, params } : undefined,
      },
      { ...DEFAULT_SWEEP_ROUND_CONFIG, weightBudget: weightBudgetFor() },
    );
    console.log(`  -- liquidation ${on ? "ON " : "OFF"}: ${res.plan.txs.length} tx(s), outcomes ${res.outcomes.map((o) => (o.kind === "dry-run" ? `dry-run ok (${o.ixCount} ix, ${o.unitsConsumed} CU)` : o.kind === "refused" ? `REFUSED code=${o.code} ${o.name} idx=${o.index}` : o.kind)).join("; ")}`);
    simLog.forEach((l) => console.log(l));
    lines.filter((l) => l.startsWith("[liq]") || l.includes("DRY-RUN")).forEach((l) => console.log("    " + l));
    console.log(`    pruned=${res.pruned} settled=${res.settled.length} liq=${res.liq.map((x) => `${x.key.slice(0, 6)}:${x.result}`).join(",") || "none"} liqDeltaIncluded=${pairingStats.liqIncluded - before.liqIncluded}`);
  }
}
console.log("DONE: simulate-only, nothing was sent");
