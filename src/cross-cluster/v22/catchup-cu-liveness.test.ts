/**
 * v22price 2026-10-22 (v2.2 devnet, keeper 91bd33e):
 *   1. A v2.2 bounded catch-up crank costs 36,350 CU (simulated on SOL BYFuWyuo…). The planner priced it at 30k and
 *      packed 40 per tx (1.454M > 1.4M): boot reverts "compute exhausted at 1400000 CU (40 cranks)" and a deep-stale
 *      single-asset market that never caught up. The per-tx catch-up count is now CU-capped for every hint count.
 *   2. cap4b 2xhs: a lapsed Fresh backing bucket on asset 2 (domain 5) refused every round with EngineStale (19). The
 *      v2.2 loop now plans liveness repairs over every engine slot and lands them before the round.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { resetJobCounters } from "./exec.ts";
import { resetPairingStats } from "./sweep.ts";
import { V22Loop, livenessRepairsFor } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { setSweepDelegate, setLoneLpCrankSuppressor, setBondFeeDelegated, setProtectiveTrigger } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { ACCRUAL_TX_CU_HEADROOM, CATCHUP_CRANK_CU, MAX_CATCHUP_CRANKS, MAX_TX_CU, planCrankTx } from "../positioned-refresh.ts";
import { maxCatchupCranksFor } from "../multi-asset.ts";
import { detectLayout } from "../market-layout.ts";
import { livenessOffsetsFor } from "../liveness-repair.ts";
import { fakeLoopConn, key, portfolioBytes, registryBytes, v22Ctx, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

/** Measured v2.2 cost of one bounded catch-up crank (simulation, 2026-10-22): SOL BYFuWyuo, and the band market CHILLHOUSE ALdzXdcR. */
const MEASURED_V22_CATCHUP_CU = 36_350;
const MEASURED_V22_BAND_CATCHUP_CU = 42_538;
const MARKET = key(900);
const NOW = 50_000n;

beforeEach(() => { resetPairingStats(); resetJobCounters(); });
afterEach(() => { setSweepDelegate(null); setLoneLpCrankSuppressor(null); setBondFeeDelegated(false); setProtectiveTrigger(null); setV22HealthProvider(null); });

/** Write a backing bucket (status @96, expiry @88 of the 97 B bucket) of `asset`'s `side` into v22 market bytes. */
function withBucket(data: Uint8Array, asset: number, side: 0 | 1, status: number, expiry: bigint): Uint8Array {
  const b = Buffer.from(data);
  const det = detectLayout(b);
  if (!det.known) throw new Error("test market layout unknown");
  const o = livenessOffsetsFor(det.layout, asset)!;
  const at = o.engineBase + (side === 0 ? o.backingLong : o.backingShort);
  b[at + 96] = status;
  b.writeBigUInt64LE(expiry, at + 88);
  return new Uint8Array(b);
}

describe("catch-up crank count is CU-capped (single-asset too)", () => {
  it("never plans more catch-up compute than the tx limit at the MEASURED v2.2 cost", () => {
    for (const hints of [1, 2, 5]) {
      const n = maxCatchupCranksFor(MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, hints, MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM);
      assert.ok(n >= 1 && n <= MAX_CATCHUP_CRANKS);
      if (hints === 1) assert.ok(n * MEASURED_V22_BAND_CATCHUP_CU + ACCRUAL_TX_CU_HEADROOM / 2 <= MAX_TX_CU, `${n} single-asset cranks overflow 1.4M`);
    }
  });
  it("NEGATIVE CONTROL: the old pricing (30k, uncapped 40) is exactly the overflow seen live", () => {
    assert.ok(40 * MEASURED_V22_CATCHUP_CU > MAX_TX_CU);
    assert.ok(CATCHUP_CRANK_CU >= MEASURED_V22_BAND_CATCHUP_CU, "the static estimate must not be below the worst measured cost");
    assert.ok(34 * MEASURED_V22_BAND_CATCHUP_CU > MAX_TX_CU, "a band market overflows even at 34 cranks (the first fix's count)");
  });
  it("legacy planner (boot crank): a deep-stale single-asset market gets a CU-capped catch-up-only tx", () => {
    const plan = planCrankTx({ owner: key(1), market: key(2), lpPortfolio: key(3), catchup: MAX_CATCHUP_CRANKS, refreshTargets: [] });
    const n = plan.cranks.filter((c) => c.kind === "catchup").length;
    assert.equal(n, 28);
    assert.equal(plan.cranks.length, n, "catch-up only, no accrual");
    assert.ok(n * MEASURED_V22_CATCHUP_CU <= plan.computeUnits && plan.computeUnits <= MAX_TX_CU);
  });
});

describe("v2.2 liveness repairs over every engine slot", () => {
  it("plans ExpireBackingBucket for a lapsed Fresh bucket on asset 2 (domain 5), nothing for live / non-Fresh buckets", () => {
    let data = v22MarketBytes({ slots: 5, currentSlot: NOW });
    data = withBucket(data, 2, 1, 1, NOW - 10n); // Fresh, lapsed -> repair
    data = withBucket(data, 3, 1, 1, NOW + 77_000n); // Fresh, live -> none
    data = withBucket(data, 0, 0, 2, NOW - 1_000n); // not Fresh -> none
    const ctx = { ...v22Ctx({ slots: 5, currentSlot: NOW }), data };
    assert.deepEqual(livenessRepairsFor(ctx), [{ kind: "expire", domain: 5 }]);
  });
  it("NEGATIVE CONTROL: the asset-0-only decode (the legacy planner's view) misses it", () => {
    let data = v22MarketBytes({ slots: 5, currentSlot: NOW });
    data = withBucket(data, 2, 1, 1, NOW - 10n);
    const ctx = { ...v22Ctx({ slots: 1, currentSlot: NOW }), data };
    assert.deepEqual(livenessRepairsFor(ctx), []);
  });

  async function runLoop(market: Uint8Array) {
    const f = fakeLoopConn({ readSlot: Number(NOW), market, registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(key(901), 0n), lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }) });
    const lines: string[] = [];
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l) });
    const run = () => loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22" }, marketData: market, slot: Number(NOW), dryRun: false });
    return { f, lines, run };
  }

  it("the sweep delegate lands the repair FIRST (one tag-89 tx) and leaves the round to the next cycle", async () => {
    const market = withBucket(v22MarketBytes({ slots: 5, currentSlot: NOW }), 2, 1, 1, NOW - 10n);
    const r = await runLoop(market);
    assert.equal(await r.run(), true);
    assert.equal(r.f.sent.length, 1, r.lines.join("\n"));
    assert.deepEqual(r.f.sent[0].tags, [89]);
    assert.ok(r.lines.some((l) => l.includes("[v22][repair]") && l.includes("ExpireBackingBucket(d5)") && l.includes("sent landed")), r.lines.join("\n"));
  });
  it("NEGATIVE CONTROL: no lapsed bucket -> no repair tx, the round runs as before", async () => {
    const r = await runLoop(v22MarketBytes({ slots: 5, currentSlot: NOW }));
    await r.run();
    assert.ok(!r.lines.some((l) => l.includes("[v22][repair]")));
    assert.ok(r.f.sent.every((s) => !s.tags.includes(89)));
  });
});

describe("v2.2 loop sizes the catch-up tx from a one-crank simulation of the market", () => {
  async function catchupAt(measuredCu: number) {
    const gap = 150n * 100n; // 100 windows (v22MarketBytes max_accrual_dt_slots = 150)
    const market = v22MarketBytes({ currentSlot: NOW, slotLast: NOW - gap });
    const f = fakeLoopConn({ readSlot: Number(NOW), market, registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(key(901), 0n), lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }), simUnitsConsumed: (d: { tags: number[] }) => d.tags.filter((t) => t === 5).length * measuredCu });
    const lines: string[] = [];
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l) });
    await loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22" }, marketData: market, slot: Number(NOW), dryRun: false });
    return { f, lines };
  }
  for (const [name, cu, expected] of [["SOL-like (36,350)", MEASURED_V22_CATCHUP_CU, 33], ["band market (42,538)", MEASURED_V22_BAND_CATCHUP_CU, 28]] as const) {
    it(`${name}: ${expected} cranks, and the real cost of the tx fits 1.4M`, async () => {
      const r = await catchupAt(cu);
      assert.equal(r.f.sent.length, 1, r.lines.join("\n"));
      assert.equal(r.f.sent[0].tags.length, expected);
      assert.ok(expected * cu <= MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM / 2);
    });
  }
});

describe("catch-up is paced across markets (RPC rate limit)", () => {
  it("a second market behind in the same instant waits for the spacing; after it, it catches up", async () => {
    const gap = 150n * 10n;
    const market = v22MarketBytes({ currentSlot: NOW, slotLast: NOW - gap });
    const f = fakeLoopConn({ readSlot: Number(NOW), market, registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(key(901), 0n), lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }) });
    let t = 1_000_000;
    const lines: string[] = [];
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l), now: () => t, catchupSpacingMs: 1500 });
    const run = (label: string) => loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label }, marketData: market, slot: Number(NOW), dryRun: false });
    assert.equal(await run("A"), true);
    assert.equal(f.sent.length, 1);
    t += 100;
    assert.equal(await run("B"), true, "handled (the legacy cranker must not send its own catch-up)");
    assert.equal(f.sent.length, 1, "paced: nothing sent inside the spacing");
    t += 1500;
    await run("B");
    assert.equal(f.sent.length, 2);
  });
});

