#!/usr/bin/env tsx
/**
 * pre-resolve-drain.ts — run BEFORE any ResolveMarket (fee-flow audit F4).
 *
 *   npm run pre-resolve -- --market <slab> [--dry-run]
 *
 * Cranks the market's LP fee leg (tag 78) and staker fee leg (tag 87 ->
 * stake AccrueFees), re-reads the slab, and prints what is still owed.
 * Exit codes (Live market — before ResolveMarket):
 *   0  safe to resolve: no Live-only leg outstanding (protocol/creator
 *      warnings may still print — claim those before CloseSlab)
 *   2  NOT safe: a Live-only leg is still owed and would be lost at resolve,
 *      or a stake-bound insurance budget would be stranded (no stake tag 29)
 *   1  error (bad args, RPC failure)
 *
 * On a market that is already Resolved (or a CloseSlab tombstone) it runs the
 * post-resolve wind-down instead (stake F-9): tag 29 with the insurance budget,
 * then tag 29 with amount 0 (book third-party tag-41 pushes, sweep a stray).
 *   0  wind-down complete (no stake-bound budget left unbooked)
 *   2  budget still unbooked (cooldown, pre-F-9 stake, or a failure) — rerun later
 *
 * Env: DEVNET_RPC_URL (required), DEVNET_RPC_ORIGIN (optional Origin header),
 * KEEPER_KEYPAIR_PATH / KEEPER_KEYPAIR (any funded signer — both cranks are
 * permissionless), WRAPPER_PROGRAM_ID / STAKE_PROGRAM_ID (see program-ids.ts).
 */
import { failoverFromEnv, parseFallbackUrls } from "./rpc-failover.ts";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import { drainFeeLegsBeforeResolve, windDownAfterResolve } from "./cross-cluster/pre-resolve.ts";
import { decodeTerminalState, terminalInsuranceConfigFromEnv } from "./cross-cluster/terminal-insurance.ts";
import { PublicKey } from "@solana/web3.js";
import { stakeFeeConfigFromEnv } from "./cross-cluster/stake-fee-pusher.ts";
import { describeProgramIds } from "./program-ids.ts";
import { devnetConnectionConfig } from "./rpc-headers.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadKeypair(): Keypair {
  if (process.env.KEEPER_KEYPAIR) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEEPER_KEYPAIR) as number[]));
  }
  const p = process.env.KEEPER_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

async function main(): Promise<number> {
  const market = arg("--market");
  const dryRun = process.argv.includes("--dry-run");
  const rpc = process.env.DEVNET_RPC_URL;
  if (!market || !rpc) {
    console.error("usage: DEVNET_RPC_URL=… npm run pre-resolve -- --market <slab> [--dry-run]");
    return 1;
  }
  const failover = failoverFromEnv("devnet", rpc, parseFallbackUrls(process.env.DEVNET_RPC_FALLBACK_URLS ?? process.env.RPC_FALLBACK_URLS), process.env, (i, init) => fetch(i, init));
  const conn = new Connection(rpc, { ...devnetConnectionConfig(process.env), ...(failover ? { fetch: failover.fetch } : {}) });
  const keeper = loadKeypair();
  console.log(`[pre-resolve] ${describeProgramIds().join("  ")}`);
  console.log(`[pre-resolve] market=${market} signer=${keeper.publicKey.toBase58()} mode=${dryRun ? "DRY-RUN" : "LIVE"}`);
  const tcfg = terminalInsuranceConfigFromEnv(process.env);
  const info = await conn.getAccountInfo(new PublicKey(market), "confirmed");
  const ts = info ? decodeTerminalState(new Uint8Array(info.data)) : null;
  if (ts && ts.kind !== "live") {
    const w = await windDownAfterResolve(conn, keeper, market, dryRun, tcfg);
    console.log(`[wind-down] market is ${w.state}; stake-bound=${w.stakeBound} budget=${w.budget ?? "?"} tag29=${w.support ?? "n/a"}`);
    for (const s of w.steps) console.log(`[wind-down] tag 29(amount=${s.amount}): ${s.outcome} — ${s.detail}`);
    console.log(`[wind-down] outcome ${w.outcome}`);
    console.log(`[wind-down] ${w.complete ? "COMPLETE" : "NOT complete — rerun later"}`);
    return w.complete ? 0 : 2;
  }
  const r = await drainFeeLegsBeforeResolve(conn, keeper, market, dryRun, stakeFeeConfigFromEnv(process.env), undefined, undefined, tcfg);
  const fmt = (l: typeof r.before) =>
    `protocol=${l.protocolOwed} lp=${l.lpOwed} stake=${l.stakeOwed} creator=${l.creatorClaimable ?? "?"}`;
  console.log(`[pre-resolve] before: ${fmt(r.before)}`);
  console.log(`[pre-resolve] tag 78: ${typeof r.lp === "string" ? r.lp : `error ${r.lp.error}`}`);
  console.log(`[pre-resolve] tag 87+12: ${JSON.stringify(r.stake)}`);
  console.log(`[pre-resolve] after:  ${fmt(r.after)}`);
  for (const w of r.warnings) console.warn(`[pre-resolve][warn] ${w}`);
  for (const b of r.blockers) console.error(`[pre-resolve][BLOCKER] ${b}`);
  console.log(`[pre-resolve] ${r.safeToResolve ? "SAFE to resolve" : "NOT safe to resolve"}`);
  return r.safeToResolve ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[pre-resolve][fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
