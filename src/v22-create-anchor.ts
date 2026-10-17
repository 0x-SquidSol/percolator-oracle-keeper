#!/usr/bin/env tsx
/**
 * v22-create-anchor.ts: OPERATOR TOOL, never started by the keeper. Creates the keeper's own flat anchor portfolio on one
 * v2.2 market (see cross-cluster/v22/create-anchor.ts). Refuses to do anything unless explicitly enabled:
 *
 *   KEEPER_V22_CREATE_ANCHOR=on KEEPER_V22_CREATE_ANCHOR_DRY_RUN=on|off  \
 *   DEVNET_RPC_URL=... KEEPER_KEYPAIR_PATH=... npx tsx src/v22-create-anchor.ts <market>
 *
 * Dry-run is the DEFAULT (simulate and print). A real send needs KEEPER_V22_CREATE_ANCHOR_DRY_RUN=off.
 */
import fs from "fs";
import { failoverFromEnv, parseFallbackUrls } from "./rpc-failover.ts";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { parseFlag } from "./cross-cluster/v22/flags.ts";
import { createKeeperAnchor } from "./cross-cluster/v22/create-anchor.ts";
import { WRAPPER_PROGRAM_ID } from "./program-ids.ts";

const enabled = parseFlag(process.env, "KEEPER_V22_CREATE_ANCHOR", false);
if (!enabled) {
  console.error("v22-create-anchor: KEEPER_V22_CREATE_ANCHOR is not on; nothing done (this tool never runs by itself).");
  process.exit(1);
}
const dryRun = parseFlag(process.env, "KEEPER_V22_CREATE_ANCHOR_DRY_RUN", true);
const marketArg = process.argv[2];
const rpc = process.env.DEVNET_RPC_URL;
if (!marketArg || !rpc) {
  console.error("usage: KEEPER_V22_CREATE_ANCHOR=on DEVNET_RPC_URL=... KEEPER_KEYPAIR_PATH=... tsx src/v22-create-anchor.ts <market>");
  process.exit(1);
}
const secret = process.env.KEEPER_KEYPAIR ? JSON.parse(process.env.KEEPER_KEYPAIR) : JSON.parse(fs.readFileSync(process.env.KEEPER_KEYPAIR_PATH ?? "", "utf8"));
const keeper = Keypair.fromSecretKey(Uint8Array.from(secret));
const failover = failoverFromEnv("devnet", rpc, parseFallbackUrls(process.env.DEVNET_RPC_FALLBACK_URLS ?? process.env.RPC_FALLBACK_URLS), process.env, (i, init) => fetch(i, init));
const conn = new Connection(rpc, { commitment: "confirmed", ...(failover ? { fetch: failover.fetch } : {}) });
const r = await createKeeperAnchor({ conn, keeper, dryRun }, conn, { market: new PublicKey(marketArg), programId: WRAPPER_PROGRAM_ID, dryRun });
if (r.outcome.kind === "failed") {
  console.error(`[v22-create-anchor] ${r.outcome.error}`);
  process.exit(1);
}
console.log(`[v22-create-anchor] ${dryRun ? "DRY-RUN " : ""}anchor ${r.anchor.toBase58()} rent ${r.lamports} lamports: ${r.outcome.kind}`);
