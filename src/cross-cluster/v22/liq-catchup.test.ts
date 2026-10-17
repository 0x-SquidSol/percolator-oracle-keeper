/**
 * LIQ-DIAG 2026-10-17 (E2E-B B1): a bankrupt account nobody refreshed during an outage cannot be liquidated while the
 * asset clock lags by a full accrual window or more (the program refuses every refresh with Custom(22) until the
 * observation cranks have closed the gap). The v22 loop must send those catch-up cranks for a SINGLE-asset market too
 * (it used to do so for multi-asset markets only), and spread a gap larger than one transaction over several cycles.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { resetJobCounters } from "./exec.ts";
import { resetPairingStats } from "./sweep.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { setSweepDelegate, setLoneLpCrankSuppressor, setBondFeeDelegated, setProtectiveTrigger } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { MAX_CATCHUP_CRANKS, catchupCrankCount, planCrankTx } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { fakeLoopConn, key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const MARKET = key(900);
const DT = 150n; // v22MarketBytes: max_accrual_dt_slots
const NOW = 50000n;

beforeEach(() => { resetPairingStats(); resetJobCounters(); });
afterEach(() => { setSweepDelegate(null); setLoneLpCrankSuppressor(null); setBondFeeDelegated(false); setProtectiveTrigger(null); setV22HealthProvider(null); });

async function runAt(gap: bigint) {
  const f = fakeLoopConn({ readSlot: Number(NOW), market: v22MarketBytes({ currentSlot: NOW, slotLast: NOW - gap }), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(key(901), 0n), lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }) });
  const lines: string[] = [];
  const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l) });
  const handled = await loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22" }, marketData: v22MarketBytes({ currentSlot: NOW, slotLast: NOW - gap }), slot: Number(NOW), dryRun: false });
  return { f, lines, handled };
}

describe("single-asset v22 catch-up before the round", () => {
  it("gap of 3 windows + change: ONE tx of 3 observation cranks, no refresh (the round runs next cycle)", async () => {
    const r = await runAt(DT * 3n + 20n);
    assert.equal(r.handled, true);
    assert.ok(r.lines.some((l) => l.includes("[v22][catchup]") && l.includes("3 catch-up crank(s)")), r.lines.join("\n"));
    assert.equal(r.f.sent.length, 1);
    assert.deepEqual(r.f.sent[0].tags, [5, 5, 5], "exactly floor(gap/dt) cranks, nothing else");
  });
  it("gap far beyond one tx (100 windows): the tx is capped at MAX_CATCHUP_CRANKS; the rest is the next cycles' work", async () => {
    const r = await runAt(DT * 100n);
    assert.equal(r.f.sent.length, 1);
    assert.equal(r.f.sent[0].tags.length, MAX_CATCHUP_CRANKS);
    assert.ok(r.f.sent[0].tags.every((t: number) => t === 5));
    assert.equal(catchupCrankCount(DT * 100n, DT), MAX_CATCHUP_CRANKS);
    // 100 windows = 3 cycles: 40 + 40 + 20, each recomputed from the market that cycle reads
    assert.deepEqual([DT * 100n, DT * 60n, DT * 20n].map((g) => catchupCrankCount(g, DT)), [40, 40, 20]);
  });
  it("NEGATIVE CONTROL: a gap below one window sends no catch-up (steady state unchanged)", async () => {
    const r = await runAt(DT - 1n);
    assert.ok(!r.lines.some((l) => l.includes("[v22][catchup]")));
    assert.ok(r.f.sent.every((s) => s.tags.length !== 0));
  });
});

describe("legacy planner: catch-up + accrue + refresh + liquidation in one tx while the gap allows it", () => {
  const p = (i: number): PositionedPortfolio => ({ pubkey: key(700 + i), isLp: false } as unknown as PositionedPortfolio);
  const build = (gap: bigint) => planCrankTx({ owner: key(1), market: key(2), lpPortfolio: key(3), catchup: catchupCrankCount(gap, DT), refreshTargets: [p(1)], liquidateTargets: [p(1).pubkey] });
  it("673/500-style gap (4 windows + change): 4 catch-ups, accrue, refresh, liquidation crank", () => {
    assert.deepEqual(build(DT * 4n + 73n).cranks.map((c) => c.kind), ["catchup", "catchup", "catchup", "catchup", "accrue", "refresh", "liquidate"]);
  });
  it("more than MAX_CATCHUP_WITH_REFRESH windows: catch-up only, no refresh yet", () => {
    assert.ok(build(DT * 12n).cranks.every((c) => c.kind === "catchup"));
  });
});
