/**
 * Review M-7 (2026-10-01): the keeper bounds the markets it prices, so rows that reach the
 * `markets` table past the app's enrollment gate cannot grow the push batch (and the SOL bill)
 * without limit. Oldest rows keep their place; only the newest over a ceiling wait.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/market-cap.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Connection } from "@solana/web3.js";
import {
  capMarketRows,
  fetchActiveMarkets,
  keeperMarketCapsFromEnv,
  DEFAULT_KEEPER_MAX_MARKETS,
  DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER,
  type DbMarketRow,
} from "./db-markets.ts";
import type { DexType } from "./registry.ts";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const row = (i: number, deployer: string, pool = `P${i}`): DbMarketRow => ({
  slab_address: `S${String(i).padStart(3, "0")}`,
  dex_pool_address: pool,
  symbol: null,
  mint_address: "MINT",
  mainnet_ca: null,
  deployer,
  created_at: new Date(t0 + i * 60_000).toISOString(),
});

describe("capMarketRows", () => {
  it("one deployer flooding: only its oldest maxPerDeployer are kept, others' markets untouched", () => {
    const honest = [row(0, "A"), row(1, "B")];
    const flood = Array.from({ length: 30 }, (_, i) => row(10 + i, "SPAM"));
    const { kept, capped } = capMarketRows([...flood.reverse(), ...honest], { maxTotal: 50, maxPerDeployer: 3 });
    assert.deepEqual(kept.map((r) => r.slab_address), ["S000", "S001", "S010", "S011", "S012"]);
    assert.equal(capped.length, 27);
  });

  it("many deployers (sybil wallets): the global ceiling keeps the OLDEST markets", () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(i, `W${i}`));
    const { kept } = capMarketRows([...rows].reverse(), { maxTotal: 50, maxPerDeployer: 10 });
    assert.equal(kept.length, 50);
    assert.equal(kept[0].slab_address, "S000");
    assert.equal(kept[49].slab_address, "S049");
  });

  it("unpriceable rows are not counted (they never take a priced market's place)", () => {
    const rows = [row(0, "A", "BAD0"), row(1, "A", "BAD1"), row(2, "A"), row(3, "A")];
    const { kept } = capMarketRows(rows, { maxTotal: 2, maxPerDeployer: 2 }, (r) => !r.dex_pool_address!.startsWith("BAD"));
    assert.deepEqual(kept.map((r) => r.slab_address), ["S000", "S001", "S002", "S003"]);
  });

  it("under the ceilings nothing changes; a non-empty list never comes back empty", () => {
    const rows = [row(0, "A"), row(1, "A"), row(2, "B")];
    assert.equal(capMarketRows(rows, { maxTotal: 50, maxPerDeployer: 10 }).kept.length, 3);
    assert.equal(capMarketRows(rows, { maxTotal: 1, maxPerDeployer: 1 }).kept.length, 1);
  });

  it("env overrides, defaults on garbage", () => {
    assert.deepEqual(keeperMarketCapsFromEnv({} as NodeJS.ProcessEnv), {
      maxTotal: DEFAULT_KEEPER_MAX_MARKETS,
      maxPerDeployer: DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER,
    });
    assert.deepEqual(keeperMarketCapsFromEnv({ KEEPER_MAX_MARKETS: "20", KEEPER_MAX_MARKETS_PER_DEPLOYER: "0" } as never), {
      maxTotal: 20,
      maxPerDeployer: DEFAULT_KEEPER_MAX_MARKETS_PER_DEPLOYER,
    });
  });
});

describe("fetchActiveMarkets applies the ceiling", () => {
  it("a flood of active rows from one deployer reaches the registry only up to the ceiling", async () => {
    const rows = [row(0, "A"), ...Array.from({ length: 40 }, (_, i) => row(1 + i, "SPAM"))];
    const dexCache = new Map<string, DexType>(rows.map((r) => [r.dex_pool_address!, "pumpswap" as DexType]));
    let url = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as typeof fetch;
    try {
      const out = await fetchActiveMarkets({
        supabaseUrl: "https://db.invalid",
        supabaseAnonKey: "anon",
        network: "devnet",
        mainnetConn: new Connection("http://127.0.0.1:1"),
        dexCache,
        caps: { maxTotal: 50, maxPerDeployer: 10 },
      });
      assert.ok(out);
      assert.equal(out!.length, 11);
      assert.equal(out![0].marketAddress, "S000");
      assert.match(url, /deployer/);
      assert.match(url, /order=created_at\.asc/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
