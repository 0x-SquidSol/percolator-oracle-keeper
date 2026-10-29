import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SWEEP_ROUND_CONFIG, buildSweepTxIxs, pairingStats, resetPairingStats, runSettleRound } from "./sweep.ts";
import { resetJobCounters, allJobCounters } from "./exec.ts";
import { customAt, execCtx, fakeExecConn, key, pf } from "./test-helpers.ts";
import { Keypair } from "@solana/web3.js";

const LP = key(500);
const MARKET = key(900);
const cps = (n: number) => Array.from({ length: n }, (_, i) => pf(i + 1, 1));
const OBS = 5; // PermissionlessCrank tag

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
});

function deps(conn: ReturnType<typeof fakeExecConn>["conn"], extra: { dry?: boolean; holds?: string[]; releases?: string[]; slot?: () => number } = {}) {
  return {
    exec: execCtx(conn, extra.dry),
    getSlot: async () => (extra.slot ? extra.slot() : 1010),
    hold: (m: string) => extra.holds?.push(m),
    release: (m: string) => extra.releases?.push(m),
  };
}

describe("runSettleRound", () => {
  it("single-tx round: sends [LP crank, refresh x N] once, no push hold", async () => {
    const f = fakeExecConn();
    const holds: string[] = [];
    const r = await runSettleRound(deps(f.conn, { holds }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(5) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 6);
    assert.equal(r.lpSettled, true);
    assert.equal(r.plan.paired, true);
    assert.equal(holds.length, 0);
    assert.equal(pairingStats.singleTxRounds, 1);
    assert.equal(pairingStats.pairedLpSettles, 1);
    // the first instruction is the observation crank on the LP: its portfolio account is the LP
    assert.ok(f.sent[0].keys[0].includes(LP.toBase58()));
  });

  it("multi-tx round: the LP tx is sent LAST, after every counterparty tx landed; pushes held then released", async () => {
    const f = fakeExecConn();
    const holds: string[] = [];
    const releases: string[] = [];
    const r = await runSettleRound(deps(f.conn, { holds, releases }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.ok(f.sent.length > 1);
    const lpIdx = f.sent.findIndex((s) => s.keys[0].includes(LP.toBase58()));
    assert.equal(lpIdx, f.sent.length - 1, "the LP tx is the last send");
    f.sent.slice(0, -1).forEach((s) => assert.ok(!s.keys[0].includes(LP.toBase58()), "no earlier tx touches the LP"));
    assert.equal(r.lpSettled, true);
    assert.equal(holds.length, 1);
    assert.equal(releases.length, 1);
    assert.equal(pairingStats.multiTxRounds, 1);
    assert.equal(pairingStats.pairedLpSettles, 1);
    assert.equal(pairingStats.unpairedLpSettles, 0);
  });

  it("NEGATIVE CONTROL: pairing off sends the LP crank in EVERY tx (the exposure this policy removes)", async () => {
    const f = fakeExecConn();
    await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: "off" });
    assert.ok(f.sent.length > 1);
    assert.ok(f.sent.every((s) => s.keys[0].includes(LP.toBase58())));
  });

  it("residual window: the slot gap between phase 1 and the LP tx is measured; beyond maxGapSlots the LP tx is NOT sent", async () => {
    const f = fakeExecConn({ landedSlot: () => 1000 });
    const r = await runSettleRound(deps(f.conn, { slot: () => 1000 + 9 }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.lpSettled, false);
    assert.match(r.abandoned ?? "", /slot gap 9 > 8/);
    assert.equal(pairingStats.gapExceeded, 1);
    assert.ok(f.sent.every((s) => !s.keys[0].includes(LP.toBase58())));
    // within the window it is sent and the gap is recorded
    const g = fakeExecConn({ landedSlot: () => 1000 });
    const ok = await runSettleRound(deps(g.conn, { slot: () => 1000 + 3 }), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(ok.lpSettled, true);
    assert.equal(pairingStats.lastGapSlots !== null, true);
  });

  it("phase 1 that does not LAND: the LP is NOT settled alone (strict and prefer), and nothing forces it later", async () => {
    // every counterparty tx lands but FAILS on chain with an unrelated code: phase 1 did not settle anything
    for (const pairing of ["strict", "prefer"] as const) {
      resetPairingStats();
      const conn = fakeExecConn({ confirmFail: () => 7 });
      for (let i = 0; i < 4; i++) {
        const r = await runSettleRound(deps(conn.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(30) }, { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing });
        assert.equal(r.lpSettled, false, `${pairing} round ${i}`);
      }
      assert.equal(pairingStats.lpHeldPhase1Unlanded, 4, pairing);
      assert.ok(conn.sent.every((s) => !s.keys[0].includes(LP.toBase58())), pairing);
    }
  });

  it("a refresh the engine says is not stale (Custom(22)) is pruned and the tx re-simulated; the prune is counted", async () => {
    const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(3, 22) : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(5) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(r.pruned, 1);
    assert.equal(f.sent[0].tags.length, 5, "6 instructions minus the pruned refresh");
    assert.equal(pairingStats.prunedCurrent, 1);
  });

  it("an accrue crank that answers Custom(22) (an earlier tx accrued this slot) degrades to refresh-only; the LP still settles (as a refresh)", async () => {
    const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(0, 22) : null) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(2) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].tags.length, 3, "LP crank + 2 refreshes, no second accrue crank");
    assert.ok(f.sentData[0][0].length > f.sentData[0][1].length, "the first crank observes (A5-1: a hint-less first crank is ambiguous in a later slot)");
    assert.ok(f.sent[0].keys.some((k) => k.includes(LP.toBase58())));
    assert.equal(r.lpSettled, true);
  });

  it("band expected states (104/111/112/113) on a refresh drop that portfolio and are COUNTED as expected, not failures", async () => {
    for (const code of [104, 111, 112, 113]) {
      resetJobCounters();
      const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(2, code) : null) });
      await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(3) }, DEFAULT_SWEEP_ROUND_CONFIG);
      const c = allJobCounters().sweep;
      assert.equal(c.expected, 1, `code ${code}`);
      assert.equal(c.failed, 0);
      assert.equal(c.refused, 0);
      assert.ok(Object.keys(c.byError).some((k) => k.includes(`(${code})`)), "named in the counters");
    }
  });

  it("an UNEXPECTED refusal on the ACCRUE crank is a refusal and nothing is sent for that tx", async () => {
    const f = fakeExecConn({ simErr: () => customAt(0, 999) });
    const r = await runSettleRound(deps(f.conn), { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(3) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 0);
    assert.equal(r.lpSettled, false);
    assert.equal(allJobCounters().sweep.refused, 1);
  });

  it("dry-run: simulates, logs, sends NOTHING", async () => {
    const f = fakeExecConn();
    const lines: string[] = [];
    const d = deps(f.conn, { dry: true });
    d.exec.log = (l) => lines.push(l);
    await runSettleRound(d, { market: MARKET, label: "T" }, { lp: LP, counterparties: cps(5) }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 0);
    assert.ok(f.sims.length >= 1);
    assert.ok(lines.some((l) => l.includes("[DRY-RUN]") && l.includes("would send")));
    assert.equal(allJobCounters().sweep.dryRun >= 1, true);
  });

  it("buildSweepTxIxs: observation crank first, then refreshes; accrue none = refresh-only", () => {
    const owner = Keypair.generate().publicKey;
    const a = buildSweepTxIxs(owner, MARKET, { accrue: "lp", accrueTarget: LP, refresh: cps(2) });
    assert.equal(a.length, 3);
    assert.equal(a[0].data[0], OBS);
    const b = buildSweepTxIxs(owner, MARKET, { accrue: "none", accrueTarget: null, refresh: cps(2) });
    assert.equal(b.length, 2);
  });
});
