#!/usr/bin/env tsx
/**
 * sim-k6-multiasset-cycle.ts — SIMULATE (never send) one keeper cycle's transactions for a K-6 multi-asset market,
 * through the keeper's own code paths, against devnet. Read-only: no transaction is ever sent and no private key is
 * read (the keeper is a stand-in Keypair carrying the oracle authority's PUBLIC key; every simulation runs with
 * sigVerify off, which is how the keeper itself preflights).
 *
 *   1. push    pushAuthMarkBatch (auth-mark-pusher.ts) for every asset of the row, live mainnet spot for pool assets and
 *              the configured mark for fixed ones. The pusher's own preflight simulation is captured and reported, then
 *              the captured tx is re-simulated with the market account returned to show every asset's new target.
 *   2. crank   crankOneMarket (recovery-cranker.ts) with the v2.2 sweep delegate installed (KEEPER_V22_SWEEP=on, dry-run
 *              executor = simulate only), exactly as run-v22fresh.sh runs it. Every simulateTransaction is captured; a
 *              send is refused by the connection wrapper (it throws, nothing leaves the process).
 *   3. proof   (optional, --proof) one tx [pushes, the catch-up cranks the planner chose, an accrue crank observing all
 *              assets on the LP, then on the positioned counterparty], to show the steady-state crank lands with
 *              every asset fresh. Not a shape the keeper sends; evidence only.
 *
 * usage (from the keeper dir):
 *   SEED_RPC_URL=<devnet rpc> MAINNET_RPC_URL=<mainnet rpc> \
 *   node --import tsx/esm scripts/sim-k6-multiasset-cycle.ts [registry-additions-v22-multiasset.json] [market] [--proof]
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram, TransactionMessage } from "@solana/web3.js";

const WRAPPER = "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM";
const ORACLE_AUTHORITY = "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7";
Object.assign(process.env, {
  WRAPPER_PROGRAM_ID: WRAPPER,
  STAKE_PROGRAM_ID: "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V",
  KEEPER_NFT_PROGRAM_ID: "27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1",
  MATCHER_PROGRAM_ID: "AsHvEJ8zNctKmdeS57H5E4w6nkTLi3bPVpd6ZCLc2ayN",
  KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1",
  PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE: "1",
  KEEPER_V22: "on",
  KEEPER_V22_SWEEP: "on",
  KEEPER_V22_LIQUIDATE: "on",
  KEEPER_V22_SETTLE_PAIRING: "prefer",
  KEEPER_V22_DRY_RUN: "on",
});

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PROOF = process.argv.includes("--proof");
const regPath = args[0] ?? "registry-additions-v22-multiasset.json";
const want = args[1] ?? "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw";
const devnetUrl = process.env.SEED_RPC_URL ?? process.env.DEVNET_RPC_URL;
const mainnetUrl = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
if (!devnetUrl) throw new Error("SEED_RPC_URL / DEVNET_RPC_URL required");

const { bindObservationRegistry, priceUnitsOf, observationAssetsFor, decodeAssetRefreshStates } = await import("../src/cross-cluster/multi-asset.ts");
const { pushAuthMarkBatch } = await import("../src/cross-cluster/auth-mark-pusher.ts");
const { readAllPoolPricesE6 } = await import("../src/cross-cluster/price-reader.ts");
const { crankOneMarket, freshCrankMarketState } = await import("../src/cross-cluster/recovery-cranker.ts");
const { V22Loop } = await import("../src/cross-cluster/v22/loop.ts");
const { v22FlagsFromEnv } = await import("../src/cross-cluster/v22/flags.ts");
const { detectLayout, assetSlotsOff } = await import("../src/cross-cluster/market-layout.ts");
const { buildObservationCrankIx, catchupCrankCount, MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, MAX_TX_CU, ACCRUAL_TX_CU_HEADROOM } = await import("../src/cross-cluster/positioned-refresh.ts");
const { refreshStateForMarket, maxCatchupCranksFor } = await import("../src/cross-cluster/multi-asset.ts");
const { parseAssetOracleProfileV17 } = await import("@percolatorct/sdk");
const { setSweepDelegate } = await import("../src/cross-cluster/v22/delegation.ts");
type MarketEntry = import("../src/cross-cluster/registry.ts").MarketEntry;

const reg = JSON.parse(fs.readFileSync(regPath, "utf8")) as { markets: MarketEntry[] };
const entry = reg.markets.find((m) => m.marketAddress === want);
if (!entry) throw new Error(`market ${want} not in ${regPath}`);
const markets = [entry];
bindObservationRegistry(() => markets);

const devnet = new Connection(devnetUrl, "processed");
const mainnet = new Connection(mainnetUrl, "confirmed");
// A stand-in keeper: the oracle authority's PUBLIC key with a throwaway secret. Signatures it makes are invalid, which
// is irrelevant: nothing is sent, and every simulation below (the keeper's own included) runs with sigVerify off.
const throwaway = Keypair.generate();
const secret = new Uint8Array(64);
secret.set(throwaway.secretKey.subarray(0, 32), 0);
secret.set(new PublicKey(ORACLE_AUTHORITY).toBytes(), 32);
const keeper = new Keypair({ publicKey: new PublicKey(ORACLE_AUTHORITY).toBytes(), secretKey: secret });

/** Every simulation the keeper code runs, in order. Sends are refused (nothing leaves the process). */
const sims: Array<{ phase: string; ixs: number; tags: string; dataLens: number[]; err: unknown; units: number | null; logsTail: string[] }> = [];
let phase = "push";
function describeTx(t: Transaction | VersionedTransaction): { ixs: number; tags: string; dataLens: number[] } {
  const msg = t instanceof VersionedTransaction ? t.message : t.compileMessage();
  const keys = msg.staticAccountKeys;
  const wr = msg.compiledInstructions.filter((ix) => keys[ix.programIdIndex].toBase58() === WRAPPER);
  return { ixs: msg.compiledInstructions.length, tags: wr.map((ix) => ix.data[0]).join(","), dataLens: wr.map((ix) => ix.data.length) };
}
const simConn = new Proxy(devnet, {
  get(target, prop, recv) {
    if (prop === "sendRawTransaction" || prop === "sendTransaction") {
      return async () => {
        throw new Error("SIM-ONLY: send refused by sim-k6-multiasset-cycle (nothing was sent)");
      };
    }
    if (prop === "simulateTransaction") {
      return async (tx: Transaction | VersionedTransaction, ...rest: unknown[]) => {
        const res = await (target.simulateTransaction as (...a: unknown[]) => Promise<{ value: { err: unknown; unitsConsumed?: number; logs?: string[] | null } }>).call(target, tx, ...rest);
        sims.push({ phase, ...describeTx(tx), err: res.value.err, units: res.value.unitsConsumed ?? null, logsTail: (res.value.logs ?? []).slice(-4) });
        return res;
      };
    }
    const v = Reflect.get(target, prop, recv);
    return typeof v === "function" ? v.bind(target) : v;
  },
}) as Connection;

async function marketState(label: string): Promise<{ slot: number; data: Uint8Array }> {
  const r = await devnet.getAccountInfoAndContext(new PublicKey(entry!.marketAddress), "processed");
  if (!r.value) throw new Error("market not found");
  const data = new Uint8Array(r.value.data);
  const det = detectLayout(data);
  if (!det.known) throw new Error("unknown layout");
  console.log(`\n[${label}] slot ${r.context.slot} layout ${det.layout.id} slots ${det.slots}`);
  for (const { assetIndex, state } of decodeAssetRefreshStates(data, observationAssetsFor(entry!.marketAddress))) {
    const prof = parseAssetOracleProfileV17(data, assetSlotsOff(det.layout) + assetIndex * det.layout.slotStride);
    console.log(
      `  asset ${assetIndex}: lifecycle ${state.lifecycle} slot_last ${state.slotLast} (lag ${BigInt(r.context.slot) - state.slotLast}) ` +
        `target ${prof.oracleTargetPriceE6} mark_ewma ${prof.markEwmaE6} last_good_oracle_slot ${prof.lastGoodOracleSlot} stored ${state.storedPosLong}L/${state.storedPosShort}S stale ${state.staleLong}/${state.staleShort}`,
    );
  }
  return { slot: r.context.slot, data };
}

console.log(`[sim] ${entry.label} ${entry.marketAddress}; observation hints [${observationAssetsFor(entry.marketAddress).join(",")}]`);
const pre = await marketState("pre");

// ── 1. push ────────────────────────────────────────────────────────────────────────────────────────────────────────
const units = priceUnitsOf(entry);
const poolUnits = units.filter((u) => u.source === "pool");
const prices = poolUnits.length
  ? await readAllPoolPricesE6(mainnet, poolUnits.map((u) => ({ poolAddress: u.poolAddress, dexType: u.dexType as "meteora-dlmm", label: u.label, symbol: u.symbol })), new Map())
  : new Map<string, bigint>();
const pushes = units.map((u) => ({
  marketAddress: u.marketAddress,
  assetIndex: u.assetIndex,
  multi: u.multi,
  priceE6: u.source === "fixed" ? (u.fixedPriceE6 as bigint) : (prices.get(u.poolAddress) ?? 0n),
  depth: null,
}));
console.log(`\n[push] ${pushes.map((p) => `asset ${p.assetIndex} = ${p.priceE6}`).join(", ")}  (raw spot; the live loop pushes the smoothed median of the same reads)`);
if (pushes.some((p) => p.priceE6 <= 0n)) throw new Error("a pool returned no price");
const bh = await devnet.getLatestBlockhash("processed");
const nowSlot = BigInt(await devnet.getSlot("processed"));
const res = await pushAuthMarkBatch(simConn, keeper, pushes, nowSlot, bh, false);
console.log(`[push] pushAuthMarkBatch: pushedKeys=${JSON.stringify(res.pushedKeys)} skipped=${JSON.stringify(res.skippedMarkets)} inactive=${JSON.stringify(res.inactiveKeys)} (a refused send after a clean preflight is expected here: SIM-ONLY)`);

// ── 2. crank (v2.2 sweep delegate + legacy cranker, simulate only) ─────────────────────────────────────────────────
phase = "crank";
const loop = new V22Loop({ conn: simConn, keeper, programId: new PublicKey(WRAPPER), markets: () => markets, flags: v22FlagsFromEnv(process.env), dryRun: true });
loop.install();
const st = freshCrankMarketState();
const preRefresh = refreshStateForMarket(pre.data, entry.marketAddress);
const gap = BigInt(pre.slot) - preRefresh.slotLast;
console.log(`\n[crank] oldest observed asset gap ${gap} slots, max_accrual_dt ${preRefresh.maxAccrualDtSlots} -> catch-up ${catchupCrankCount(gap, preRefresh.maxAccrualDtSlots)} crank(s) wanted`);
await crankOneMarket(simConn, keeper, entry, st, false);
setSweepDelegate(null);
console.log(`[crank] cranker state: totalReverts=${st.totalReverts} lastError=${st.lastErrorMsg ?? "none"} benignNoProgress=${st.benignNoProgress}`);

// ── 3. proof: [pushes, catch-up xN, accrue(LP), accrue(counterparty)] in ONE simulation ─────────────────────────────
if (PROOF) {
  phase = "proof";
  const { encodePushAuthMark, ACCOUNTS_PUSH_AUTH_MARK, buildAccountMetas, buildIx, parseAssetControlSequencesV17 } = await import("@percolatorct/sdk");
  const det = detectLayout(pre.data);
  if (!det.known) throw new Error("layout");
  const market = new PublicKey(entry.marketAddress);
  const ixs = [ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  for (const p of pushes) {
    const slotOff = assetSlotsOff(det.layout) + p.assetIndex * det.layout.slotStride;
    const eng = slotOff + det.layout.wrapperLen;
    const marketId = new DataView(pre.data.buffer, pre.data.byteOffset).getBigUint64(eng, true);
    ixs.push(buildIx({ programId: new PublicKey(WRAPPER), keys: buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, { oracleAuthority: keeper.publicKey, market }), data: encodePushAuthMark({ assetIndex: p.assetIndex, marketId, nowSlot, markE6: p.priceE6, observationSequence: parseAssetControlSequencesV17(pre.data, slotOff).oracleObservation + 1n }) }));
  }
  const hints = observationAssetsFor(entry.marketAddress).length;
  const n = Math.min(catchupCrankCount(gap, preRefresh.maxAccrualDtSlots), maxCatchupCranksFor(MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, hints, MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM));
  const lp = new PublicKey(entry.lpPortfolio!);
  for (let i = 0; i < n; i++) ixs.push(buildObservationCrankIx(keeper.publicKey, market, lp));
  const target = process.argv.includes("--proof-counterparty") ? new PublicKey(process.argv[process.argv.indexOf("--proof-counterparty") + 1]) : lp;
  ixs.push(buildObservationCrankIx(keeper.publicKey, market, target));
  const msg = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const sim = await devnet.simulateTransaction(tx, { sigVerify: false, commitment: "processed", accounts: { encoding: "base64", addresses: [entry.marketAddress] } });
  const d = sim.value.accounts?.[0] ? new Uint8Array(Buffer.from(sim.value.accounts[0].data[0], "base64")) : null;
  console.log(`\n[proof] [CU, heap, push x${pushes.length}, catch-up x${n}, accrue on ${target.toBase58().slice(0, 8)}…] err=${JSON.stringify(sim.value.err)} CU=${sim.value.unitsConsumed} size=${tx.serialize().length} B`);
  if (sim.value.err) console.log((sim.value.logs ?? []).slice(-8).join("\n"));
  if (d) {
    const slot = BigInt(await devnet.getSlot("processed"));
    for (const { assetIndex, state } of decodeAssetRefreshStates(d, observationAssetsFor(entry.marketAddress))) {
      const prof = parseAssetOracleProfileV17(d, assetSlotsOff(det.layout) + assetIndex * det.layout.slotStride);
      console.log(`  post asset ${assetIndex}: slot_last ${state.slotLast} (current_slot ${state.currentSlot}, chain ~${slot}) target ${prof.oracleTargetPriceE6} stale ${state.staleLong}/${state.staleShort}`);
    }
  }
}

console.log("\n[sim] every simulation the keeper code ran (nothing was sent):");
for (const s of sims) console.log(`  ${s.phase.padEnd(5)} ixs=${s.ixs} wrapper tags=[${s.tags}] data bytes=[${s.dataLens.join(",")}] err=${JSON.stringify(s.err)} CU=${s.units}`);
for (const s of sims.filter((x) => x.err)) console.log(`  -- ${s.phase} err logs: ${s.logsTail.join(" | ")}`);
process.exit(0);
