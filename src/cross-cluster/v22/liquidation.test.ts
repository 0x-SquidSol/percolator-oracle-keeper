/**
 * F1 (liquidation crank in the same sweep tx as the refresh): the pure margin / budget arithmetic (liquidation.ts) and the
 * sweep behaviour (sweep.ts) against a recording fake connection. The account bytes are REAL v2.2 devnet accounts captured
 * read-only on 2026-10-14 (fixtures/f1-live-2026-10-14.json): the PENGU market, the PENGU account that was ALREADY below
 * maintenance on chain (335 bps of notional against a 600 bps requirement: the F1 victim), the PENGU vault LP, and a healthy
 * SOL account. Where a test needs a different state it patches ONE field of a real account and says so.
 *
 * Nothing here talks to a network. The fake connection cannot run the engine, so "the second crank liquidates" is asserted as
 * what the keeper SENDS (shape, order, bounds) and as what it does when the simulation says yes / 22 / another code; the
 * engine side of it is the program team's, and the sim harness reproduction is in the ledger section "Keeper half".
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { LIQUIDATE_CRANK_CU, V22_CU_PER_WEIGHT, riskSnapOf } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import { layoutById } from "../market-layout.ts";
import {
  DEFAULT_LIQ_MAX_PER_TX, MAX_TX_BYTES, atOrBelowMaintenance, estimateBaseCu, fitLiquidations, liqExtraWeight, marginOf, markLiquidationCandidates,
  readMarginParams, serializedTxSize, fitToPacket,
} from "./liquidation.ts";
import { DEFAULT_SWEEP_ROUND_CONFIG, buildSweepTxSlots, pairingStats, resetPairingStats, runSettleRound } from "./sweep.ts";
import { resetJobCounters } from "./exec.ts";
import { portfolioWeight, planSettleRound } from "./settle-pairing.ts";
import { customAt, computeAt, execCtx, fakeExecConn, key } from "./test-helpers.ts";
import type { SentTx } from "./test-helpers.ts";
import { v22FlagsFromEnv, describeV22Flags } from "./flags.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "f1-live-2026-10-14.json"), "utf8")) as { accounts: Record<string, { pubkey: string; data: string }> };
const bytes = (n: string): Uint8Array => new Uint8Array(Buffer.from(fx.accounts[n].data, "base64"));

const L = layoutById("v2.2-b");
const PENGU_MARKET = bytes("penguMarket");
const SOL_MARKET = bytes("solMarket");
const UNDER = bytes("penguUnderwater");
const SOL_HEALTHY = bytes("solHealthy");
const PARAMS = readMarginParams(PENGU_MARKET, L, 1)!;
const SOL_PARAMS = readMarginParams(SOL_MARKET, L, 1)!;

const CAPITAL_OFF = 148; // u128, test-helpers.portfolioBytes / the SDK parser (asserted below)
function withCapital(b: Uint8Array, capital: bigint): Uint8Array {
  const c = new Uint8Array(b);
  const v = new DataView(c.buffer);
  v.setBigUint64(CAPITAL_OFF, capital & 0xffff_ffff_ffff_ffffn, true);
  v.setBigUint64(CAPITAL_OFF + 8, capital >> 64n, true);
  return c;
}
const snapOf = (b: Uint8Array) => riskSnapOf(parsePortfolioV17(b));
/** A healthy twin of the underwater account: the SAME real legs, capital raised to $2,000 (atoms are e6). */
const HEALTHY = withCapital(UNDER, 2_000_000_000n);

const LP = key(500);
const MARKET = key(900);
const OBS_TAG = 5;

function entry(n: number, b: Uint8Array, o: { lp?: boolean; risk?: boolean } = {}): PositionedPortfolio {
  return { pubkey: key(n), longLegs: 1, shortLegs: 0, isLp: o.lp === true, activeLegs: 1, lossWeight: BigInt(n), ...(o.risk === false ? {} : { risk: snapOf(b) }) };
}

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
});

describe("F1 margin arithmetic on real accounts", () => {
  it("the SDK parser reads capital where the test patches it", () => {
    const p = parsePortfolioV17(withCapital(UNDER, 123_456_789n));
    assert.equal(p.capital, 123_456_789n);
  });

  it("reads maintenance margin, the floor, the mark and A from the real PENGU and SOL markets", () => {
    assert.equal(PARAMS.mmrBps, 600n);
    assert.equal(PARAMS.minNonzeroMmReq, 1_000_000n);
    assert.ok(PARAMS.assets.get(0)!.priceE6 > 0n);
    assert.equal(PARAMS.assets.get(0)!.aLong, 1_000_000_000_000_000n);
    assert.equal(SOL_PARAMS.mmrBps, 600n);
  });

  it("the live PENGU account is below maintenance: 335 bps of notional against a 600 bps requirement (the F1 victim)", () => {
    const m = marginOf(snapOf(UNDER), PARAMS);
    assert.equal(m.ratioBps, 335n);
    assert.ok(m.equity < m.requirement);
    assert.equal(atOrBelowMaintenance(m, 0), true);
  });

  it("NEGATIVE CONTROL: the real healthy SOL account is not at or below maintenance, with or without the pad", () => {
    const m = marginOf(snapOf(SOL_HEALTHY), SOL_PARAMS);
    assert.ok(m.ratioBps! > 5_000n);
    assert.equal(atOrBelowMaintenance(m, 0), false);
    assert.equal(atOrBelowMaintenance(m, 500), false);
  });

  it("NEGATIVE CONTROL: the same PENGU legs with capital raised (patched) are healthy", () => {
    const m = marginOf(snapOf(HEALTHY), PARAMS);
    assert.equal(atOrBelowMaintenance(m, 500), false);
  });

  it("the boundary: exactly at the requirement counts, one atom above does not (pad 0); the pad moves it", () => {
    const base = marginOf(snapOf(UNDER), PARAMS);
    const at = withCapital(UNDER, 0n);
    // capital such that equity == requirement
    const p = parsePortfolioV17(UNDER);
    const need = base.requirement - (p.pnl + p.feeCredits);
    assert.equal(atOrBelowMaintenance(marginOf(snapOf(withCapital(at, need)), PARAMS), 0), true);
    assert.equal(atOrBelowMaintenance(marginOf(snapOf(withCapital(at, need + 1n)), PARAMS), 0), false);
    assert.equal(atOrBelowMaintenance(marginOf(snapOf(withCapital(at, need + 1n)), PARAMS), 100), true);
  });

  it("a flat portfolio is never flagged; a market of another layout or a nonsense mmr reads as null (no guess)", () => {
    assert.equal(atOrBelowMaintenance(marginOf({ equity: -5n, legs: [] }, PARAMS), 500), false);
    assert.equal(readMarginParams(PENGU_MARKET, layoutById("v2.1-legacy"), 1), null);
    const bad = new Uint8Array(PENGU_MARKET);
    new DataView(bad.buffer).setBigUint64(L.groupOff + 86, 0n, true);
    assert.equal(readMarginParams(bad, L, 1), null);
    new DataView(bad.buffer).setBigUint64(L.groupOff + 86, 60_000n, true);
    assert.equal(readMarginParams(bad, L, 1), null);
    assert.equal(readMarginParams(PENGU_MARKET.subarray(0, 100), L, 1), null);
  });
});

describe("F1 stage A: candidates and plan weight", () => {
  it("marks the underwater counterparty, not the healthy one, not the LP, not an entry without a snapshot", () => {
    const cs = [entry(1, HEALTHY), entry(2, UNDER), entry(3, UNDER, { lp: true }), entry(4, UNDER, { risk: false })];
    const { marked, candidates } = markLiquidationCandidates(cs, { params: PARAMS, padBps: 500 });
    assert.deepEqual([...candidates.keys()], [key(2).toBase58()]);
    assert.equal(marked[1].liqWeight, liqExtraWeight(cs[1]));
    assert.equal(marked[0].liqWeight, undefined);
    assert.equal(marked[2].liqWeight, undefined);
    assert.equal(marked[3].liqWeight, undefined);
    assert.equal(cs[1].liqWeight, undefined, "the input is not mutated");
  });

  it("with no margin parameters nothing is a candidate (an unreadable market never gets a liquidation crank)", () => {
    const { candidates } = markLiquidationCandidates([entry(2, UNDER)], null);
    assert.equal(candidates.size, 0);
  });

  it("a candidate weighs its liquidation crank (250k CU = 8 units at 35k) on top of its refresh", () => {
    assert.equal(liqExtraWeight(entry(1, UNDER)), Math.ceil(LIQUIDATE_CRANK_CU / V22_CU_PER_WEIGHT));
    const plain = entry(1, UNDER);
    const cand = { ...plain, liqWeight: liqExtraWeight(plain) };
    assert.equal(portfolioWeight(cand), portfolioWeight(plain) + 8);
  });

  it("the planner SPLITS the round to make room: the same book needs one more tx when two members are candidates", () => {
    const book = (liq: boolean): PositionedPortfolio[] =>
      Array.from({ length: 6 }, (_, i) => ({ ...entry(i + 1, HEALTHY), ...(liq && i < 2 ? { liqWeight: 8 } : {}) }));
    const flat = planSettleRound({ mode: "prefer", lp: LP, lpWeight: 4, counterparties: book(false), weightBudget: 32 });
    const heavy = planSettleRound({ mode: "prefer", lp: LP, lpWeight: 4, counterparties: book(true), weightBudget: 32 });
    assert.equal(flat.txs.length, 1);
    assert.ok(heavy.txs.length > flat.txs.length, "candidates are packed with their liquidation weight");
  });
});

describe("F1 budget: bounds, CU and size", () => {
  const flaggedN = (n: number) => Array.from({ length: n }, (_, i) => ({ portfolio: entry(i + 1, UNDER), ratioBps: BigInt(500 - i) }));

  it("takes the worst margin first and stops at the per-tx cap, deferring the rest", () => {
    const f = fitLiquidations({ flagged: flaggedN(6), baseCu: 400_000, maxPerTx: 3 });
    assert.equal(f.chosen.length, 3);
    assert.deepEqual(f.chosen.map((c) => c.ratioBps), [495n, 496n, 497n].sort((a, b) => (a < b ? -1 : 1)));
    assert.ok(f.chosen[0].ratioBps <= f.chosen[1].ratioBps);
    assert.equal(f.deferred.length, 3);
    assert.ok(f.deferred.every((d) => d.why === "max-per-tx"));
  });

  it("stops at the compute budget: 1.4M minus 60k headroom minus the plain tx, 250k per single-leg liquidation", () => {
    const f = fitLiquidations({ flagged: flaggedN(8), baseCu: 700_000, maxPerTx: 99 });
    assert.equal(f.chosen.length, 2); // 700k + 2 x 250k = 1.2M; a third is 1.45M > 1.34M
    assert.ok(f.deferred.every((d) => d.why === "compute"));
    const none = fitLiquidations({ flagged: flaggedN(3), baseCu: 1_300_000, maxPerTx: 99 });
    assert.equal(none.chosen.length, 0);
  });

  it("a multi-leg account costs more to liquidate (linear to 728,649 at the 4-leg cap)", () => {
    const four: PositionedPortfolio = { ...entry(1, UNDER), activeLegs: 4, longLegs: 4 };
    const f = fitLiquidations({ flagged: [{ portfolio: four, ratioBps: 100n }], baseCu: 700_000, maxPerTx: 99 });
    assert.equal(f.chosen.length, 0, "700k + 728k does not fit");
    const one = fitLiquidations({ flagged: [{ portfolio: entry(1, UNDER), ratioBps: 100n }], baseCu: 700_000, maxPerTx: 99 });
    assert.equal(one.chosen.length, 1);
  });

  it("estimates the plain tx at the accrue crank plus 35k per weight unit of refresh", () => {
    assert.equal(estimateBaseCu(false, []), 0);
    assert.equal(estimateBaseCu(true, []), 200_000);
    assert.ok(estimateBaseCu(true, [entry(1, UNDER), entry(2, UNDER)]) >= 200_000 + 2 * 114_000);
  });

  it("the serialized size grows with each added crank and the 1,232-byte limit is detectable (never throws)", () => {
    const owner = Keypair.generate().publicKey;
    const mk = (n: number) => buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: Array.from({ length: n }, (_, i) => entry(i + 1, UNDER)) }).map((s) => s.ix);
    const s3 = serializedTxSize(owner, mk(3));
    const s4 = serializedTxSize(owner, mk(4));
    assert.ok(s4 > s3 && s3 < MAX_TX_BYTES);
    assert.ok(serializedTxSize(owner, mk(40)) > MAX_TX_BYTES || serializedTxSize(owner, mk(40)) === Number.POSITIVE_INFINITY);
  });

  it("fitToPacket drops the least urgent liquidations until the tx serializes under the limit (synthetic builder: compute binds first in practice)", () => {
    const owner = Keypair.generate().publicKey;
    const items = Array.from({ length: 6 }, (_, i) => entry(i + 1, UNDER));
    const build = (kept: ReadonlyArray<PositionedPortfolio>) =>
      buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: items, liquidate: new Set(kept.map((p) => p.pubkey.toBase58())) }).map((s) => s.ix);
    const one = serializedTxSize(owner, build(items.slice(0, 1)));
    const two = serializedTxSize(owner, build(items.slice(0, 2)));
    assert.ok(two > one);
    const r = fitToPacket(items, build, owner, two); // room for exactly two cranks
    assert.equal(r.kept.length, 2);
    assert.deepEqual(r.kept.map((p) => p.pubkey.toBase58()), items.slice(0, 2).map((p) => p.pubkey.toBase58()), "the worst-first head is kept, the tail dropped");
    assert.equal(r.dropped.length, 4);
    assert.ok(serializedTxSize(owner, r.ixs) <= two);
    assert.equal(fitToPacket(items, build, owner, 99_999).dropped.length, 0);
    assert.equal(fitToPacket(items, build, owner, 10).kept.length, 0, "nothing fits: no liquidation, the plain tx goes out");
  });

  it("a full tx at the CU cap fits the packet: accrue + 7 refreshes + the capped number of liquidation cranks <= 1,232 bytes", () => {
    const owner = Keypair.generate().publicKey;
    const refresh = Array.from({ length: 7 }, (_, i) => entry(i + 1, UNDER));
    const liquidate = new Set(refresh.slice(0, DEFAULT_LIQ_MAX_PER_TX).map((p) => p.pubkey.toBase58()));
    const ixs = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh, liquidate }).map((s) => s.ix);
    assert.equal(ixs.length, 1 + 7 + DEFAULT_LIQ_MAX_PER_TX);
    assert.ok(serializedTxSize(owner, ixs) <= MAX_TX_BYTES, `size ${serializedTxSize(owner, ixs)}`);
  });
});

describe("F1 tx builder: shape and ordering", () => {
  const owner = Keypair.generate().publicKey;
  const a = entry(1, HEALTHY);
  const t = entry(2, UNDER);
  const c = entry(3, HEALTHY);
  const keys = (s: ReturnType<typeof buildSweepTxSlots>) => s.map((x) => `${x.kind}:${x.key === null ? "-" : x.key}`);

  it("without a liquidation set the list is exactly today's [accrue, refresh x N] (byte-identical instructions)", () => {
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c] });
    assert.deepEqual(keys(s), [`accrue:${LP.toBase58()}`, `refresh:${a.pubkey.toBase58()}`, `refresh:${t.pubkey.toBase58()}`, `refresh:${c.pubkey.toBase58()}`]);
    const l = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c], liquidate: new Set() });
    assert.deepEqual(l.map((x) => x.ix.data.toString("hex")), s.map((x) => x.ix.data.toString("hex")));
  });

  it("the liquidation crank is the account's SECOND crank, immediately after its refresh, and is the plain no-observation crank", () => {
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [a, t, c], liquidate: new Set([t.pubkey.toBase58()]) });
    assert.deepEqual(keys(s), [`accrue:${LP.toBase58()}`, `refresh:${a.pubkey.toBase58()}`, `refresh:${t.pubkey.toBase58()}`, `liq:${t.pubkey.toBase58()}`, `refresh:${c.pubkey.toBase58()}`]);
    assert.deepEqual(s[2].ix.data, s[3].ix.data, "the same no-observation crank");
    assert.deepEqual(s[2].ix.keys.map((k) => k.pubkey.toBase58()), s[3].ix.keys.map((k) => k.pubkey.toBase58()));
  });

  it("when the account is the tx's accrue target (counterparty form) its second crank follows the observation crank", () => {
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "counterparty", accrueTarget: t.pubkey, refresh: [a, c], liquidate: new Set([t.pubkey.toBase58()]) });
    assert.deepEqual(keys(s).slice(0, 3), [`accrue:${t.pubkey.toBase58()}`, `liq:${t.pubkey.toBase58()}`, `refresh:${a.pubkey.toBase58()}`]);
  });

  it("a liquidation key that is not in the tx is ignored; an accrue on an anchor never doubles the anchor", () => {
    const s = buildSweepTxSlots(owner, MARKET, { accrue: "anchor", accrueTarget: key(77), refresh: [a], liquidate: new Set([key(77).toBase58(), key(99).toBase58()]) });
    assert.deepEqual(keys(s), [`accrue:${key(77).toBase58()}`, `refresh:${a.pubkey.toBase58()}`]);
  });
});

// ── the sweep, with a recording fake connection ────────────────────────────────────────────────────────────────────────
function deps(conn: ReturnType<typeof fakeExecConn>["conn"], lines: string[] = []) {
  const ex = execCtx(conn);
  ex.log = (l: string) => lines.push(l);
  return { exec: ex, getSlot: async () => 1010, hold: () => {}, release: () => {} };
}
const T = key(2).toBase58();
const countOf = (d: SentTx, k: string): number => d.keys.filter((ks) => ks.includes(k)).length;
/** Index of the SECOND instruction that touches `k` in a simulated tx, or -1. */
const secondCrankIndex = (d: SentTx, k: string): number => {
  let seen = 0;
  for (let i = 0; i < d.keys.length; i++) if (d.keys[i].includes(k) && ++seen === 2) return i;
  return -1;
};
const LIQ = { layout: L, slots: 1, params: PARAMS };

/** Post-simulation state: the market, and each requested portfolio as `state(addr)` (default: its pre-refresh bytes). */
const postState = (state: (addr: string) => Uint8Array) => (_d: SentTx, _i: number, addrs: string[]): Array<Uint8Array | null> =>
  addrs.map((a) => (a === MARKET.toBase58() ? PENGU_MARKET : state(a)));
const book = () => [entry(1, HEALTHY), entry(2, UNDER), entry(3, HEALTHY)];
const run = (f: ReturnType<typeof fakeExecConn>, input: Partial<Parameters<typeof runSettleRound>[2]> = {}, lines: string[] = []) =>
  runSettleRound(deps(f.conn, lines), { market: MARKET, label: "PENGU" }, { lp: LP, counterparties: book(), liq: LIQ, ...input }, DEFAULT_SWEEP_ROUND_CONFIG);

describe("F1 sweep: the liquidation crank rides in the same tx as the price-refresh", () => {
  it("below maintenance: one plain simulation, one extended simulation, ONE tx sent with T's second crank right after its refresh", async () => {
    const f = fakeExecConn({ simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)) });
    const lines: string[] = [];
    const r = await run(f, {}, lines);
    assert.equal(f.sims.length, 2, "plain sim (with accounts) then the extended sim");
    assert.equal(f.sims[0].tags.length, 4, "[LP accrue, 3 refreshes]");
    assert.equal(f.sims[1].tags.length, 5, "plus ONE liquidation crank");
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 5);
    assert.equal(countOf(f.sent[0], T), 2, "T is cranked twice, in the one tx");
    assert.equal(countOf(f.sent[0], key(1).toBase58()), 1, "a healthy account gets no second crank");
    assert.equal(countOf(f.sent[0], key(3).toBase58()), 1);
    const i = f.sent[0].keys.findIndex((ks) => ks.includes(T));
    assert.ok(f.sent[0].keys[i + 1].includes(T), "adjacent");
    assert.ok(f.sent[0].keys[0].includes(LP.toBase58()), "the LP accrue is still first");
    assert.equal(r.lpSettled, true);
    assert.equal(r.liq.length, 1);
    assert.equal(r.liq[0].result, "landed");
    assert.equal(pairingStats.liqLanded, 1);
    assert.ok(lines.some((l) => l.startsWith("[liq] PENGU ") && l.includes(T) && l.includes("landed")), lines.join("\n"));
  });

  it("NEGATIVE CONTROL (detection): every account healthy -> no extra crank, ONE simulation, the tx is today's tx", async () => {
    const f = fakeExecConn({ simAccounts: postState(() => HEALTHY) });
    const r = await run(f, { counterparties: [entry(1, HEALTHY), entry(2, HEALTHY), entry(3, HEALTHY)] });
    assert.equal(f.sims.length, 1, "no candidates -> no accounts requested, no extra simulation");
    assert.equal(f.sent[0].tags.length, 4);
    assert.equal(r.liq.length, 0);
    assert.equal(pairingStats.liqIncluded, 0);
  });

  it("NEGATIVE CONTROL (post-refresh measure): a candidate at plan time that is healthy after the simulated refresh gets NO crank", async () => {
    const f = fakeExecConn({ simAccounts: postState(() => HEALTHY) });
    const r = await run(f); // book() has T underwater at plan time (stale snapshot) but the post-refresh state says healthy
    assert.equal(f.sims.length, 1, "the plain sim asked for accounts, found nothing to add");
    assert.equal(f.sent[0].tags.length, 4);
    assert.equal(r.liq.length, 0);
  });

  it("NEGATIVE CONTROL (flag off): no liq input -> no accounts requested, tx identical to the base shape, stage A not applied", async () => {
    const f = fakeExecConn({ simAccounts: postState(() => UNDER) });
    const r = await run(f, { liq: undefined });
    assert.equal(f.sims.length, 1);
    assert.equal(f.sent[0].tags.length, 4);
    assert.equal(r.liq.length, 0);
    assert.equal(r.plan.txs[0].refresh.every((p) => p.liqWeight === undefined), true);
  });

  it("an unreadable market (no margin parameters) behaves as flag off", async () => {
    const f = fakeExecConn({ simAccounts: postState(() => UNDER) });
    await run(f, { liq: { ...LIQ, params: null } });
    assert.equal(f.sims.length, 1);
    assert.equal(f.sent[0].tags.length, 4);
  });

  it("FALLBACK on 22: the engine says nothing to liquidate -> the crank is dropped, the plain refresh is sent, the push/refresh is not blocked", async () => {
    const f = fakeExecConn({
      simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)),
      simErr: (d) => {
        const i = secondCrankIndex(d, T);
        return i >= 0 ? customAt(i, 22) : null;
      },
    });
    const lines: string[] = [];
    const r = await run(f, {}, lines);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 4, "the plain refresh went out");
    assert.equal(countOf(f.sent[0], T), 1);
    assert.equal(r.lpSettled, true);
    assert.equal(r.liq[0].result, "nothing-to-do");
    assert.equal(r.liq[0].code, 22);
    assert.equal(pairingStats.liqNothingToDo, 1);
    assert.equal(pairingStats.liqLanded, 0);
    assert.ok(lines.some((l) => l.startsWith("[liq] ") && l.includes("nothing-to-do") && l.includes("code=22")));
    // T's refresh itself was not pruned or marked missing
    assert.ok(r.settled.includes(T));
    assert.equal(r.missing.length, 0);
  });

  it("another program code on the liquidation crank is dropped the same way and named", async () => {
    const f = fakeExecConn({
      simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)),
      simErr: (d) => {
        const i = secondCrankIndex(d, T);
        return i >= 0 ? customAt(i, 71) : null;
      },
    });
    const r = await run(f);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 4);
    assert.equal(r.liq[0].result, "refused");
    assert.equal(r.liq[0].code, 71);
    assert.equal(pairingStats.liqRefused, 1);
    assert.equal(r.lpSettled, true);
    assert.equal(r.missing.length, 0, "a refused liquidation never quarantines the account's refresh");
  });

  it("compute exhaustion in the extended tx drops every liquidation crank and sends the plain tx", async () => {
    const f = fakeExecConn({
      simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)),
      simErr: (d) => (secondCrankIndex(d, T) >= 0 ? computeAt(secondCrankIndex(d, T)) : null),
    });
    const r = await run(f);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 4);
    assert.equal(r.liq[0].result, "skipped");
    assert.equal(pairingStats.liqSkipped, 1);
    assert.equal(r.lpSettled, true);
  });

  it("an unrelated refusal inside the extended tx drops the liquidation, not the refresh of the neighbour", async () => {
    const A = key(1).toBase58();
    const f = fakeExecConn({
      simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)),
      // only the extended tx refuses the NEIGHBOUR (a side effect of the liquidation): the plain tx is clean
      simErr: (d) => (secondCrankIndex(d, T) >= 0 ? customAt(d.keys.findIndex((ks) => ks.includes(A)), 104) : null),
    });
    const r = await run(f);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 4);
    assert.ok(r.settled.includes(A), "the neighbour was NOT pruned for a refusal the liquidation caused");
    assert.equal(r.liq[0].result, "skipped");
  });

  it("a tx with the liquidation crank that LANDS and FAILS is re-sent plain (the code cannot say which crank failed)", async () => {
    const f = fakeExecConn({
      simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)),
      confirmFail: (_i, tx) => (countOf(tx, T) >= 2 ? 22 : null),
    });
    const r = await run(f);
    assert.equal(f.sent.length, 2, "failed with the crank, then the plain refresh");
    assert.equal(f.sent[0].tags.length, 5);
    assert.equal(f.sent[1].tags.length, 4);
    assert.equal(r.lpSettled, true);
    assert.equal(r.liq.some((l) => l.result === "skipped"), true);
  });

  it("NEGATIVE CONTROL (the accrue-22 retry is untouched): a landed 22 with NO liquidation crank still re-sends refresh-only", async () => {
    const f = fakeExecConn({ confirmFail: (i) => (i === 0 ? 22 : null) });
    const r = await run(f, { liq: undefined });
    assert.equal(f.sent.length, 2);
    assert.equal(pairingStats.accrueAlreadyDone, 1);
    assert.equal(r.lpSettled, true);
  });

  it("WITH THE PROGRAM FIX (refresh continues into liquidation), case 1: the refreshed account is already liquidated in the simulated post-state -> no second crank at all", async () => {
    const f = fakeExecConn({ simAccounts: postState((a) => (a === T ? HEALTHY : HEALTHY)) });
    const r = await run(f);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 4);
    assert.equal(countOf(f.sent[0], T), 1);
    assert.equal(r.lpSettled, true);
    assert.equal(r.liq.length, 0);
  });

  it("WITH THE PROGRAM FIX, case 2: post-state still looks low, the second crank finds nothing to do (22) -> the tx still lands as the plain refresh", async () => {
    const f = fakeExecConn({
      simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)),
      simErr: (d) => (secondCrankIndex(d, T) >= 0 ? customAt(secondCrankIndex(d, T), 22) : null),
    });
    const r = await run(f);
    assert.equal(f.sent.length, 1);
    assert.equal(r.lpSettled, true);
    assert.equal(r.liq[0].result, "nothing-to-do");
    assert.equal(r.settled.includes(T), true);
  });

  it("WITH THE PROGRAM FIX, case 3: the second crank is an accepted no-op -> the tx lands WITH it", async () => {
    const f = fakeExecConn({ simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)) });
    const r = await run(f);
    assert.equal(f.sent[0].tags.length, 5);
    assert.equal(r.lpSettled, true);
    assert.equal(r.liq[0].result, "landed");
  });

  it("BEFORE the fix the extended tx is the one that goes out when the simulation accepts it (the second crank liquidates)", async () => {
    const f = fakeExecConn({ simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)) });
    await run(f);
    const last = f.sims[f.sims.length - 1];
    assert.deepEqual(last.keys, f.sent[0].keys, "what was simulated last is what was sent");
  });

  it("BOUND: six accounts below maintenance with a cap of 1 per tx -> at most one second crank in any tx, the rest deferred and logged", async () => {
    const six = Array.from({ length: 6 }, (_, i) => entry(i + 1, UNDER));
    const f = fakeExecConn({ landedSlot: () => 1005, simAccounts: postState(() => UNDER) });
    const lines: string[] = [];
    const r = await run(f, { counterparties: six, liq: { ...LIQ, maxPerTx: 1 } }, lines);
    for (const d of f.sent) {
      const doubled = six.filter((s) => countOf(d, s.pubkey.toBase58()) >= 2).length;
      assert.ok(doubled <= 1, `at most 1 liquidation crank per tx (got ${doubled})`);
    }
    assert.equal(r.lpSettled, true);
    assert.ok(r.liq.some((l) => l.result === "deferred"), "the accounts that did not fit are named, not silently dropped");
    assert.ok(lines.some((l) => l.startsWith("[liq] ") && l.includes("deferred") && l.includes("max-per-tx")), lines.join("\n"));
    assert.ok(pairingStats.liqDeferred >= 1);
  });

  it("SPLIT: the sent tx never exceeds 1,232 bytes or the CU cap with the maximum number of cranks", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => entry(i + 1, UNDER));
    const f = fakeExecConn({ simAccounts: postState(() => UNDER) });
    await run(f, { counterparties: eight, liq: { ...LIQ, maxPerTx: 99 } });
    assert.ok(f.rawSizes.length > 0);
    for (const n of f.rawSizes) assert.ok(n <= MAX_TX_BYTES, `sent ${n} bytes`);
    for (const u of f.simUnits) assert.ok(u <= 1_400_000);
    // the book was split across txs by stage A weight; each tx has its own accrue crank
    assert.ok(f.sent.length >= 2);
  });

  it("DRY-RUN simulates the extended tx and sends nothing", async () => {
    const f = fakeExecConn({ simAccounts: postState((a) => (a === T ? UNDER : HEALTHY)) });
    const lines: string[] = [];
    const ex = execCtx(f.conn, true);
    ex.log = (l: string) => lines.push(l);
    const r = await runSettleRound({ exec: ex, getSlot: async () => 1010, hold: () => {}, release: () => {} }, { market: MARKET, label: "PENGU" }, { lp: LP, counterparties: book(), liq: LIQ }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 0);
    assert.equal(r.liq[0].result, "simulated");
    assert.ok(lines.some((l) => l.includes("[DRY-RUN]") && l.includes("5 instruction(s)")));
    assert.ok(lines.some((l) => l.startsWith("[liq] ") && l.includes("simulated")));
  });

  it("the counterparty-accrue form (no flat anchor, split round): the accrue target itself gets its second crank right after the observation crank", async () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(i + 1, i === 0 ? UNDER : HEALTHY));
    const f = fakeExecConn({ landedSlot: () => 1005, simAccounts: postState((a) => (a === key(1).toBase58() ? UNDER : HEALTHY)) });
    const r = await run(f, { counterparties: many });
    const withT1 = f.sent.filter((d) => countOf(d, key(1).toBase58()) === 2);
    assert.equal(withT1.length, 1);
    const d = withT1[0];
    const first = d.keys.findIndex((ks) => ks.includes(key(1).toBase58()));
    assert.ok(d.keys[first + 1].includes(key(1).toBase58()));
    assert.equal(r.lpSettled, true);
  });
});

describe("F1 flags", () => {
  it("default off; on by KEEPER_V22_LIQUIDATE; pad and per-tx cap are parsed strictly", () => {
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on" }).liquidate, false);
    const f = v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIQUIDATE: "on", KEEPER_V22_LIQUIDATE_PAD_BPS: "300", KEEPER_V22_LIQUIDATE_MAX_PER_TX: "2" });
    assert.equal(f.liquidate, true);
    assert.equal(f.liquidatePadBps, 300);
    assert.equal(f.liquidateMaxPerTx, 2);
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIQUIDATE: "maybe" }));
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_LIQUIDATE_MAX_PER_TX: "0" }));
    assert.equal(describeV22Flags(f).liquidate, true);
    assert.equal(v22FlagsFromEnv({ KEEPER_V22_LIQUIDATE: "garbage" }).liquidate, false, "flags off: stray values are not read");
  });
});

void PublicKey;
