#!/usr/bin/env tsx
/**
 * preflight-v22fresh.ts — refuse to start the v2.2 fresh-ID keeper against a registry that could touch anything but
 * the fresh wrapper's markets. Read-only (one getMultipleAccounts on devnet). Exit 0 = safe, 1 = refuse.
 *
 * env: DEVNET_RPC_URL, WRAPPER_PROGRAM_ID, REGISTRY_PATH, PREFLIGHT_ALLOW_EMPTY=1 (dry-run boot with no markets)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import crypto from "crypto";
import { failoverFromEnv, isTransientRpcError, parseFallbackUrls, preflightOutageDecision, preflightStampSha, redactText, GENESIS_HASH } from "../src/rpc-failover.ts";
import { alertText, recordLaunch, restartConfig } from "../src/restart-escalation.ts";

const DEVNET_RPC = process.env.DEVNET_RPC_URL ?? "";
const WRAPPER = process.env.WRAPPER_PROGRAM_ID ?? "";
const REGISTRY_PATH = process.env.REGISTRY_PATH ?? "";
const DEX = new Set(["raydium-clmm", "meteora-dlmm", "pumpswap"]);

/** Error text with any endpoint URL / api-key scrubbed (the primary URL carries the key). */
function safe(e: unknown): string {
  return redactText(e instanceof Error ? e.message : String(e), [DEVNET_RPC, ...(process.env.DEVNET_RPC_FALLBACK_URLS ?? process.env.RPC_FALLBACK_URLS ?? "").split(",")]);
}

/** Restart escalation: count this launch; N launches in M minutes -> loud [ALERT] line + optional https webhook. */
async function noteLaunch(): Promise<void> {
  const c = restartConfig(process.env);
  if (!c.path) return;
  const { health, alertDue } = recordLaunch(c.path, Date.now(), c.threshold, c.windowMs);
  if (!health.escalated) return;
  const text = alertText(health, "v2.2 keeper");
  console.error(text);
  const hook = process.env.KEEPER_ALERT_WEBHOOK_URL?.trim();
  if (alertDue && hook && hook.startsWith("https://")) {
    try {
      await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, alert: health }), signal: AbortSignal.timeout(5_000) });
    } catch (e) {
      console.error(`[preflight] alert webhook failed: ${e instanceof Error ? e.name : "error"}`);
    }
  }
}

function fail(msg: string): never {
  console.error(`[preflight] REFUSE: ${msg}`);
  process.exit(1);
}

interface AssetRow { assetIndex?: number; source?: string; poolAddress?: string; dexType?: string; fixedPriceE6?: string | number }
interface Entry { label?: string; marketAddress?: string; poolAddress?: string; dexType?: string; assetIndex?: number; assets?: AssetRow[] }

/** K-6: a multi-asset row (`assets`) names one source per asset instead of a row-level pool. */
function checkAssets(m: Entry): void {
  const assets = m.assets ?? [];
  if (!Array.isArray(assets) || assets.length === 0) fail(`entry ${m.label ?? "?"}: "assets" must be a non-empty list`);
  const seen = new Set<number>();
  for (const a of assets) {
    if (!Number.isInteger(a.assetIndex) || (a.assetIndex as number) < 0 || (a.assetIndex as number) >= 16) fail(`entry ${m.label}: bad assetIndex ${String(a.assetIndex)}`);
    if (seen.has(a.assetIndex as number)) fail(`entry ${m.label}: asset ${a.assetIndex} listed twice`);
    seen.add(a.assetIndex as number);
    if (a.source === "pool") {
      if (!a.poolAddress || !a.dexType || !DEX.has(a.dexType)) fail(`entry ${m.label} asset ${a.assetIndex}: pool source needs poolAddress + a known dexType`);
      new PublicKey(a.poolAddress);
    } else if (a.source === "fixed") {
      const v = a.fixedPriceE6;
      const ok = (typeof v === "string" && /^[0-9]+$/.test(v) && BigInt(v) > 0n) || (typeof v === "number" && Number.isSafeInteger(v) && v > 0);
      if (!ok) fail(`entry ${m.label} asset ${a.assetIndex}: fixed source needs a positive integer fixedPriceE6`);
    } else {
      fail(`entry ${m.label} asset ${a.assetIndex}: unknown source ${String(a.source)}`);
    }
  }
}

async function main(): Promise<void> {
  await noteLaunch();
  if (!DEVNET_RPC || !WRAPPER || !REGISTRY_PATH) fail("DEVNET_RPC_URL, WRAPPER_PROGRAM_ID and REGISTRY_PATH are required");
  if (!fs.existsSync(REGISTRY_PATH)) {
    if (process.env.PREFLIGHT_ALLOW_EMPTY === "1") { console.log(`[preflight] ok (no registry at ${REGISTRY_PATH}; empty boot allowed)`); return; }
    fail(`registry file ${REGISTRY_PATH} does not exist`);
  }
  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as { programSet?: string; markets?: Entry[] };
  if (reg.programSet !== undefined && reg.programSet !== "v1") fail(`registry programSet=${reg.programSet}; this keeper runs the explicit-ID (untagged/"v1") mode`);
  const markets = reg.markets ?? [];
  if (markets.length === 0) {
    if (process.env.PREFLIGHT_ALLOW_EMPTY === "1") { console.log("[preflight] ok (registry empty; allowed for dry-run)"); return; }
    fail("registry has 0 markets (live mode exits on an empty registry)");
  }
  const seen = new Set<string>();
  for (const m of markets) {
    if (m.assets !== undefined) {
      if (!m.marketAddress) fail(`entry ${m.label ?? "?"} lacks marketAddress`);
      checkAssets(m);
    } else {
      if (!m.marketAddress || !m.poolAddress || !m.dexType) fail(`entry ${m.label ?? "?"} lacks marketAddress/poolAddress/dexType`);
      if (!DEX.has(m.dexType)) fail(`entry ${m.label}: unknown dexType ${m.dexType}`);
      new PublicKey(m.poolAddress);
    }
    if (seen.has(m.marketAddress)) fail(`duplicate market ${m.marketAddress}`);
    seen.add(m.marketAddress);
    new PublicKey(m.marketAddress);
  }
  // F3: the stamp binds registry + wrapper program id + cluster genesis, not the registry alone.
  const registrySha = preflightStampSha(fs.readFileSync(REGISTRY_PATH), WRAPPER, GENESIS_HASH.devnet);
  const stampPath = process.env.PREFLIGHT_STAMP_PATH ?? `${REGISTRY_PATH}.preflight-ok`;
  const fallbacks = parseFallbackUrls(process.env.DEVNET_RPC_FALLBACK_URLS ?? process.env.RPC_FALLBACK_URLS);
  // Each endpoint passes the genesis-hash cluster check + slot-lag check before it answers (rpc-failover.ts).
  const failover = failoverFromEnv("devnet", DEVNET_RPC, fallbacks, process.env, (i, init) => fetch(i, init));
  const conn = new Connection(DEVNET_RPC, { commitment: "confirmed", ...(failover ? { fetch: failover.fetch } : {}) });
  let infos;
  try {
    infos = await conn.getMultipleAccountsInfo(markets.map((m) => new PublicKey(m.marketAddress as string)));
  } catch (e) {
    if (!isTransientRpcError(e)) throw e;
    const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8") : undefined;
    if (preflightOutageDecision(registrySha, stamp) === "refuse") {
      fail(`RPC unavailable (${safe(e)}) and this registry has not passed the ownership check before`);
    }
    console.warn(`[preflight] WARN: RPC unavailable (${safe(e)}); registry unchanged since the last passing check, starting degraded instead of exiting`);
    return;
  }
  infos.forEach((info, i) => {
    const m = markets[i] as Entry;
    if (!info) fail(`${m.label}: market ${m.marketAddress} does not exist on devnet`);
    if (info.owner.toBase58() !== WRAPPER) fail(`${m.label}: market ${m.marketAddress} is owned by ${info.owner.toBase58()}, not the fresh wrapper ${WRAPPER}`);
  });
  try { fs.writeFileSync(stampPath, registrySha + "\n"); } catch { /* read-only checkout: the stamp is an optimisation */ }
  console.log(`[preflight] ok: ${markets.length} market(s), all owned by wrapper ${WRAPPER}`);
}
main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
