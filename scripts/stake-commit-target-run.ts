/**
 * One-pool runner for the KEEPER_V22_STAKE_COMMIT_TARGET job (stake tag 33), for verification on a market you own.
 *   usage: tsx scripts/stake-commit-target-run.ts <market> <keypair.json> [--once] [--dry]
 * Loops (60 s) until the pool's proposed deploy target has been committed. Not the production loop: the production path is
 * the V22Loop tick with KEEPER_V22=on KEEPER_V22_STAKE_COMMIT_TARGET=on (default OFF).
 * env: STAKE_PROGRAM_ID, WRAPPER_PROGRAM_ID (+ KEEPER_ALLOW_PROGRAM_ID_OVERRIDE=1 PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE=1 for the fresh v2.2 ids).
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { WRAPPER_PROGRAM_ID } from "../src/program-ids.ts";
import { loadV22Market } from "../src/cross-cluster/v22/market.ts";
import { freshStakeCommitTargetState, stakeCommitTargetOnce, commitDueSlot } from "../src/cross-cluster/v22/stake-commit-target.ts";
import { STAKE_PROGRAM_ID } from "../src/program-ids.ts";
import { decodeStakePoolV5, deriveStakePool } from "@percolatorct/sdk";

const [marketArg, keyFile, ...flags] = process.argv.slice(2);
if (!marketArg || !keyFile) throw new Error("usage: stake-commit-target-run.ts <market> <keypair.json> [--once] [--dry]");
const once = flags.includes("--once"), dry = flags.includes("--dry");
// the public devnet RPC rate-limits hard: back off on 429 instead of failing the loop
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retryingFetch(url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  for (let i = 0; i < 12; i++) { const r = await fetch(url, init); if (r.status !== 429) return r; await sleep(Math.min(20_000, 800 * 2 ** i) + Math.random() * 500); }
  return fetch(url, init);
}
const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", { commitment: "confirmed", fetch: retryingFetch as never, disableRetryOnRateLimit: true });
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
const st = freshStakeCommitTargetState();
const log = (l: string) => console.log(`${new Date().toISOString()} ${l}`);
for (;;) {
  try {
  const load = await loadV22Market(conn, { marketAddress: marketArg, label: marketArg.slice(0, 8) }, WRAPPER_PROGRAM_ID);
  if (!load.ok) { log(`market load failed: ${load.reason} ${load.detail ?? ""}`); }
  else {
    const [pool] = deriveStakePool(new PublicKey(marketArg), STAKE_PROGRAM_ID);
    const info = await conn.getAccountInfo(pool, "processed");
    const d = info ? decodeStakePoolV5(new Uint8Array(info.data)) : null;
    if (d) log(`pool ${pool.toBase58().slice(0, 8)} deploy ${d.deployTargetBps} bps, pending ${d.pendingTargetBps} @ ${d.pendingTargetSlot}, due ${d.pendingTargetSlot ? commitDueSlot(d) : "-"}, now ${load.ctx.readSlot}`);
    const r = await stakeCommitTargetOnce({ conn, keeper, dryRun: dry, log }, load.ctx, info ? new Uint8Array(info.data) : null, st);
    log(`job result: ${r.kind}${"outcome" in r && r.outcome.kind === "sent" ? ` sig ${r.outcome.signature} landed=${r.outcome.landed}` : ""}`);
    if (r.kind === "sent" || r.kind === "dry-run" || (r.kind === "skipped" && /no pending/.test(r.reason))) break;
  }
  } catch (e) { log(`tick error (will retry): ${(e as Error).message.slice(0, 160)}`); if (once) throw e; }
  if (once) break;
  await new Promise((res) => setTimeout(res, 60_000));
}
