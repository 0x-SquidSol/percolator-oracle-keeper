/**
 * The keeper's market list, read from Supabase.
 *
 * WHY THIS EXISTS
 * ---------------
 * The list used to live in a Vercel blob, written by a second registration call
 * and polled over HTTP. The `markets` row already carried everything needed, and
 * the keeper was ALREADY subscribed to Supabase Realtime on that table — it just
 * used the notification to go and fetch a different store. This makes the row
 * the source of truth, so `keeper_status='active'` is the single switch that
 * enrolls a market for pricing and retiring one is a column update.
 *
 * `dex_type` is deliberately NOT a column. The keeper derives it from the pool
 * account's owner program, which `readPoolPriceE6` already re-validates on every
 * price read. Storing it would create a second copy that can silently disagree
 * with chain — and a wrong dexType means a wrong price, not a failed read.
 *
 * See percolator-launch/docs/MARKET-REGISTRATION-SPEC-2026-07-30.md.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { detectDexType } from "@percolatorct/sdk";
import type { MarketEntry, DexType } from "./registry.ts";

/** The columns the keeper needs. Everything else on the row is display data. */
export interface DbMarketRow {
  slab_address: string;
  dex_pool_address: string | null;
  symbol: string | null;
  mint_address: string;
  mainnet_ca: string | null;
  /** The market's creator (review M-7 per-deployer ceiling). Absent in older fixtures. */
  deployer?: string | null;
  /** Row creation time; the ceiling keeps the OLDEST markets (the ones already being priced). */
  created_at?: string | null;
}

/** Pool address -> DEX type, cached across cycles (a pool never changes owner). */
export type DexCache = Map<string, DexType>;

/**
 * Classify pools by their on-chain owner program.
 *
 * Only pools missing from the cache are fetched, so steady state costs nothing;
 * a newly registered market costs one batched getMultipleAccountsInfo.
 */
export async function classifyPools(
  conn: Connection,
  pools: readonly string[],
  cache: DexCache,
): Promise<DexCache> {
  const unknown = [...new Set(pools)].filter((p) => !cache.has(p));
  for (let i = 0; i < unknown.length; i += 100) {
    const chunk = unknown.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(
      chunk.map((p) => new PublicKey(p)),
      "confirmed",
    );
    infos.forEach((info, j) => {
      if (!info) return;
      const dex = detectDexType(info.owner);
      if (dex) cache.set(chunk[j], dex as DexType);
    });
  }
  return cache;
}

/**
 * Map DB rows to registry entries, dropping anything that cannot be priced.
 *
 * Both drops are deliberate: no pool means there is no price source, and an
 * unclassified pool means we would have to GUESS a dexType. Neither belongs in
 * the registry — the push loop reads it without re-checking these.
 */
const warnedUnclassified = new Set<string>();

export function rowsToEntries(rows: readonly DbMarketRow[], dexByPool: DexCache): MarketEntry[] {
  const out: MarketEntry[] = [];
  for (const r of rows) {
    if (!r.dex_pool_address) continue;
    const dexType = dexByPool.get(r.dex_pool_address);
    if (!dexType) {
      // Said out loud, once per market: a silently dropped row leaves a live
      // market uncranked with nothing in the logs. 9EPm8nB8 (2026-10-01) sat
      // ~34 min between its INSERT and its admission with no keeper line
      // explaining why.
      if (!warnedUnclassified.has(r.slab_address)) {
        warnedUnclassified.add(r.slab_address);
        console.warn(
          `[db-markets] NOT admitting ${r.slab_address.slice(0, 8)}… — pool ` +
            `${r.dex_pool_address.slice(0, 8)}… is not a recognised DEX pool (unclassified); no price source`,
        );
      }
      continue;
    }
    const name = r.symbol ?? r.slab_address.slice(0, 8);
    out.push({
      label: `${name}/USDC — ${dexType}`,
      marketAddress: r.slab_address,
      poolAddress: r.dex_pool_address,
      dexType,
      assetIndex: 0,
      symbol: r.symbol ?? undefined,
      collateral: r.mint_address,
      // #100: previously SELECTed and then dropped on the floor here.
      mainnetCa: r.mainnet_ca ?? undefined,
    } as MarketEntry);
  }
  return out;
}

/**
 * Keeper-side ceiling on the markets it prices (review M-7, 2026-10-01).
 *
 * Every market in the registry is one more PushAuthMark leg the keeper pays for, every cycle.
 * Enrollment is gated in the app (percolator-launch keeper-register: finished market + per-creator
 * and global caps), but a row can reach the table other ways (the admin path, a manual SQL edit,
 * a future bug), and the keeper's SOL is what runs out. So the keeper bounds itself too: at most
 * `maxTotal` priceable markets, at most `maxPerDeployer` from one creator, OLDEST first by
 * `created_at` (slab address breaks ties), so markets already being priced keep their place and
 * only the newest rows over a ceiling wait. Never empties a non-empty list (both caps are >= 1),
 * so the wipe-the-board guard in register-poll keeps its meaning.
 */
export interface KeeperMarketCaps {
  maxTotal: number;
  maxPerDeployer: number;
}

export const DEFAULT_KEEPER_MAX_MARKETS = 50;
export const DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER = 10;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** KEEPER_MAX_MARKETS / KEEPER_MAX_MARKETS_PER_DEPLOYER, else the defaults. */
export function keeperMarketCapsFromEnv(env: NodeJS.ProcessEnv = process.env): KeeperMarketCaps {
  return {
    maxTotal: positiveInt(env.KEEPER_MAX_MARKETS, DEFAULT_KEEPER_MAX_MARKETS),
    maxPerDeployer: positiveInt(env.KEEPER_MAX_MARKETS_PER_DEPLOYER, DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER),
  };
}

const warnedCapped = new Set<string>();

/**
 * Apply the ceilings. Rows `isPriceable` rejects pass through uncounted (rowsToEntries drops them
 * with its own warning), so an unpriceable row never takes a priced market's place.
 */
export function capMarketRows(
  rows: readonly DbMarketRow[],
  caps: KeeperMarketCaps,
  isPriceable: (r: DbMarketRow) => boolean = () => true,
): { kept: DbMarketRow[]; capped: DbMarketRow[] } {
  const order = [...rows].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const tb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    const da = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
    const db = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    if (da !== db) return da < db ? -1 : 1;
    return a.slab_address < b.slab_address ? -1 : a.slab_address > b.slab_address ? 1 : 0;
  });
  const kept: DbMarketRow[] = [];
  const capped: DbMarketRow[] = [];
  const perDeployer = new Map<string, number>();
  let total = 0;
  for (const r of order) {
    if (!isPriceable(r)) {
      kept.push(r);
      continue;
    }
    const who = r.deployer ?? "";
    const n = perDeployer.get(who) ?? 0;
    if (total >= caps.maxTotal || n >= caps.maxPerDeployer) {
      capped.push(r);
      if (!warnedCapped.has(r.slab_address)) {
        warnedCapped.add(r.slab_address);
        console.warn(
          `[db-markets] NOT admitting ${r.slab_address.slice(0, 8)}… — over the keeper's ` +
            (total >= caps.maxTotal
              ? `market ceiling (${caps.maxTotal})`
              : `per-deployer ceiling (${caps.maxPerDeployer} for ${who.slice(0, 8) || "unknown"}…)`),
        );
      }
      continue;
    }
    perDeployer.set(who, n + 1);
    total++;
    kept.push(r);
  }
  return { kept, capped };
}

export interface FetchActiveConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  network: string;
  mainnetConn: Connection;
  dexCache: DexCache;
  /** Review M-7 ceilings; defaults to keeperMarketCapsFromEnv(). */
  caps?: KeeperMarketCaps;
}

/**
 * The active market list, or `null` when the query FAILED.
 *
 * The null-vs-empty distinction is load-bearing. Callers reconcile the registry
 * against this result, so returning `[]` for a failed query would retire every
 * market. `[]` means "the query succeeded and there are genuinely none"; `null`
 * means "we learned nothing this cycle — change nothing".
 */
export async function fetchActiveMarkets(cfg: FetchActiveConfig): Promise<MarketEntry[] | null> {
  const url =
    `${cfg.supabaseUrl}/rest/v1/markets` +
    `?select=slab_address,dex_pool_address,symbol,mint_address,mainnet_ca,deployer,created_at` +
    `&keeper_status=eq.active` +
    `&network=eq.${encodeURIComponent(cfg.network)}` +
    `&dex_pool_address=not.is.null` +
    // Oldest first: the ceiling (capMarketRows) keeps the markets already being priced.
    `&order=created_at.asc,slab_address.asc`;

  let rows: DbMarketRow[];
  try {
    const resp = await fetch(url, {
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[db-markets] query failed: HTTP ${resp.status} — registry left unchanged`);
      return null;
    }
    const body: unknown = await resp.json();
    if (!Array.isArray(body)) {
      console.warn("[db-markets] query returned a non-array body — registry left unchanged");
      return null;
    }
    rows = body as DbMarketRow[];
  } catch (err) {
    console.warn(
      `[db-markets] query failed: ${err instanceof Error ? err.message : String(err)} — registry left unchanged`,
    );
    return null;
  }

  // A classification failure is also "we learned nothing": without it every row
  // would be dropped as unclassifiable, which reconcile would read as a mass
  // retirement.
  try {
    const pools = rows.map((r) => r.dex_pool_address).filter((p): p is string => !!p);
    await classifyPools(cfg.mainnetConn, pools, cfg.dexCache);
  } catch (err) {
    console.warn(
      `[db-markets] pool classification failed: ${err instanceof Error ? err.message : String(err)} — registry left unchanged`,
    );
    return null;
  }

  const { kept } = capMarketRows(
    rows,
    cfg.caps ?? keeperMarketCapsFromEnv(),
    (r) => !!r.dex_pool_address && cfg.dexCache.has(r.dex_pool_address),
  );
  return rowsToEntries(kept, cfg.dexCache);
}
