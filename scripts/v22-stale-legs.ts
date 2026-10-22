/**
 * Read-only: for each given v2.2 market, print the asset's KF epochs / stale counters and every portfolio's legs with
 * their kf_epoch_snap, so a stuck stale counter can be matched to the legs that hold it.
 *   tsx scripts/v22-stale-legs.ts <market> [market...]     (needs DEVNET_RPC_URL, WRAPPER_PROGRAM_ID)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { decodeMarketRefreshState } from "../src/cross-cluster/positioned-refresh.ts";
import { detectLayout } from "../src/cross-cluster/market-layout.ts";
import { fetchMarketPortfolios } from "../src/cross-cluster/recovery-cranker.ts";

const conn = new Connection(process.env.DEVNET_RPC_URL!, "processed");
for (const addr of process.argv.slice(2)) {
  const pk = new PublicKey(addr);
  const ai = await conn.getAccountInfoAndContext(pk, "processed");
  const data = ai.value!.data;
  const det = detectLayout(data);
  if (!det.known) { console.log(addr, "unknown layout"); continue; }
  console.log(`${addr} slot=${ai.context.slot} layout=${det.layout.id} slots=${det.slots}`);
  for (let i = 0; i < det.slots; i++) {
    try {
      const s = decodeMarketRefreshState(data, i);
      if (det.slots > 8 && s.storedPosLong + s.storedPosShort + s.staleLong + s.staleShort === 0n && !s.contributesToLossStale) continue;
      console.log(`  asset ${i}: life=${s.lifecycle} kfEpoch L=${s.kfEpochLong} S=${s.kfEpochShort} stored ${s.storedPosLong}L/${s.storedPosShort}S stale ${s.staleLong}L/${s.staleShort}S slotLast=${s.slotLast} cur=${s.currentSlot} lossStaleFlag=${s.lossStaleActive}`);
    } catch (e) { console.log(`  asset ${i}: ${(e as Error).message}`); }
  }
  const pfs = await fetchMarketPortfolios(conn, pk, det.layout.portfolioAccountLen);
  for (const a of pfs) {
    let p;
    try { p = parsePortfolioV17(a.account.data); } catch (e) { console.log(`  pf ${a.pubkey.toBase58()} undecodable`); continue; }
    const legs = p.legs.filter((l: { active: boolean }) => l.active);
    if (legs.length === 0) continue;
    console.log(`  pf ${a.pubkey.toBase58()} owner=${p.owner.toBase58().slice(0, 8)} matcher=${p.matcherEnabled}`);
    for (const l of legs) console.log(`     asset=${l.assetIndex} side=${l.side === 0 ? "L" : "S"} basis=${l.basisPosQ} kfSnap=${l.kfEpochSnap} lossW=${l.lossWeight}`);
  }
}
