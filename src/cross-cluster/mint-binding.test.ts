/**
 * #100 — the market's token must be one side of the pool being priced.
 *
 * The defect this closes: `dex_pool_address` is creator-supplied, and nothing
 * checked that the pool prices the token the market is FOR. `baseMint` was parsed
 * and used only to fetch decimals. A pool for an entirely different token was
 * accepted as the AuthMark every trade settles against.
 *
 * Also pinned here: `mainnet_ca` was already SELECTed by db-markets and then
 * dropped when building the entry, which is why the value existed but the check
 * could not. rowsToEntries carrying it is asserted, because the binding is
 * silently a no-op without it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { checkMintBinding } from "./price-reader.ts";
import { rowsToEntries } from "./db-markets.ts";

const TOKEN = new PublicKey("So11111111111111111111111111111111111111112");
const USDC  = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const OTHER = new PublicKey("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");

describe("#100 mint binding", () => {
  it("accepts when the market token is the pool's BASE mint", () => {
    assert.deepEqual(checkMintBinding(TOKEN.toBase58(), TOKEN, USDC), { ok: true });
  });

  // S3-B2 (audit 2026-10-17): this used to be accepted. Here TOKEN is WSOL: a USDC/WSOL pool prices USDC (quote-per-base
  // x SOL/USD ~ $1), so the "SOL" market would publish USDC's price. The priced token is always the base.
  it("REJECTS the market token on the QUOTE side — the pool prices the base, a different token", () => {
    const r = checkMintBinding(TOKEN.toBase58(), USDC, TOKEN);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /QUOTE/);
  });

  it("REJECTS a pool for an entirely different token", () => {
    const r = checkMintBinding(TOKEN.toBase58(), OTHER, USDC);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /WRONG TOKEN/);
    assert.match((r as { reason: string }).reason, /Refusing to use it as the AuthMark/);
  });

  it("accepts when mainnetCa is absent — pre-seeded entries predate the column", () => {
    assert.deepEqual(checkMintBinding(undefined, OTHER, USDC), { ok: true });
  });

  it("is exact, not a prefix match", () => {
    const truncated = TOKEN.toBase58().slice(0, 30);
    assert.equal(checkMintBinding(truncated, TOKEN, USDC).ok, false);
  });
});

describe("#100 mainnet_ca must survive the DB -> entry mapping", () => {
  const dexByPool = new Map([["POOL1", "raydium-clmm" as const]]);

  it("carries mainnet_ca onto the entry", () => {
    const [e] = rowsToEntries(
      [{
        slab_address: "SLAB1", dex_pool_address: "POOL1", symbol: "TKN",
        mint_address: "MINT1", mainnet_ca: TOKEN.toBase58(),
      } as never],
      dexByPool as never,
    );
    assert.equal(
      e.mainnetCa, TOKEN.toBase58(),
      "without this the binding is silently a no-op — the column was already queried and then dropped",
    );
  });

  it("leaves mainnetCa undefined when the DB has null", () => {
    const [e] = rowsToEntries(
      [{
        slab_address: "SLAB1", dex_pool_address: "POOL1", symbol: "TKN",
        mint_address: "MINT1", mainnet_ca: null,
      } as never],
      dexByPool as never,
    );
    assert.equal(e.mainnetCa, undefined);
  });
});

describe("#100 the binding must be on EVERY pool-parse site, not just one path", () => {
  /**
   * This test exists because I got it wrong.
   *
   * The binding was first added only inside `readPoolPriceE6`. The keeper loop calls
   * `readAllPoolPricesE6` — the batched fast path — which parses pools at its own
   * three sites. So the guard shipped, passed its unit tests, and protected nothing
   * in production. Its `Pick<MarketEntry, …>` did not even include `mainnetCa`, which
   * is why it could not have worked.
   *
   * A behavioural test of the fast path would need a mocked Connection and fabricated
   * pool bytes for three DEX layouts. This is deliberately a STRUCTURAL test instead,
   * and it is honest about what it proves: not that the binding is correct — the tests
   * above do that — but that no `parseDexPool` call site is left unguarded. That is
   * exactly the failure that occurred, and the one most likely to recur when a fourth
   * DEX or a third read path is added.
   */
  it("every parseDexPool call is followed by a checkMintBinding", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "price-reader.ts"),
      "utf8",
    );

    const lines = src.split("\n");
    const parseSites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes("parseDexPool(") && !l.includes("import"));

    assert.ok(
      parseSites.length >= 6,
      `expected at least 6 parseDexPool sites (3 per read path), found ${parseSites.length} — ` +
        "if the file was restructured, update this test rather than deleting it",
    );

    const unguarded = parseSites.filter(({ i }) => {
      // the binding must appear within a few lines of the parse
      const window = lines.slice(i, i + 12).join("\n");
      return !window.includes("checkMintBinding");
    });

    assert.deepEqual(
      unguarded.map(({ i }) => `line ${i + 1}: ${lines[i].trim()}`),
      [],
      "every parseDexPool site must bind mainnet_ca to the pool's mints — an unguarded " +
        "site means a creator-supplied pool for the WRONG TOKEN is accepted as the AuthMark " +
        "on that path",
    );
  });
});
