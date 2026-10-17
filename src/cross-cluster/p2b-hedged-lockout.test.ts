/**
 * Hedged-lockout alert (p2b-hedged-lockout.ts): the truth table, the vault LP's effective
 * position, and the monitor over real v18 portfolio bytes. Reasoning: percolator-prog #524
 * `sec3_hedged_lockout_of_both_sides` (both users' crowds closed by capacity while the LP is flat).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { decodeAssetGrowthV19, parsePortfolioV17 } from "@percolatorct/sdk";
import type { AssetGrowthV19 } from "@percolatorct/sdk";
import {
  DEFAULT_HEDGED_LOCKOUT_THRESHOLDS,
  evaluateHedgedLockout,
  evaluateHedgedLockouts,
  hedgedLockoutThresholdsFromEnv,
  vaultLpEffectivePositionQ,
} from "./p2b-hedged-lockout.ts";
import type { HedgedLockoutInput } from "./p2b-hedged-lockout.ts";
import { isV18MarketHeader } from "./adl-state.ts";
import { ADL_ONE, fakeConn, fx, patchedMarket, registryBytes, snapshot, vaultLpStateBytes } from "./p2b-test-helpers.ts";

const T = DEFAULT_HEDGED_LOCKOUT_THRESHOLDS;
const N = 1_000_000_000n; // N_cap with C_m = 1e9 atoms, lambda 1x, price 1.0
const growth = (lambdaBps = 10_000): AssetGrowthV19 => decodeAssetGrowthV19(patchedMarket({ growthLambdaBps: lambdaBps }), 0)!;

/** users long / short as fractions of N_cap in bps, LP net in bps of N_cap (positive = long). */
function input(o: { uLong: number; uShort: number; lp?: number; g?: AssetGrowthV19 | null; cM?: bigint; price?: bigint }): HedgedLockoutInput {
  const lpQ = (BigInt(o.lp ?? 0) * N) / 10_000n;
  const usersL = (BigInt(o.uLong) * N) / 10_000n;
  const usersS = (BigInt(o.uShort) * N) / 10_000n;
  // engine OI includes the vault LP's own leg on its side
  return {
    growth: o.g === undefined ? growth() : o.g,
    cM: o.cM ?? N,
    priceE6: o.price ?? 1_000_000n,
    oiEffLongQ: usersL + (lpQ > 0n ? lpQ : 0n),
    oiEffShortQ: usersS + (lpQ < 0n ? -lpQ : 0n),
    lpEffQ: lpQ,
  };
}

describe("hedged lockout: truth table", () => {
  it("N_cap sanity: C_m 1e9, lambda 1x, price 1.0 -> N_cap 1e9", () => {
    const v = evaluateHedgedLockout(input({ uLong: 9500, uShort: 9500 }), T);
    assert.equal(v.nCapQ, N);
  });

  const rows: Array<[string, Parameters<typeof input>[0], "alert" | "ok" | "no-growth" | "no-capacity" | "r3-unsupported"]> = [
    ["both sides 95%, LP flat -> ALERT", { uLong: 9500, uShort: 9500 }, "alert"],
    ["both sides exactly 90.00%, LP flat -> ALERT (inclusive)", { uLong: 9000, uShort: 9000 }, "alert"],
    ["both sides 89.99% -> no alert", { uLong: 8999, uShort: 8999 }, "ok"],
    ["only the long side full -> no alert (normal crowd-side-full)", { uLong: 9900, uShort: 5000 }, "ok"],
    ["only the short side full -> no alert", { uLong: 5000, uShort: 9900 }, "ok"],
    ["both full but the LP carries 10% net long -> no alert (the LP is absorbing the imbalance)", { uLong: 9500, uShort: 9500, lp: 1000 }, "ok"],
    ["both full but the LP carries 10% net short -> no alert", { uLong: 9500, uShort: 9500, lp: -1000 }, "ok"],
    ["LP exactly at the flat threshold (3.00%) -> ALERT (inclusive)", { uLong: 9500, uShort: 9500, lp: 300 }, "alert"],
    ["LP just over the flat threshold (3.01%) -> no alert", { uLong: 9500, uShort: 9500, lp: 301 }, "ok"],
    ["LP slightly short (-2%), both full -> ALERT", { uLong: 9500, uShort: 9500, lp: -200 }, "alert"],
    ["no growth block -> no-op, whatever the OI", { uLong: 9900, uShort: 9900, g: null }, "no-growth"],
    ["zero C_m -> no capacity, no alert", { uLong: 9900, uShort: 9900, cM: 0n }, "no-capacity"],
    ["zero price -> no capacity, no alert", { uLong: 9900, uShort: 9900, price: 0n }, "no-capacity"],
    ["empty market -> no alert", { uLong: 0, uShort: 0 }, "ok"],
  ];
  for (const [name, i, expected] of rows) {
    it(name, () => {
      assert.equal(evaluateHedgedLockout(input(i), T).status, expected);
    });
  }

  it("users OI excludes the LP's own leg: LP long 20% + engine OI long 115% => users long 95%", () => {
    const v = evaluateHedgedLockout({ ...input({ uLong: 9500, uShort: 9500 }), oiEffLongQ: (11500n * N) / 10_000n, lpEffQ: (2000n * N) / 10_000n }, { ...T, flatBps: 5000 });
    assert.equal(v.utilLongBps, 9500n);
    assert.equal(v.lpNetBps, 2000n);
  });

  it("thresholds are tunable", () => {
    const i = input({ uLong: 8200, uShort: 8200 });
    assert.equal(evaluateHedgedLockout(i, T).status, "ok");
    assert.equal(evaluateHedgedLockout(i, { utilBps: 8000, flatBps: 300 }).status, "alert");
  });

  it("env: defaults 9000 / 300, overrides, garbage rejected", () => {
    assert.deepEqual(hedgedLockoutThresholdsFromEnv({}), { utilBps: 9000, flatBps: 300 });
    assert.deepEqual(hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "8500", HEDGED_LOCKOUT_FLAT_BPS: "100" }), { utilBps: 8500, flatBps: 100 });
    assert.throws(() => hedgedLockoutThresholdsFromEnv({ HEDGED_LOCKOUT_UTIL_BPS: "abc" }), /HEDGED_LOCKOUT_UTIL_BPS/);
  });
});

describe("vaultLpEffectivePositionQ (real v18 LP portfolios)", () => {
  it("CATE LP: long 6,400,773,782 at a_basis = ONE, A_long = ONE -> +6,400,773,782", () => {
    const p = parsePortfolioV17(new Uint8Array(fx("cate-lp-portfolio-v18")));
    assert.equal(vaultLpEffectivePositionQ(p, 0, { aLong: ADL_ONE, aShort: ADL_ONE }), 6_400_773_782n);
  });
  it("ANSEM LP: short -16,511,677,058 -> negative; ADL scales it by A_short / a_basis (floor)", () => {
    const p = parsePortfolioV17(new Uint8Array(fx("ansem-lp-portfolio-v18")));
    assert.equal(vaultLpEffectivePositionQ(p, 0, { aLong: ADL_ONE, aShort: ADL_ONE }), -16_511_677_058n);
    const a = 861_700_000_000_000n;
    assert.equal(vaultLpEffectivePositionQ(p, 0, { aLong: ADL_ONE, aShort: a }), -((16_511_677_058n * a) / ADL_ONE));
  });
  it("no leg on the asset -> 0", () => {
    const p = parsePortfolioV17(new Uint8Array(fx("cate-lp-portfolio-v18")));
    assert.equal(vaultLpEffectivePositionQ(p, 5, { aLong: ADL_ONE, aShort: ADL_ONE }), 0n);
  });
});

describe("R3 (controller) growth records: fail closed", () => {
  const r3 = (flags: number): AssetGrowthV19 => decodeAssetGrowthV19(patchedMarket({ growthLambdaBps: 10_000, growthFlags: flags }), 0)!;
  it("legacy fixture (flags 0) is r3Layout=false and keeps alerting", () => {
    const g = r3(0);
    assert.equal(g.r3Layout, false);
    assert.equal(evaluateHedgedLockout(input({ uLong: 9500, uShort: 9500, g }), T).status, "alert");
  });
  for (const flags of [1, 3]) {
    it(`flags ${flags}: r3Layout=true -> r3-unsupported, no capacity figure, no alert even with both crowds full and the LP flat`, () => {
      const g = r3(flags);
      assert.equal(g.r3Layout, true);
      const v = evaluateHedgedLockout(input({ uLong: 9900, uShort: 9900, g }), T);
      assert.equal(v.status, "r3-unsupported");
      assert.equal(v.nCapQ, null);
      assert.equal(v.utilLongBps, null);
    });
  }
  it("monitor: an R3 market yields a record, no alert, and one warn line per market", async () => {
    const lp = Keypair.generate().publicKey;
    const m = patchedMarket({ effectivePriceE6: 1_000n, growthLambdaBps: 10_000, growthFlags: 3, oiEffLong: 2_000_000_000_000n, oiEffShort: 2_000_000_000_000n });
    const s = snapshot({ label: "R3MKT", marketData: m, registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    const c = fakeConn({ accounts: new Map([[lp.toBase58(), new Uint8Array(fx("cate-lp-portfolio-v18"))]]) });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    try {
      const r1 = await evaluateHedgedLockouts(c.conn as never, [s], T);
      await evaluateHedgedLockouts(c.conn as never, [s], T);
      assert.deepEqual(r1.alerts, []);
      assert.equal(r1.records[0].verdict.status, "r3-unsupported");
    } finally { console.warn = orig; }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /R3MKT.*controller \(R3\) growth record.*SKIPPED/);
  });
});

describe("v2.2 slabs", () => {
  it("every live v2.2 market (2026-10-17 fixture) fails the v2.1-only header gate, so evaluateHedgedLockouts never reaches them today", () => {
    const f = JSON.parse(readFileSync(new URL("./__fixtures__/v22-live-accounts-2026-10-17.json", import.meta.url), "utf8")) as { accounts: { slab: string }[] };
    assert.equal(f.accounts.length, 13);
    for (const a of f.accounts) assert.equal(isV18MarketHeader(new Uint8Array(Buffer.from(a.slab, "base64"))), false);
  });
});

describe("monitor over snapshots", () => {
  const PRICE = 1_000n; // e6: 0.001 -> N_cap = 1e12 for the CATE LP's C_m (1e9)
  const NCAP = 1_000_000_000_000n;
  const lpBytes = new Uint8Array(fx("cate-lp-portfolio-v18")); // long 6,400,773,782 (0.64% of N_cap: flat)

  function world(o: { growth?: boolean; bound?: boolean; uLong?: bigint; uShort?: bigint }) {
    const lp = Keypair.generate().publicKey;
    const lpQ = 6_400_773_782n;
    const m = patchedMarket({
      effectivePriceE6: PRICE,
      growthLambdaBps: o.growth === false ? undefined : 10_000,
      oiEffLong: (o.uLong ?? (NCAP * 95n) / 100n) + lpQ,
      oiEffShort: o.uShort ?? (NCAP * 95n) / 100n,
    });
    const s = snapshot({ label: "CATE", marketData: m, registryData: registryBytes({ bound: o.bound !== false }), vaultLpData: vaultLpStateBytes({ lp }) });
    const c = fakeConn({ accounts: new Map([[lp.toBase58(), lpBytes]]) });
    return { s, c };
  }

  it("both crowds at 95% of N_cap with the LP at 0.64%: ALERT with the numbers", async () => {
    const { s, c } = world({});
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.equal(r.alerts.length, 1);
    const a = r.alerts[0];
    assert.equal(a.kind, "hedged-lockout");
    assert.equal(a.subject, "CATE");
    assert.equal(a.severity, "warn");
    assert.deepEqual([a.data?.utilLongBps, a.data?.utilShortBps, a.data?.lpNetBps], [9500, 9500, 64]);
    assert.equal(a.data?.nCapQ, NCAP.toString());
    assert.equal(r.records[0].verdict.status, "alert");
  });

  it("one side at 50%: no alert (record still says ok)", async () => {
    const { s, c } = world({ uShort: NCAP / 2n });
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.equal(r.alerts.length, 0);
    assert.equal(r.records[0].verdict.status, "ok");
  });

  it("no growth block: NO-OP, and not even an LP read (today's programs)", async () => {
    const { s, c } = world({ growth: false });
    const r = await evaluateHedgedLockouts(c.conn as never, [s], T);
    assert.deepEqual(r, { alerts: [], records: [] });
    assert.equal(c.calls.length, 0);
  });

  it("an unbound market is skipped", async () => {
    const { s, c } = world({ bound: false });
    assert.deepEqual((await evaluateHedgedLockouts(c.conn as never, [s], T)).alerts, []);
    assert.equal(c.calls.length, 0);
  });

  it("an unreadable LP portfolio is skipped, never thrown", async () => {
    const { s } = world({});
    const c = fakeConn({ accounts: new Map() });
    assert.deepEqual((await evaluateHedgedLockouts(c.conn as never, [s], T)).alerts, []);
  });

  it("a market account that is not a market at all does not throw", async () => {
    const lp = Keypair.generate().publicKey;
    const s = snapshot({ marketData: new Uint8Array(50), registryData: registryBytes({ bound: true }), vaultLpData: vaultLpStateBytes({ lp }) });
    assert.deepEqual(await evaluateHedgedLockouts(fakeConn().conn as never, [s], T), { alerts: [], records: [] });
  });

  it("decodeAssetGrowthV19 is null on today's real v18 market bytes (the no-op precondition)", () => {
    for (const f of ["sol-market-v18", "ansem-market-v18", "jup-market-v18", "cate-market-v18"]) {
      assert.equal(decodeAssetGrowthV19(new Uint8Array(fx(f)), 0), null, f);
    }
  });
});
