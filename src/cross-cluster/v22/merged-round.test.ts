/**
 * MERGED_ROUND: a multi-asset paired round goes out as ONE atomic tx when it fits
 * [obs crank (first counterparty, hints 0-4), refresh-only crank(s) of the other counterparties, refresh-only LP LAST].
 * Real 2xhs addresses (k6-multi-asset.test.ts fixtures); single-asset markets stay byte-identical.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/v22/merged-round.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodePermissionlessCrank } from "@percolatorct/sdk";
import type { MarketEntry } from "../registry.ts";
import { bindObservationRegistry, resetMultiAssetState } from "../multi-asset.ts";
import { DEFAULT_SWEEP_ROUND_CONFIG, MERGED_MAX_CU, resetMergedSkipLog, buildSweepTxIxs, pairingStats, resetPairingStats, runSettleRound } from "./sweep.ts";
import type { RoundInput } from "./sweep.ts";
import { resetJobCounters } from "./exec.ts";
import { customAt, execCtx, fakeExecConn, key } from "./test-helpers.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ADDITIONS = JSON.parse(readFileSync(join(here, "..", "..", "..", "registry-additions-v22-multiasset.json"), "utf8")) as { markets: MarketEntry[] };
const M2XHS = "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw";
const LP = new PublicKey("6w14eZR3S4e1AxkWEtruGZ6dRSj2mDaNsWtfcKZ3Dg4W");
const GV86 = new PublicKey("GV86syBheFoAZkCB9EXEHfphAoKJSgQ3dvfwCwiK7QJ4");
const OTHER = key(77);
const MARKET = new PublicKey(M2XHS);
const row2xhs = (): MarketEntry => structuredClone(ADDITIONS.markets.find((m) => m.marketAddress === M2XHS)!);
const SINGLE_ROW: MarketEntry = { ...row2xhs(), assets: undefined, assetIndex: 0 } as MarketEntry;

const ALL_HINTS = encodePermissionlessCrank({ nowSlot: 0n, observations: [0, 1, 2, 3, 4].map((assetIndex) => ({ assetIndex, oracleAccounts: 0 })) });
const HINT0 = encodePermissionlessCrank({ nowSlot: 0n, observations: [{ assetIndex: 0, oracleAccounts: 0 }] });
const NO_HINT = encodePermissionlessCrank({ nowSlot: 0n, observations: [] });

const cp = (pubkey: PublicKey, legs = 4): PositionedPortfolio => ({ pubkey, longLegs: legs, shortLegs: 0, isLp: false, lossWeight: pubkey.equals(GV86) ? 10n : 1n }); // GV86 orders first (heaviest weight, then loss weight)
// the LP holds 4 legs: solo weight, so the LP cannot share a phased tx and the plan is multi-tx
const input = (cps: PositionedPortfolio[]): RoundInput => ({ lp: LP, lpWeight: 1_000, counterparties: cps });
const deps = (conn: ReturnType<typeof fakeExecConn>["conn"], dry = false) => ({ exec: execCtx(conn, dry), getSlot: async () => 1010, hold: () => {}, release: () => {} });
const run = (f: ReturnType<typeof fakeExecConn>, cps: PositionedPortfolio[], dry = false) =>
  runSettleRound(deps(f.conn, dry), { market: MARKET, label: "2xhs" }, input(cps), DEFAULT_SWEEP_ROUND_CONFIG);
const at = (keys: string[], k: PublicKey) => keys[2] === k.toBase58();
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
  resetMergedSkipLog();
  bindObservationRegistry(() => [row2xhs()]);
});
afterEach(() => resetMultiAssetState());

describe("MERGED_ROUND (multi-asset)", () => {
  it("one atomic tx: [obs(GV86, hints 0-4), refresh-only(other cp), refresh-only(LP) LAST]", async () => {
    const f = fakeExecConn();
    const r = await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(f.sent.length, 1, "exactly one transaction");
    assert.deepEqual(f.sent[0].tags, [5, 5, 5]);
    assert.ok(at(f.sent[0].keys[0], GV86));
    assert.ok(at(f.sent[0].keys[1], OTHER));
    assert.ok(at(f.sent[0].keys[2], LP), "LP last");
    assert.ok(!at(f.sent[0].keys[0], LP));
    assert.ok(eq(f.sentData[0][0], ALL_HINTS), "first crank: hints 0,1,2,3,4 ascending");
    assert.equal(f.sentData[0][0].length, 25);
    assert.ok(eq(f.sentData[0][1], NO_HINT), "other counterparty: hint-less");
    assert.ok(eq(f.sentData[0][2], NO_HINT), "LP: hint-less");
    assert.equal(r.lpSettled, true);
    assert.deepEqual([...r.settled].sort(), [GV86.toBase58(), OTHER.toBase58(), LP.toBase58()].sort());
    assert.equal(pairingStats.mergedRounds, 1);
    assert.equal(pairingStats.mergedFallbacks, 0);
    assert.equal(pairingStats.pairedLpSettles, 1);
  });

  it("the sent tx is also simulated first (never an unsimulated send) and the CU gate is the F1 10% line", async () => {
    const f = fakeExecConn({ simUnitsConsumed: () => 936_149 });
    await run(f, [cp(GV86)]);
    assert.ok(f.sims.length >= 1);
    assert.equal(MERGED_MAX_CU, 1_260_000);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].tags, [5, 5]);
    assert.ok(at(f.sent[0].keys[1], LP));
  });

  it("exactly at the line is accepted; one CU over falls back to the phased plan unchanged", async () => {
    const ok = fakeExecConn({ simUnitsConsumed: () => 1_260_000 });
    await run(ok, [cp(GV86), cp(OTHER)]);
    assert.equal(ok.sent.length, 1);
    resetPairingStats();
    const f = fakeExecConn({ simUnitsConsumed: () => 1_260_001 });
    const r = await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(pairingStats.mergedRounds, 0);
    assert.equal(pairingStats.mergedFallbacks, 1);
    // phased (4-leg counterparties are solo): one tx per counterparty, then the LP observing tx, last
    assert.equal(f.sent.length, 3);
    assert.deepEqual(f.sent.map((s) => s.tags.length), [1, 1, 1]);
    assert.ok(at(f.sent[2].keys[0], LP));
    assert.ok(eq(f.sentData[2][0], ALL_HINTS), "phased LP crank still observes every asset");
    assert.equal(r.lpSettled, true);
  });

  it("a simulation error on the merged tx falls back to the phased plan, nothing merged is sent", async () => {
    const f = fakeExecConn({ simErr: (d) => (d.tags.length === 3 ? customAt(1, 999) : null) });
    const r = await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(pairingStats.mergedFallbacks, 1);
    assert.ok(f.sent.every((s) => s.tags.length !== 3));
    assert.equal(f.sent.length, 3);
    assert.equal(r.lpSettled, true);
  });

  it("a runtime error with no program code (compute exhaustion) falls back too", async () => {
    const f = fakeExecConn({ simErr: (d) => (d.tags.length === 3 ? { InstructionError: [4, "ComputationalBudgetExceeded"] } : null) });
    await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(pairingStats.mergedFallbacks, 1);
    assert.equal(f.sent.length, 3);
  });

  it("a crank refused Custom(22) (already current) is dropped and the tx re-simulated, then sent merged", async () => {
    const f = fakeExecConn({ simErr: (d) => (d.tags.length === 3 ? customAt(1, 22) : null) });
    const r = await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].tags, [5, 5], "OTHER dropped");
    assert.ok(at(f.sent[0].keys[0], GV86));
    assert.ok(at(f.sent[0].keys[1], LP));
    assert.ok(eq(f.sentData[0][0], ALL_HINTS));
    assert.equal(pairingStats.mergedDroppedCurrent, 1);
    assert.ok(r.settled.includes(OTHER.toBase58()), "current counts as settled");
    assert.equal(r.lpSettled, true);
  });

  it("the LP answering Custom(22) is dropped as current; the observing crank alone is sent", async () => {
    const f = fakeExecConn({ simErr: (d) => (d.tags.length === 3 ? customAt(2, 22) : null) });
    const r = await run(f, [cp(GV86), cp(OTHER)]);
    assert.deepEqual(f.sent[0].tags, [5, 5]);
    assert.ok(f.sent[0].keys.every((k) => k[2] !== LP.toBase58()));
    assert.equal(r.lpSettled, true);
  });

  it("22 on the OBSERVING crank (clock already current this slot) falls back; no hint-less crank goes out on its own", async () => {
    const f = fakeExecConn({ simErr: (d) => (d.tags.length === 3 ? customAt(0, 22) : null) });
    await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(pairingStats.mergedFallbacks, 1);
    for (let i = 0; i < f.sent.length; i++) {
      assert.ok(eq(f.sentData[i][0], ALL_HINTS), `tx ${i} begins with an all-asset observing crank`);
    }
  });

  it("no positioned counterparty: the LP observing crank alone (existing behaviour, hints on every asset)", async () => {
    const f = fakeExecConn();
    await run(f, []);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].tags, [5]);
    assert.ok(eq(f.sentData[0][0], ALL_HINTS));
    assert.equal(pairingStats.mergedRounds, 0);
  });

  it("dry-run: simulates, sends nothing, still reports the merged shape", async () => {
    const f = fakeExecConn();
    const r = await run(f, [cp(GV86), cp(OTHER)], true);
    assert.equal(f.sent.length, 0);
    assert.equal(pairingStats.mergedRounds, 1);
    assert.equal(r.lpSettled, true);
  });

  it("a merged tx that lands failed/unconfirmed is NOT followed by the phased plan", async () => {
    const f = fakeExecConn({ confirmFail: () => 7 });
    const r = await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(f.sent.length, 1);
    assert.equal(r.lpSettled, false);
    assert.match(r.abandoned ?? "", /merged round/);
  });

  it("too many counterparties for one packet fall back (no oversized tx is sent)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => cp(key(1000 + i), 1));
    const f = fakeExecConn();
    await run(f, many);
    assert.equal(pairingStats.mergedRounds, 0);
    assert.ok(f.sent.every((s) => s.tags.length < 30));
  });
});

describe("MERGED_ROUND: refresh-only never goes out hint-less on its own (multi-asset)", () => {
  const owner = Keypair.generate().publicKey;
  it("accrue 'none' on 2xhs: the first crank observes with all five hints, the rest are hint-less", () => {
    const ixs = buildSweepTxIxs(owner, MARKET, { accrue: "none", accrueTarget: null, refresh: [cp(GV86), cp(OTHER)] });
    assert.equal(ixs.length, 2);
    assert.ok(eq(ixs[0].data, ALL_HINTS));
    assert.ok(eq(ixs[1].data, NO_HINT));
  });

  it("the 'accrue answered 22 -> re-send refresh-only' path on 2xhs re-sends with an observing first crank", async () => {
    // the planned LP-only tx fails on chain with 22 on its accrue crank: the retry must still begin with an all-asset observation
    const f = fakeExecConn({ confirmFail: (i) => (i === 0 ? 22 : null) });
    await run(f, []);
    assert.equal(f.sent.length, 2);
    assert.ok(eq(f.sentData[0][0], ALL_HINTS));
    assert.ok(eq(f.sentData[1][0], ALL_HINTS), "retry carries hints for every listed asset");
  });
});

describe("MERGED_ROUND: single-asset markets are byte-identical", () => {
  const owner = Keypair.generate().publicKey;
  it("a single-asset row: the same round is phased exactly as before (obs hint {0}, no merge)", async () => {
    bindObservationRegistry(() => [SINGLE_ROW]);
    const f = fakeExecConn();
    await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(pairingStats.mergedRounds, 0);
    assert.equal(pairingStats.mergedFallbacks, 0);
    assert.equal(f.sent.length, 3);
    assert.deepEqual(f.sent.map((s) => s.tags), [[5], [5], [5]]);
    for (let i = 0; i < 3; i++) assert.ok(eq(f.sentData[i][0], HINT0), `tx ${i}: obs hint {0}`);
    assert.ok(at(f.sent[2].keys[0], LP));
  });

  it("unbound registry (every legacy test): same", async () => {
    bindObservationRegistry(null);
    const f = fakeExecConn();
    await run(f, [cp(GV86), cp(OTHER)]);
    assert.equal(f.sent.length, 3);
    assert.ok(eq(f.sentData[0][0], HINT0));
  });

  it("buildSweepTxIxs on a single-asset market: accrue none is all hint-less (unchanged)", () => {
    bindObservationRegistry(() => [SINGLE_ROW]);
    const ixs = buildSweepTxIxs(owner, MARKET, { accrue: "none", accrueTarget: null, refresh: [cp(GV86), cp(OTHER)] });
    assert.ok(ixs.every((i) => eq(i.data, NO_HINT)));
    const lp = buildSweepTxIxs(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: [cp(GV86)] });
    assert.ok(eq(lp[0].data, HINT0));
    assert.ok(eq(lp[1].data, NO_HINT));
  });
});

describe("MERGED_ROUND: a skip is never silent (rate-limited debug line with the reason)", () => {
  const lines = (f: ReturnType<typeof fakeExecConn>, extra: Partial<RoundInput> = {}) => {
    const out: string[] = [];
    const d = deps(f.conn);
    d.exec.log = (l) => out.push(l);
    return { out, go: () => runSettleRound(d, { market: MARKET, label: "2xhs" }, { ...input([cp(GV86)]), ...extra }, DEFAULT_SWEEP_ROUND_CONFIG) };
  };

  it("protective round: reason logged ONCE across repeated cycles, not once per cycle", async () => {
    const f = fakeExecConn();
    const { out, go } = lines(f, { protective: true });
    await go();
    await go();
    await go();
    const merged = out.filter((l) => l.includes("[v22][merged]"));
    assert.equal(merged.length, 1);
    assert.match(merged[0], /protective round/);
    assert.equal(pairingStats.mergedRounds, 0);
  });

  it("a CU fallback is logged with its reason", async () => {
    const f = fakeExecConn({ simUnitsConsumed: () => 1_300_000 });
    const { out, go } = lines(f);
    await go();
    assert.ok(out.some((l) => /\[v22\]\[merged\].*1300000 CU > 1260000/.test(l)), out.join("\n"));
  });

  it("a merged round logs nothing as skipped, and single-asset markets never log", async () => {
    const f = fakeExecConn();
    const a = lines(f);
    await a.go();
    assert.equal(a.out.filter((l) => l.includes("[v22][merged]")).length, 0);
    bindObservationRegistry(() => [SINGLE_ROW]);
    const b = lines(fakeExecConn());
    await b.go();
    assert.equal(b.out.filter((l) => l.includes("[v22][merged]")).length, 0);
  });
});
