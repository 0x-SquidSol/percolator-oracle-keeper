#!/usr/bin/env tsx
/**
 * cross-cluster.ts — Cross-cluster price keeper entrypoint
 *
 * Reads spot prices from mainnet DEX pools (Raydium CLMM, Meteora DLMM,
 * PumpSwap) and pushes them as PushAuthMark instructions to the
 * corresponding devnet Percolator markets.
 *
 * The keeper is the per-asset oracle_authority.  Markets delegate to it
 * at creation via the bundled InitMarket + ConfigureAuthMark +
 * UpdateAssetAuthority flow (one user action, keeper co-signs).
 *
 * Environment variables:
 *
 *   MAINNET_RPC_URL       mainnet Helius RPC  (required)
 *   DEVNET_RPC_URL        devnet Helius RPC   (required)
 *   KEEPER_KEYPAIR_PATH   path to keeper JSON keypair
 *                           (default: ~/.config/solana/percolator-v17-devnet.json)
 *   KEEPER_KEYPAIR        inline JSON u8 array (Railway alternative to path)
 *   REGISTRY_PATH         path to registry.json (default: ./registry.json)
 *   CC_INTERVAL_MS        push cycle interval ms  (default: 7000)
 *   CC_HEALTH_PORT        health server port      (default: 3001)
 *   CC_HEALTH_BIND        health server bind addr (default: 0.0.0.0)
 *   CC_CYCLE_TIMEOUT_MS   D2a per-cycle hang-detection timeout (default: 10000)
 *   DRY_RUN               "true" for dry-run (no on-chain writes, default: false)
 *   CRANK_ENABLED          "false" disables the recovery crank loop + crank-on-boot (default: true)
 *   CRANK_INTERVAL_MS       recovery crank cycle interval ms (default: 20000)
 *   CRANK_LIVENESS_INTERVALS      exit 1 if the crank loop is silent for more than this many intervals (default 2; 0 disables)
 *   CRANK_LIVENESS_MIN_SILENCE_MS floor on that limit in ms (default 120000)
 *   ALERT_LOSS_STALE_PROLONGED_MS loud critical alert once a market is loss-stale this long (default 300000 = 5 min)
 *   LP_FEE_CRANK_ENABLED    "false" disables the tag 78 LP-fee crank job (default: true)
 *   STAKE_FEE_PUSH_ENABLED  "false" disables the tag 87 -> stake AccrueFees job (default: true)
 *   LP_FEE_CRANK_INTERVAL_MS  fee-job loop interval ms (default: 200000)
 *   STAKE_FEE_MIN_REAL_SHARES real (non-dead) stake shares required above the 1,000 floor (default: 0)
 *   STAKE_FEE_MIN_PUSH_ATOMS  smallest staker leg worth a transaction (default: 1)
 *   TERMINAL_INSURANCE_ENABLED "false" disables the post-resolve stake tag-29 wind-down job (default: true)
 *   ALERT_TERMINAL_BUDGET_CYCLES cycles a resolved stake-bound market may hold a budget before alerting (default: 3)
 *   WRAPPER_PROGRAM_ID / STAKE_PROGRAM_ID / MATCHER_PROGRAM_ID  program ids (default: SDK
 *                           constants; PROGRAM_ID is a legacy alias for the wrapper) — see program-ids.ts
 *   DEVNET_RPC_ORIGIN       Origin header for an Origin-restricted devnet RPC key (optional)
 *   KEEPER_ALERT_WEBHOOK_URL  https webhook for [ALERT] lines (optional; Slack/Discord-compatible `text`)
 *   KEEPER_ALERT_TELEGRAM_BOT_TOKEN / KEEPER_ALERT_TELEGRAM_CHAT_ID  Telegram delivery for [ALERT] lines (optional; both or neither)
 *   ALERT_SLOT_LAG_WARN / ALERT_SLOT_LAG_CRITICAL / ALERT_CRANK_REVERTS / ALERT_ZERO_PUSH_CYCLES /
 *   ALERT_LAPSED_BUCKET_CYCLES / ALERT_BANKRUPT_CYCLES / ALERT_COOLDOWN_MS  alert thresholds (alerting.ts)
 *   ALERT_MARKET_NO_PUSH_CYCLES (default 40) / ALERT_MARK_LAG_MS (120000) / ALERT_MARK_LAG_PCT (10) /
 *   ALERT_SOURCE_FROZEN_MS (7200000)  K-1/K-3 per-market push alerts + /health status (alerting.ts)
 *   CROSS_CLUSTER_SUSTAINED_RELOCATION_MS  K-3: longest the breaker may hold the mark away from a
 *                           consistently-diverged source before publishing it (default 300000; 0 = off)
 *   REGISTER_SOURCE_URL     GET endpoint polled for wizard-registered markets (unset = disabled)
 *   REGISTER_POLL_INTERVAL_MS  register-poll interval ms (default: 30000)
 *   REGISTRY_RELOAD_INTERVAL_MS  G6 registry.json hot-reload interval ms (default: 15000)
 *
 * CLI flags:
 *   --dry-run             same as DRY_RUN=true
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadRegistry } from "./cross-cluster/registry.ts";
import { parsePositiveLamportsFromSolEnv, parsePositiveNumberEnv } from "./env-utils.ts";
import { isExplicitTrue, validateRpcEndpoint } from "./rpc-url.ts";
import { startKeeperLoop } from "./cross-cluster/keeper-loop.ts";
import { MIN_POOL_LIQUIDITY_USD_E6 } from "./cross-cluster/price-reader.ts";
import { markCadenceCheck } from "./cross-cluster/mark-smoother.ts";
import { crankAllOnce, startRecoveryCrankLoop } from "./cross-cluster/recovery-cranker.ts";
import { makeLpFeeJob } from "./cross-cluster/lp-fee-cranker.ts";
import { makeStakeFeeJob, stakeFeeConfigFromEnv } from "./cross-cluster/stake-fee-pusher.ts";
import { makeTerminalInsuranceJob, terminalInsuranceConfigFromEnv } from "./cross-cluster/terminal-insurance.ts";
import type { TerminalInsuranceConfig } from "./cross-cluster/terminal-insurance.ts";
import type { StakeFeeConfig } from "./cross-cluster/stake-fee-pusher.ts";
import { startFeeJobLoop } from "./cross-cluster/fee-jobs.ts";
import { juniorWatchConfigFromEnv, makeJuniorWatchJob } from "./cross-cluster/vault-lp-junior-watch.ts";
import { bankruptCloseWatchConfigFromEnv, makeBankruptCloseWatchJob } from "./cross-cluster/bankrupt-close-watch.ts";
import { VaultLpCranker } from "./cross-cluster/vault-lp-crank.ts";
import { getExhaustedRegistry, makeExhaustedResolveJob } from "./cross-cluster/p3-exhausted-resolve.ts";
import type { BankruptCloseWatchConfig } from "./cross-cluster/bankrupt-close-watch.ts";
import type { JuniorWatchConfig } from "./cross-cluster/vault-lp-junior-watch.ts";
import { WRAPPER_PROGRAM_ID as CFG_WRAPPER_PROGRAM_ID } from "./program-ids.ts";
import type { FeeJob } from "./cross-cluster/fee-jobs.ts";
import { getAlertSink } from "./cross-cluster/alerting.ts";
import type { AlertSink } from "./cross-cluster/alerting.ts";
import { describeProgramIds } from "./program-ids.ts";
import { devnetConnectionConfig } from "./rpc-headers.ts";
import type { ConnectionConfig } from "@solana/web3.js";
import { startRegisterPollLoop, pollOnce } from "./cross-cluster/register-poll.ts";
import { startRegistrationStream, type RegistrationStream } from "./cross-cluster/registration-stream.ts";
import { startRegistryReloadLoop } from "./cross-cluster/registry-reload.ts";
import { WRAPPER_PROGRAM_ID } from "./cross-cluster/auth-mark-pusher.ts";
import { countingFetch } from "./cross-cluster/rpc-metrics.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Resilience guard (2026-07-06) ─────────────────────────────────────────────
// A keeper is a long-running service; a transient RPC fault (e.g. a 429 rate
// limit) must NEVER exit the process. The outage that bricked 4 markets began
// with an un-retried 429 bubbling to an unhandledRejection that killed the
// process — taking the recovery cranker down with it and letting engine accrual
// drift past the point of recovery. Log loudly and stay up; individual RPC calls
// are retried with backoff, and this is the last line of defense so a fault in
// any loop can't take the whole keeper down.
process.on("unhandledRejection", (reason) => {
  console.error(
    `[keeper][unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
process.on("uncaughtException", (err) => {
  console.error(`[keeper][uncaughtException] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});

// ── RPC endpoints ─────────────────────────────────────────────────────────────
const MAINNET_RPC = process.env.MAINNET_RPC_URL;
const DEVNET_RPC = process.env.DEVNET_RPC_URL;

if (!MAINNET_RPC) {
  console.error("[fatal] MAINNET_RPC_URL is required (e.g. https://mainnet.helius-rpc.com/?api-key=...)");
  process.exit(1);
}
if (!DEVNET_RPC) {
  console.error("[fatal] DEVNET_RPC_URL is required (e.g. https://devnet.helius-rpc.com/?api-key=...)");
  process.exit(1);
}

// The two RPC endpoints carry the Helius API key in the query string and are the
// ONLY RPC endpoints the running keeper uses (launchd -> start-keeper.sh -> this
// file). A plaintext http:// endpoint would put that key on the wire in clear, so
// the same scheme check #89 added for the legacy entry point is applied here, where
// it actually protects something. http:// stays available for localhost when
// ALLOW_INSECURE_LOCAL_RPC=true, matching rpc-url.ts's contract exactly.
//
// #65: SUPABASE_URL is validated by the SAME rule, deliberately. The reported
// defect was `/^https?:$/` in the legacy entry point, but the live path had no
// scheme check at ALL — worse than filed. It matters more than the anon key it
// carries: this feed supplies `dex_pool_address`, which becomes the AuthMark every
// trade in that market settles against (#100). A MITM on a plaintext Supabase URL
// therefore picks the settlement price. It is `required: false` because Supabase
// registration is optional (see the `SUPABASE_URL && SUPABASE_ANON_KEY` guard
// below); when it IS set, it must be secure.
{
  const allowInsecureLocalRpc = isExplicitTrue(process.env.ALLOW_INSECURE_LOCAL_RPC);
  for (const [name, value, required] of [
    ["MAINNET_RPC_URL", MAINNET_RPC, true],
    ["DEVNET_RPC_URL", DEVNET_RPC, true],
    ["SUPABASE_URL", process.env.SUPABASE_URL, false],
  ] as const) {
    const problem = validateRpcEndpoint(name, value, {
      required,
      allowInsecureLocalRpc,
    });
    if (problem) {
      console.error(`[fatal] ${problem}`);
      process.exit(1);
    }
  }
}

// #71: parsed HERE, in the fail-fast section, deliberately. The guard existed only
// in the dead index.ts so the live keeper had none at all. Parsing it later — after
// the crank and registration loops are already running — meant a bad value threw
// into a process that then refused to exit, because those loops keep the event loop
// alive. Config must fail before anything starts.
//
// The parser is the one #95 added: it rejects a sub-lamport threshold that would
// round to zero and silently disable the guard, which was #71's original report.
//
// Wrapped in try/catch and exiting explicitly, matching the `[fatal]` pattern the
// RPC checks above use. A bare throw here would NOT be fatal: the
// `uncaughtException` handler at the top of this file logs and returns, which
// suppresses Node's non-zero exit, so a misconfigured keeper would report success
// to its supervisor and simply never push. Config errors must exit 1.
let MIN_KEEPER_BALANCE_LAMPORTS: number;
let BALANCE_CHECK_INTERVAL_MS: number;
let STAKE_FEE_CONFIG: StakeFeeConfig;
let TERMINAL_CONFIG: TerminalInsuranceConfig;
let JUNIOR_WATCH_CONFIG: JuniorWatchConfig;
let BANKRUPT_CLOSE_CONFIG: BankruptCloseWatchConfig;
let ALERT_SINK: AlertSink;
let DEVNET_CONN_CONFIG: ConnectionConfig;
try {
  // Ops-track config fails fast with everything else: a malformed alert
  // threshold, webhook URL or fee-job knob must stop boot, not surface as a
  // throw inside a background loop hours later.
  STAKE_FEE_CONFIG = stakeFeeConfigFromEnv(process.env);
  TERMINAL_CONFIG = terminalInsuranceConfigFromEnv(process.env);
  JUNIOR_WATCH_CONFIG = juniorWatchConfigFromEnv(process.env, CFG_WRAPPER_PROGRAM_ID);
  BANKRUPT_CLOSE_CONFIG = bankruptCloseWatchConfigFromEnv(process.env, CFG_WRAPPER_PROGRAM_ID);
  ALERT_SINK = getAlertSink();
  DEVNET_CONN_CONFIG = devnetConnectionConfig(process.env);
  MIN_KEEPER_BALANCE_LAMPORTS = parsePositiveLamportsFromSolEnv(
    "MIN_KEEPER_BALANCE_SOL",
    0.05,
  );
  BALANCE_CHECK_INTERVAL_MS = parsePositiveNumberEnv(
    "BALANCE_CHECK_INTERVAL_MS",
    30_000,
  );
} catch (err) {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── Keeper keypair ─────────────────────────────────────────────────────────────
function loadKeypair(): Keypair {
  if (process.env.KEEPER_KEYPAIR) {
    const raw = JSON.parse(process.env.KEEPER_KEYPAIR) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kpPath =
    process.env.KEEPER_KEYPAIR_PATH ??
    `${process.env.HOME}/.config/solana/percolator-v17-devnet.json`;
  if (!fs.existsSync(kpPath)) {
    console.error(
      `[fatal] Keeper keypair not found at ${kpPath}.` +
        " Set KEEPER_KEYPAIR_PATH or KEEPER_KEYPAIR.",
    );
    process.exit(1);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8")) as number[]),
  );
}

// ── Config ─────────────────────────────────────────────────────────────────────
// KEEPER_DRY_RUN=1 is the Railway cutover switch (same meaning as DRY_RUN=true):
// a standby keeper boots with it on so two keepers never sign at once.
const DRY_RUN =
  process.env.DRY_RUN === "true" ||
  process.env.KEEPER_DRY_RUN === "1" ||
  process.env.KEEPER_DRY_RUN === "true" ||
  process.argv.includes("--dry-run");

const CC_INTERVAL_MS = parsePositiveNumberEnv("CC_INTERVAL_MS", 7000);

// Cadence footgun (runbook fresh-id-redeploy-plan §8): the mark smoother only
// publishes once its window SPANS 5/6 of CC_MARK_WINDOW_MS, and samples older
// than the window are evicted — so some interval/window pairs can never push
// (default 15 s window with CC_INTERVAL_MS 4–6 s). Same default as keeper-loop.ts.
// `never` refuses to boot (a keeper that never pushes looks alive and prices
// nothing); `fragile` warns. Skipped in dry-run, which never pushes anyway.
{
  const windowMs = parsePositiveNumberEnv("CC_MARK_WINDOW_MS", 15_000);
  const c = markCadenceCheck(CC_INTERVAL_MS, windowMs);
  if (c.verdict === "never" && !DRY_RUN) {
    console.error(`[fatal] this cadence can never publish a mark — the keeper would never push. ${c.detail}. Use e.g. 1500 / 8000 (the live pair).`);
    process.exit(1);
  }
  if (c.verdict === "never") console.warn(`[warn] cadence can never publish (dry-run, continuing): ${c.detail}`);
  if (c.verdict === "fragile") console.warn(`[warn] cadence publishes only if every cycle is exactly on time: ${c.detail}`);
}
const CC_HEALTH_PORT = parsePositiveNumberEnv("CC_HEALTH_PORT", 3001);
const CC_HEALTH_BIND = process.env.CC_HEALTH_BIND ?? "0.0.0.0";
// D2a — see cross-cluster/keeper-loop.ts's hang-detection doc comment.
const CC_CYCLE_TIMEOUT_MS = parsePositiveNumberEnv("CC_CYCLE_TIMEOUT_MS", 10000);

// Recovery/maintenance crank loop — independent cadence from the oracle push.
// See cross-cluster/recovery-cranker.ts for why this exists (keeps
// asset.slot_last from drifting far enough behind the live slot to trip
// EngineLockActive on risk-increasing trades). Defaults to on; set
// CRANK_ENABLED=false to disable (e.g. for a read-only / dry-run deploy).
const CRANK_ENABLED = process.env.CRANK_ENABLED !== "false";
const CRANK_INTERVAL_MS = parsePositiveNumberEnv("CRANK_INTERVAL_MS", 20000);
// LP_FEE_CRANK_ENABLED=false to disable. 200s by default: fee distribution is not
// latency-sensitive (it only moves already-accrued atoms into the vault), and a
// market with no LP depositors costs no transaction at all.
const LP_FEE_CRANK_ENABLED = process.env.LP_FEE_CRANK_ENABLED !== "false";
const LP_FEE_CRANK_INTERVAL_MS = parsePositiveNumberEnv("LP_FEE_CRANK_INTERVAL_MS", 200000);
// Stake-fee push (tag 87 -> stake AccrueFees, fee-flow audit F2/F3). Shares the
// fee-job loop and its interval with the LP-fee crank.
const STAKE_FEE_PUSH_ENABLED = process.env.STAKE_FEE_PUSH_ENABLED !== "false";
// Post-resolve wind-down for stake-bound markets (stake F-9 tag 29). A no-op
// until the deployed stake program supports tag 29 (probed, cached 1 h).
const TERMINAL_INSURANCE_ENABLED = process.env.TERMINAL_INSURANCE_ENABLED !== "false";

// Registration-poll loop — outbound poll of the Vercel-hosted playground registered-
// markets blob, so markets created through the create-market wizard after this keeper
// booted get added live. See cross-cluster/register-poll.ts for why this exists (the
// keeper is NAT'd/outbound-only; the frontend can never reach it directly). Off unless
// REGISTER_SOURCE_URL is set — nothing to poll without a source.
const REGISTER_SOURCE_URL = process.env.REGISTER_SOURCE_URL;

// Supabase Realtime credentials for push registration. Anon key only: `markets`
// has RLS with a public_read SELECT policy and Realtime enforces RLS per
// subscriber, so this exposes nothing GET /api/markets does not already serve.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
let registrationStream: RegistrationStream | null = null;
// This is the SAFETY NET, not the fast path. Supabase Realtime (see
// registration-stream.ts) triggers a poll the instant a `markets` row changes,
// so a new market is picked up in ~ms. This loop exists for when that socket is
// down, throttled, or Realtime is unavailable — registration still converges,
// just slower. 30s is fine for that role; it does not gate launch latency.
const REGISTER_POLL_INTERVAL_MS = parsePositiveNumberEnv("REGISTER_POLL_INTERVAL_MS", 30000);

const REGISTRY_PATH =
  process.env.REGISTRY_PATH ??
  path.resolve(__dirname, "..", "registry.json");

// G6 — registry.json hot-reload, so a re-seed is picked up live without a
// restart. See cross-cluster/registry-reload.ts for the full rationale.
const REGISTRY_RELOAD_INTERVAL_MS = parsePositiveNumberEnv("REGISTRY_RELOAD_INTERVAL_MS", 15000);

// ── Boot ───────────────────────────────────────────────────────────────────────
const keeper = loadKeypair();
const registry = loadRegistry(REGISTRY_PATH);

if (registry.markets.length === 0) {
  console.warn(
    "[warn] Registry is empty — no markets to push to." +
      " Register markets via addMarket() or by populating registry.json.",
  );
  // An empty registry is only fatal when there is no way to become non-empty.
  //
  // This exit predates the registration-poll loop, when registry.json was the
  // only source and empty genuinely meant "nothing to do, ever". With
  // REGISTER_SOURCE_URL set there IS something to do: wait for the frontend to
  // publish a market and pick it up on the next poll.
  //
  // Exiting here made retiring every market a trap — the board is cleared, the
  // keeper dies, and the next market launched is never priced because nothing
  // is alive to poll for it. Starting empty and filling from the poll is the
  // normal cold-start path now, not an error.
  if (!DRY_RUN && !REGISTER_SOURCE_URL) {
    console.error(
      "[fatal] Nothing to do in live mode with an empty registry and no" +
        " REGISTER_SOURCE_URL to poll. Exiting.",
    );
    process.exit(1);
  }
  if (REGISTER_SOURCE_URL) {
    console.warn(
      `[warn] Starting with an empty registry — waiting for markets from ${REGISTER_SOURCE_URL}` +
        ` (poll every ${REGISTER_POLL_INTERVAL_MS}ms).`,
    );
  }
}

const mainnetConn = new Connection(MAINNET_RPC, { commitment: "confirmed", fetch: countingFetch("mainnet") });
// DEVNET_RPC_ORIGIN replaces the uncommitted `httpHeaders: { Origin }` edit the
// live machine carried here (Origin-restricted Helius key; see rpc-headers.ts).
const devnetConn = new Connection(DEVNET_RPC, { ...DEVNET_CONN_CONFIG, fetch: countingFetch("devnet") });

// Dry-run hard stop. Every write path is meant to honour `dryRun` on its own,
// but there are a dozen send sites; a standby keeper that signs even one tx
// while the live keeper runs races it (Custom(19) sequence collisions). So in
// dry-run the connections themselves refuse to send — any path that forgets
// the flag fails loudly instead of landing a transaction.
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

console.log("[cross-cluster] Boot:");
console.log(`  keeper:    ${keeper.publicKey.toBase58()}`);
console.log(`  registry:  ${REGISTRY_PATH} (${registry.markets.length} markets)`);
console.log(`  mode:      ${DRY_RUN ? "DRY-RUN (no on-chain writes)" : "LIVE"}`);
console.log(`  interval:  ${CC_INTERVAL_MS}ms`);
for (const line of describeProgramIds()) console.log(`  program:   ${line}`);
console.log(`  alerts:    webhook ${process.env.KEEPER_ALERT_WEBHOOK_URL ? "ON" : "off"}; telegram ${ALERT_SINK.telegramEnabled ? "ON" : "off"}; thresholds ${JSON.stringify(ALERT_SINK.thresholds)}`);
console.log(
  `  cranker:   ${CRANK_ENABLED ? `every ${CRANK_INTERVAL_MS}ms` : "disabled (CRANK_ENABLED=false)"}`,
  `  lp-fee:    ${LP_FEE_CRANK_ENABLED ? `every ${LP_FEE_CRANK_INTERVAL_MS}ms` : "disabled (LP_FEE_CRANK_ENABLED=false)"}`,
  `  stake-fee: ${STAKE_FEE_PUSH_ENABLED ? `every ${LP_FEE_CRANK_INTERVAL_MS}ms (real stakers only)` : "disabled (STAKE_FEE_PUSH_ENABLED=false)"}`,
);
for (const m of registry.markets) {
  console.log(
    `  market:    ${m.label} | slab=${m.marketAddress.slice(0, 8)}… → pool=${m.poolAddress.slice(0, 8)}… (${m.dexType})${m.lpPortfolio ? ` | lp=${m.lpPortfolio.slice(0, 8)}…` : ""}`,
  );
}
console.log();

// G9 — register-poll is what picks up markets created through the create-market
// wizard AFTER this keeper booted. Silently running without it in live mode means
// those markets never get priced/cranked and quietly die on arrival — loud enough
// to be seen in logs/alerts, but not fatal (some deploys are intentionally
// registry.json-only).
if (!REGISTER_SOURCE_URL && !DRY_RUN) {
  console.warn(
    "[warn] REGISTER_SOURCE_URL is unset in LIVE mode — markets created through the" +
      " create-market wizard after this keeper booted will NEVER be picked up" +
      " (register-poll is disabled). Set REGISTER_SOURCE_URL (see .env.example) unless" +
      " this registry.json-only deploy is intentional.",
  );
}

// D1 — deterministic crank-on-boot. AWAITED (unlike every loop below, which is
// deliberately fire-and-forget) so process boot does not complete — and the
// recurring loops below do not start — until every seeded market has had a real
// crank attempt. Uses ONLY registry.json's known lpPortfolio (no discovery), so
// this resolves in a small, bounded number of RPC calls regardless of registry
// size. See cross-cluster/recovery-cranker.ts's crankAllOnce() doc comment for
// exactly why this closes the SOL/JUP/TRUMP boot-gap.
// B7: the boot states go to the loop, so its first cycle does not re-crank a
// market in the slot the boot crank already covered (a benign Custom(22)).
const bootCrankStates = CRANK_ENABLED ? await crankAllOnce(devnetConn, keeper, registry, DRY_RUN) : undefined;

// Recovery crank loop runs concurrently on its own interval — deliberately
// NOT awaited, and deliberately never allowed to throw out of this scope, so
// it can never delay or take down the oracle push loop below.
if (CRANK_ENABLED) {
  // Supervised: a crash used to kill the cranker for the life of the process (2026-10-01:
  // "Cannot read properties of undefined (reading 'consecutiveReverts')" after a run of
  // cycle timeouts froze every market's engine clock for ~1h while /health said ok).
  // Restart with backoff; boot states are only valid for the first run.
  void (async () => {
    let states = bootCrankStates;
    let backoffMs = 5_000;
    for (;;) {
      try {
        await startRecoveryCrankLoop(devnetConn, keeper, registry, {
          intervalMs: CRANK_INTERVAL_MS,
          dryRun: DRY_RUN,
        }, ALERT_SINK, states);
        console.error("[cranker] loop exited unexpectedly — restarting");
      } catch (err: unknown) {
        console.error(
          `[cranker] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.stack ?? err.message : String(err)} — restarting in ${backoffMs}ms`,
        );
      }
      states = undefined;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  })();
}

// P3 senior draw (d119eebd): crank each bound market's vault LP after every landed mark
// move, so its deficit is drawn from the vault's pots (junior, then Earn seniors) BEFORE
// the engine can liquidate it. Markets without a vault-LP state are a cached no-op.
const P3_EXHAUSTED_WITHHOLD_PUSHES = process.env.P3_EXHAUSTED_WITHHOLD_PUSHES !== "false";
const vaultLpCranker =
  process.env.VAULT_LP_MARK_CRANK_ENABLED === "false" || DRY_RUN
    ? null
    : new VaultLpCranker(devnetConn, keeper, ALERT_SINK, {
        wrapperProgramId: CFG_WRAPPER_PROGRAM_ID,
        lookupTtlMs: 10 * 60_000,
        withholdPushes: P3_EXHAUSTED_WITHHOLD_PUSHES,
        registry: getExhaustedRegistry(),
      });

// Fee-job loop: every "move accrued fee value to its owner" job, in order, per
// market (fee-jobs.ts). Same "concurrent, never awaited, never throws out of
// scope" pattern as the crank loop.
//   lp-fee    tag 78 — the LP leg (48%) into the Earn vault. Without it
//             `lp_fee_accrued_atoms` grows forever and LPs see 0% APY.
//   stake-fee tag 87 + stake AccrueFees — the staker leg (16%), only for pools
//             with real stakers above the 1,000 dead shares (F2/F3).
// Later phases append jobs here (P3: vault NAV / fee sweeps).
{
  const feeJobs: FeeJob[] = [];
  if (LP_FEE_CRANK_ENABLED) feeJobs.push(makeLpFeeJob());
  if (STAKE_FEE_PUSH_ENABLED) feeJobs.push(makeStakeFeeJob(STAKE_FEE_CONFIG));
  if (TERMINAL_INSURANCE_ENABLED) feeJobs.push(makeTerminalInsuranceJob(TERMINAL_CONFIG));
  // Read-only: alerts when a bound vault's seniors are done but the junior's tag 102 has not run.
  if (process.env.JUNIOR_WATCH_ENABLED !== "false") feeJobs.push(makeJuniorWatchJob(JUNIOR_WATCH_CONFIG));
  // Read-only: warn / critical when a Live market's bankrupt close nears / passes max_close_slot with residual.
  if (process.env.BANKRUPT_CLOSE_WATCH_ENABLED !== "false") feeJobs.push(makeBankruptCloseWatchJob(BANKRUPT_CLOSE_CONFIG));
  // P3 senior backing exhausted: critical alert with the tag 39 window, push withholding,
  // and tag 39 sent by the keeper once the stale window has matured.
  if (process.env.P3_EXHAUSTED_RESOLVE_ENABLED !== "false") {
    feeJobs.push(
      makeExhaustedResolveJob({
        wrapperProgramId: CFG_WRAPPER_PROGRAM_ID,
        registry: getExhaustedRegistry(),
        vaultLpFor: vaultLpCranker ? (m) => vaultLpCranker.vaultLpFor(m) : undefined,
        withholdPushes: P3_EXHAUSTED_WITHHOLD_PUSHES,
      }),
    );
  }
  if (feeJobs.length > 0) {
    void startFeeJobLoop(
      feeJobs,
      { conn: devnetConn, keeper, dryRun: DRY_RUN },
      registry,
      { intervalMs: LP_FEE_CRANK_INTERVAL_MS },
      ALERT_SINK,
    ).catch((err: unknown) => {
      console.error(
        `[fee-jobs] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

// Registration-poll loop — same "runs concurrently, never awaited, never allowed to
// throw out of this scope" pattern as the recovery cranker above. Mutates `registry`
// in place (addMarket + saveRegistry), and it's the SAME registry object passed to
// startKeeperLoop/startRecoveryCrankLoop below, so a market added here is picked up
// by both of those loops on their very next cycle.
// The market list now comes from Supabase (`markets` where keeper_status='active')
// rather than the Vercel blob, so Supabase config — not REGISTER_SOURCE_URL — is
// what gates registration. The blob was a second store that the Realtime
// notification this keeper already subscribes to pointed away from.
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  const registerPollConfig = {
    db: {
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      network: "devnet",
      mainnetConn,
      // Pool -> DEX type, resolved from each pool's on-chain owner and cached
      // for the process. dex_type is deliberately not a DB column.
      dexCache: new Map(),
    },
    registryPath: REGISTRY_PATH,
    intervalMs: REGISTER_POLL_INTERVAL_MS,
    // Owner filter: only admit markets owned by the current wrapper (WRAPPER_PROGRAM_ID
    // = PROGRAM_IDS_V17.percolator). Keeps retired-wrapper entries out of the
    // atomic push batch (they revert it with IncorrectProgramId).
    connection: devnetConn,
    expectedOwner: WRAPPER_PROGRAM_ID,
  };

  // Push path: Supabase Realtime tells us the instant a `markets` row changes,
  // so a market the user just created is picked up in ~ms rather than waiting
  // for the next tick. It TRIGGERS the poll rather than replacing it — one code
  // path still admits a market, and if the socket drops the loop below covers
  // it. See cross-cluster/registration-stream.ts.
  {
    registrationStream = startRegistrationStream({
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      onChange: () => {
        void pollOnce(registry, registerPollConfig).catch((err) => {
          console.warn(
            `[registration-stream] triggered poll failed (periodic poll unaffected): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      },
    });
  }

  void startRegisterPollLoop(registry, registerPollConfig).catch((err) => {
    console.error(
      `[register-poll] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
} else {
  console.log("[register-poll] disabled (REGISTER_SOURCE_URL unset)");
}

// G6 — registry.json hot-reload. Same fire-and-forget pattern as the other
// background loops. Critical ahead of the upcoming re-seed: without this, a
// new registry.json on disk is invisible to a running keeper until restart —
// and a restart right after a re-seed reintroduces exactly the kind of
// boot-time gap D5/D1 exist to close.
void startRegistryReloadLoop(registry, {
  registryPath: REGISTRY_PATH,
  intervalMs: REGISTRY_RELOAD_INTERVAL_MS,
}).catch((err) => {
  console.error(
    `[registry-reload] loop crashed (oracle push is unaffected): ${err instanceof Error ? err.message : String(err)}`,
  );
});

// #100 — announce the liquidity floor's state. Off by default, because the value
// is a policy call that depends on the depth of the markets actually listed, and
// no floor has ever existed in this repo's history. Announcing beats defaulting
// silently: a guard nobody knows is off is worse than no guard.
if (MIN_POOL_LIQUIDITY_USD_E6 === 0n) {
  console.warn(
    "[cross-cluster] MIN_POOL_LIQUIDITY_USD is unset — the #100 liquidity floor is OFF. " +
      "Any creator-supplied pool is priced regardless of depth. Set it to enable the floor.",
  );
} else {
  console.log(
    `[cross-cluster] liquidity floor: $${(Number(MIN_POOL_LIQUIDITY_USD_E6) / 1e6).toFixed(2)} ` +
      "(pumpswap markets; other DEX types expose no reserves — see #100)",
  );
}

await startKeeperLoop(mainnetConn, devnetConn, keeper, registry, {
  withholdPush: (m) => getExhaustedRegistry().shouldWithholdPush(m, P3_EXHAUSTED_WITHHOLD_PUSHES),
  onPushLanded: vaultLpCranker
    ? (m, px, label) => {
        void vaultLpCranker.onPushLanded(m, px, label);
      }
    : undefined,
  intervalMs: CC_INTERVAL_MS,
  healthPort: CC_HEALTH_PORT,
  healthBind: CC_HEALTH_BIND,
  dryRun: DRY_RUN,
  cycleTimeoutMs: CC_CYCLE_TIMEOUT_MS,
  minKeeperBalanceLamports: MIN_KEEPER_BALANCE_LAMPORTS,
  balanceCheckIntervalMs: BALANCE_CHECK_INTERVAL_MS,
});
