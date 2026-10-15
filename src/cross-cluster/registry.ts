/**
 * cross-cluster/registry.ts
 *
 * Market→pool registry for the cross-cluster keeper.
 *
 * Each entry maps a devnet slab (market) address to its corresponding
 * mainnet DEX pool. The keeper reads prices from mainnet pools and pushes
 * them to devnet markets via PushAuthMark.
 *
 * The registry is backed by a JSON file (default: ./registry.json).
 * Managed programmatically via addMarket() / removeMarket(), and by the
 * create-market wizard which registers markets at creation time.
 */
import fs from "fs";
import path from "path";

/** DEX types supported by the dex-oracle module. */
export type DexType = "raydium-clmm" | "meteora-dlmm" | "pumpswap";

/** What the pool price reader needs from a price source (a single-asset row, or one pool-sourced asset). */
export interface PoolPriceSource {
  poolAddress: string;
  dexType: DexType;
  label: string;
  symbol?: string;
  mainnetCa?: string;
}

/**
 * K-6: the price source of ONE asset of a multi-asset market (see multi-asset.ts).
 *   pool   live spot from a mainnet DEX pool (same reader, smoother and circuit breaker as a single-asset market)
 *   fixed  a constant mark pushed every cycle (synthetic QA assets with no real pool); no smoother, no breaker
 */
export interface AssetSource {
  /** Engine asset slot index in the market. */
  assetIndex: number;
  source: "pool" | "fixed";
  /** pool: mainnet DEX pool address. */
  poolAddress?: string;
  /** pool: DEX type. */
  dexType?: DexType;
  /** pool: the token's mainnet CA, bound against the pool's mints (#100), when known. */
  mainnetCa?: string;
  /** fixed: the mark to push, e6, as a decimal integer string (or a safe integer). "100000000" = 100.0. */
  fixedPriceE6?: string | number;
  /** Display only. */
  symbol?: string;
}

/**
 * A single market registration: one devnet slab tracked against one mainnet pool, or (K-6) against one price source
 * per asset when `assets` is present.
 */
export interface MarketEntry {
  /** Human-readable label, e.g. "SOL/USDC (Raydium CLMM)". */
  label: string;
  /** Devnet slab (market) account address — target for PushAuthMark. */
  marketAddress: string;
  /**
   * Mainnet DEX pool address — price source. Required on a single-asset row. On a multi-asset row (`assets` present)
   * it is ignored (each asset names its own source) and may be omitted.
   */
  poolAddress?: string;
  /** DEX type for price computation. Required on a single-asset row; ignored on a multi-asset row. */
  dexType?: DexType;
  /**
   * K-6: a MULTI-ASSET market. When present (non-empty), the keeper pushes every listed asset each cycle (batched),
   * every observation crank accrues all of them, positioned portfolios are those holding a leg on any of them, and
   * /health reports each asset (multi-asset.ts). `assetIndex` / `poolAddress` / `dexType` / `mainnetCa` of the row
   * are then not used for pricing. Absent = the single-asset behaviour, unchanged.
   */
  assets?: AssetSource[];
  /**
   * #100 — the mainnet contract address this market is FOR, when the DB knows it.
   * Bound against the pool's base/quote mint before the pool is trusted as a price
   * source, so a creator cannot point a market at a pool for a different token.
   */
  mainnetCa?: string;
  /**
   * Asset slot index in the slab.
   * Current markets use a single asset at index 0.
   */
  assetIndex: number;
  /** Unix timestamp (ms) when this entry was registered. */
  registeredAt?: number;
  /**
   * Optional display symbol (e.g. "SOL/USDC"). Present on the pre-seeded entries in
   * registry.json and on entries added by the playground registration-poll loop
   * (register-poll.ts). Not read by the push/crank loops — display/logging only.
   */
  symbol?: string;
  /**
   * Optional collateral label or mint address, for display/logging only — not read
   * by the push/crank loops. Pre-seeded entries use a short label ("SimUSDC");
   * playground-registered entries carry the actual devnet collateral mint.
   */
  collateral?: string;
  /**
   * Optional pre-known LP-vault ("matcher-enabled") portfolio address for this
   * market, seeded directly in registry.json for markets created via
   * newmarkets.ts / launch-test-market.ts. When present, the recovery cranker
   * (recovery-cranker.ts) uses it immediately and SKIPS the
   * getProgramAccounts discovery scan entirely for this market.
   *
   * This closes the D5 boot-gap that caused the 2026-07 SOL/JUP/TRUMP market
   * deaths: the old discovery-only path retried a failed lookup only every
   * DISCOVERY_RETRY_MS (previously 5 minutes) — longer than the ~190s engine
   * accrue-staleness cliff — so a single transient discovery miss right after
   * boot was enough to leave a market un-cranked long enough to drift into a
   * permanent EngineStale(19)/EngineLockActive(21) state. Markets registered
   * live via the register-poll loop have no lpPortfolio in their payload, so
   * they still fall back to discovery — just retried much faster now.
   */
  lpPortfolio?: string;
}

export interface Registry {
  version: number;
  description: string;
  markets: MarketEntry[];
  /**
   * Which program-ID world these markets belong to (Devnet v2.1 fresh-ID cutover,
   * 2026-10-05). Absent = "v1" (every registry written before the cutover).
   * A v2.1 keeper (KEEPER_DEVNET_V21=1) only runs from a registry tagged "v21",
   * so it can never push or crank v1 slabs under the v2.1 wrapper, and vice versa.
   */
  programSet?: "v1" | "v21";
}

/** Default registry file for each program set, relative to the repo root. */
export const DEFAULT_REGISTRY_FILE: Readonly<Record<"v1" | "v21", string>> = Object.freeze({
  v1: "registry.json",
  v21: "registry.v21.json",
});

/** The registry's program set; an untagged registry is v1. */
export function registryProgramSet(registry: Pick<Registry, "programSet">): "v1" | "v21" {
  return registry.programSet ?? "v1";
}

/**
 * Throws when a registry belongs to a different program set than the keeper
 * runs. With the switch off and an untagged registry this is a no-op, which is
 * every deployment before the cutover.
 */
export function assertRegistryProgramSet(
  registry: Pick<Registry, "programSet">,
  expected: "v1" | "v21",
  registryPath: string,
): void {
  const actual = registryProgramSet(registry);
  if (actual !== expected) {
    throw new Error(
      `registry ${registryPath} is programSet "${actual}" but this keeper runs program set "${expected}" ` +
        `(KEEPER_DEVNET_V21=${expected === "v21" ? "1" : "off"}). Point REGISTRY_PATH at the ${expected} registry ` +
        `(default ${DEFAULT_REGISTRY_FILE[expected]}); a keeper must never push/crank the other world's slabs.`,
    );
  }
}

/**
 * Boot-time load for a given program set. A missing v21 file starts empty and
 * TAGGED "v21" (so register-poll's first save writes the tag); anything on disk
 * must match the set.
 */
export function loadRegistryForProgramSet(registryPath: string, expected: "v1" | "v21"): Registry {
  const reg = loadRegistry(registryPath);
  if (expected === "v21" && !fs.existsSync(registryPath)) {
    return { ...reg, programSet: "v21", description: "Devnet v2.1 keeper (fresh-ID wrapper 5NGgnU2j)" };
  }
  assertRegistryProgramSet(reg, expected, registryPath);
  return reg;
}

const REGISTRY_VERSION = 1;

/**
 * Load the registry from a JSON file.
 * Returns an empty registry if the file does not exist.
 * Throws on malformed JSON or missing required fields.
 */
export function loadRegistry(registryPath: string): Registry {
  if (!fs.existsSync(registryPath)) {
    return {
      version: REGISTRY_VERSION,
      description:
        "Cross-cluster oracle keeper: devnet markets → mainnet pool price sources",
      markets: [],
    };
  }
  const raw = fs.readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<Registry>;
  if (typeof parsed.version !== "number" || !Array.isArray(parsed.markets)) {
    throw new Error(
      `Invalid registry at ${registryPath}: missing version or markets array`,
    );
  }
  return parsed as Registry;
}

/**
 * Save the registry to a JSON file.
 * Creates parent directories if necessary.
 */
export function saveRegistry(registry: Registry, registryPath: string): void {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify(registry, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Add or update a market entry.
 * If a market with the same `marketAddress` already exists it is replaced.
 * Returns the (possibly updated) entry.
 */
export function addMarket(
  registry: Registry,
  entry: Omit<MarketEntry, "registeredAt">,
): MarketEntry {
  const idx = registry.markets.findIndex(
    (m) => m.marketAddress === entry.marketAddress,
  );
  const full: MarketEntry = { ...entry, registeredAt: Date.now() };
  if (idx >= 0) {
    registry.markets[idx] = full;
  } else {
    registry.markets.push(full);
  }
  return full;
}

/**
 * Remove a market entry by its devnet address.
 * Returns true if an entry was removed, false if it was not found.
 */
export function removeMarket(
  registry: Registry,
  marketAddress: string,
): boolean {
  const before = registry.markets.length;
  registry.markets = registry.markets.filter(
    (m) => m.marketAddress !== marketAddress,
  );
  return registry.markets.length < before;
}
