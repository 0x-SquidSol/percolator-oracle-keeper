/**
 * GH#163 — the cycle's SOL/USD reference must not be nominatable by a
 * creator-supplied token symbol.
 *
 * `isSolUsdEntry` picks the entry whose price becomes the SOL/USD rate, and that
 * rate denominates every pumpswap and WSOL-quoted mark. Its label is SYNTHESISED
 * from the symbol (`db-markets.ts` `${name}/USDC - ${dexType}`), so matching on a
 * label prefix while a symbol is present let `symbol = "SOL"` nominate itself.
 *
 * The contract: an entry WITH a symbol is judged on the symbol alone; only an
 * entry with no symbol falls back to the label.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isSolUsdEntry } from "./price-reader.js";
import { rowsToEntries } from "./db-markets.js";

const DLMM = "meteora-dlmm" as const;

describe("GH#163 SOL/USD reference trust", () => {
  it("does NOT accept a creator-supplied symbol of SOL", () => {
    assert.equal(
      isSolUsdEntry({ dexType: DLMM, symbol: "SOL", label: "SOL/USDC — meteora-dlmm" }),
      false,
    );
  });

  it("does NOT accept it in any casing", () => {
    for (const sym of ["sol", "Sol", "sOl", " SOL "]) {
      assert.equal(
        isSolUsdEntry({ dexType: DLMM, symbol: sym, label: `${sym}/USDC — meteora-dlmm` }),
        false,
        `symbol ${JSON.stringify(sym)} must not nominate itself`,
      );
    }
  });

  it("does NOT accept any other symbol whose synthesised label starts with SOL/USDC", () => {
    // The only way to build such a label is a symbol of "SOL", but pin the rule
    // rather than the one example: a present symbol is never judged on its label.
    assert.equal(
      isSolUsdEntry({ dexType: DLMM, symbol: "ATKTOKEN", label: "SOL/USDC — meteora-dlmm" }),
      false,
    );
  });

  it("STILL accepts the canonical pair symbols the seeded registry uses", () => {
    for (const sym of ["SOL/USDC", "SOL/USDT", "sol/usdc"]) {
      assert.equal(isSolUsdEntry({ dexType: DLMM, symbol: sym, label: "whatever" }), true, sym);
    }
  });

  it("STILL falls back to the label when the entry has no symbol (dry-run.ts:96 shape)", () => {
    assert.equal(
      isSolUsdEntry({ dexType: DLMM, symbol: undefined, label: "SOL/USDC — meteora-dlmm" }),
      true,
    );
    assert.equal(isSolUsdEntry({ dexType: DLMM, symbol: "", label: "SOL/USDT pool" }), true);
  });

  it("still refuses pool types that cannot be a USD reference", () => {
    assert.equal(isSolUsdEntry({ dexType: "pumpswap", symbol: "SOL/USDC", label: "" }), false);
  });

  it("end to end: a DB row with symbol SOL does not yield a SOL/USD entry", () => {
    // Uses the REAL label synthesiser, so this fails if db-markets ever changes
    // the label shape in a way that reopens the hole.
    const rows = [
      {
        slab_address: "SLAB1111111111111111111111111111111111111111",
        dex_pool_address: "POOL1111111111111111111111111111111111111111",
        symbol: "SOL",
        mint_address: "MINT1111111111111111111111111111111111111111",
        mainnet_ca: "CA111111111111111111111111111111111111111111",
      },
    ];
    const entries = rowsToEntries(rows as never, new Map([[rows[0]!.dex_pool_address, DLMM]]));
    assert.equal(entries.length, 1, "row should still be admitted — this is not an admission gate");
    assert.match(entries[0]!.label!, /^SOL\/USDC/, "the label really is synthesised as SOL/USDC…");
    // On feat/v22-keeper-growth MarketEntry.dexType is optional (multi-asset rows), isSolUsdEntry's pick needs it; a DB row carries it.
    const e = entries[0]!;
    assert.ok(e.dexType, "the DB row carries its dexType");
    assert.equal(isSolUsdEntry({ dexType: e.dexType, label: e.label, symbol: e.symbol }), false, "…but it must not be trusted as the reference");
  });
});
