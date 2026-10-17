// read-only: fetch v2.2 market slabs + stake pools from public devnet RPC with backoff
import { Connection, PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const reg = JSON.parse(readFileSync(process.env.HOME + "/wt-v22-fresh/keeper/registry.v22fresh.json", "utf8"));
const STAKE = new PublicKey("7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(pk) {
  for (let i = 0, d = 1500; i < 8; i++, d *= 2) {
    try { return await conn.getAccountInfo(pk); } catch (e) { console.error("retry", pk.toBase58().slice(0, 6), String(e).slice(0, 60)); await sleep(d); }
  }
  throw new Error("gave up");
}
const meta = [];
for (const m of reg.markets) {
  const mk = new PublicKey(m.marketAddress);
  const [pool] = deriveStakePool(mk, STAKE);
  const mi = await get(mk); await sleep(400);
  const pi = await get(pool); await sleep(400);
  const rec = { symbol: m.symbol, market: m.marketAddress, assetIndex: m.assetIndex, assets: m.assets ?? null, pool: pool.toBase58(),
    marketOwner: mi?.owner.toBase58() ?? null, marketLen: mi?.data.length ?? 0, poolOwner: pi?.owner.toBase58() ?? null, poolLen: pi?.data.length ?? 0 };
  if (mi) writeFileSync(`${out}/${m.marketAddress}.market.b64`, mi.data.toString("base64"));
  if (pi) writeFileSync(`${out}/${pool.toBase58()}.pool.b64`, pi.data.toString("base64"));
  meta.push(rec); console.log(JSON.stringify(rec));
}
writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 1));
