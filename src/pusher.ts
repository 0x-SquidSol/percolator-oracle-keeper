#!/usr/bin/env tsx
/**
 * pusher.ts — the SECOND, INDEPENDENT price pusher (F2, LP audit 4.6). Separate entrypoint of the same image:
 * `KEEPER_ROLE=pusher` in deploy/railway-start.sh runs this instead of cross-cluster.ts.
 *
 * It is the keeper's push loop and nothing else (no cranks, liquidations, Earn / fee / stake / P2b / v2.2 jobs, no Supabase,
 * no register-poll), reading the v2.2 registry FILE, with its OWN devnet RPC, and it pushes a market only while the on-chain
 * price is older than PUSHER_TAKEOVER_SLOTS (see cross-cluster/pusher-role.ts). While the primary is healthy this process
 * reads prices (to keep its smoother warm) and sends nothing.
 *
 * Environment (the keeper's own variables keep their meaning):
 *   MAINNET_RPC_URL, DEVNET_RPC_URL     required. DEVNET_RPC_URL must be a DIFFERENT endpoint from the primary's.
 *   PUSHER_PRIMARY_DEVNET_RPC_URL       the primary keeper's devnet endpoint; boot refuses if it equals DEVNET_RPC_URL
 *   KEEPER_KEYPAIR / KEEPER_KEYPAIR_PATH  the oracle authority key (same key as the primary: a market has ONE oracle authority)
 *   REGISTRY_PATH                       required: the v2.2 registry file (hot-reloaded)
 *   WRAPPER_PROGRAM_ID (+ the usual program-id overrides)
 *   PUSHER_TAKEOVER_SLOTS (60) / PUSHER_REFRESH_MS (2000) / PUSHER_STALE_STATE_MS (30000) / PUSHER_ALERT_HOLD_MS (120000)
 *   CC_INTERVAL_MS, CC_MARK_WINDOW_MS, CC_HEALTH_PORT, CC_HEALTH_BIND, DRY_RUN, KEEPER_PUSH_DEPTH ...  as for the keeper
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import { loadRegistryForProgramSet } from "./cross-cluster/registry.ts";
import { PROGRAM_IDS_RESOLVED, describeProgramIds } from "./program-ids.ts";
import { parsePositiveLamportsFromSolEnv, parsePositiveNumberEnv } from "./env-utils.ts";
import { isExplicitTrue, validateRpcEndpoint } from "./rpc-url.ts";
import { devnetConnectionConfig } from "./rpc-headers.ts";
import { countingFetch } from "./cross-cluster/rpc-metrics.ts";
import { failoverFromEnv, parseFallbackUrls } from "./rpc-failover.ts";
import { markCadenceCheck } from "./cross-cluster/mark-smoother.ts";
import { setHealthExtension, startKeeperLoop } from "./cross-cluster/keeper-loop.ts";
import { startRegistryReloadLoop } from "./cross-cluster/registry-reload.ts";
import { getAlertSink } from "./cross-cluster/alerting.ts";
import { TakeoverGate, pusherConfigFromEnv, refreshTakeoverGate, rpcEndpointProblem } from "./cross-cluster/pusher-role.ts";

process.on("unhandledRejection", (r) => console.error(`[pusher][unhandledRejection] ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`));
process.on("uncaughtException", (e) => console.error(`[pusher][uncaughtException] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));

function fatal(msg: string): never {
  console.error(`[fatal] ${msg}`);
  process.exit(1);
}

const MAINNET_RPC = process.env.MAINNET_RPC_URL;
const DEVNET_RPC = process.env.DEVNET_RPC_URL;
if (!MAINNET_RPC) fatal("MAINNET_RPC_URL is required");
if (!DEVNET_RPC) fatal("DEVNET_RPC_URL is required");
for (const [name, value] of [["MAINNET_RPC_URL", MAINNET_RPC], ["DEVNET_RPC_URL", DEVNET_RPC]] as const) {
  const problem = validateRpcEndpoint(name, value, { required: true, allowInsecureLocalRpc: isExplicitTrue(process.env.ALLOW_INSECURE_LOCAL_RPC) });
  if (problem) fatal(problem);
}
const endpointProblem = rpcEndpointProblem(DEVNET_RPC, process.env.PUSHER_PRIMARY_DEVNET_RPC_URL);
if (endpointProblem) fatal(endpointProblem);
if (!process.env.PUSHER_PRIMARY_DEVNET_RPC_URL) {
  console.warn("[pusher][warn] PUSHER_PRIMARY_DEVNET_RPC_URL is unset: cannot verify this pusher's RPC endpoint differs from the primary's");
}
if (!process.env.REGISTRY_PATH) fatal("REGISTRY_PATH is required (the pusher reads the v2.2 registry file; it has no Supabase / register-poll)");

let CFG;
try {
  CFG = pusherConfigFromEnv(process.env);
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err));
}

const DRY_RUN = process.env.DRY_RUN === "true" || process.env.KEEPER_DRY_RUN === "1" || process.env.KEEPER_DRY_RUN === "true" || process.argv.includes("--dry-run");
const CC_INTERVAL_MS = parseInt(process.env.CC_INTERVAL_MS ?? "3000", 10);
{
  const c = markCadenceCheck(CC_INTERVAL_MS, Number(process.env.CC_MARK_WINDOW_MS ?? 15_000));
  if (c.verdict === "never" && !DRY_RUN) fatal(`this cadence can never publish a mark. ${c.detail}`);
}

function loadKeypair(): Keypair {
  if (process.env.KEEPER_KEYPAIR) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEEPER_KEYPAIR) as number[]));
  const p = process.env.KEEPER_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/percolator-v17-devnet.json`;
  if (!fs.existsSync(p)) fatal(`keeper keypair not found at ${p}. Set KEEPER_KEYPAIR_PATH or KEEPER_KEYPAIR.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

const keeper = loadKeypair();
const REGISTRY_PATH = process.env.REGISTRY_PATH;
const registry = loadRegistryForProgramSet(REGISTRY_PATH, PROGRAM_IDS_RESOLVED.programSet);
const mainnetFailover = failoverFromEnv("mainnet", MAINNET_RPC, parseFallbackUrls(process.env.MAINNET_RPC_FALLBACK_URLS, []), process.env, countingFetch("mainnet"));
const devnetFailover = failoverFromEnv("devnet", DEVNET_RPC, parseFallbackUrls(process.env.DEVNET_RPC_FALLBACK_URLS ?? process.env.RPC_FALLBACK_URLS), process.env, countingFetch("devnet"));
const mainnetConn = new Connection(MAINNET_RPC, { commitment: "confirmed", fetch: mainnetFailover?.fetch ?? countingFetch("mainnet") });
const devnetConn = new Connection(DEVNET_RPC, { ...devnetConnectionConfig(process.env), fetch: devnetFailover?.fetch ?? countingFetch("devnet") });
if (DRY_RUN) {
  for (const conn of [devnetConn, mainnetConn]) {
    const refuse = (): never => {
      throw new Error("DRY-RUN: transaction send blocked at the connection");
    };
    conn.sendRawTransaction = refuse;
    conn.sendTransaction = refuse;
    conn.sendEncodedTransaction = refuse;
  }
}

console.log("[pusher] Boot (second independent pusher: pushes only, backs off while the primary is healthy)");
console.log(`  keeper:    ${keeper.publicKey.toBase58()}`);
console.log(`  registry:  ${REGISTRY_PATH} (${registry.markets.length} markets)`);
console.log(`  mode:      ${DRY_RUN ? "DRY-RUN" : "LIVE"}; takeover after ${CFG.takeoverSlots} slots without a push; state refresh ${CFG.refreshMs}ms`);
for (const line of describeProgramIds()) console.log(`  program:   ${line}`);

const gate = new TakeoverGate(CFG);

const refresh = async (): Promise<void> => {
  const addrs = registry.markets.map((m) => m.marketAddress);
  for (const m of registry.markets) gate.setLabel(m.marketAddress, m.label);
  await refreshTakeoverGate(devnetConn, gate, addrs);
  try {
    await getAlertSink().reconcile("pusher", gate.activeAlerts());
  } catch (err) {
    console.error(`[pusher] alert report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
await refresh();
setInterval(() => void refresh(), CFG.refreshMs).unref?.();

setHealthExtension(() => ({
  role: "pusher",
  pusher: {
    takeoverSlots: CFG.takeoverSlots.toString(),
    primaryRpcDiffers: process.env.PUSHER_PRIMARY_DEVNET_RPC_URL ? true : null,
    markets: gate.health(registry.markets.map((m) => m.marketAddress)),
  },
}));

void startRegistryReloadLoop(registry, {
  registryPath: REGISTRY_PATH,
  intervalMs: parseInt(process.env.REGISTRY_RELOAD_INTERVAL_MS ?? "15000", 10),
}).catch((err) => console.error(`[registry-reload] loop crashed: ${err instanceof Error ? err.message : String(err)}`));

await startKeeperLoop(mainnetConn, devnetConn, keeper, registry, {
  standby: (m) => gate.isStandby(m),
  onPushLanded: (m, _px, label) => {
    gate.recordPush(m);
    console.warn(`[pusher][TAKEOVER] pushed ${label}: the on-chain price was older than ${CFG.takeoverSlots} slots (primary silent)`);
  },
  intervalMs: CC_INTERVAL_MS,
  healthPort: parseInt(process.env.CC_HEALTH_PORT ?? "3002", 10),
  healthBind: process.env.CC_HEALTH_BIND ?? "0.0.0.0",
  dryRun: DRY_RUN,
  cycleTimeoutMs: parseInt(process.env.CC_CYCLE_TIMEOUT_MS ?? "10000", 10),
  minKeeperBalanceLamports: parsePositiveLamportsFromSolEnv("MIN_KEEPER_BALANCE_SOL", 0.05),
  balanceCheckIntervalMs: parsePositiveNumberEnv("BALANCE_CHECK_INTERVAL_MS", 30_000),
});
