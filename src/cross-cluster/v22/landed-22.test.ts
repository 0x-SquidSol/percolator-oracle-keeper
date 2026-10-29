/**
 * A5-1: a Custom(22) must never make a round report a stale counterparty settled, or the LP settled / paired.
 *
 * Fake chain whose Custom(22) follows the wrapper (v16_program.rs at 21b8ccfd), one market clock (`obsSlot` = the slot the market
 * was last accrued in):
 *  - observing crank on P at slot S: accrues when obsSlot != S (`market_accrual_performed |= accrual.dt != 0`, :29465).
 *    P stale -> settled. P current -> ok only if it accrued, else 22 (NoAction && !market_accrual_performed, :29616-29621).
 *  - hint-less crank on P at slot S: P current -> 22 (NoAction; a hint-less crank never accrues). P stale -> ok only when the
 *    market was accrued in S (Hybrid `last_good_oracle_slot != now_slot` :14104-14108, price-managed pending move / funding
 *    :14146-14147), else 22. `hybrid: false` = stationary AUTH_MARK (nothing pending: a later slot is fine).
 *  - a tx is atomic; a landed failure commits nothing and reports InstructionError [ix, Custom 22].
 *  - txs sent before any confirm land together in the next slot ("same") or one slot apart ("staggered"); a confirm advances
 *    the tip past the landing slot. `external(slot, st)` = another party's tx that lands FIRST in the first landing slot (a trade,
 *    a crank), once.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { DEFAULT_SWEEP_ROUND_CONFIG, pairingStats, resetPairingStats, runSettleRound } from "./sweep.ts";
import { resetJobCounters } from "./exec.ts";
import { customAt, execCtx, fakeExecConn, fakeLoopConn, key, pf, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";
import { buildRefreshCrankIx } from "../positioned-refresh.ts";
import { nonComputeBudget, nonComputeBudgetCompiled } from "../test-ix.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { bindObservationRegistry, resetMultiAssetState } from "../multi-asset.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { setSweepDelegate, setLoneLpCrankSuppressor, setBondFeeDelegated, setProtectiveTrigger } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";

const REF = buildRefreshCrankIx(key(1), key(2), key(3)).data;
const MARKET = key(900);
const LP = key(500);
const ANCHOR = key(950);

interface St { slot: number; obsSlot: number; stale: Set<string> }
interface Ix { obs: boolean; key: string | null }
interface Sent { ixs: Ix[]; landSlot: number; err?: { idx: number; code: number } | null }

function makeChain(o: { known: Set<string>; stale: Iterable<string>; hybrid?: boolean; landing?: "same" | "staggered"; external?: (slot: number, st: St) => void; accruedNow?: boolean; hardAfterSend?: number; moving?: boolean }) {
  const hybrid = o.hybrid ?? true;
  // moving: the mark moves every slot, so an accrual in a new slot re-stales every positioned portfolio (the LP and the counterparties)
  const positioned = [...o.known].filter((k) => k !== ANCHOR.toBase58());
  const st: St = { slot: 5000, obsSlot: o.accruedNow ? 5000 : -1, stale: new Set(o.stale) };
  const sent: Sent[] = [];
  let extDone = false;
  let lastLand = -1;
  const toIx = (programId: PublicKey, data: Uint8Array, keys: string[]): Ix =>
    !programId.equals(WRAPPER_PROGRAM_ID) || data[0] !== REF[0] ? { obs: false, key: null } : { obs: data.length > REF.length, key: keys.find((k) => o.known.has(k)) ?? null };
  const run = (ixs: Ix[], slot: number): { idx: number; code: number } | null => {
    let obsSlot = st.obsSlot;
    const stale = new Set(st.stale);
    for (let i = 0; i < ixs.length; i++) {
      const { obs, key: k } = ixs[i];
      if (k === null) continue;
      if (obs) {
        const accrued = obsSlot !== slot;
        obsSlot = slot;
        if (accrued && o.moving) for (const p of positioned) stale.add(p);
        if (stale.has(k)) stale.delete(k);
        else if (!accrued) return { idx: i, code: 22 };
      } else if (stale.has(k) && (!hybrid || obsSlot === slot)) stale.delete(k);
      else return { idx: i, code: 22 };
    }
    return null;
  };
  const commit = (ixs: Ix[], slot: number) => {
    if (o.moving && ixs.some((x) => x.obs) && st.obsSlot !== slot) for (const p of positioned) st.stale.add(p);
    for (const { obs, key: k } of ixs) {
      if (obs) st.obsSlot = slot;
      if (k) st.stale.delete(k);
    }
  };
  const landPending = () => {
    for (const x of sent.filter((s) => s.err === undefined).sort((a, b) => a.landSlot - b.landSlot)) {
      if (o.external && !extDone) {
        extDone = true;
        o.external(x.landSlot, st);
      }
      x.err = run(x.ixs, x.landSlot);
      if (!x.err) commit(x.ixs, x.landSlot);
      st.slot = Math.max(st.slot, x.landSlot + 1);
    }
  };
  const errOf = (x: Sent) => (x.err ? { InstructionError: [x.err.idx + 2, { Custom: x.err.code }] } : null);
  const conn = {
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000_000 };
    },
    async simulateTransaction(tx: { message: { compiledInstructions: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>; staticAccountKeys: PublicKey[] } }) {
      const m = tx.message;
      const ixs = nonComputeBudgetCompiled(m.compiledInstructions, m.staticAccountKeys).map((c) => toIx(m.staticAccountKeys[c.programIdIndex], c.data, c.accountKeyIndexes.map((i) => m.staticAccountKeys[i].toBase58())));
      // hardAfterSend: once a send has landed, the program refuses every later simulation at its first crank with that code
      const first = ixs.findIndex((x) => x.key !== null);
      const e = o.hardAfterSend && first >= 0 && sent.some((x) => x.err !== undefined) ? { idx: first, code: o.hardAfterSend } : run(ixs, st.slot);
      return { context: { slot: st.slot }, value: { err: e ? { InstructionError: [e.idx + 2, { Custom: e.code }] } : null, logs: [], unitsConsumed: 100_000 } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      const t = Transaction.from(Buffer.from(raw));
      const ixs = nonComputeBudget(t.instructions).map((i) => toIx(i.programId, new Uint8Array(i.data), i.keys.map((k) => k.pubkey.toBase58())));
      const landSlot = o.landing === "staggered" ? Math.max(st.slot + 1, lastLand + 1) : st.slot + 1;
      lastLand = landSlot;
      sent.push({ ixs, landSlot });
      return `sig${sent.length}`;
    },
    async confirmTransaction(arg: { signature: string }) {
      landPending();
      return { context: { slot: st.slot }, value: { err: errOf(sent[Number(arg.signature.slice(3)) - 1]) } };
    },
    async getSignatureStatuses(sigs: string[]) {
      landPending();
      const x = sent[Number(sigs[0].slice(3)) - 1];
      return { context: { slot: st.slot }, value: [x ? { slot: x.landSlot, confirmations: 1, err: errOf(x), confirmationStatus: "confirmed" as const } : null] };
    },
    async getBlockHeight() {
      return 1;
    },
    async getSlot() {
      return st.slot;
    },
  };
  return { conn, st, sent };
}

const cpsOf = (n: number) => Array.from({ length: n }, (_, i) => pf(10 + i, 1));
/** An outside tx in the landing slot that accrues the market and settles `who` (a trade on the LP, a counterparty's own crank). */
const outside = (who: PublicKey) => (slot: number, st: St) => {
  st.obsSlot = slot;
  st.stale.delete(who.toBase58());
};

async function round(o: { n: number; anchor: boolean; landing?: "same" | "staggered"; hybrid?: boolean; external?: (slot: number, st: St) => void; current?: boolean; lpCurrent?: boolean; accruedNow?: boolean; hardAfterSend?: number; moving?: boolean }) {
  const cps = cpsOf(o.n);
  const known = new Set([LP, ANCHOR, ...cps.map((c) => c.pubkey)].map((k) => k.toBase58()));
  const ch = makeChain({ known, stale: o.current ? [] : [...(o.lpCurrent ? [] : [LP]), ...cps.map((c) => c.pubkey)].map((k) => k.toBase58()), hybrid: o.hybrid, landing: o.landing, external: o.external, accruedNow: o.accruedNow, hardAfterSend: o.hardAfterSend, moving: o.moving });
  const deps = { exec: { conn: ch.conn as never, keeper: Keypair.generate(), dryRun: false, log: () => {}, confirm: { statusRetries: 0, statusRetryDelayMs: 0 } }, getSlot: async () => ch.st.slot, hold: () => {}, release: () => {} };
  const res = await runSettleRound(deps, { market: MARKET, label: "T" }, { lp: LP, lpWeight: 4, counterparties: cps, anchor: o.anchor ? ANCHOR : null, nowSlot: 5000 }, DEFAULT_SWEEP_ROUND_CONFIG);
  const stale = (k: string) => ch.st.stale.has(k);
  return { res, ch, cps: cps.map((c) => c.pubkey.toBase58()), stale };
}

/** The invariant: nothing reported settled is stale on chain; an LP reported settled is settled and paired for real. */
function assertTruthful(r: Awaited<ReturnType<typeof round>>) {
  const falsely = r.res.settled.filter(r.stale);
  assert.deepEqual(falsely, [], "a portfolio reported settled is still stale on chain");
  if (r.res.lpSettled) {
    assert.equal(r.stale(LP.toBase58()), false, "lpSettled but the LP is stale on chain");
    assert.deepEqual(r.cps.filter(r.stale), [], "lpSettled with counterparties still stale on chain");
  }
  assert.ok(!r.res.outcomes.some((x) => x.kind === "dry-run"), "a live round never reports a dry-run outcome");
}
/** No send is hidden: a landed failure that was retried still counts. */
function assertEverySendCounted(r: Awaited<ReturnType<typeof round>>) {
  assert.equal(r.res.txsSent, r.ch.sent.length, "every send is in txsSent");
  assert.equal(r.res.outcomes.filter((x) => x.kind === "sent").length, r.ch.sent.length, "every send is in outcomes");
}

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
});
afterEach(() => {
  resetMultiAssetState();
  setSweepDelegate(null);
  setLoneLpCrankSuppressor(null);
  setBondFeeDelegated(false);
  setProtectiveTrigger(null);
  setV22HealthProvider(null);
});

describe("A5-1: a landed Custom(22) on a single-asset market", () => {
  it("single-tx round, an outside trade on the LP lands first in the same slot: the retry settles every counterparty for real", async () => {
    const r = await round({ n: 3, anchor: true, external: outside(LP) });
    assert.equal(r.res.plan.txs.length, 1);
    assert.equal(r.ch.sent[0].err?.code, 22, "the first send lands failed (the scenario happened)");
    assertTruthful(r);
    assert.deepEqual(r.cps.filter(r.stale), []);
    // The LP is current, but the outside tx settled it, not our crank (pruned "current"): not reported as our LP settle.
    assert.equal(r.stale(LP.toBase58()), false);
    assert.equal(r.res.lpSettled, false);
  });

  it("single-tx round, a counterparty's own tx lands first: 22 at a REFRESH index is retried, not read as 'current'", async () => {
    const r = await round({ n: 3, anchor: true, external: outside(cpsOf(3)[1].pubkey) });
    assert.equal(r.ch.sent[0].err?.idx, 2, "the refresh of cp #2 failed, not the accrue");
    assertTruthful(r);
    assert.equal(r.res.lpSettled, true);
  });

  it("multi-tx flat-anchor round, the two phase-1 txs land in the SAME slot: the LP tx never follows a failed counterparty tx unrepaired", async () => {
    const r = await round({ n: 20, anchor: true });
    assert.equal(r.res.plan.txs.length, 3);
    assert.ok(r.ch.sent.some((s) => s.err?.code === 22), "the anchor collision happened");
    assertTruthful(r);
  });

  it("everything current, the market already accrued in the simulation slot: the observing first crank answers 22, nothing sent, no LP settle reported", async () => {
    const r = await round({ n: 3, anchor: false, current: true, accruedNow: true });
    assert.equal(r.ch.sent.length, 0);
    assertTruthful(r);
    assert.equal(r.res.lpSettled, false, "an LP tx that sent nothing is not an LP settle");
    assert.equal(pairingStats.pairedLpSettles + pairingStats.unpairedLpSettles, 0);
  });

  it("all-pruned refresh-only tx (every retry refused by the program at its first crank): not an LP settle, not a dry-run", async () => {
    const r = await round({ n: 3, anchor: true, external: outside(LP), hardAfterSend: 999 });
    assert.equal(r.ch.sent.length, 1, "only the landed-failed send");
    assertTruthful(r);
    assert.equal(r.res.lpSettled, false);
    assert.equal(pairingStats.pairedLpSettles + pairingStats.unpairedLpSettles, 0);
    assertEverySendCounted(r);
  });

  it("a landed failure that is retried stays visible in outcomes / txsSent (stationary AUTH_MARK: the retry lands)", async () => {
    const r = await round({ n: 3, anchor: true, hybrid: false, external: outside(LP) });
    assert.equal(r.ch.sent.length, 2);
    assertEverySendCounted(r);
  });

  it("simulated 22 at the LP accrue (the market already accrued in the simulation slot, the LP current), stationary AUTH_MARK: the refresh-only tx settles every counterparty", async () => {
    // target-FIRST would lead the refresh-only tx with the LP, answer 22 again at the observing crank and send nothing
    const r = await round({ n: 3, anchor: true, hybrid: false, accruedNow: true, lpCurrent: true });
    assert.equal(r.ch.sent.length, 1);
    assert.equal(r.ch.sent[0].err, null);
    assertTruthful(r);
    assert.deepEqual(r.cps.filter(r.stale), []);
  });

  it("moving mark, simulated 22 at the LP accrue (slot already accrued, LP current): the LP pruned in the simulation slot is NOT an LP settle", async () => {
    // the tx lands in a later slot, accrues through its first counterparty and the moved mark re-stales the LP it no longer cranks
    const r = await round({ n: 3, anchor: true, moving: true, accruedNow: true, lpCurrent: true });
    assert.equal(r.ch.sent.length, 1);
    assert.equal(r.ch.sent[0].err, null);
    assert.equal(r.stale(LP.toBase58()), true, "the LP is stale on chain after the tx (the scenario happened)");
    assert.equal(r.res.lpSettled, false);
    assert.ok(!r.res.settled.includes(LP.toBase58()));
    assertTruthful(r);
  });

  it("CONTROL: no outside tx, single-tx round", async () => {
    const r = await round({ n: 3, anchor: true });
    assert.equal(r.ch.sent.length, 1);
    assert.equal(r.ch.sent[0].err, null);
    assertTruthful(r);
    assert.equal(pairingStats.pairedLpSettles, 1);
  });

  it("stationary AUTH_MARK, outside LP trade: still retried, every counterparty settled", async () => {
    const r = await round({ n: 3, anchor: true, hybrid: false, external: outside(LP) });
    assertTruthful(r);
    assert.deepEqual(r.cps.filter(r.stale), []);
    assert.equal(r.stale(LP.toBase58()), false, "the outside tx made the LP current");
    assert.equal(r.res.lpSettled, false, "not by our crank");
  });

  it("CONTROL: multi-tx counterparty-accrue round, same slot (no collision)", async () => {
    const r = await round({ n: 20, anchor: false });
    assert.ok(r.ch.sent.every((s) => s.err === null));
    assertTruthful(r);
    assert.equal(r.res.lpSettled, true);
  });

  it("CONTROL: multi-tx anchor round, staggered landing (no failure)", async () => {
    const r = await round({ n: 20, anchor: true, landing: "staggered" });
    assert.ok(r.ch.sent.every((s) => s.err === null));
    assertTruthful(r);
    assert.equal(r.res.lpSettled, true);
  });

  it("CONTROL: multi-asset market (observing refresh-only), anchor, same slot", async () => {
    bindObservationRegistry(() => [{ marketAddress: MARKET.toBase58(), label: "MA", lpPortfolio: LP.toBase58(), assetIndex: 0, assets: [{ assetIndex: 0, source: "fixed", fixedPriceE6: "1000000", symbol: "A" }, { assetIndex: 1, source: "fixed", fixedPriceE6: "2000000", symbol: "B" }] } as never]);
    const r = await round({ n: 20, anchor: true });
    assertTruthful(r);
    assert.equal(r.res.lpSettled, true);
  });

  it("the LP guard keeps a REAL LP settle: a counterparty pruned 'current', the LP cranked in the landed tx", async () => {
    const f = fakeExecConn({ simErr: (_d, n) => (n === 0 ? customAt(2, 22) : null) });
    const r = await runSettleRound({ exec: execCtx(f.conn), getSlot: async () => 1010, hold: () => {}, release: () => {} }, { market: MARKET, label: "T" }, { lp: LP, counterparties: [pf(1, 1), pf(2, 1)] }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 1);
    assert.equal(r.lpSettled, true);
    assert.equal(pairingStats.pairedLpSettles, 1);
  });

  it("a second landed 22 is a plain failure: both sends counted, nothing settled, the LP held", async () => {
    const f = fakeExecConn({ confirmFail: () => 22 });
    const r = await runSettleRound({ exec: execCtx(f.conn), getSlot: async () => 1010, hold: () => {}, release: () => {} }, { market: MARKET, label: "T" }, { lp: LP, counterparties: [pf(1, 1), pf(2, 1)] }, DEFAULT_SWEEP_ROUND_CONFIG);
    assert.equal(f.sent.length, 2);
    assert.equal(r.txsSent, 2);
    assert.deepEqual(r.settled, []);
    assert.equal(r.lpSettled, false);
    assert.ok(r.missing.length > 0 && r.missing.every((m) => m.why === "unlanded"));
  });
});

describe("A5-1 through the REAL V22Loop.sweepDelegate", () => {
  it("LP unsettled 400 s, a counterparty's own tx lands first: lastLpSettledAtMs moves only with every counterparty settled on chain", async () => {
    const keeper = Keypair.generate();
    const lp = key(901);
    const cps = Array.from({ length: 5 }, (_, i) => ({ pubkey: key(100 + i), data: portfolioBytes({ owner: key(8), capital: 5n, legs: [{ side: 0, basis: 5n }] }) }));
    const portfolios = [...cps, { pubkey: lp, data: portfolioBytes({ owner: key(9), capital: 1000n, legs: [{ side: 1, basis: 25n }] }) }, { pubkey: ANCHOR, data: portfolioBytes({ owner: keeper.publicKey, capital: 1n, legs: [] }) }];
    const f = fakeLoopConn({ market: v22MarketBytes(), registry: registryBytes({ bound: true }), vaultLpState: vaultLpStateBytes(lp), portfolios });
    const all = [lp, ANCHOR, ...cps.map((c) => c.pubkey)].map((k) => k.toBase58());
    const ch = makeChain({ known: new Set(all), stale: [lp, ...cps.map((c) => c.pubkey)].map((k) => k.toBase58()), external: outside(key(101)) });
    Object.assign(f.conn, ch.conn);
    const now = 1_000_000;
    const entry = { marketAddress: MARKET.toBase58(), label: "T/V22" };
    const loop = new V22Loop({ conn: f.conn as never, keeper, programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on", KEEPER_V22_SETTLE_PAIRING: "prefer" }), dryRun: false, log: () => {}, now: () => now });
    const rt = (loop as unknown as { rtFor(a: string): { lastLpSettledAtMs: number } }).rtFor(MARKET.toBase58());
    rt.lastLpSettledAtMs = now - 400_000;
    await loop.sweepDelegate({ conn: f.conn as never, keeper, entry, marketData: v22MarketBytes(), slot: 5000, dryRun: false } as never);
    assert.equal(ch.sent[0].err?.code, 22, "the scenario happened");
    assert.equal(rt.lastLpSettledAtMs, now, "the retry settled the LP: the time bound is reset");
    assert.deepEqual(cps.map((c) => c.pubkey.toBase58()).filter((k) => ch.st.stale.has(k)), [], "the time bound was reset with counterparties stale on chain");
    assert.equal(ch.st.stale.has(lp.toBase58()), false);
  });
});
