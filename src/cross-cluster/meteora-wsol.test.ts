/**
 * Regression test for the WSOL-quoted Meteora DLMM price bug (2026-07-29).
 *
 * A TOKEN/SOL Meteora pool prices in SOL. The SDK only applies the WSOL->USD
 * conversion for `pumpswap`, so these markets published a SOL-denominated
 * price as if it were USD — low by the whole SOL/USD rate (~80x). On devnet
 * that made market 5sDvEs2… (Fauci) publish $0.000011 against a real
 * $0.000943, collapsing its per-trade LP cap from $1,000 to $9.57 and failing
 * every larger trade with a bare `InvalidAccountData`.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/meteora-wsol.test.ts
 * Or via:   pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { meteoraWsolPriceToUsdE6, raydiumPriceIsNotUsd } from "./price-reader.ts";
import { computeDexSpotPriceE6 } from "@percolatorct/sdk";

/**
 * Build a Meteora DLMM pool account with a chosen activeId/binStep — the only
 * two fields the price math reads (activeId i32 @76, binStep u16 @80).
 */
function makePool(activeId: number, binStep: number): Uint8Array {
  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  dv.setInt32(76, activeId, true);
  dv.setUint16(80, binStep, true);
  return buf;
}

/** token(6dp)/WSOL(9dp) — the shape of every affected pool. */
const DEC = { base: 6, quote: 9 };
const SOL_USD_E6 = 73_340_000n; // $73.34

/** Independent float reference for a pool's SOL-denominated price. */
function nativeFloat(activeId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, activeId) * Math.pow(10, DEC.base - DEC.quote);
}

describe("meteoraWsolPriceToUsdE6", () => {
  // Calibrated to sit in the same range as the real Fauci pool (~1e-5 SOL).
  const FAUCI_LIKE = { activeId: -2304, binStep: 20 };

  it("scales the SOL-denominated price up by the SOL/USD rate", () => {
    const pool = makePool(FAUCI_LIKE.activeId, FAUCI_LIKE.binStep);
    const nativeE6 = computeDexSpotPriceE6("meteora-dlmm", pool, undefined, DEC);
    const usdE6 = meteoraWsolPriceToUsdE6(pool, DEC, SOL_USD_E6);

    // This is the bug: before the fix, nativeE6 WAS what got published.
    assert.ok(usdE6 > nativeE6, `expected ${usdE6} > ${nativeE6}`);
    const ratio = Number(usdE6) / Number(nativeE6);
    assert.ok(ratio > 70, `ratio ${ratio} should exceed 70`);
    assert.ok(ratio < 77, `ratio ${ratio} should be under 77`);
  });

  it("beats the naive e6 round-trip on a badly quantized pool", () => {
    // binStep=25/activeId=-2049 reads 5.999329e-6 SOL, which is just `5` in
    // e6 — a 16.7% truncation. Converting from that quantized integer would
    // ship a 16%-wrong oracle price; converting from e12 does not.
    const pool = makePool(-2049, 25);
    const nativeE6 = computeDexSpotPriceE6("meteora-dlmm", pool, undefined, DEC);
    assert.equal(nativeE6, 5n);

    const naive = (nativeE6 * SOL_USD_E6) / 1_000_000n;
    const exact = meteoraWsolPriceToUsdE6(pool, DEC, SOL_USD_E6);

    const expected = nativeFloat(-2049, 25) * (Number(SOL_USD_E6) / 1e6) * 1e6;
    const exactErr = Math.abs(Number(exact) - expected) / expected;
    const naiveErr = Math.abs(Number(naive) - expected) / expected;

    assert.ok(exactErr < 0.005, `exact err ${exactErr} should be <0.5%`);
    assert.ok(naiveErr > 0.10, `naive err ${naiveErr} should exceed 10%`);
  });

  it("throws (fail closed) for an uninitialised pool (binStep=0); the SDK no longer returns 0n (#338) and the caller's per-pool catch skips it", () => {
    assert.throws(() => meteoraWsolPriceToUsdE6(makePool(0, 0), DEC, SOL_USD_E6), /binStep = 0/);
  });

  it("scales linearly with the SOL/USD rate", () => {
    const pool = makePool(FAUCI_LIKE.activeId, FAUCI_LIKE.binStep);
    const at50 = meteoraWsolPriceToUsdE6(pool, DEC, 50_000_000n);
    const at100 = meteoraWsolPriceToUsdE6(pool, DEC, 100_000_000n);
    assert.ok(at50 > 0n);
    assert.ok(Math.abs(Number(at100) / Number(at50) - 2) < 0.01);
  });

  it("reproduces the real Fauci pool's USD price, not its SOL price", () => {
    // Live values 2026-07-29: priceNative 0.00001286 SOL, priceUsd 0.0009432,
    // implied SOL/USD 73.34. The oracle was publishing 11-13 (the SOL price).
    const pool = makePool(FAUCI_LIKE.activeId, FAUCI_LIKE.binStep);
    const usdE6 = meteoraWsolPriceToUsdE6(pool, DEC, SOL_USD_E6);
    // Same order of magnitude as the real USD price (~943), NOT ~12.
    assert.ok(Number(usdE6) > 500, `got ${usdE6}`);
    assert.ok(Number(usdE6) < 1500, `got ${usdE6}`);
  });
});

/**
 * Raydium CLMM is withheld until price-reader handles both mint orientations
 * (see raydiumPriceIsNotUsd). These lock in WHICH pools stay publishable, so
 * the block can't silently take the SOL/USD reference down with it.
 */
describe("raydium-clmm USD gate", () => {
  // Exercises the REAL predicate. An earlier version of this block defined its
  // own `blocked()` mirror of the rule and never imported the module under
  // test — deleting raydiumPriceIsNotUsd outright would have left it green.
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
  const FAUCI = new PublicKey("3VFnDoACa991DYe987w354sbvmhqjjzC4Z31SoZepump");

  it("keeps the SOL/USD reference pool publishable (mint1 = USDC)", () => {
    // 8sLbNZoA…: mint0 = WSOL, mint1 = USDC -> price is USDC per SOL = USD.
    // Every pumpswap and WSOL-Meteora conversion depends on this pool.
    assert.equal(raydiumPriceIsNotUsd(USDC), false);
  });

  it("allows USDT-quoted pools too", () => {
    assert.equal(raydiumPriceIsNotUsd(USDT), false);
  });

  it("blocks a SOL-quoted pool — the price is SOL per token, not USD", () => {
    assert.equal(raydiumPriceIsNotUsd(WSOL), true);
  });

  it("blocks a pool quoted in an arbitrary token", () => {
    assert.equal(raydiumPriceIsNotUsd(FAUCI), true);
  });
});
