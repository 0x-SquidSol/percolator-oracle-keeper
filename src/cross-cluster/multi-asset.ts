/**
 * cross-cluster/multi-asset.ts
 *
 * K-6: keeper support for MULTI-ASSET markets (one market account, several engine asset slots, each with its own
 * AUTH_MARK oracle profile, mark and accrual clock).
 *
 * Before this module the keeper pushed and cranked asset 0 only: a registry row named one `assetIndex`, every
 * observation crank carried the single hint `{asset 0}`, and the positioned set counted legs on asset 0. On the
 * 5-asset QA fixtures (2xhs…, 3vW8…) assets 1-4 therefore went stale within minutes (no push), never accrued (no
 * observation), and the market became resolvable by anyone (tag 39) once its stale window passed.
 *
 * REGISTRY SHAPE. A multi-asset market is ONE registry row with an `assets` list (see `AssetSource` in registry.ts):
 *   { "marketAddress": "2xhs…", "lpPortfolio": "6w14…", "label": "…", "assetIndex": 0,
 *     "assets": [ { "assetIndex": 0, "source": "pool", "poolAddress": "5rCf…", "dexType": "meteora-dlmm", "symbol": "SOL" },
 *                 { "assetIndex": 1, "source": "fixed", "fixedPriceE6": "100000000", "symbol": "SYN1" }, … ] }
 * A row WITHOUT `assets` is a single-asset market and behaves exactly as before (one push for `assetIndex`, the
 * observation hint `{asset 0}`, positioned = legs on asset 0, health keyed by the market address).
 *
 * WHAT CHANGES FOR A MULTI-ASSET ROW
 *   push      one price unit per listed asset (`priceUnitsOf`): its own source (pool or fixed), breaker, stats key
 *             (`<market>#<asset>`), authority check and nonce lane; all of them go into the normal size-chunked
 *             PushAuthMark batch (35 B each).
 *   crank     every observation crank (catch-up, accrue, protective probe) carries one hint per listed asset
 *             (`observationAssetsFor`), so every asset accrues in the same instruction. A hint is 3 B and the
 *             program accepts at most 16 (CRANK_OBSERVATION_DECODE_MAX); a hint naming a non-Active asset is
 *             accepted and records the committed price (v16_program.rs handle_permissionless_crank_zero_copy).
 *   catch-up  the accrual gap is the WORST observed Active/DrainOnly asset (`decodeMarketRefreshStateFor`), and the
 *             per-crank CU grows with the hint count (`catchupCrankCuFor`, `maxCatchupCranksFor`).
 *   refresh   positioned = portfolios holding a leg on ANY listed asset; stale / stored counts are summed.
 *   health    per-asset push staleness and accrual lag; one stale asset makes the market degraded.
 *
 * Only AUTH_MARK assets are supported on a multi-asset row (the oracle-leg tail of a Hybrid crank belongs to one
 * asset). The registry validator below refuses malformed rows; the keeper never guesses.
 */
import { PublicKey } from "@solana/web3.js";
import type { AssetSource, DexType, MarketEntry } from "./registry.ts";
import { decodeMarketRefreshState, isAssetLossStale } from "./positioned-refresh.ts";
import type { MarketRefreshState } from "./positioned-refresh.ts";

/** The single observation hint every single-asset market has always carried. */
export const SINGLE_ASSET_OBSERVATION: ReadonlyArray<number> = Object.freeze([0]);
/** CRANK_OBSERVATION_DECODE_MAX / V16_MAX_PORTFOLIO_ASSETS_N of the v2.2 wrapper (153c62fc). */
export const MAX_OBSERVATION_HINTS = 16;

const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;

// ── Registry rows -> price units ─────────────────────────────────────────────────────────────────────────────────

/** One thing the push loop prices and pushes: a whole single-asset market, or one asset of a multi-asset market. */
export interface PriceUnit {
  /**
   * Key of this unit's per-unit state (/health stats, circuit breaker, authority latch, landed set). EXACTLY the
   * market address for a single-asset row (so every existing map and /health key is unchanged), `<market>#<asset>`
   * for an asset of a multi-asset row.
   */
  key: string;
  marketAddress: string;
  assetIndex: number;
  label: string;
  /** True for an asset of a multi-asset row. */
  multi: boolean;
  source: "pool" | "fixed";
  /** Pool source: the mainnet pool. Fixed source: a synthetic id `fixed:<key>` that is never read from chain. */
  poolAddress: string;
  dexType: DexType | "fixed";
  mainnetCa?: string;
  symbol?: string;
  /** Fixed source: the mark to push every cycle (e6). */
  fixedPriceE6?: bigint;
}

/** Stats / breaker key of asset `assetIndex` of a multi-asset market. */
export function multiAssetKey(marketAddress: string, assetIndex: number): string {
  return `${marketAddress}#${assetIndex}`;
}

/** True when the row describes a multi-asset market. */
export function isMultiAssetEntry(entry: Pick<MarketEntry, "assets">): boolean {
  return Array.isArray(entry.assets) && entry.assets.length > 0;
}

/** Parse a fixed price (decimal integer string or safe integer, e6). Null when it is not a positive integer. */
export function parseFixedPriceE6(v: unknown): bigint | null {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    return BigInt(v);
  }
  if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) {
    const n = BigInt(v.trim());
    return n > 0n ? n : null;
  }
  return null;
}

/**
 * The price units of one registry row. A single-asset row yields exactly one unit whose key is the market address
 * and whose fields are the row's own; a multi-asset row yields one unit per listed asset, in asset order.
 * An asset that fails validation is skipped here (the validator reports it; see `validateMultiAssetEntry`).
 */
export function priceUnitsOf(entry: MarketEntry): PriceUnit[] {
  if (!isMultiAssetEntry(entry)) {
    return [
      {
        key: entry.marketAddress,
        marketAddress: entry.marketAddress,
        assetIndex: entry.assetIndex,
        label: entry.label,
        multi: false,
        source: "pool",
        poolAddress: entry.poolAddress ?? "",
        dexType: entry.dexType ?? "fixed",
        ...(entry.mainnetCa !== undefined ? { mainnetCa: entry.mainnetCa } : {}),
        ...(entry.symbol !== undefined ? { symbol: entry.symbol } : {}),
      },
    ];
  }
  const out: PriceUnit[] = [];
  for (const a of sortedAssets(entry.assets ?? [])) {
    if (assetSourceProblem(a) !== null) continue;
    const key = multiAssetKey(entry.marketAddress, a.assetIndex);
    const label = `${entry.label} [${a.assetIndex}${a.symbol ? ` ${a.symbol}` : ""}]`;
    if (a.source === "fixed") {
      out.push({
        key,
        marketAddress: entry.marketAddress,
        assetIndex: a.assetIndex,
        label,
        multi: true,
        source: "fixed",
        poolAddress: `fixed:${key}`,
        dexType: "fixed",
        fixedPriceE6: parseFixedPriceE6(a.fixedPriceE6) ?? undefined,
        ...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
      });
    } else {
      out.push({
        key,
        marketAddress: entry.marketAddress,
        assetIndex: a.assetIndex,
        label,
        multi: true,
        source: "pool",
        poolAddress: a.poolAddress as string,
        dexType: a.dexType as DexType,
        ...(a.mainnetCa !== undefined ? { mainnetCa: a.mainnetCa } : {}),
        ...(a.symbol !== undefined ? { symbol: a.symbol } : {}),
      });
    }
  }
  return out;
}

/** Every price unit of the registry, in registry order. */
export function priceUnitsOfRegistry(markets: ReadonlyArray<MarketEntry>): PriceUnit[] {
  return markets.flatMap((m) => priceUnitsOf(m));
}

function sortedAssets(assets: ReadonlyArray<AssetSource>): AssetSource[] {
  return [...assets].sort((x, y) => x.assetIndex - y.assetIndex);
}

const DEX_TYPES: ReadonlySet<string> = new Set(["raydium-clmm", "meteora-dlmm", "pumpswap"]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Why one asset row is unusable, or null. */
export function assetSourceProblem(a: AssetSource): string | null {
  if (!Number.isInteger(a.assetIndex) || a.assetIndex < 0 || a.assetIndex >= MAX_OBSERVATION_HINTS) {
    return `assetIndex ${String(a.assetIndex)} is not an integer in [0, ${MAX_OBSERVATION_HINTS})`;
  }
  if (a.source === "fixed") {
    if (parseFixedPriceE6(a.fixedPriceE6) === null) return `asset ${a.assetIndex}: fixed source needs a positive integer fixedPriceE6`;
    return null;
  }
  if (a.source === "pool") {
    if (typeof a.poolAddress !== "string" || !BASE58.test(a.poolAddress)) return `asset ${a.assetIndex}: pool source needs a base58 poolAddress`;
    if (typeof a.dexType !== "string" || !DEX_TYPES.has(a.dexType)) return `asset ${a.assetIndex}: unknown dexType ${String(a.dexType)}`;
    return null;
  }
  return `asset ${a.assetIndex}: unknown source ${String((a as { source?: unknown }).source)} (expected "pool" or "fixed")`;
}

/** Every problem with a multi-asset row (empty = valid). A single-asset row is always valid here. */
export function validateMultiAssetEntry(entry: Pick<MarketEntry, "assets" | "label" | "marketAddress">): string[] {
  if (entry.assets === undefined) return [];
  if (!Array.isArray(entry.assets) || entry.assets.length === 0) return [`${entry.label}: "assets" must be a non-empty list`];
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const a of entry.assets) {
    const p = assetSourceProblem(a);
    if (p) problems.push(`${entry.label}: ${p}`);
    if (seen.has(a.assetIndex)) problems.push(`${entry.label}: asset ${a.assetIndex} listed twice`);
    seen.add(a.assetIndex);
  }
  if (entry.assets.length > MAX_OBSERVATION_HINTS) problems.push(`${entry.label}: ${entry.assets.length} assets > ${MAX_OBSERVATION_HINTS} observation hints`);
  return problems;
}

function isPubkey(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every problem with the registry's rows (empty = valid): the shape every consumer assumes (the preflight's row checks,
 * without its RPC owner check). Run at boot and on every hot-reload, so a bad row is refused before a push batch or a
 * crank parses it: one unparsable marketAddress used to fail the whole PushAuthMark batch (every market) every cycle.
 */
export function registryRowProblems(markets: ReadonlyArray<MarketEntry>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of markets) {
    const who = m?.label ?? "?";
    if (!isPubkey(m?.marketAddress)) {
      problems.push(`${who}: marketAddress ${String(m?.marketAddress)} is not a public key`);
      continue;
    }
    if (seen.has(m.marketAddress)) problems.push(`${who}: duplicate marketAddress ${m.marketAddress}`);
    seen.add(m.marketAddress);
    if (m.assets !== undefined) {
      problems.push(...validateMultiAssetEntry(m));
      continue;
    }
    if (!isPubkey(m.poolAddress)) problems.push(`${who}: poolAddress ${String(m.poolAddress)} is not a public key`);
    if (typeof m.dexType !== "string" || !DEX_TYPES.has(m.dexType)) problems.push(`${who}: unknown dexType ${String(m.dexType)}`);
  }
  return problems;
}

// ── Observation hints (which assets each observation crank accrues) ─────────────────────────────────────────────

let registryMarkets: (() => ReadonlyArray<MarketEntry>) | null = null;

/**
 * Bind the live registry (hot-reloaded in place). Called once at boot by cross-cluster.ts. Unbound (every unit test
 * that does not opt in) every market observes asset 0 only, which is the pre-K-6 behaviour.
 */
export function bindObservationRegistry(markets: (() => ReadonlyArray<MarketEntry>) | null): void {
  registryMarkets = markets;
}

/**
 * The asset indices an observation crank on `marketAddress` must carry, ascending. `[0]` for a single-asset market
 * (byte-identical to every crank the keeper has sent), every listed asset for a multi-asset row.
 */
export function observationAssetsFor(marketAddress: string): ReadonlyArray<number> {
  const markets = registryMarkets?.();
  if (!markets) return SINGLE_ASSET_OBSERVATION;
  for (const m of markets) {
    if (m.marketAddress !== marketAddress) continue;
    if (!isMultiAssetEntry(m)) return SINGLE_ASSET_OBSERVATION;
    const idx = [...new Set(sortedAssets(m.assets ?? []).filter((a) => assetSourceProblem(a) === null).map((a) => a.assetIndex))];
    return idx.length > 0 ? idx.slice(0, MAX_OBSERVATION_HINTS) : SINGLE_ASSET_OBSERVATION;
  }
  return SINGLE_ASSET_OBSERVATION;
}

/** True when `marketAddress` is a multi-asset registry row (more than the single asset-0 hint). */
export function isMultiAssetMarket(marketAddress: string): boolean {
  return observationAssetsFor(marketAddress) !== SINGLE_ASSET_OBSERVATION;
}

/**
 * The CrankObservationHint list for an observation crank: one per asset. The oracle-leg tail (Hybrid) is declared on
 * the FIRST hint only; on a multi-asset (AUTH_MARK-only) market it is empty and every hint declares 0 accounts.
 */
export function observationHints(assets: ReadonlyArray<number>, oracleAccounts: number): Array<{ assetIndex: number; oracleAccounts: number }> {
  return assets.map((assetIndex, i) => ({ assetIndex, oracleAccounts: i === 0 ? oracleAccounts : 0 }));
}

// ── CU of multi-hint cranks ────────────────────────────────────────────────────────────────────────────────────

/**
 * Extra CU of one observation crank per hinted asset beyond the first. Sized from devnet: 18 catch-up cranks observing
 * 5 assets plus 5 pushes landed in ~1.25M CU on 2xhs (~69k per crank against ~27.5k single-asset), i.e. ~10.5k per
 * extra hinted asset; 12k leaves margin. Re-measured by the K-6 simulation (ledger R3.22).
 */
export const EXTRA_HINT_CATCHUP_CU = 12_000;
/** Extra CU of an ACCRUING observation crank per extra hinted asset (a full accrual + mark move per asset). */
export const EXTRA_HINT_ACCRUE_CU = 40_000;

/** CU of one catch-up crank carrying `hints` observations (`base` = the single-asset figure). */
export function catchupCrankCuFor(base: number, hints: number): number {
  return base + Math.max(0, hints - 1) * EXTRA_HINT_CATCHUP_CU;
}

/** CU of one accrual crank carrying `hints` observations (`base` = the single-asset figure). */
export function accrueCrankCuFor(base: number, hints: number): number {
  return base + Math.max(0, hints - 1) * EXTRA_HINT_ACCRUE_CU;
}

/**
 * Most catch-up cranks one transaction can carry at `hints` observations each: what fits `budget` CU at
 * `catchupCrankCuFor`, never more than `singleAssetCap` (the packet-size cap), never fewer than 1.
 * v22price 2026-10-22: the single-asset count is CU-capped too. It used to return `singleAssetCap` (40) for one hint,
 * which at the real v2.2 cost (36.35k per crank) overflows 1.4M.
 */
export function maxCatchupCranksFor(singleAssetCap: number, base: number, hints: number, budget: number): number {
  return Math.max(1, Math.min(singleAssetCap, Math.floor(budget / catchupCrankCuFor(base, hints))));
}

// ── Refresh state over several assets ──────────────────────────────────────────────────────────────────────────

/** Per-asset refresh state of the observed assets (asset order). Assets out of range are skipped. */
export function decodeAssetRefreshStates(data: Uint8Array, assets: ReadonlyArray<number>): Array<{ assetIndex: number; state: MarketRefreshState }> {
  const out: Array<{ assetIndex: number; state: MarketRefreshState }> = [];
  for (const assetIndex of assets) {
    try {
      out.push({ assetIndex, state: decodeMarketRefreshState(data, assetIndex) });
    } catch {
      // out of range for this account: not an asset of this market
    }
  }
  return out;
}

/**
 * One MarketRefreshState for the cranker and the v2.2 layer, over every observed asset. For `[0]` this is EXACTLY
 * `decodeMarketRefreshState(data)` (single-asset behaviour). Otherwise:
 *   - header words (currentSlot, maxAccrualDtSlots, lossStaleActive) are shared;
 *   - lifecycle / K-F epochs are asset 0's (the market-level gate the callers already apply);
 *   - stored / stale counts are SUMMED (they match a positioned set built over the same assets);
 *   - slotLast is the OLDEST Active/DrainOnly observed asset (what the catch-up must cover);
 *   - contributesToLossStale is true iff some asset is loss-stale by the clock, so `isAssetLossStale` on the result
 *     equals "some observed asset is loss-stale".
 * Throws like decodeMarketRefreshState when asset 0 cannot be decoded.
 */
export function decodeMarketRefreshStateFor(data: Uint8Array, assets: ReadonlyArray<number>): MarketRefreshState {
  if (assets.length === 1 && assets[0] === 0) return decodeMarketRefreshState(data);
  const base = decodeMarketRefreshState(data);
  const per = decodeAssetRefreshStates(data, assets);
  if (per.length === 0) return base;
  let storedPosLong = 0n;
  let storedPosShort = 0n;
  let staleLong = 0n;
  let staleShort = 0n;
  let clockStale = false;
  let oldestActive: bigint | null = null;
  for (const { state: s } of per) {
    storedPosLong += s.storedPosLong;
    storedPosShort += s.storedPosShort;
    staleLong += s.staleLong;
    staleShort += s.staleShort;
    if (s.contributesToLossStale && s.slotLast < s.currentSlot) clockStale = true;
    if (s.lifecycle === LIFECYCLE_ACTIVE || s.lifecycle === LIFECYCLE_DRAIN_ONLY) {
      if (oldestActive === null || s.slotLast < oldestActive) oldestActive = s.slotLast;
    }
  }
  const slotLast = oldestActive ?? base.slotLast;
  return {
    ...base,
    slotLast,
    storedPosLong,
    storedPosShort,
    staleLong,
    staleShort,
    // With clockStale false the result must not read loss-stale through the clock even when the OLDEST asset is
    // behind (that asset holds nothing); with it true, slotLast (the oldest) is < currentSlot by construction.
    contributesToLossStale: clockStale,
  };
}

/** The refresh state of `marketAddress`'s observed assets (see decodeMarketRefreshStateFor). */
export function refreshStateForMarket(data: Uint8Array, marketAddress: string): MarketRefreshState {
  return decodeMarketRefreshStateFor(data, observationAssetsFor(marketAddress));
}

// ── Per-asset accrual health ───────────────────────────────────────────────────────────────────────────────────

export interface AssetAccrualSample {
  assetIndex: number;
  lifecycle: number;
  slotLast: bigint;
  /** chain slot of the read - slotLast (0 when the asset is ahead of the read). */
  lagSlots: number;
  lossStale: boolean;
}

export interface MarketAccrualSample {
  readSlot: bigint;
  atMs: number;
  assets: AssetAccrualSample[];
}

const accrualByMarket = new Map<string, MarketAccrualSample>();

/** Per-asset accrual of `data` at `readSlot` over `assets`. Pure. */
export function sampleAssetAccrual(data: Uint8Array, assets: ReadonlyArray<number>, readSlot: bigint, atMs: number): MarketAccrualSample {
  return {
    readSlot,
    atMs,
    assets: decodeAssetRefreshStates(data, assets).map(({ assetIndex, state }) => ({
      assetIndex,
      lifecycle: state.lifecycle,
      slotLast: state.slotLast,
      lagSlots: readSlot > state.slotLast ? Number(readSlot - state.slotLast) : 0,
      lossStale: isAssetLossStale(state),
    })),
  };
}

/** Record the cranker's latest read of a MULTI-ASSET market (single-asset markets are not recorded). Never throws. */
export function recordMarketAccrual(marketAddress: string, data: Uint8Array, readSlot: bigint, atMs: number = Date.now()): void {
  try {
    if (!isMultiAssetMarket(marketAddress)) return;
    accrualByMarket.set(marketAddress, sampleAssetAccrual(data, observationAssetsFor(marketAddress), readSlot, atMs));
  } catch {
    // health only
  }
}

export function getMarketAccrual(marketAddress: string): MarketAccrualSample | undefined {
  return accrualByMarket.get(marketAddress);
}

/** Drop the accrual samples of markets no longer registered. */
export function pruneMarketAccrual(keep: ReadonlySet<string>): void {
  for (const m of [...accrualByMarket.keys()]) if (!keep.has(m)) accrualByMarket.delete(m);
}

/** Test hook. */
export function resetMultiAssetState(): void {
  accrualByMarket.clear();
  registryMarkets = null;
}

/**
 * Assets whose accrual lags the chain by `lagWarnSlots` or more (Active / DrainOnly only: a Disabled asset never
 * accrues by design), from the latest sample. Empty when there is no sample.
 */
export function laggingAssets(sample: MarketAccrualSample | undefined, lagWarnSlots: number): number[] {
  if (!sample) return [];
  return sample.assets
    .filter((a) => (a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY) && a.lagSlots >= lagWarnSlots)
    .map((a) => a.assetIndex);
}
