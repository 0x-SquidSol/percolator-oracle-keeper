/**
 * Tests for the security-review fixes of PR #148 (review file security-review-v22-keeper-2026-10-07.md).
 * Each block names the item and carries a negative control (the behaviour the fix removes, or a case the fix must not touch).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCOUNTS_PERMISSIONLESS_CRANK_BASE, buildSettleHoldingRentIxV22, deriveLpVaultRegistry, parsePortfolioV17 } from "@percolatorct/sdk";
import { allJobCounters, resetJobCounters } from "./exec.ts";
import { DEFAULT_SWEEP_ROUND_CONFIG, QUARANTINE_FIRST_SLOTS, buildSweepTxIxs, freshGapBackoff, pairingStats, resetPairingStats, runSettleRound } from "./sweep.ts";
import { crankBondFee, planBondFee } from "./fee-bond.ts";
import { analysePortfolios } from "./positioned.ts";
import type { V22Positioned } from "./positioned.ts";
import { crankOracleAccounts } from "./market.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { EARN_EXIT_COOLDOWN_SLOTS, executeKeeperExits, fetchRedemptionRequests, freshEarnExitState } from "./earn-exit.ts";
import { redactErrorText } from "./redact.ts";
import { setProtectiveTrigger } from "./delegation.ts";
import { setSweepDelegate, setLoneLpCrankSuppressor, setBondFeeDelegated } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { VaultLpCranker } from "../vault-lp-crank.ts";
import { buildObservationCrankIx } from "../positioned-refresh.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { computeAt, customAt, execCtx, fakeExecConn, fakeLoopConn, key, pf, portfolioBytes, refusePortfolio, registryBytes, v22Ctx, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const LP = key(500);
const MARKET = key(900);
const cps = (n: number) => Array.from({ length: n }, (_, i) => pf(i + 1, 1));
const hasKey = (s: { keys: string[][] }, pk: PublicKey) => s.keys.some((ks) => ks.includes(pk.toBase58()));
const deps = (conn: ReturnType<typeof fakeExecConn>["conn"], o: { slot?: () => number; dry?: boolean } = {}) => ({ exec: execCtx(conn, o.dry), getSlot: async () => (o.slot ? o.slot() : 1010), hold: () => {}, release: () => {} });
const lpOnly = (s: { keys: string[][] }) => hasKey(s, LP);

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
});
afterEach(() => {
  setSweepDelegate(null);
  setLoneLpCrankSuppressor(null);
  setBondFeeDelegated(false);
  setProtectiveTrigger(null);
  setV22HealthProvider(null);
});

describe("item 1: a pruned refresh is NOT a settled counterparty", () => {
  it("single tx: a band-refused counterparty (104/111/112/113) blocks the LP under strict, is counted under prefer; 22 (current) stays paired", async () => {
    for (const code of [104, 111, 112, 113]) {
      resetPairingStats();
      const target = pf(3, 1);
      const list = [pf(1), pf(2), target, pf(4), pf(5)];
      const strict = fakeExecConn({ simErr: refusePortfolio(target.pubkey, code, true) });
      const rs = await runSettleRound(deps(strict.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100 }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "strict" });
      assert.equal(rs.lpSettled, false, `strict ${code}`);
      assert.equal(strict.sent.length, 0, "nothing sent: the LP tx was held after pruning");
      assert.equal(pairingStats.lpHeldCounterpartyMiss, 1);
      assert.ok(rs.missing.some((m) => m.key === target.pubkey.toBase58() && m.why === "band"));

      resetPairingStats();
      const prefer = fakeExecConn({ simErr: refusePortfolio(target.pubkey, code, true) });
      const rp = await runSettleRound(deps(prefer.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
      assert.equal(rp.lpSettled, true, `prefer ${code}`);
      assert.equal(pairingStats.unpairedLpSettles, 1, "the miss is COUNTED");
      assert.equal(pairingStats.pairedLpSettles, 0, "and the round is not 'paired'");
    }
    // NEGATIVE CONTROL: Custom(22) means "already current": settled, still paired.
    resetPairingStats();
    const t = pf(3, 1);
    const cur = fakeExecConn({ simErr: refusePortfolio(t.pubkey, 22, true) });
    const r = await runSettleRound(deps(cur.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: [pf(1), pf(2), t], nowSlot: 100 }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "strict" });
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.pairedLpSettles, 1);
    assert.ok(r.settled.includes(t.pubkey.toBase58()));
  });

  it("multi tx: a band-refused counterparty in phase 1 holds the LP tx under strict; prefer sends it and counts the miss", async () => {
    const list = cps(30);
    const target = list[0];
    for (const mode of ["strict", "prefer"] as const) {
      resetPairingStats();
      const f = fakeExecConn({ simErr: refusePortfolio(target.pubkey, 104, true) });
      const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100 }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: mode });
      if (mode === "strict") {
        assert.equal(r.lpSettled, false);
        assert.ok(f.sent.every((s) => !lpOnly(s)));
        assert.equal(pairingStats.lpHeldCounterpartyMiss, 1);
      } else {
        assert.equal(r.lpSettled, true);
        assert.equal(pairingStats.unpairedLpSettles, 1);
        assert.equal(pairingStats.pairedLpSettles, 0);
      }
    }
  });
});

describe("item 2: one refused portfolio does not block its whole tx; it is quarantined", () => {
  it("a HARD refusal (999) is pruned, its neighbours are still sent, and it is not retried until the cool-down ends", async () => {
    const list = cps(30);
    const bad = list[7];
    const quarantine = new Map<string, bigint>();
    const f = fakeExecConn({ simErr: refusePortfolio(bad.pubkey, 999) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100, quarantine }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(pairingStats.hardRefusals >= 1, true);
    assert.equal(f.sent.length, r.plan.txs.length, "every planned tx was still sent");
    assert.ok(f.sent.every((s) => !hasKey(s, bad.pubkey)), "the poisoned portfolio is in no sent tx");
    assert.equal(r.settled.length, 29, "the other 29 settled");
    assert.equal(quarantine.get(bad.pubkey.toBase58()), BigInt(100 + QUARANTINE_FIRST_SLOTS), "first cool-down is the SHORT one (150)");
    // next round inside the cool-down: the portfolio is not even planned (its key never appears in a simulation)
    const g = fakeExecConn();
    const r2 = await runSettleRound(deps(g.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 110, quarantine }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(g.sims.every((s) => !hasKey(s, bad.pubkey)));
    assert.ok(r2.missing.some((m) => m.key === bad.pubkey.toBase58() && m.why === "quarantined"));
    // after the cool-down it is retried
    const h = fakeExecConn();
    await runSettleRound(deps(h.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100 + QUARANTINE_FIRST_SLOTS + 1, quarantine }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(h.sims.some((s) => hasKey(s, bad.pubkey)));
  });
});

describe("item 3: no forced LP-alone settle; protective rounds use the full shape", () => {
  it("prefer: five rounds of failing counterparty txs never produce an LP-alone settle (the old 'force after 3' is gone)", async () => {
    const f = fakeExecConn({ simErr: (d) => (lpOnly(d) ? null : customAt(0, 999)) });
    for (let i = 0; i < 5; i++) {
      const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
      assert.equal(r.lpSettled, false, `round ${i}`);
    }
    assert.equal(f.sent.length, 0);
    assert.equal(pairingStats.lpHeldPhase1Unlanded, 5);
  });
  it("PROTECTIVE round: the LP is settled LAST in a tx WITH counterparties, never alone", async () => {
    const f = fakeExecConn({ simErr: (d) => (lpOnly(d) ? null : customAt(0, 999)) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), nowSlot: 100, protective: true }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.protectiveRounds, 1);
    assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0].tags.length > 1, "LP crank plus refreshes of the counterparties that fit");
  });
});

describe("item 4: a gap-exceeded round backs off and is counted", () => {
  it("round 1 abandons (gap 9 > 8) and sets a backoff; the next round sends NOTHING; it then resumes; success resets", async () => {
    const backoff = freshGapBackoff();
    const f = fakeExecConn({ landedSlot: () => 1000 });
    const run = (slot: number) => runSettleRound(deps(f.conn, { slot: () => slot }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), nowSlot: 100, gapBackoff: backoff }, DEFAULT_SWEEP_ROUND_CONFIG);
    const r1 = await run(1009);
    assert.match(r1.abandoned ?? "", /backing off 1 round/);
    assert.equal(pairingStats.gapExceeded, 1);
    const simsAfter1 = f.sims.length;
    const r2 = await run(1009);
    assert.match(r2.abandoned ?? "", /gap backoff/);
    assert.equal(f.sims.length, simsAfter1, "no phase 1 re-sent during the backoff");
    assert.equal(pairingStats.gapBackoffRounds, 1);
    const r3 = await run(1009); // backoff over: phase 1 again, gap again -> level 2
    assert.ok(f.sims.length > simsAfter1);
    assert.equal(backoff.skipRounds, 2, "capped at 2 rounds so the engine clock does not stall");
    backoff.skipRounds = 0;
    const ok = await run(1003);
    assert.equal(ok.lpSettled, true);
    assert.equal(backoff.level, 0);
    assert.equal(pairingStats.consecutiveGapExceeded, 0);
    void r3;
  });
});

describe("item 5: tag 78 is counted, pruned, and rides the end of a round", () => {
  const positioned = (cs: ReturnType<typeof pf>[]): V22Positioned => ({ all: cs, counterparties: cs, lp: pf(901, 2, { lp: true }), minLegAbs: new Map(), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 });
  const sd = (conn: ReturnType<typeof fakeExecConn>["conn"]) => ({ exec: execCtx(conn), getSlot: async () => 1000 });
  it("prefer + overflow: the LP-alone shape is COUNTED (it was uncounted)", async () => {
    const f = fakeExecConn();
    const big = positioned(Array.from({ length: 12 }, (_, i) => pf(i + 1)));
    const r = await crankBondFee(sd(f.conn), v22Ctx(), big, { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "sent");
    assert.equal(pairingStats.unpairedLpSettles, 1);
    assert.equal(pairingStats.feeUnpairedLpSettles, 1);
    // NEGATIVE CONTROL: the paired shape is not counted as unpaired
    resetPairingStats();
    const g = fakeExecConn();
    await crankBondFee(sd(g.conn), v22Ctx(), positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(pairingStats.feeUnpairedLpSettles, 0);
  });
  it("paired shape: a non-stale counterparty (Custom 22 at its refresh) is PRUNED and 78 still goes (it used to be refused whole)", async () => {
    const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(1, 22) : null) });
    const r = await crankBondFee(sd(f.conn), v22Ctx(), positioned([pf(1), pf(2)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "sent");
    assert.deepEqual(f.sent[0].tags, [5, 5, 78], "LP crank, the one remaining refresh, 78");
  });
  it("after-round shape: 78 ALONE (the LP was just settled paired) and counted as such", async () => {
    const f = fakeExecConn();
    const ctx = v22Ctx();
    const p = planBondFee(ctx, key(1), positioned([pf(1)]), "prefer", 32, { afterRound: true });
    assert.equal(p.shape, "after-round");
    assert.deepEqual(p.ixs.map((i) => i.data[0]), [78]);
    const r = await crankBondFee(sd(f.conn), ctx, positioned([pf(1)]), { mode: "prefer", weightBudget: 32, afterRound: true });
    assert.equal(r.kind, "sent");
    assert.equal(pairingStats.feeAfterRound, 1);
    assert.equal(pairingStats.unpairedLpSettles, 0);
  });
  it("78 refusal at the tail: 38 is 'nothing'; any other code on the after-round shape is deferred, not an LP settle", async () => {
    const a = fakeExecConn({ simErr: () => customAt(0, 38) });
    assert.equal((await crankBondFee(sd(a.conn), v22Ctx(), positioned([]), { mode: "prefer", weightBudget: 32, afterRound: true })).kind, "nothing");
    const b = fakeExecConn({ simErr: () => customAt(0, 999) });
    assert.equal((await crankBondFee(sd(b.conn), v22Ctx(), positioned([]), { mode: "prefer", weightBudget: 32, afterRound: true })).kind, "deferred");
    assert.equal(b.sent.length, 0);
  });
});

describe("item 6: lone LP crank stays suppressed; protection runs a PAIRED round, never a lone crank", () => {
  it("suppressed path calls the protective trigger (once per new mark) and makes NO RPC call", async () => {
    let calls = 0;
    const conn = new Proxy({}, { get: () => async () => { calls++; return [null]; } });
    const c = new VaultLpCranker(conn as never, Keypair.generate(), { fire: async () => {} } as never, { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 1000, settleMs: 0 });
    const seen: string[] = [];
    setLoneLpCrankSuppressor(() => true);
    setProtectiveTrigger((m) => seen.push(m));
    assert.equal(await c.onPushLanded("mk", 100n), "suppressed");
    assert.equal(await c.onPushLanded("mk", 100n), "suppressed");
    assert.equal(await c.onPushLanded("mk", 101n), "suppressed");
    assert.deepEqual(seen, ["mk", "mk"], "once per NEW mark");
    assert.equal(calls, 0, "no lone LP crank, no RPC");
    // NEGATIVE CONTROL: not suppressed -> the normal path runs and the trigger is never called
    setLoneLpCrankSuppressor(null);
    seen.length = 0;
    assert.equal(await c.onPushLanded(Keypair.generate().publicKey.toBase58(), 100n), "not-bound");
    assert.deepEqual(seen, []);
  });
  it("V22Loop: a landed push on a market whose LP has a senior draw pending runs ONE paired round; a healthy LP runs none", async () => {
    const lp = key(901);
    const mk = (outstanding: bigint) => {
      const f = fakeLoopConn({ market: v22MarketBytes(), registry: registryBytes({ bound: true, ext: true, bond: false }), vaultLpState: vaultLpStateBytes(lp, outstanding), lpAccount: portfolioBytes({ owner: key(8), capital: 1000n, pnl: 0n, legs: [{ side: 0, basis: 5n }] }) });
      const lines: string[] = [];
      const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (l) => lines.push(l) });
      return { f, lines, loop };
    };
    const hot = mk(5n);
    assert.equal(await hot.loop.sweepDelegate({ conn: hot.f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22" }, marketData: v22MarketBytes(), slot: 5000, dryRun: false }), true);
    const before = hot.f.sims.length;
    await (hot.loop as unknown as { protectiveRound(m: string): Promise<void> }).protectiveRound(MARKET.toBase58());
    assert.ok(hot.lines.some((l) => l.includes("[v22][protect]") && l.includes("senior draw outstanding")));
    assert.ok(hot.f.sims.length > before, "a round ran");
    const calm = mk(0n);
    await calm.loop.sweepDelegate({ conn: calm.f.conn as never, keeper: Keypair.generate(), entry: { marketAddress: MARKET.toBase58(), label: "T/V22" }, marketData: v22MarketBytes(), slot: 5000, dryRun: false });
    const b2 = calm.f.sims.length;
    await (calm.loop as unknown as { protectiveRound(m: string): Promise<void> }).protectiveRound(MARKET.toBase58());
    assert.equal(calm.f.sims.length, b2 + 1, "only the read-only signal simulation ran");
    assert.equal(calm.f.sent.length, 1, "no protective round: only the delegate's own round above was sent");
    assert.ok(!calm.lines.some((l) => l.includes("[v22][protect]")));
  });
});

describe("item 7 / N-3: rent (tag 106) runs AFTER the LP tx, sequentially, never in place of a refresh", () => {
  const rentFor = (ctx: ReturnType<typeof v22Ctx>, keeper: PublicKey) => (p: { pubkey: PublicKey }) => buildSettleHoldingRentIxV22(ctx.sdk, keeper, p.pubkey, 0, 5000n, []);
  it("a due portfolio keeps its PLAIN refresh in phase 1; its 106 goes in a later tx, after the LP tx", async () => {
    const ctx = v22Ctx({ rent: true });
    const f = fakeExecConn();
    const d = deps(f.conn);
    const target = pf(2, 1);
    const r = await runSettleRound(d, { market: MARKET, label: "T" }, { lp: LP, counterparties: [pf(1), target, pf(3)], nowSlot: 100, rent: { due: new Set([target.pubkey.toBase58()]), build: rentFor(ctx, d.exec.keeper.publicKey) } }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent[0].tags, [5, 5, 5, 5], "the round tx has ONLY plain cranks: the refresh (so a liquidation still happens) stays");
    assert.ok(hasKey(f.sent[0], target.pubkey), "the due portfolio is refreshed in the round");
    assert.deepEqual(f.sent[1].tags, [106], "then ONE separate tx with the 106");
    assert.ok(f.sent[1].order > f.sent[0].order, "after the LP tx");
    assert.deepEqual(r.rentSettled, [target.pubkey.toBase58()]);
    assert.equal(pairingStats.rentSettlesInRound, 1);
  });
  it("multi-tx rounds: no phase-1 tx carries a 106 (phase 1 stays parallel: no LP write lock from rent)", async () => {
    const ctx = v22Ctx({ rent: true });
    const list = cps(30);
    const f = fakeExecConn();
    const d = deps(f.conn);
    await runSettleRound(d, { market: MARKET, label: "T" }, { lp: LP, counterparties: list, nowSlot: 100, rent: { max: 3, due: new Set(list.slice(0, 3).map((x) => x.pubkey.toBase58())), build: rentFor(ctx, d.exec.keeper.publicKey) } }, DEFAULT_SWEEP_ROUND_CONFIG);
    const idx106 = f.sent.map((s, i) => (s.tags.includes(106) ? i : -1)).filter((i) => i >= 0);
    assert.equal(idx106.length, 3);
    const lpIdx = f.sent.findIndex((s) => hasKey(s, LP));
    assert.ok(idx106.every((i) => i > lpIdx), "every 106 comes after the LP tx");
    assert.ok(f.sent.filter((s) => s.tags.includes(106)).every((s) => s.tags.length === 1), "one 106 per tx");
  });
  it("NEGATIVE CONTROLS: no rent when the LP did not settle, none for a portfolio the round did not settle, 106 refusal changes nothing else", async () => {
    const ctx = v22Ctx({ rent: true });
    const target = pf(2, 1);
    const build = (d: ReturnType<typeof deps>) => ({ due: new Set([target.pubkey.toBase58()]), build: rentFor(ctx, d.exec.keeper.publicKey) });
    // LP held (counterparty tx did not land): no rent tx at all
    const a = fakeExecConn({ confirmFail: () => 7 });
    const da = deps(a.conn);
    await runSettleRound(da, { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30).concat([target]), nowSlot: 100, rent: build(da) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(a.sent.every((s) => !s.tags.includes(106)));
    // the target was refused (band) in the round: not settled -> no rent for it
    const b = fakeExecConn({ simErr: refusePortfolio(target.pubkey, 104, true) });
    const db = deps(b.conn);
    await runSettleRound(db, { market: MARKET, label: "T" }, { lp: LP, counterparties: [pf(1), target], nowSlot: 100, rent: build(db) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(b.sent.every((s) => !s.tags.includes(106)));
    // a refused 106 is not recorded and does not affect the round
    const c = fakeExecConn({ simErr: (d) => (d.tags.includes(106) ? customAt(0, 999) : null) });
    const dc = deps(c.conn);
    const r = await runSettleRound(dc, { market: MARKET, label: "T" }, { lp: LP, counterparties: [pf(1), target], nowSlot: 100, rent: build(dc) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.deepEqual(r.rentSettled, []);
    assert.equal(r.lpSettled, true);
  });
  it("the tick's lone rent timer is OFF while the sweep + pairing own rent; ON when the sweep is off", async () => {
    const owner = key(7);
    const mk = (env: Record<string, string>) => {
      const f = fakeLoopConn({ market: v22MarketBytes({ rent: true }), registry: registryBytes({ bound: true, ext: true }), vaultLpState: vaultLpStateBytes(key(901)), portfolios: [{ pubkey: key(11), data: portfolioBytes({ owner, capital: 10n, legs: [{ side: 0, basis: 5n }] }) }] });
      const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [{ marketAddress: MARKET.toBase58(), label: "T/V22" }], flags: v22FlagsFromEnv(env), dryRun: false, log: () => {} });
      return { f, loop };
    };
    const owned = mk({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on", KEEPER_V22_HOLDING_RENT: "on" });
    await owned.loop.tick();
    assert.equal(owned.f.sims.filter((s) => s.tags.includes(106)).length, 0);
    const timer = mk({ KEEPER_V22: "on", KEEPER_V22_HOLDING_RENT: "on" });
    await timer.loop.tick();
    assert.ok(timer.f.sims.some((s) => s.tags.includes(106)));
  });
});

describe("items 8 and 10: the vault LP is the registry's exact key; the anchor is the KEEPER's own flat portfolio", () => {
  const keeper = key(42);
  const user = key(43);
  const lp = key(50);
  const acc = (n: number, owner: PublicKey, o: Parameters<typeof portfolioBytes>[0] extends infer T ? Partial<T> : never = {}) => ({ pubkey: key(n), data: portfolioBytes({ owner, ...o } as Parameters<typeof portfolioBytes>[0]) });
  it("F-4: a matcher-enabled impostor is a COUNTERPARTY; the real LP (even flat) is the LP", () => {
    const impostor = acc(60, user, { legs: [{ side: 0, basis: 5n }], matcher: true });
    assert.equal(parsePortfolioV17(impostor.data).matcherEnabled, true, "fixture: the impostor really is matcher-enabled (the old code would call it the LP)");
    const r = analysePortfolios([impostor, acc(50, key(44), { legs: [{ side: 1, basis: 5n }] })], { lpPortfolio: lp, portfolioLen: 10603 });
    assert.ok(r.lp?.pubkey.equals(lp));
    assert.ok(r.counterparties.some((c) => c.pubkey.equals(impostor.pubkey)));
    // a flat LP is still the LP
    const flat = analysePortfolios([impostor], { lpPortfolio: lp, portfolioLen: 10603 });
    assert.ok(flat.lp?.pubkey.equals(lp));
    assert.equal(flat.lp?.longLegs, 0);
    // unknown LP: no LP at all (the delegate declines), nobody is guessed
    assert.equal(analysePortfolios([impostor], { lpPortfolio: null, portfolioLen: 10603 }).lp, null);
  });
  it("anchor: only the KEEPER's own flat portfolio; a user's flat portfolio is never picked (negative control)", () => {
    const userFlat = acc(61, user);
    const keeperFlat = acc(62, keeper);
    const keeperBusy = acc(63, keeper, { legs: [{ side: 0, basis: 5n }] });
    assert.equal(analysePortfolios([userFlat], { lpPortfolio: lp, portfolioLen: 10603, keeperOwner: keeper }).flatAnchor, null);
    assert.equal(analysePortfolios([userFlat, keeperBusy], { lpPortfolio: lp, portfolioLen: 10603, keeperOwner: keeper }).flatAnchor, null, "a keeper portfolio WITH a position is not flat");
    assert.ok(analysePortfolios([userFlat, keeperFlat], { lpPortfolio: lp, portfolioLen: 10603, keeperOwner: keeper }).flatAnchor?.equals(keeperFlat.pubkey));
    assert.equal(analysePortfolios([userFlat, keeperFlat], { lpPortfolio: lp, portfolioLen: 10603 }).flatAnchor, null, "no keeper identity: no anchor");
  });
  it("with an anchor the accrue goes through the ANCHOR (counted anchorAccrues); without one it falls back to a counterparty and COUNTS it", async () => {
    const anchor = key(77);
    const a = fakeExecConn();
    await runSettleRound(deps(a.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), anchor, nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(pairingStats.anchorAccrues >= 1);
    assert.equal(pairingStats.counterpartyAccrues, 0);
    assert.ok(a.sims.some((s) => s.keys[0].includes(anchor.toBase58())));
    resetPairingStats();
    const b = fakeExecConn();
    await runSettleRound(deps(b.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(pairingStats.anchorAccrues, 0);
    assert.ok(pairingStats.counterpartyAccrues >= 1);
  });
});

describe("item 9: a parallel accrue that lands in the same slot (Custom 22) is 'already accrued', not a failed phase", () => {
  it("a LANDED tx that failed with 22 on its accrue is re-sent refresh-only; the round still pairs", async () => {
    const f = fakeExecConn({ confirmFail: (i) => (i === 0 ? 22 : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), anchor: key(77), nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(pairingStats.accrueAlreadyDone, 1);
    assert.equal(r.lpSettled, true);
    assert.equal(r.missing.filter((m) => m.why === "unlanded").length, 0);
    assert.ok(f.sent.length > r.plan.txs.length - 0, "the refused tx was re-sent");
  });
  it("NEGATIVE CONTROL: a landed failure with any other code is NOT retried and holds the LP", async () => {
    const f = fakeExecConn({ confirmFail: (i) => (i === 0 ? 7 : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30), anchor: key(77), nowSlot: 100 }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(pairingStats.accrueAlreadyDone, 0);
    assert.equal(r.lpSettled, false);
    assert.ok(r.missing.some((m) => m.why === "unlanded"));
  });
});

describe("item 11 (F-3): the observation crank carries the Hybrid leg feeds", () => {
  const feeds = [key(301), key(302)];
  it("Hybrid fixture: the market's leg feeds come from the profile and ride the observation crank (keys + hint count)", () => {
    const hybrid = v22Ctx({ oracleMode: 1, legs: 2, legFeeds: feeds });
    assert.deepEqual(crankOracleAccounts(hybrid).map((k) => k.toBase58()), feeds.map((k) => k.toBase58()));
    const base = ACCOUNTS_PERMISSIONLESS_CRANK_BASE.length;
    const withFeeds = buildObservationCrankIx(key(1), MARKET, LP, crankOracleAccounts(hybrid));
    const plain = buildObservationCrankIx(key(1), MARKET, LP);
    assert.equal(withFeeds.keys.length, base + 2);
    assert.ok(withFeeds.keys.slice(base).every((k) => !k.isWritable && !k.isSigner));
    assert.deepEqual(withFeeds.keys.slice(base).map((k) => k.pubkey.toBase58()), feeds.map((k) => k.toBase58()));
    assert.equal(plain.keys.length, base, "the legacy / AUTH_MARK form is unchanged");
    assert.notDeepEqual([...withFeeds.data], [...plain.data], "the hint count differs");
  });
  it("sweep txs and the 78 LP crank use them; AUTH_MARK (mode 3) gets none", () => {
    const hybrid = v22Ctx({ oracleMode: 1, legs: 2, legFeeds: feeds });
    const ixs = buildSweepTxIxs(key(1), MARKET, { accrue: "lp", accrueTarget: LP, refresh: [pf(1)], oracleAccounts: crankOracleAccounts(hybrid) });
    assert.equal(ixs[0].keys.length, ACCOUNTS_PERMISSIONLESS_CRANK_BASE.length + 2);
    assert.equal(ixs[1].keys.length, ACCOUNTS_PERMISSIONLESS_CRANK_BASE.length, "refreshes need no oracle accounts");
    const fee = planBondFee(hybrid, key(1), null, "off", 32);
    assert.equal(fee.ixs[0].keys.length, ACCOUNTS_PERMISSIONLESS_CRANK_BASE.length + 2);
    const auth = v22Ctx({ oracleMode: 3, legs: 0 });
    assert.deepEqual(crankOracleAccounts(auth), []);
  });
});

describe("item 13 (F-5): the sweep delegate only claims a market it actually ran", () => {
  const entry = { marketAddress: MARKET.toBase58(), label: "T/V22" };
  const loopFor = (o: Parameters<typeof fakeLoopConn>[0]) => {
    const f = fakeLoopConn(o);
    return { f, loop: new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: () => {} }) };
  };
  const args = (f: ReturnType<typeof loopFor>["f"]) => ({ conn: f.conn as never, keeper: Keypair.generate(), entry, marketData: v22MarketBytes(), slot: 5000, dryRun: false });
  it("handled (true) only on a normal run; false for no LP, non-Active, unreadable and error paths", async () => {
    const lp = key(901);
    const good = loopFor({ market: v22MarketBytes(), registry: registryBytes({ bound: true }), vaultLpState: vaultLpStateBytes(lp) });
    assert.equal(await good.loop.sweepDelegate(args(good.f)), true);
    assert.ok(good.f.sims.length > 0);
    const noLp = loopFor({ market: v22MarketBytes(), registry: registryBytes({ bound: false }) });
    assert.equal(await noLp.loop.sweepDelegate(args(noLp.f)), false, "no vault LP: the legacy accrual crank must still run");
    const resolved = loopFor({ market: v22MarketBytes({ lifecycle: 5 }), registry: registryBytes({ bound: true }), vaultLpState: vaultLpStateBytes(lp) });
    assert.equal(await resolved.loop.sweepDelegate(args(resolved.f)), false, "not Active / DrainOnly");
    const broken = loopFor({ market: v22MarketBytes(), throwOnRead: true });
    assert.equal(await broken.loop.sweepDelegate(args(broken.f)), false, "an unreadable market");
  });
});

describe("item 15 (F-7): Earn exit queue rotates and the scan is filtered by registry", () => {
  const reqBytes = (registry: PublicKey, n: number): Uint8Array => {
    const b = Buffer.alloc(128);
    b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
    b.writeUInt16LE(19, 8);
    b[10] = 6;
    Buffer.from(registry.toBytes()).copy(b, 16);
    Buffer.from(key(300 + n).toBytes()).copy(b, 48);
    b.writeBigUInt64LE(1000n, 80);
    b.writeBigUInt64LE(BigInt(n), 96);
    b[104] = 1;
    b.writeBigUInt64LE(5n, 112);
    b[120] = 1;
    return new Uint8Array(b);
  };
  it("two refused requests do not pin the head of the queue: the next tick tries the third; after the cool-down they return", async () => {
    const ctx = v22Ctx();
    const reg = deriveLpVaultRegistry(ctx.programId, ctx.market)[0];
    const reqs = [1, 2, 3].map((n) => ({ pubkey: key(n), data: reqBytes(reg, n) }));
    const st = freshEarnExitState();
    const f = fakeExecConn({ simErr: (d) => (hasKey(d, key(301)) || hasKey(d, key(302)) ? customAt(0, 117) : null) });
    const t1 = await executeKeeperExits(execCtx(f.conn), ctx, reqs, 2, st);
    assert.deepEqual(t1.outcomes.map((o) => o.redemption), [key(1).toBase58(), key(2).toBase58()]);
    const t2 = await executeKeeperExits(execCtx(f.conn), ctx, reqs, 2, st);
    assert.deepEqual(t2.outcomes.map((o) => o.redemption), [key(3).toBase58()], "rotated past the refused ones");
    const later = { ...ctx, readSlot: ctx.readSlot + Number(EARN_EXIT_COOLDOWN_SLOTS) + 1 };
    const t3 = await executeKeeperExits(execCtx(f.conn), later, reqs, 2, st);
    assert.ok(t3.outcomes.some((o) => o.redemption === key(1).toBase58()), "retried after the cool-down");
    // NEGATIVE CONTROL: with no memory the head is pinned forever
    const g = fakeExecConn({ simErr: (d) => (hasKey(d, key(301)) || hasKey(d, key(302)) ? customAt(0, 117) : null) });
    const a = await executeKeeperExits(execCtx(g.conn), ctx, reqs, 2, freshEarnExitState());
    const b = await executeKeeperExits(execCtx(g.conn), ctx, reqs, 2, freshEarnExitState());
    assert.deepEqual(a.outcomes.map((o) => o.redemption), b.outcomes.map((o) => o.redemption));
  });
  it("getProgramAccounts is filtered by THIS market's registry (memcmp at the first body field), dataSize and kind", async () => {
    const ctx = v22Ctx();
    const reg = deriveLpVaultRegistry(ctx.programId, ctx.market)[0];
    const calls: Array<{ filters: Array<Record<string, unknown>> }> = [];
    await fetchRedemptionRequests({ getProgramAccounts: async (_p: PublicKey, cfg: { filters: Array<Record<string, unknown>> }) => (calls.push(cfg), []) } as never, ctx);
    const reg16 = calls[0].filters.find((f) => (f.memcmp as { offset: number } | undefined)?.offset === 16) as { memcmp: { bytes: string } };
    assert.equal(reg16.memcmp.bytes, reg.toBase58());
    assert.ok(calls[0].filters.some((f) => f.dataSize === 128));
    assert.ok(calls[0].filters.some((f) => (f.memcmp as { offset: number } | undefined)?.offset === 10));
  });
  it("the stale comment is fixed: bound markets are not loss-gated by the program for unsigned exits", () => {
    const src = readFileSync(new URL("./earn-exit.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /The program ALWAYS loss-gates/);
    assert.match(src, /ONLY on Live NON-bound markets/);
  });
});

describe("item 17 (F-10): error text is redacted; no literal key in dry-run.ts", () => {
  it("api keys and URL queries never reach /health or the logs", async () => {
    const t = "fetch failed https://mainnet.helius-rpc.com/?api-key=2a089bfd-SECRET&x=1 (api-key=ABC123)";
    const r = redactErrorText(t);
    assert.doesNotMatch(r, /SECRET|ABC123|2a089bfd/);
    const f = fakeExecConn();
    (f.conn as unknown as { simulateTransaction: () => Promise<never> }).simulateTransaction = async () => {
      throw new Error(t);
    };
    const { simulateAndSend } = await import("./exec.ts");
    const out = await simulateAndSend(execCtx(f.conn), [buildObservationCrankIx(key(1), MARKET, LP)], { job: "redact", label: "T", units: 1 });
    assert.equal(out.kind, "failed");
    if (out.kind === "failed") assert.doesNotMatch(out.error, /SECRET|2a089bfd/);
    assert.doesNotMatch(allJobCounters().redact.lastError ?? "", /SECRET|2a089bfd/);
    // the loop's layout-problem text path goes through it too (negative control: a plain message survives)
    assert.equal(redactErrorText("layout unknown: length 123"), "layout unknown: length 123");
  });
  it("GH#225: a key in the URL PATH is redacted too, not just one in the query", () => {
    // The sibling test above uses Helius, which carries its key in the query -- the one form the
    // original implementation handled. Every other major provider puts it in the path.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["alchemy", "https://solana-mainnet.g.alchemy.com/v2/SECRETKEY123"],
      ["quicknode", "https://example-name.solana-mainnet.quiknode.pro/SECRETKEY123/"],
      ["ankr", "https://rpc.ankr.com/solana/SECRETKEY123"],
      ["triton", "https://example.rpcpool.com/SECRETKEY123"],
    ];
    for (const [name, url] of cases) {
      const r = redactErrorText(`fetch failed ${url} (503)`);
      assert.doesNotMatch(r, /SECRETKEY123/, `${name}: key survived redaction in ${r}`);
      assert.match(r, /\/\*\*\*/, `${name}: the path should be marked as elided, got ${r}`);
    }
    // the host still identifies the endpoint, which is what the log is for
    assert.match(redactErrorText("fetch failed https://rpc.ankr.com/solana/SECRETKEY123"), /rpc\.ankr\.com/);
    // a bare host keeps its empty path (no spurious /***), and the query form still works
    assert.equal(redactErrorText("down: https://api.devnet.solana.com"), "down: https://api.devnet.solana.com");
    assert.equal(redactErrorText("x https://h.io/?api-key=K"), "x https://h.io?***");
  });

  it("src/dry-run.ts carries no literal Helius key (same removal as #146 on relaunch-live)", () => {
    const src = readFileSync(new URL("../../dry-run.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /api-key=[0-9a-f]{8}-[0-9a-f]{4}-/i);
    assert.match(src, /HELIUS_MAINNET_RPC_URL/);
  });
});
