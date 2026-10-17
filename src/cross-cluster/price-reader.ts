/**
 * cross-cluster/price-reader.ts
 *
 * Reads spot prices from mainnet DEX pools using the @percolatorct/sdk
 * dex-oracle module (detectDexType / parseDexPool / computeDexSpotPriceE6 /
 * fetchMintDecimals).
 *
 * Supported DEX types:
 *   raydium-clmm   price from sqrtPriceX64 (decimals embedded in pool data)
 *   meteora-dlmm   price from active_id/bin_step (caller-supplied decimals, cached)
 *   pumpswap       price from vault token reserves, decimal-adjusted, converted
 *                  to USD via the registry's SOL/USD reference market (see
 *                  `isSolUsdEntry` below) when the pool is WSOL-quoted (almost
 *                  always). Base/quote mint decimals are cached the same way
 *                  as Meteora's.
 *
 * Liveness checks — returns priceE6=0n + skipped=true on:
 *   - Pool account not found or empty data
 *   - On-chain pool owner does not match expected dexType
 *   - computeDexSpotPriceE6 returns 0n (sqrtPrice=0 / binStep=0 / base-amount=0)
 *   - PumpSwap: either vault amount === 0, or the pool is WSOL-quoted and no
 *     SOL/USD price was available this cycle (the reference market's own read
 *     failed/was skipped), or the quote is neither WSOL nor a USD stable
 *     (quoteIsNotUsdOrWsol)
 *   - Meteora DLMM: the quote is neither WSOL nor a USD stable (quoteIsNotUsdOrWsol)
 *
 * RPC error handling:
 *   - HTTP 429 (rate-limit): exponential back-off with 20 % jitter (0.5 → 1 → 2 → 4 s)
 *   - Other errors: propagated to the caller (per-market isolation in the loop)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { AccountInfo, RpcResponseAndContext } from "@solana/web3.js";
import {
  detectDexType,
  parseDexPool,
  computeDexSpotPriceE6,
  fetchMintDecimals,
  SPL_MINT_DECIMALS_OFFSET,
  WSOL_MINT,
} from "@percolatorct/sdk";
import type { PoolPriceSource } from "./registry.ts";
import { redactErrorText } from "./v22/redact.ts";

/** Per-pool cached mint decimals (keyed by pool address string). */
export type DecimalsCache = Map<string, { base: number; quote: number }>;

/**
 * True when `entry` is (by convention) this registry's SOL/USD reference
 * market — a raydium-clmm or meteora-dlmm pool whose computed price is
 * treated as the current SOL/USD rate for the cycle. PumpSwap pools quote in
 * WSOL, not USD, so converting them to USD requires resolving this price
 * first (see {@link readAllPoolPricesE6} and {@link readPoolPriceE6}).
 *
 * Matches on `symbol === "SOL/USDC"` / `"SOL/USDT"` (the convention used by
 * every pre-seeded registry.json entry and by register-poll.ts), falling
 * back to a `label` prefix check for entries that lack `symbol`.
 */
export function isSolUsdEntry(entry: Pick<PoolPriceSource, "dexType" | "label" | "symbol">): boolean {
  if (entry.dexType !== "raydium-clmm" && entry.dexType !== "meteora-dlmm") return false;
  const sym = (entry.symbol ?? "").toUpperCase();
  if (sym === "SOL/USDC" || sym === "SOL/USDT") return true;
  const label = (entry.label ?? "").toUpperCase();
  return label.startsWith("SOL/USDC") || label.startsWith("SOL/USDT");
}

/**
 * USD price (e6) of a WSOL-quoted Meteora DLMM pool.
 *
 * WHY THIS EXISTS: `computeDexSpotPriceE6` returns the price in the pool's
 * QUOTE asset. For a TOKEN/USDC pool that is already USD, but for a TOKEN/SOL
 * pool it is a price in SOL. The SDK applies the WSOL->USD conversion for
 * `pumpswap` ONLY (see its `solPriceE6` param docs) — Meteora had no such
 * path, so every WSOL-quoted Meteora market published a SOL-denominated price
 * mislabeled as USD, low by the whole SOL/USD rate (~80x).
 *
 * Real impact (devnet, 2026-07-29): market 5sDvEs2… (Fauci, meteora-dlmm,
 * WSOL-quoted) published $0.000011 while the token traded at $0.000943. The
 * LP guardrails written at creation are a fixed TOKEN count, so an 80x-low
 * price shrank that market's per-trade cap from $1,000 to $9.57 and every
 * trade above it failed with a bare `InvalidAccountData`.
 *
 * PRECISION: the naive fix — multiply the e6 SOL price by solPriceE6 — is
 * badly lossy for cheap tokens. Fauci's SOL price is 0.00001286, which is
 * just `12` in e6; converting from that quantized integer lands 5-8% off.
 * Meteora's price scales as `10^(baseDecimals - quoteDecimals)` (see the SDK's
 * computeMeteoraDlmmPriceE6), so asking for 6 EXTRA base decimals returns the
 * same price at e12 instead of e6. Converting from e12 reproduces $0.000943
 * exactly. We inflate `base` rather than deflating `quote` so the argument can
 * never go negative for a low-decimal quote mint.
 */
/**
 * Mainnet USD-stable mints. A pool is USD-denominated only when its QUOTE side
 * is one of these.
 */
const USD_STABLE_MINTS: ReadonlySet<string> = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/**
 * True when a raydium-clmm pool's price cannot be trusted as USD.
 *
 * `computeRaydiumClmmPriceE6` returns "mint1 per mint0", and Raydium CLMM
 * orders those two mints by PUBKEY rather than by meaning. So for a token
 * paired against SOL, WSOL lands on either side depending on the other token's
 * address: when WSOL is mint0 the price reads token-per-SOL, when WSOL is
 * mint1 it reads SOL-per-token. One needs a multiply by SOL/USD, the other an
 * invert — and publishing either convention for both would be ~80x wrong half
 * the time. Until the conversion handles both orientations, only pools whose
 * QUOTE (mint1) is a USD stable are published.
 *
 * This deliberately still allows the registry's SOL/USD reference pool
 * (WSOL=mint0, USDC=mint1 -> USDC per SOL = a real USD price), which every
 * pumpswap and WSOL-quoted-Meteora conversion depends on.
 */
export function raydiumPriceIsNotUsd(quoteMint: PublicKey): boolean {
  return !USD_STABLE_MINTS.has(quoteMint.toBase58());
}

/**
 * True when a pumpswap or meteora-dlmm pool's price cannot be turned into USD.
 *
 * Both price as quote-per-base, and only a WSOL quote is converted (via
 * SOL/USD). Any other non-stable quote (COLLECT's CARDS, Murphy's DOGE-quoted
 * pool) comes back in QUOTE-TOKEN units — publishing it as USD was ~4.5x/~10x
 * high. Refused until there is a quote->USD conversion for that token.
 * (Raydium has no WSOL conversion, so it keeps raydiumPriceIsNotUsd.)
 */
/**
 * S3-B1 (audit 2026-10-17): a pool may serve as THE SOL/USD rate only if it really is WSOL priced in a USD stable.
 * `isSolUsdEntry` matches a display symbol / label, which a DB row derives from its creator-supplied symbol
 * (db-markets.ts: label `${symbol}/USDC — …`), so it can never be the only test.
 */
export function poolIsSolUsd(baseMint: PublicKey, quoteMint: PublicKey): boolean {
  return baseMint.equals(WSOL_MINT) && !raydiumPriceIsNotUsd(quoteMint);
}

export function quoteIsNotUsdOrWsol(quoteMint: PublicKey): boolean {
  return !quoteMint.equals(WSOL_MINT) && raydiumPriceIsNotUsd(quoteMint);
}

/** The /health-facing reason a pool was refused by quoteIsNotUsdOrWsol. */
export function nonUsdQuoteSkipReason(dex: string, quoteMint: PublicKey): string {
  return `${dex} quote mint ${quoteMint.toBase58()} is neither WSOL nor a USD stable — price is not USD, refused`;
}

/** The same conversion kept at e12 (USD per token x 1e12): `nativeE12 (SOL per token) x solPriceE6 / 1e6`. */
export function meteoraWsolPriceToUsdE12(
  poolData: Uint8Array,
  decimals: { base: number; quote: number },
  solPriceE6: bigint,
): bigint {
  const nativeE12 = computeDexSpotPriceE6("meteora-dlmm", poolData, undefined, {
    base: decimals.base + 6,
    quote: decimals.quote,
  });
  if (nativeE12 <= 0n) return 0n;
  return (nativeE12 * solPriceE6) / 1_000_000n;
}

export function meteoraWsolPriceToUsdE6(
  poolData: Uint8Array,
  decimals: { base: number; quote: number },
  solPriceE6: bigint,
): bigint {
  const nativeE12 = computeDexSpotPriceE6("meteora-dlmm", poolData, undefined, {
    base: decimals.base + 6,
    quote: decimals.quote,
  });
  if (nativeE12 <= 0n) return 0n;
  return (nativeE12 * solPriceE6) / 1_000_000_000_000n;
}

/**
 * #112 — the SDK prices a WSOL-quoted pumpswap pool as
 * `quotePerBaseE6 * solPriceE6 / 1e6`, truncating the SOL price to whole
 * micro-SOL first (the trap meteoraWsolPriceToUsdE6 above documents). SOLCAT at
 * 1.81e-6 SOL read as `1`, so its mark halved (235 -> 117) the moment it crossed
 * 2e-6 SOL; the breaker refused that phantom 50% drop and the market silently
 * stopped being pushed. 6 extra base decimals return the price at e12 (WSOL- or
 * USD-stable-quoted alike); callers divide by 1e6 once, at the end.
 *
 * Ceiling: the SDK caps decimals at 24, so a base mint with more than 18
 * decimals is now rejected and skipped. Every pumpswap market today is 6dp.
 * Once the SDK multiplies by the SOL price before dividing, this can go.
 */
function pumpswapE12Decimals(dec: { base: number; quote: number }): { base: number; quote: number } {
  return { base: dec.base + 6, quote: dec.quote };
}

export interface PriceReadResult {
  priceE6: bigint;
  /** Short description of the price source, e.g. "raydium-clmm:8sLbN…". */
  source: string;
  /** True when the pool was skipped due to a liveness/validation check. */
  skipped?: boolean;
  skipReason?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const MAX_RETRIES = 4;

function is429(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("429") || msg.includes("too many requests");
}

/**
 * Retry an RPC call only on 429 errors; propagate everything else immediately.
 * Delay sequence: 500 ms → 1 s → 2 s → 4 s (with 20 % jitter each step).
 */
async function withRpcBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delayMs = 500;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (is429(err) && attempt < MAX_RETRIES - 1) {
        const jitter = Math.floor(Math.random() * 0.2 * delayMs);
        const wait = delayMs + jitter;
        console.warn(
          `[price-reader] RPC 429 — backoff ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        delayMs = Math.min(delayMs * 2, 8_000);
      } else {
        throw err;
      }
    }
  }
  /* istanbul ignore next */
  throw new Error("unreachable");
}

// ── Slot-consistency watermark ───────────────────────────────────────────────
//
// WHY THIS EXISTS (2026-07-31, the CATE LP drain)
// A load-balanced RPC endpoint can serve consecutive requests from different
// backend nodes, and a lagging node returns account state from a slot we have
// ALREADY MOVED PAST. For a fast-moving pool that showed up as the published
// price flapping between two levels ~1.6% apart (fresh vs ~1-minute-stale
// vault balances) for MINUTES — and the engine converts price oscillation
// into permanent LP losses (losses realize in full; gains for an underwater
// account are support-gated and vaporize). That one-way ratchet drained the
// CATE LP's entire $1,000 seed and pushed it $900+ underwater while the real
// price went nowhere.
//
// THE FIX: every mainnet pricing read carries `minContextSlot` = the highest
// context slot this process has already observed from that endpoint. A node
// that is behind must either catch up or return the JSON-RPC "Minimum context
// slot has not been reached" error — it can never silently hand us the past.
// On that error we retry briefly (the LB usually routes elsewhere); if the
// endpoint stays behind we throw and the cycle is skipped, holding the last
// published price. Holding for 7s is strictly safer than publishing stale.
//
// A median/EWMA filter was deliberately NOT used instead: with an alternating
// fresh/stale pair, median-of-3 still flips levels — slot monotonicity kills
// the failure mode by construction.
const slotWatermarks = new Map<string, number>();

/**
 * Poisoned-watermark escape hatch. A single node reporting an INFLATED
 * context.slot would raise the watermark above the real chain tip — and then
 * every honest node fails the minimum-context-slot check forever: pricing
 * freezes until a human restarts the process, and frozen prices eventually
 * deep-stale the on-chain markets (the exact class of outage this file
 * exists to prevent). So: after MAX_CONSECUTIVE_MIN_SLOT_FAILURES reads in a
 * row die on the min-slot check, the endpoint's watermark is DROPPED and
 * rebuilt from the next response. Damage from a real poisoning is bounded to
 * ~3 skipped reads (~20s of held prices); the one stale read that could slip
 * through right after a reset is exactly what the downstream median smoother
 * absorbs. Failures counted here are ONLY min-slot rejections — 429s and
 * network errors never touch the watermark.
 */
const consecutiveMinSlotFailures = new Map<string, number>();
const MAX_CONSECUTIVE_MIN_SLOT_FAILURES = 3;

/** Test hook: forget every endpoint's watermark. */
export function resetSlotWatermarksForTests(): void {
  slotWatermarks.clear();
  consecutiveMinSlotFailures.clear();
}

function isMinContextSlotError(err: unknown): boolean {
  // Match the JSON-RPC code (-32016) FIRST: providers and proxies reword the
  // message, and a reworded rejection that fails this predicate would skip
  // both the retry AND the poisoned-watermark counter — reopening the
  // permanent-freeze path this file exists to close. web3.js surfaces the
  // code on SolanaJSONRPCError; the text match stays as a fallback for
  // wrappers that swallow it.
  if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === -32016) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("minimum context slot");
}

const MIN_SLOT_RETRIES = 3;
const MIN_SLOT_RETRY_DELAY_MS = 250;

/**
 * Run a `...AndContext` read pinned to this endpoint's slot watermark, then
 * advance the watermark to the slot the response was served at.
 *
 * The `read` callback MUST forward `minContextSlot` to the RPC call — that is
 * the entire point. Composes with {@link withRpcBackoff} (backoff outside,
 * watermark inside): 429s keep their existing retry policy.
 */
export async function readAtWatermark<T>(
  conn: Connection,
  read: (minContextSlot: number | undefined) => Promise<RpcResponseAndContext<T>>,
): Promise<T> {
  const key = conn.rpcEndpoint;
  for (let attempt = 0; ; attempt++) {
    const watermark = slotWatermarks.get(key);
    try {
      const res = await read(watermark);
      // ENFORCE client-side too: a provider that silently ignores
      // `minContextSlot` would otherwise hand us the past without the error
      // this loop retries on. A response served below the requested slot is
      // treated exactly like the server-side rejection.
      if (watermark !== undefined && res.context.slot < watermark) {
        throw new Error(
          `Minimum context slot has not been reached (served ${res.context.slot} < watermark ${watermark})`,
        );
      }
      // Re-read at set time: two concurrent reads may resolve out of order and
      // the later .set must not lower the mark the earlier one just raised.
      const current = slotWatermarks.get(key);
      if (current === undefined || res.context.slot > current) {
        slotWatermarks.set(key, res.context.slot);
      }
      consecutiveMinSlotFailures.delete(key);
      return res.value;
    } catch (err) {
      if (isMinContextSlotError(err) && attempt < MIN_SLOT_RETRIES - 1) {
        console.warn(
          `[price-reader] RPC node behind watermark ${watermark} — retrying` +
            ` (attempt ${attempt + 1}/${MIN_SLOT_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, MIN_SLOT_RETRY_DELAY_MS));
        continue;
      }
      if (isMinContextSlotError(err)) {
        const fails = (consecutiveMinSlotFailures.get(key) ?? 0) + 1;
        consecutiveMinSlotFailures.set(key, fails);
        if (fails >= MAX_CONSECUTIVE_MIN_SLOT_FAILURES) {
          console.error(
            `[price-reader] ${fails} consecutive reads rejected below watermark ` +
              `${slotWatermarks.get(key)} on ${redactErrorText(key)} — watermark likely poisoned by an ` +
              `inflated context slot. DROPPING it; the next response rebuilds it.`,
          );
          slotWatermarks.delete(key);
          consecutiveMinSlotFailures.delete(key);
        }
      }
      throw err;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the spot price (in e6) from a mainnet DEX pool.
 *
 * For Meteora DLMM and PumpSwap, mint decimals are fetched once and cached in
 * `decimalsCache`. Pass the same Map across all calls in a keeper cycle.
 *
 * For PumpSwap, both vault accounts are fetched on every call so the price
 * always reflects the current reserve balance. An explicit base-vault-amount=0
 * check guards against un-seeded pools that would produce a divide-by-zero.
 * PumpSwap pools quote in WSOL almost universally, so `solPriceE6` (the
 * current SOL/USD price, e6) is REQUIRED to produce a USD price for those —
 * callers should resolve it from this registry's SOL/USD reference market
 * (see {@link isSolUsdEntry}) before calling this for a pumpswap entry. A
 * WSOL-quoted pool with no `solPriceE6` supplied is skipped (not thrown).
 *
 * A returned `skipped=true` result means the pool is not live or failed a
 * validation check — the caller should skip pushing this market for the cycle.
 */
/**
 * #100 — bind the market's token to the pool actually being priced.
 *
 * A creator supplies `dex_pool_address` freely. Until now nothing checked that
 * the pool prices the token the market is FOR: `baseMint` was parsed but used
 * only to fetch decimals, never compared to anything. A pool for an entirely
 * different token was therefore accepted as the AuthMark every trade in that
 * market settles against — not merely a thin pool, the wrong asset.
 *
 * The market's token must appear on one side of the pair. Either side is
 * legitimate: a TOKEN/USDC pool has it as base, a WSOL/TOKEN pool as quote.
 *
 * Absent `mainnetCa` returns ok. That is deliberate and it is a real gap, not an
 * oversight: pre-seeded registry.json entries predate the column, and failing
 * them closed would take live markets offline. It is recorded on #100 rather
 * than hidden here — the binding protects every market the DB registers, which
 * is every market a creator can add.
 */
export function checkMintBinding(
  mainnetCa: string | undefined,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): { ok: true } | { ok: false; reason: string } {
  if (!mainnetCa) return { ok: true };
  const base = baseMint.toBase58();
  const quote = quoteMint.toBase58();
  // S3-B2 (audit 2026-10-17): the token must be the BASE, i.e. the side the published price is for. Every reader
  // here publishes quote-per-base and only accepts a WSOL / USD-stable quote, so a quote-side match only ever passed
  // when the market is FOR WSOL (or a stable) and the pool prices a DIFFERENT token (a "SOL" market on a MEME/WSOL
  // pool published MEME's price).
  if (mainnetCa === base) return { ok: true };
  return {
    ok: false,
    reason:
      mainnetCa === quote
        ? `pool prices the WRONG TOKEN: market mainnet_ca ${mainnetCa} is the pool's QUOTE, the price is for ` +
          `base ${base}. Refusing to use it as the AuthMark.`
        : `pool prices the WRONG TOKEN: market mainnet_ca ${mainnetCa} is neither ` +
          `base ${base} nor quote ${quote}. Refusing to use it as the AuthMark.`,
  };
}

/** SPL token-account minimum length for the amount field at offset 64. */
const MIN_VAULT_LEN = 72;

/**
 * #100 — quote-side depth of a PumpSwap pool, in USD (E6).
 *
 * The floor answers "how much USD does it take to move this mark", so the quote
 * reserve is the right measure: it is what an attacker must put up to shift the
 * pool. Base-side depth is denominated in the very token whose price is in doubt,
 * so it cannot bound the cost of manipulating it.
 *
 * Returns null when the depth cannot be established — an unreadable vault or a
 * WSOL-quoted pool with no SOL/USD rate this cycle. Callers MUST treat null as
 * "unknown", not "fine": a floor that passes when it cannot measure is not a floor.
 *
 * Only PumpSwap is supported, and that is not an arbitrary limitation:
 * `parseDexPool` exposes `baseVault`/`quoteVault` for pumpswap ONLY. Raydium CLMM
 * prices from `sqrtPrice` and Meteora DLMM from `binStep`; neither returns vault
 * addresses, so there are no reserves to read without extending the SDK. Every
 * market currently registered is pumpswap, so this covers the live board.
 */
export function pumpswapQuoteDepthUsdE6(
  quoteVaultData: Uint8Array,
  quoteDecimals: number,
  quoteMint: PublicKey,
  solPriceE6: bigint | undefined,
): bigint | null {
  // A quote that is neither WSOL nor a USD stable has no known USD value.
  if (quoteIsNotUsdOrWsol(quoteMint)) return null;
  const isWsolQuoted = quoteMint.equals(WSOL_MINT);
  if (quoteVaultData.length < MIN_VAULT_LEN) return null;
  const dv = new DataView(
    quoteVaultData.buffer,
    quoteVaultData.byteOffset,
    quoteVaultData.byteLength,
  );
  const amount =
    BigInt(dv.getUint32(64, true)) | (BigInt(dv.getUint32(68, true)) << 32n);
  if (amount === 0n) return 0n;

  const scale = 10n ** BigInt(quoteDecimals);
  if (isWsolQuoted) {
    if (solPriceE6 === undefined || solPriceE6 <= 0n) return null;
    // amount(lamports) / 10^dec * solUsdE6  -> USD E6
    return (amount * solPriceE6) / scale;
  }
  // USD-stable quote: 1 unit ~= $1. amount / 10^dec * 1e6 -> USD E6
  return (amount * 1_000_000n) / scale;
}

/**
 * #100 — the configured minimum, in USD E6. 0 disables the floor.
 *
 * Deliberately defaults to OFF and announces it at boot. A floor is a policy
 * number that depends on the depth of the markets actually listed, and across
 * this repo's history NO liquidity floor has ever existed — so there is no prior
 * value to restore and nothing to infer. Guessing one silently could refuse
 * legitimate markets; defaulting to off silently would be a guard that guards
 * nothing. Announcing it is the honest middle.
 */
export const MIN_POOL_LIQUIDITY_USD_E6: bigint = (() => {
  const raw = (process.env.MIN_POOL_LIQUIDITY_USD ?? "").trim();
  if (raw === "") return 0n;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(
      `MIN_POOL_LIQUIDITY_USD must be a non-negative decimal USD amount (got: ${JSON.stringify(raw)})`,
    );
  }
  const [whole, frac = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
})();

export async function readPoolPriceE6(
  mainnetConn: Connection,
  entry: Pick<PoolPriceSource, "poolAddress" | "dexType" | "label" | "mainnetCa">,
  decimalsCache: DecimalsCache,
  solPriceE6?: bigint,
): Promise<PriceReadResult> {
  const poolPk = new PublicKey(entry.poolAddress);
  const shortPool = entry.poolAddress.slice(0, 8) + "…";
  const source = `${entry.dexType}:${shortPool}`;

  // ── Fetch pool account ────────────────────────────────────────────────────
  const poolInfo = await withRpcBackoff(() =>
    readAtWatermark(mainnetConn, (minContextSlot) =>
      mainnetConn.getAccountInfoAndContext(poolPk, { commitment: "confirmed", minContextSlot }),
    ),
  );
  if (!poolInfo) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason: "pool account not found on mainnet",
    };
  }
  if (poolInfo.data.length === 0) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason: "pool account has empty data",
    };
  }
  const data = new Uint8Array(poolInfo.data);

  // ── Validate owner matches expected DEX type ──────────────────────────────
  const detectedDex = detectDexType(poolInfo.owner);
  if (detectedDex !== entry.dexType) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason:
        `pool owner ${poolInfo.owner.toBase58()} does not match dexType=${entry.dexType}` +
        ` (detected: ${detectedDex ?? "unknown"})`,
    };
  }

  // ── Per-DEX price computation ─────────────────────────────────────────────

  if (entry.dexType === "raydium-clmm") {
    const poolParsed = parseDexPool("raydium-clmm", poolPk, data);
    {
      const bind = checkMintBinding(entry.mainnetCa, poolParsed.baseMint, poolParsed.quoteMint);
      if (!bind.ok) {
        return { priceE6: 0n, source, skipped: true, skipReason: bind.reason };
      }
    }
    if (raydiumPriceIsNotUsd(poolParsed.quoteMint)) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason:
          `Raydium CLMM: quote mint ${poolParsed.quoteMint.toBase58()} is not a USD stable, ` +
          `so this pool's price is not USD-denominated (see raydiumPriceIsNotUsd)`,
      };
    }
    const priceE6 = computeDexSpotPriceE6("raydium-clmm", data);
    if (priceE6 === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "Raydium CLMM: sqrtPriceX64=0 (pool not initialised or live)",
      };
    }
    return { priceE6, source };
  }

  if (entry.dexType === "meteora-dlmm") {
    // Parsed unconditionally (pure byte parsing of an already-fetched account,
    // no RPC): the quote mint decides whether this pool prices in USD or SOL.
    const poolParsed = parseDexPool("meteora-dlmm", poolPk, data);
    {
      const bind = checkMintBinding(entry.mainnetCa, poolParsed.baseMint, poolParsed.quoteMint);
      if (!bind.ok) {
        return { priceE6: 0n, source, skipped: true, skipReason: bind.reason };
      }
    }
    if (quoteIsNotUsdOrWsol(poolParsed.quoteMint)) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason:
          `Meteora DLMM: quote mint ${poolParsed.quoteMint.toBase58()} is neither WSOL nor a USD stable, ` +
          `so this pool's price is not USD-denominated (see quoteIsNotUsdOrWsol)`,
      };
    }
    // Cache mint decimals after the first successful read.
    if (!decimalsCache.has(entry.poolAddress)) {
      const [baseDecimals, quoteDecimals] = await Promise.all([
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.baseMint)),
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.quoteMint)),
      ]);
      decimalsCache.set(entry.poolAddress, {
        base: baseDecimals,
        quote: quoteDecimals,
      });
      console.log(
        `[price-reader] Meteora ${shortPool} decimals cached:` +
          ` base(${poolParsed.baseMint.toBase58().slice(0, 8)}…)=${baseDecimals}` +
          ` quote(${poolParsed.quoteMint.toBase58().slice(0, 8)}…)=${quoteDecimals}`,
      );
    }
    const dec = decimalsCache.get(entry.poolAddress)!;

    // WSOL-quoted pools price in SOL, not USD — convert with this cycle's
    // SOL/USD rate. See meteoraWsolPriceToUsdE6. Mirrors the pumpswap branch
    // below: no rate available means SKIP, never publish a SOL price as USD.
    if (poolParsed.quoteMint.equals(WSOL_MINT)) {
      if (solPriceE6 === undefined) {
        return {
          priceE6: 0n,
          source,
          skipped: true,
          skipReason:
            "Meteora DLMM: pool is WSOL-quoted but no SOL/USD price was available this cycle",
        };
      }
      const usdE6 = meteoraWsolPriceToUsdE6(data, dec, solPriceE6);
      if (usdE6 === 0n) {
        return {
          priceE6: 0n,
          source,
          skipped: true,
          skipReason: "Meteora DLMM: binStep=0 (pool not initialised or live)",
        };
      }
      return { priceE6: usdE6, source };
    }

    const priceE6 = computeDexSpotPriceE6("meteora-dlmm", data, undefined, dec);
    if (priceE6 === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "Meteora DLMM: binStep=0 (pool not initialised or live)",
      };
    }
    return { priceE6, source };
  }

  if (entry.dexType === "pumpswap") {
    const poolParsed = parseDexPool("pumpswap", poolPk, data);
    {
      const bind = checkMintBinding(entry.mainnetCa, poolParsed.baseMint, poolParsed.quoteMint);
      if (!bind.ok) {
        return { priceE6: 0n, source, skipped: true, skipReason: bind.reason };
      }
    }
    if (quoteIsNotUsdOrWsol(poolParsed.quoteMint)) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason:
          `PumpSwap: quote mint ${poolParsed.quoteMint.toBase58()} is neither WSOL nor a USD stable, ` +
          `so this pool's price is not USD-denominated (see quoteIsNotUsdOrWsol)`,
      };
    }
    if (!poolParsed.baseVault || !poolParsed.quoteVault) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: vault addresses missing from pool data",
      };
    }

    // Fetch both vault SPL token accounts in ONE request: a price computed
    // from vaults read at two different slots is skewed even on a healthy
    // node, and the watermark guarantees neither is older than anything this
    // process has already seen.
    const [baseVaultInfo, quoteVaultInfo] = await withRpcBackoff(() =>
      readAtWatermark(mainnetConn, (minContextSlot) =>
        mainnetConn.getMultipleAccountsInfoAndContext(
          [poolParsed.baseVault!, poolParsed.quoteVault!],
          { commitment: "confirmed", minContextSlot },
        ),
      ),
    );
    if (!baseVaultInfo || !quoteVaultInfo) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: vault account(s) not found on mainnet",
      };
    }

    const baseVaultData = new Uint8Array(baseVaultInfo.data);
    const quoteVaultData = new Uint8Array(quoteVaultInfo.data);

    // SPL token account: u64 amount is at byte offset 64.
    // Min length = 72 bytes (64 header + 8 for amount).
    if (
      baseVaultData.length < MIN_VAULT_LEN ||
      quoteVaultData.length < MIN_VAULT_LEN
    ) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: `PumpSwap: vault data too short (base=${baseVaultData.length}, quote=${quoteVaultData.length})`,
      };
    }

    // Explicit base-vault-amount guard: an un-seeded pool has amount=0,
    // which would cause a divide-by-zero inside computeDexSpotPriceE6.
    const baseDv = new DataView(
      baseVaultData.buffer,
      baseVaultData.byteOffset,
      baseVaultData.byteLength,
    );
    const baseAmount =
      BigInt(baseDv.getUint32(64, true)) |
      (BigInt(baseDv.getUint32(68, true)) << 32n);
    if (baseAmount === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: base vault amount=0 (pool not seeded / not live)",
      };
    }

    // Cache mint decimals after the first successful read (same pattern as
    // Meteora above) — pump.fun base tokens are almost always 6dp and WSOL is
    // 9dp, but decimals are fetched from the real mints rather than assumed.
    if (!decimalsCache.has(entry.poolAddress)) {
      const [baseDecimals, quoteDecimals] = await Promise.all([
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.baseMint)),
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.quoteMint)),
      ]);
      decimalsCache.set(entry.poolAddress, { base: baseDecimals, quote: quoteDecimals });
      console.log(
        `[price-reader] PumpSwap ${shortPool} decimals cached:` +
          ` base(${poolParsed.baseMint.toBase58().slice(0, 8)}…)=${baseDecimals}` +
          ` quote(${poolParsed.quoteMint.toBase58().slice(0, 8)}…)=${quoteDecimals}`,
      );
    }
    const dec = decimalsCache.get(entry.poolAddress)!;

    const isWsolQuoted = poolParsed.quoteMint.equals(WSOL_MINT);
    if (isWsolQuoted && solPriceE6 === undefined) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: pool is WSOL-quoted but no SOL/USD price was available this cycle",
      };
    }

    // #100 — same floor on the single-pool path, so the two cannot diverge.
    if (MIN_POOL_LIQUIDITY_USD_E6 > 0n) {
      const depth = pumpswapQuoteDepthUsdE6(
        quoteVaultData,
        dec.quote,
        poolParsed.quoteMint,
        solPriceE6,
      );
      if (depth === null || depth < MIN_POOL_LIQUIDITY_USD_E6) {
        return {
          priceE6: 0n,
          source,
          skipped: true,
          skipReason:
            `PumpSwap: below the liquidity floor (depth=` +
            `${depth === null ? "unknown" : `$${(Number(depth) / 1e6).toFixed(2)}`} ` +
            `< $${(Number(MIN_POOL_LIQUIDITY_USD_E6) / 1e6).toFixed(2)})`,
        };
      }
    }

    let priceE6: bigint;
    try {
      priceE6 =
        computeDexSpotPriceE6(
          "pumpswap",
          data,
          { base: baseVaultData, quote: quoteVaultData },
          pumpswapE12Decimals(dec),
          solPriceE6,
        ) / 1_000_000n;
    } catch (err) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: `PumpSwap: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (priceE6 === 0n) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: computed price=0n",
      };
    }
    return { priceE6, source };
  }

  // TypeScript exhaustiveness guard
  return {
    priceE6: 0n,
    source,
    skipped: true,
    skipReason: `unsupported dexType: ${String(entry.dexType)}`,
  };
}

/**
 * FAST PATH: read ALL pool prices in a SINGLE getMultipleAccounts RPC call for
 * the pool accounts, plus (only when PumpSwap markets are present) ONE more
 * batched getMultipleAccounts call for their vaults/mints, and compute each
 * spot price locally. Same DEX-pool source as readPoolPriceE6 (no Pyth) —
 * collapses what would otherwise be N sequential getAccountInfo calls per
 * cycle, so the keeper can push far faster without hammering the RPC.
 *
 * Runs in two passes:
 *   1. raydium-clmm / meteora-dlmm price from the already-fetched pool data
 *      (unchanged from before), PLUS resolving this cycle's SOL/USD reference
 *      price from whichever entry {@link isSolUsdEntry} matches. PumpSwap
 *      entries are parsed (mints/vaults) but deferred to pass 2 — they can't
 *      be priced from the pool account alone.
 *   2. PumpSwap — batch-fetch every candidate's base/quote vault (and, for
 *      any pool without cached decimals yet, its base/quote mint) in ONE
 *      getMultipleAccountsInfo call, then compute each price using the
 *      SOL/USD price resolved in pass 1. A pool skipped this cycle (e.g. the
 *      SOL/USD reference itself failed) is simply omitted from `out` —
 *      identical retry-next-cycle semantics to every other skip path here.
 *
 * Mint decimals are cached the same way as before (keyed by poolAddress) —
 * after the first cycle a PumpSwap pool's decimals never need re-fetching.
 *
 * Returns a map of poolAddress → priceE6 (only pools that produced a valid price).
 */

/**
 * Solana's `getMultipleAccounts` RPC hard-caps at 100 keys, and web3.js v1 does
 * NOT chunk internally — it issues exactly one RPC call. Any call whose key
 * array grows with the registry is therefore a dated cliff.
 *
 * This bit us once already (the 2026-07-13 outage was the same shape in the tx
 * builder: an unbounded batch crossing a hard limit, failing before submission,
 * invisible on-chain). Here the failure would have been WORSE than that one:
 * the PumpSwap pass sends up to 4 keys per pool on a cold process (2 vaults +
 * 2 mints until decimals are cached), so at 26 PumpSwap markets the FIRST cycle
 * after every boot sends 104 keys, the RPC rejects it, readAllPoolPricesE6
 * throws, keeper-loop returns the whole cycle — and because the decimals cache
 * is only written after a SUCCESSFUL fetch, it never populates, so every
 * subsequent cycle sends 104 keys again. That is a total, all-markets price
 * freeze that a restart cannot clear. (Registry today: 15 PumpSwap markets.)
 */
const MAX_ACCOUNTS_PER_RPC = 100;

async function getMultipleAccountsChunked(
  conn: Connection,
  keys: PublicKey[],
): Promise<Array<AccountInfo<Buffer> | null>> {
  const out: Array<AccountInfo<Buffer> | null> = [];
  for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_RPC) {
    const chunk = keys.slice(i, i + MAX_ACCOUNTS_PER_RPC);
    const infos = await withRpcBackoff(() =>
      readAtWatermark(conn, (minContextSlot) =>
        conn.getMultipleAccountsInfoAndContext(chunk, { commitment: "confirmed", minContextSlot }),
      ),
    );
    out.push(...infos);
  }
  return out;
}

export async function readAllPoolPricesE6(
  mainnetConn: Connection,
  entries: Array<Pick<PoolPriceSource, "poolAddress" | "dexType" | "label" | "symbol" | "mainnetCa">>,
  decimalsCache: DecimalsCache,
  /**
   * Mainnet raydium-clmm SOL/USDC pool used as the SOL/USD reference when no
   * registry entry provides one.
   *
   * PumpSwap pools quote in WSOL, so every pumpswap market needs a SOL/USD rate
   * to convert into USD. That rate came ONLY from a registry entry matching
   * isSolUsdEntry — i.e. from a SOL/USDC market happening to be registered. The
   * anchor is a price SOURCE, but it was modelled as a MARKET, so retiring the
   * SOL/USDC market silently made every pumpswap market unpriceable: they all
   * reported "no pool price this cycle" with nothing obviously wrong.
   *
   * Supplying this decouples the two. Read only when pass 1 produced no rate, so
   * a registered SOL/USDC market still wins and this costs nothing when present.
   */
  solUsdReferencePool?: string,
  /**
   * Optional sink for WHY a pool was refused, keyed by poolAddress. Filled for
   * the permanent refusals (quote neither WSOL nor a USD stable) so the keeper
   * can surface the real reason in /health `lastError` (and the K-1 no-push
   * alert) instead of the generic "no pool price this cycle".
   */
  skipReasons?: Map<string, string>,
  /**
   * Optional sink for the SAME prices at e12 (USD per token x 1e12), keyed by poolAddress, for pools where the read
   * can produce it (meteora-dlmm, pumpswap). Used only to compute a v2.2 per-LOT mark without first rounding the
   * per-token price to e6 (QA 2026-10-12: CHILLHOUSE at $0.0012 has 4 significant digits in e6, so its per-lot mark
   * moved in ~0.08% steps). The returned e6 map is unchanged and stays the source of truth.
   */
  pricesE12?: Map<string, bigint>,
  /**
   * Optional sink for the QUOTE reserve of x*y=k pools, in USD e6, keyed by poolAddress (G8 depth input, see
   * push-depth.ts). Filled ONLY for constant-product venues (pumpswap) whose price was published this cycle, from the
   * same vault read and the same SOL/USD rate as the price. Never filled for raydium-clmm / meteora-dlmm (not
   * constant-product) or when the reserve is unreadable or unconvertible - absence means "send no depth".
   */
  quoteReservesUsdE6?: Map<string, bigint>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (entries.length === 0) return out;
  // eslint-disable-next-line no-param-reassign -- narrowed to the rows we can actually read
  // A malformed poolAddress used to throw HERE, outside any per-entry guard —
  // one bad registry row froze the price push for EVERY market. Skip the bad
  // row instead; it simply gets "no pool price this cycle".
  const valid: Array<{ entry: (typeof entries)[number]; pubkey: PublicKey }> = [];
  for (const e of entries) {
    try {
      valid.push({ entry: e, pubkey: new PublicKey(e.poolAddress) });
    } catch {
      console.warn(`[price-reader] skipping ${e.label}: malformed poolAddress ${e.poolAddress}`);
    }
  }
  entries = valid.map((v) => v.entry);
  if (entries.length === 0) return out;
  const pubkeys = valid.map((v) => v.pubkey);
  // The SOL/USD reference pool is read ONLY when no registered entry supplies the rate, and used to
  // cost its own getAccountInfo EVERY cycle. It is a static, valid pubkey: append it to the pool
  // batch (one more key in a call that is already made; the 100-key chunking still applies) and keep
  // the old standalone read as the fallback if the batch does not return it.
  let refKeyIdx = -1;
  if (solUsdReferencePool && !entries.some((e) => isSolUsdEntry(e))) {
    try {
      pubkeys.push(new PublicKey(solUsdReferencePool));
      refKeyIdx = pubkeys.length - 1;
    } catch {
      /* malformed reference pool: the standalone read below reports it as before */
    }
  }
  const allInfos = await getMultipleAccountsChunked(mainnetConn, pubkeys);
  const refBatchInfo = refKeyIdx >= 0 ? allInfos[refKeyIdx] : undefined;
  if (refKeyIdx >= 0) pubkeys.pop();
  const infos = allInfos.slice(0, entries.length);

  // ── Pass 1: raydium-clmm + meteora-dlmm, and resolve this cycle's SOL/USD ──
  let solPriceE6: bigint | undefined;
  interface PumpswapCandidate {
    entry: (typeof entries)[number];
    poolData: Uint8Array;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseVault: PublicKey;
    quoteVault: PublicKey;
  }
  const pumpswapCandidates: PumpswapCandidate[] = [];
  /** WSOL-quoted Meteora pools: priced in SOL, so they must wait for this
   *  cycle's SOL/USD rate (resolved below) before they can be published. */
  const meteoraWsolCandidates: Array<{
    entry: (typeof entries)[number];
    poolData: Uint8Array;
  }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const info = infos[i];
    if (!info || info.data.length === 0) continue;
    if (detectDexType(info.owner) !== entry.dexType) continue;
    const data = new Uint8Array(info.data);
    try {
      if (entry.dexType === "raydium-clmm") {
        // Only USD-quoted Raydium pools are publishable — see
        // raydiumPriceIsNotUsd. This still admits the SOL/USD reference pool.
        const parsedRay = parseDexPool("raydium-clmm", pubkeys[i], data);
        // #100 — the binding must be on THIS path. The keeper loop calls
        // readAllPoolPricesE6, not readPoolPriceE6; guarding only the latter
        // would be a check that never runs in production.
        if (!checkMintBinding(entry.mainnetCa, parsedRay.baseMint, parsedRay.quoteMint).ok) {
          console.error(
            `[price-reader] ${entry.label}: WRONG-TOKEN pool refused — mainnet_ca ` +
              `${entry.mainnetCa} is neither base nor quote of ${entry.poolAddress}`,
          );
          continue;
        }
        if (raydiumPriceIsNotUsd(parsedRay.quoteMint)) continue;
        const priceE6 = computeDexSpotPriceE6("raydium-clmm", data);
        if (priceE6 > 0n) {
          out.set(entry.poolAddress, priceE6);
          if (solPriceE6 === undefined && isSolUsdEntry(entry) && poolIsSolUsd(parsedRay.baseMint, parsedRay.quoteMint)) solPriceE6 = priceE6;
        }
      } else if (entry.dexType === "meteora-dlmm") {
        const parsed = parseDexPool("meteora-dlmm", pubkeys[i], data);
        if (!checkMintBinding(entry.mainnetCa, parsed.baseMint, parsed.quoteMint).ok) {
          console.error(
            `[price-reader] ${entry.label}: WRONG-TOKEN pool refused — mainnet_ca ` +
              `${entry.mainnetCa} is neither base nor quote of ${entry.poolAddress}`,
          );
          continue;
        }
        if (quoteIsNotUsdOrWsol(parsed.quoteMint)) {
          console.error(
            `[price-reader] ${entry.label}: meteora quote mint ${parsed.quoteMint.toBase58()} ` +
              `is neither WSOL nor a USD stable — price is not USD. Refusing to price it.`,
          );
          skipReasons?.set(entry.poolAddress, nonUsdQuoteSkipReason("meteora", parsed.quoteMint));
          continue;
        }
        if (!decimalsCache.has(entry.poolAddress)) {
          const [base, quote] = await Promise.all([
            withRpcBackoff(() => fetchMintDecimals(mainnetConn, parsed.baseMint)),
            withRpcBackoff(() => fetchMintDecimals(mainnetConn, parsed.quoteMint)),
          ]);
          decimalsCache.set(entry.poolAddress, { base, quote });
        }
        // A WSOL-quoted Meteora pool prices in SOL, so it cannot be published
        // until this cycle's SOL/USD rate is known — defer to pass 2b. It also
        // must never seed `solPriceE6` itself (it is not a SOL/USD quote), and
        // isSolUsdEntry only matches USDC/USDT-quoted SOL pools, which land in
        // the branch below and still resolve the rate exactly as before.
        if (parsed.quoteMint.equals(WSOL_MINT)) {
          meteoraWsolCandidates.push({ entry, poolData: data });
          continue;
        }
        const priceE6 = computeDexSpotPriceE6(
          "meteora-dlmm",
          data,
          undefined,
          decimalsCache.get(entry.poolAddress)!,
        );
        if (priceE6 > 0n) {
          out.set(entry.poolAddress, priceE6);
          if (solPriceE6 === undefined && isSolUsdEntry(entry) && poolIsSolUsd(parsed.baseMint, parsed.quoteMint)) solPriceE6 = priceE6;
          if (pricesE12) {
            // Same price at e12 (6 extra base decimals; see meteoraWsolPriceToUsdE6). Best effort: e6 stays the source of truth.
            try {
              const dec = decimalsCache.get(entry.poolAddress)!;
              const e12 = computeDexSpotPriceE6("meteora-dlmm", data, undefined, { base: dec.base + 6, quote: dec.quote });
              if (e12 > 0n) pricesE12.set(entry.poolAddress, e12);
            } catch {
              /* no e12 this cycle: the per-lot mark falls back to the e6 price */
            }
          }
        }
      } else if (entry.dexType === "pumpswap") {
        const parsed = parseDexPool("pumpswap", pubkeys[i], data);
        if (!checkMintBinding(entry.mainnetCa, parsed.baseMint, parsed.quoteMint).ok) {
          console.error(
            `[price-reader] ${entry.label}: WRONG-TOKEN pool refused — mainnet_ca ` +
              `${entry.mainnetCa} is neither base nor quote of ${entry.poolAddress}`,
          );
          continue;
        }
        if (quoteIsNotUsdOrWsol(parsed.quoteMint)) {
          console.error(
            `[price-reader] ${entry.label}: pumpswap quote mint ${parsed.quoteMint.toBase58()} ` +
              `is neither WSOL nor a USD stable — price is not USD. Refusing to price it.`,
          );
          skipReasons?.set(entry.poolAddress, nonUsdQuoteSkipReason("pumpswap", parsed.quoteMint));
          continue;
        }
        if (!parsed.baseVault || !parsed.quoteVault) continue;
        pumpswapCandidates.push({
          entry,
          poolData: data,
          baseMint: parsed.baseMint,
          quoteMint: parsed.quoteMint,
          baseVault: parsed.baseVault,
          quoteVault: parsed.quoteVault,
        });
      }
    } catch {
      /* skip this pool for this cycle; next cycle retries */
    }
  }

  // No SOL/USD from the registry this cycle — fall back to the reference pool.
  // Without this every WSOL-quoted (pumpswap) market is skipped.
  if (solPriceE6 === undefined && solUsdReferencePool) {
    try {
      const refPk = new PublicKey(solUsdReferencePool);
      const refInfo = refBatchInfo
        ? refBatchInfo
        : await withRpcBackoff(() =>
            readAtWatermark(mainnetConn, (minContextSlot) =>
              mainnetConn.getAccountInfoAndContext(refPk, { commitment: "confirmed", minContextSlot }),
            ),
          );
      if (refInfo?.data) {
        const refDex = detectDexType(refInfo.owner);
        if (refDex === "raydium-clmm") {
          const refData = new Uint8Array(refInfo.data);
          const refParsed = parseDexPool("raydium-clmm", refPk, refData);
          // The reference pool is FOR SOL: bound like a market whose mainnet_ca is WSOL, and quoted in a USD stable.
          if (checkMintBinding(WSOL_MINT.toBase58(), refParsed.baseMint, refParsed.quoteMint).ok && poolIsSolUsd(refParsed.baseMint, refParsed.quoteMint)) {
            const refPrice = computeDexSpotPriceE6("raydium-clmm", refData);
            if (refPrice > 0n) solPriceE6 = refPrice;
          } else {
            console.error(`[price-reader] SOL_USD_REFERENCE_POOL ${solUsdReferencePool} is not a WSOL/USD-stable pool — ignored`);
          }
        }
      }
    } catch {
      // Reference unavailable — pumpswap entries skip this cycle, as before.
    }
  }

  // ── Pass 2a: WSOL-quoted Meteora — convert SOL-denominated prices to USD ───
  // No extra RPC: the pool bytes and decimals were captured in pass 1; only
  // this cycle's SOL/USD rate was missing. Without a rate we publish nothing
  // for these markets rather than a SOL price mislabeled as USD.
  if (meteoraWsolCandidates.length > 0) {
    if (solPriceE6 === undefined) {
      console.warn(
        `[price-reader] skipping ${meteoraWsolCandidates.length} WSOL-quoted Meteora pool(s):` +
          ` no SOL/USD price available this cycle`,
      );
    } else {
      for (const { entry, poolData } of meteoraWsolCandidates) {
        const dec = decimalsCache.get(entry.poolAddress);
        if (!dec) continue;
        try {
          const usdE6 = meteoraWsolPriceToUsdE6(poolData, dec, solPriceE6);
          if (usdE6 > 0n) {
            out.set(entry.poolAddress, usdE6);
            if (pricesE12) {
              const usdE12 = meteoraWsolPriceToUsdE12(poolData, dec, solPriceE6);
              if (usdE12 > 0n) pricesE12.set(entry.poolAddress, usdE12);
            }
          }
        } catch {
          /* skip this pool for this cycle; next cycle retries */
        }
      }
    }
  }

  // ── Pass 2: PumpSwap — one batched fetch for vaults (+ uncached mints) ─────
  if (pumpswapCandidates.length > 0) {
    const extraAddrs: PublicKey[] = [];
    // Position of each candidate's [baseVault, quoteVault, baseMint?, quoteMint?]
    // within extraAddrs — mint positions are only present when decimals aren't
    // cached yet for that pool.
    const positions = pumpswapCandidates.map((c) => {
      const baseVaultPos = extraAddrs.push(c.baseVault) - 1;
      const quoteVaultPos = extraAddrs.push(c.quoteVault) - 1;
      let mintPos: { base: number; quote: number } | null = null;
      if (!decimalsCache.has(c.entry.poolAddress)) {
        const baseMintPos = extraAddrs.push(c.baseMint) - 1;
        const quoteMintPos = extraAddrs.push(c.quoteMint) - 1;
        mintPos = { base: baseMintPos, quote: quoteMintPos };
      }
      return { baseVaultPos, quoteVaultPos, mintPos };
    });

    // Contained: a pass-2 failure (rate limit, behind node) must not discard
    // the pass-1 raydium/meteora prices already computed above — throwing
    // here used to abort the WHOLE cycle for every market. Now the pumpswap
    // markets skip this cycle ("no pool price") and everything else publishes.
    let extraInfos: Array<AccountInfo<Buffer> | null>;
    try {
      extraInfos = await getMultipleAccountsChunked(mainnetConn, extraAddrs);
    } catch (err) {
      console.warn(
        `[price-reader] pumpswap vault batch failed — skipping ${pumpswapCandidates.length} ` +
          `pumpswap market(s) this cycle: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      );
      return out;
    }

    for (let c = 0; c < pumpswapCandidates.length; c++) {
      const { entry, poolData } = pumpswapCandidates[c];
      const { baseVaultPos, quoteVaultPos, mintPos } = positions[c];
      const baseVaultInfo = extraInfos[baseVaultPos];
      const quoteVaultInfo = extraInfos[quoteVaultPos];
      if (!baseVaultInfo || !quoteVaultInfo) continue;

      let dec = decimalsCache.get(entry.poolAddress);
      if (!dec) {
        if (!mintPos) continue; // should not happen — mintPos is only null when already cached
        const baseMintInfo = extraInfos[mintPos.base];
        const quoteMintInfo = extraInfos[mintPos.quote];
        if (
          !baseMintInfo ||
          !quoteMintInfo ||
          baseMintInfo.data.length <= SPL_MINT_DECIMALS_OFFSET ||
          quoteMintInfo.data.length <= SPL_MINT_DECIMALS_OFFSET
        ) {
          continue;
        }
        dec = {
          base: baseMintInfo.data[SPL_MINT_DECIMALS_OFFSET],
          quote: quoteMintInfo.data[SPL_MINT_DECIMALS_OFFSET],
        };
        decimalsCache.set(entry.poolAddress, dec);
        console.log(
          `[price-reader] PumpSwap ${entry.poolAddress.slice(0, 8)}… decimals cached (batched):` +
            ` base=${dec.base} quote=${dec.quote}`,
        );
      }

      // #100 — minimum-liquidity floor. Checked on THIS path because this is the
      // one the keeper loop calls; the binding fix had to be corrected for
      // exactly that reason (see #110).
      if (MIN_POOL_LIQUIDITY_USD_E6 > 0n) {
        const depth = pumpswapQuoteDepthUsdE6(
          new Uint8Array(quoteVaultInfo.data),
          dec.quote,
          pumpswapCandidates[c].quoteMint,
          solPriceE6,
        );
        // null means the depth could NOT be established. Skip — a floor that
        // passes when it cannot measure is not a floor.
        if (depth === null || depth < MIN_POOL_LIQUIDITY_USD_E6) {
          console.error(
            `[price-reader] ${entry.label}: pool below the liquidity floor — ` +
              `depth=${depth === null ? "unknown" : `$${(Number(depth) / 1e6).toFixed(2)}`} ` +
              `< $${(Number(MIN_POOL_LIQUIDITY_USD_E6) / 1e6).toFixed(2)}. Refusing to price it.`,
          );
          continue;
        }
      }

      try {
        const priceE12 = computeDexSpotPriceE6(
          "pumpswap",
          poolData,
          { base: new Uint8Array(baseVaultInfo.data), quote: new Uint8Array(quoteVaultInfo.data) },
          pumpswapE12Decimals(dec),
          solPriceE6,
        );
        const priceE6 = priceE12 / 1_000_000n;
        if (priceE6 > 0n) {
          out.set(entry.poolAddress, priceE6);
          pricesE12?.set(entry.poolAddress, priceE12);
          if (quoteReservesUsdE6) {
            const reserve = pumpswapQuoteDepthUsdE6(
              new Uint8Array(quoteVaultInfo.data),
              dec.quote,
              pumpswapCandidates[c].quoteMint,
              solPriceE6,
            );
            if (reserve !== null && reserve > 0n) quoteReservesUsdE6.set(entry.poolAddress, reserve);
          }
        }
      } catch {
        // e.g. WSOL-quoted but solPriceE6 unavailable this cycle (SOL/USD read
        // itself failed) — skip and retry next cycle.
      }
    }
  }

  return out;
}
