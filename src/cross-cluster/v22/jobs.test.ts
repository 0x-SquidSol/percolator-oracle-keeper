import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { PERCOLATOR_ERRORS, STAKE_ERRORS_V5, STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, deriveBondTrancheV22, deriveG9FeedAllowlistV22 } from "@percolatorct/sdk";
import { allJobCounters, resetJobCounters } from "./exec.ts";
import { BAND_EXPECTED_CODES, formatProgramError, isBandExpected, stakeErrorName, wrapperErrorName } from "./errors.ts";
import { bondFeeSkipReason, buildBondCrankFeesIx, crankBondFee, planBondFee } from "./fee-bond.ts";
import { freshRentState, planRentSettles, settleRentOnce } from "./rent.ts";
import { dustCandidates, freshDustState, sweepDustOnce } from "./dust.ts";
import { decideG9, freshG9State, g9ExtraTail, g9Once, oracleQualifies } from "./g9.ts";
import { freshStakeSyncState, stakeSyncOnce } from "./stake-sync.ts";
import { commitDueSlot, freshStakeCommitTargetState, stakeCommitTargetOnce } from "./stake-commit-target.ts";
import { bookIsLossCurrent, executeKeeperExits, selectKeeperRequests } from "./earn-exit.ts";
import { bandHealthFor, pinLevelOf } from "./band.ts";
import type { V22Positioned } from "./positioned.ts";
import { customAt, execCtx, fakeExecConn, key, pf, v22Ctx } from "./test-helpers.ts";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";

beforeEach(() => resetJobCounters());
const sd = (conn: Parameters<typeof execCtx>[0], dry = false) => ({ exec: execCtx(conn, dry), getSlot: async () => 1000 });

function positioned(cps: ReturnType<typeof pf>[], lp = pf(901, 2, { lp: true }), minAbs: Record<number, bigint> = {}): V22Positioned {
  return { all: [lp, ...cps], counterparties: cps, lp, minLegAbs: new Map(Object.entries(minAbs).map(([k, v]) => [key(Number(k)).toBase58(), v])), flatAnchor: null, lpData: null, anchorOverrideRejected: null, undecodable: 0 };
}

describe("error tables", () => {
  it("every wrapper error 104-124 and stake error 33-45 has a name; logs read Name(code)", () => {
    for (let c = 104; c <= 124; c++) assert.ok(PERCOLATOR_ERRORS[c], `wrapper ${c}`);
    for (let c = 33; c <= 45; c++) assert.ok(STAKE_ERRORS_V5[c], `stake ${c}`);
    assert.equal(wrapperErrorName(104), "PriceBandPinned");
    assert.equal(wrapperErrorName(111), "PriceBandPositionCap");
    assert.equal(wrapperErrorName(112), "PriceBandTooNarrow");
    assert.equal(wrapperErrorName(113), "PriceBandLegBelowMinNotional");
    assert.equal(stakeErrorName(44), "InsuranceReadingsDiverged");
    assert.equal(formatProgramError("wrapper", 104), "PriceBandPinned(104)");
    assert.equal(formatProgramError("stake", 44), "InsuranceReadingsDiverged(44)");
    assert.equal(formatProgramError("wrapper", 99999), "Custom(99999)");
    assert.equal(formatProgramError("wrapper", null), "unclassified");
  });
  it("band expected states are exactly 104, 111, 112, 113", () => {
    assert.deepEqual([...BAND_EXPECTED_CODES].sort((a, b) => a - b), [104, 111, 112, 113]);
    assert.equal(isBandExpected(105), false);
    assert.equal(isBandExpected(null), false);
  });
});

describe("tag 78 on bond markets", () => {
  it("account list: 6 base + state[6] + ext[7] + vault LP[8] WRITABLE + tranche[9] writable; tag 78", () => {
    const ctx = v22Ctx();
    const ix = buildBondCrankFeesIx(ctx, key(1));
    assert.equal(ix.data[0], 78);
    assert.equal(ix.keys.length, 10);
    assert.ok(ix.keys[8].pubkey.equals(ctx.lpPortfolio!));
    assert.equal(ix.keys[8].isWritable, true);
    assert.ok(ix.keys[9].pubkey.equals(deriveBondTrancheV22(ctx.programId, ctx.market)[0]));
    assert.equal(ix.keys[9].isWritable, true);
  });
  it("skips (never sends) unless bond + bound + ext + LP are all known; negative controls", () => {
    assert.equal(bondFeeSkipReason(v22Ctx()), null);
    assert.equal(bondFeeSkipReason(v22Ctx({ bond: false })), "not-bond");
    assert.equal(bondFeeSkipReason(v22Ctx({ bound: false })), "not-bound");
    assert.equal(bondFeeSkipReason(v22Ctx({ ext: false })), "no-ext");
    assert.equal(bondFeeSkipReason(v22Ctx({ lp: null })), "no-lp");
  });
  it("the LP is cranked (tag 5) FIRST; paired shape = [LP crank, refreshes..., 78] when everything fits", () => {
    const ctx = v22Ctx();
    const p = planBondFee(ctx, key(1), positioned([pf(1), pf(2)]), "prefer", 32);
    assert.equal(p.shape, "paired");
    assert.deepEqual(p.ixs.map((i) => i.data[0]), [5, 5, 5, 78]);
    assert.ok(p.ixs[0].keys.some((k) => k.pubkey.equals(ctx.lpPortfolio!)));
  });
  it("pairing off: [LP crank, 78] (legacy-style, unpaired); prefer + overflow: same, counted; strict + overflow: 78 alone", () => {
    const ctx = v22Ctx();
    const big = positioned(Array.from({ length: 12 }, (_, i) => pf(i + 1)));
    assert.deepEqual(planBondFee(ctx, key(1), big, "off", 32).ixs.map((i) => i.data[0]), [5, 78]);
    assert.equal(planBondFee(ctx, key(1), big, "prefer", 32).shape, "lp-only-unpaired");
    const s = planBondFee(ctx, key(1), big, "strict", 32);
    assert.equal(s.shape, "fee-only");
    assert.deepEqual(s.ixs.map((i) => i.data[0]), [78]);
  });
  it("strict + overflow + 78 refused alone: DEFERRED (nothing sent); 38 (no fees) is a healthy 'nothing'", async () => {
    const ctx = v22Ctx();
    const big = positioned(Array.from({ length: 12 }, (_, i) => pf(i + 1)));
    const f = fakeExecConn({ simErr: () => customAt(0, 999) });
    const r = await crankBondFee(sd(f.conn), ctx, big, { mode: "strict", weightBudget: 32 });
    assert.equal(r.kind, "deferred");
    assert.equal(f.sent.length, 0);
    const g = fakeExecConn({ simErr: () => customAt(1, 38) });
    assert.equal((await crankBondFee(sd(g.conn), ctx, positioned([pf(1)]), { mode: "prefer", weightBudget: 32 })).kind, "nothing");
    assert.equal(g.sent.length, 0);
  });
  it("sends after a clean simulation; dry-run sends nothing", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn();
    const r = await crankBondFee(sd(f.conn), ctx, positioned([pf(1)]), { mode: "prefer", weightBudget: 32 });
    assert.equal(r.kind, "sent");
    assert.equal(f.sims.length, 1);
    assert.equal(f.sent.length, 1);
    const d = fakeExecConn();
    assert.equal((await crankBondFee(sd(d.conn, true), ctx, positioned([pf(1)]), { mode: "prefer", weightBudget: 32 })).kind, "dry-run");
    assert.equal(d.sent.length, 0);
  });
});

describe("tag 106 holding rent", () => {
  it("only rent markets; cadence per portfolio; never-settled first; the LP is skipped under pairing (it would settle alone)", async () => {
    const ctx = v22Ctx({ rent: true });
    const p = positioned([pf(1), pf(2)]);
    const st = freshRentState();
    const plan = planRentSettles(ctx, p, st, 9000, true, 4);
    assert.equal(plan.due.length, 2);
    assert.equal(plan.skippedLp, true);
    assert.equal(planRentSettles(ctx, p, st, 9000, false, 4).due.length, 3, "pairing off: the LP is settled too");
    const f = fakeExecConn();
    const r = await settleRentOnce(execCtx(f.conn), ctx, p, st, { cadenceSlots: 9000, pairingActive: true });
    assert.equal(r.outcomes.length, 2);
    assert.ok(f.sent.every((s) => s.tags[0] === 106));
    const again = await settleRentOnce(execCtx(f.conn), ctx, p, st, { cadenceSlots: 9000, pairingActive: true });
    assert.equal(again.outcomes.length, 0, "inside the cadence: nothing");
    // negative control: not a rent market
    const none = await settleRentOnce(execCtx(f.conn), v22Ctx(), p, freshRentState(), { cadenceSlots: 9000, pairingActive: true });
    assert.equal(none.outcomes.length, 0);
  });
  it("a band expected state counts as visited (retry at the cadence) and as expected, not a failure", async () => {
    const ctx = v22Ctx({ rent: true });
    const p = positioned([pf(1)]);
    const st = freshRentState();
    const f = fakeExecConn({ simErr: () => customAt(0, 104) });
    await settleRentOnce(execCtx(f.conn), ctx, p, st, { cadenceSlots: 9000, pairingActive: true });
    assert.equal(allJobCounters()["rent-106"].expected, 1);
    assert.equal(allJobCounters()["rent-106"].failed, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(planRentSettles(ctx, p, st, 9000, true, 4).due.length, 0);
  });
});

describe("tag 118 dust sweep", () => {
  it("band markets only; smallest leg first; the LP is not a candidate", () => {
    const ctx = v22Ctx({ band: true });
    const p = positioned([pf(1), pf(2), pf(3)], pf(901, 2, { lp: true }), { 1: 500n, 2: 5n, 3: 50n });
    assert.deepEqual(dustCandidates(ctx, p, freshDustState(), 2), [key(2).toBase58(), key(3).toBase58()]);
    assert.deepEqual(dustCandidates(v22Ctx(), p, freshDustState(), 3), [], "not a band market");
  });
  it("the PROGRAM decides dust: a refused simulation sends nothing and puts the portfolio on cool-down", async () => {
    const ctx = v22Ctx({ band: true });
    const p = positioned([pf(1)], pf(901, 2, { lp: true }), { 1: 5n });
    const st = freshDustState();
    const f = fakeExecConn({ simErr: () => customAt(0, 113) });
    const r = await sweepDustOnce(execCtx(f.conn), ctx, p, st);
    assert.equal(r.length, 1);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(dustCandidates(ctx, p, st, 3), []);
    const ok = fakeExecConn();
    const r2 = await sweepDustOnce(execCtx(ok.conn), ctx, p, freshDustState());
    assert.equal(ok.sent.length, 1);
    assert.equal(ok.sent[0].tags[0], 118);
    assert.equal(r2[0].outcome.kind, "sent");
  });
});

describe("tag 111 G9", () => {
  const units = (pending: bigint, receivable = 0n) => ({ g9PendingSlot: pending, backstopReceivableAtoms: receivable });
  it("oracle gate: Hybrid with legs only; Manual / AuthMark refused; devnet override lifts it", () => {
    assert.equal(oracleQualifies({ oracleMode: 1, oracleLegCount: 1 }, false), true);
    for (const m of [0, 3, 2]) assert.equal(oracleQualifies({ oracleMode: m, oracleLegCount: 1 }, false), false, `mode ${m}`);
    assert.equal(oracleQualifies({ oracleMode: 1, oracleLegCount: 0 }, false), false);
    assert.equal(oracleQualifies({ oracleMode: 3, oracleLegCount: 0 }, true), true);
  });
  it("propose (2) -> wait 9,000 -> draw (0) in [p+9000, p+18000) -> lapsed re-proposes; restore (1) when receivable", () => {
    const ctx = v22Ctx();
    const st = freshG9State();
    assert.equal(decideG9(ctx, units(0n), 5000n, false, st).kind, "propose");
    const w = decideG9(ctx, units(4000n), 5000n, false, st);
    assert.equal(w.kind, "wait");
    if (w.kind === "wait") assert.equal(w.remainingSlots, 8000n);
    assert.equal(decideG9(ctx, units(4000n), 12999n, false, st).kind, "wait", "one slot before the window opens");
    assert.equal(decideG9(ctx, units(4000n), 13000n, false, st).kind, "draw");
    assert.equal(decideG9(ctx, units(4000n), 21999n, false, st).kind, "draw", "last slot of the window");
    assert.equal(decideG9(ctx, units(4000n), 22000n, false, st).kind, "propose", "lapsed: a fresh proposal");
    assert.equal(decideG9(ctx, units(0n, 10n), 5000n, false, st).kind, "restore");
    assert.equal(decideG9(ctx, null, 5000n, false, st).kind, "none");
  });
  it("negative controls: wrong oracle mode, unbound market, retry spacing", () => {
    const st = freshG9State();
    assert.equal(decideG9(v22Ctx({ oracleMode: 3 }), units(0n), 5000n, false, st).kind, "none");
    assert.equal(decideG9(v22Ctx({ bound: false }), units(0n), 5000n, false, st).kind, "none");
    st.lastAttempt.set(`${v22Ctx().marketAddress}|propose`, 4900n);
    assert.equal(decideG9(v22Ctx(), units(0n), 5000n, false, st).kind, "none");
  });
  it("mainnet builds pass the allowlist PDA + leg accounts for modes 0 and 2 only", () => {
    const ctx = v22Ctx();
    assert.deepEqual(g9ExtraTail(ctx, false, 2), []);
    assert.equal(g9ExtraTail(ctx, true, 1).length, 0);
    const t = g9ExtraTail(ctx, true, 0);
    assert.ok(t[0].equals(deriveG9FeedAllowlistV22(ctx.programId)[0]));
    assert.equal(t.length, 1 + ctx.oracleLegFeeds.length);
  });
  function unitsAccount(market: PublicKey, pending: bigint): Uint8Array {
    const b = Buffer.alloc(16 + 192);
    b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
    b.writeUInt16LE(19, 8);
    b[10] = 13;
    Buffer.from(market.toBytes()).copy(b, 16);
    b[16 + 136] = 1;
    b.writeBigUInt64LE(pending, 16 + 160);
    return new Uint8Array(b);
  }
  it("DRY-RUN (the default): the propose probe is simulated and logged, NOTHING is sent; armed it sends a clean simulation; 114-116 refusals are expected", async () => {
    const ctx = v22Ctx();
    const acct = unitsAccount(ctx.market, 0n);
    const args = { allowAnyOracleMode: false, mainnetBuild: false, drawCapAtoms: 1n };
    const dry = fakeExecConn();
    const lines: string[] = [];
    const dctx = execCtx(dry.conn);
    dctx.log = (l) => lines.push(l);
    const r = await g9Once(dctx, ctx, acct, freshG9State(), { ...args, dryRun: true });
    assert.equal(r.action.kind, "propose");
    assert.equal(r.outcome?.kind, "dry-run");
    assert.equal(dry.sent.length, 0);
    assert.ok(lines.some((l) => l.includes("[DRY-RUN]") && l.includes("tag 111")));
    const live = fakeExecConn();
    const r2 = await g9Once(execCtx(live.conn), ctx, acct, freshG9State(), { ...args, dryRun: false });
    assert.equal(r2.outcome?.kind, "sent");
    assert.equal(live.sent[0].tags[0], 111);
    const refused = fakeExecConn({ simErr: () => customAt(0, 116) });
    const r3 = await g9Once(execCtx(refused.conn), ctx, acct, freshG9State(), { ...args, dryRun: false });
    assert.equal(r3.outcome?.kind, "refused");
    assert.equal(refused.sent.length, 0);
    assert.equal(allJobCounters()["g9-propose"].expected, 1);
    // the wait is on-chain state: a proposal made 100 slots ago waits, and sends nothing
    const waiting = fakeExecConn();
    const r4 = await g9Once(execCtx(waiting.conn), ctx, unitsAccount(ctx.market, 4900n), freshG9State(), { ...args, dryRun: false });
    assert.equal(r4.action.kind, "wait");
    assert.equal(waiting.sims.length, 0);
  });
});

describe("stake v5 sync (tag 31)", () => {
  function poolBytes(lastSync: bigint, cooldown = 150n, o: { riskMode?: number; poolMode?: number } = {}): Uint8Array {
    const F = STAKE_POOL_FIELD_OFF_V5;
    const b = Buffer.alloc(STAKE_POOL_SIZE_V5);
    "SPOOL_V1".split("").forEach((c, i) => (b[F.reserved + i] = c.charCodeAt(0)));
    b[F.version] = 5;
    b[F.riskMode] = o.riskMode ?? 1;
    if (o.poolMode !== undefined) b[F.poolMode] = o.poolMode;
    b.writeBigUInt64LE(lastSync, F.lastSyncSlot);
    b.writeBigUInt64LE(cooldown, F.syncCooldownSlots);
    return new Uint8Array(b);
  }
  it("builds stake tag 31 on the stake program with the 11 accounts of the v5 spec", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn();
    const r = await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(0n), freshStakeSyncState(), { intervalMs: 0, nowMs: 1 });
    assert.equal(r.kind, "sent");
    assert.equal(f.sent[0].tags[0], 31);
    assert.equal(f.sent[0].keys[0].length, 11);
    assert.ok(STAKE_PROGRAM_ID instanceof PublicKey);
  });
  it("44 InsuranceReadingsDiverged: refused, counted, NOT retried until the backoff ends (no retry-spam)", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn({ simErr: () => customAt(0, 44) });
    const st = freshStakeSyncState();
    const r1 = await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(0n), st, { intervalMs: 0, nowMs: 1 });
    assert.equal(r1.kind, "diverged");
    assert.equal(f.sims.length, 1);
    for (let i = 0; i < 5; i++) {
      const r = await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(0n), st, { intervalMs: 0, nowMs: 10 + i });
      assert.equal(r.kind, "backoff");
    }
    assert.equal(f.sims.length, 1, "no further simulation, no send");
    assert.equal(f.sent.length, 0);
    assert.equal(st.diverged, 1);
    assert.equal(allJobCounters()["stake-sync"].byError["InsuranceReadingsDiverged(44)"], 1);
    assert.equal(allJobCounters()["stake-sync"].expected, 1);
  });
  it("21 EngineLockActive (wrapper tag 57 inside tag 31, h-lock latched): WAITING, expected not refused, backed off one cooldown, no retry-spam", async () => {
    const ctx = v22Ctx(); // read slot 5000
    const f = fakeExecConn({ simErr: () => customAt(0, 21) });
    const st = freshStakeSyncState();
    const r1 = await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(0n), st, { intervalMs: 0, nowMs: 1 });
    assert.equal(r1.kind, "waiting");
    assert.equal(f.sent.length, 0);
    for (let i = 0; i < 3; i++) assert.equal((await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(0n), st, { intervalMs: 0, nowMs: 10 + i })).kind, "backoff");
    assert.equal(f.sims.length, 1, "no further simulation while backed off");
    const c = allJobCounters()["stake-sync"];
    assert.equal(c.expected, 1);
    assert.equal(c.refused, 0, "not counted as a failure");
    assert.equal(st.diverged, 0);
    // a genuinely unexpected code is still a refusal
    const g = fakeExecConn({ simErr: () => customAt(0, 40) });
    assert.equal((await stakeSyncOnce(execCtx(g.conn), ctx, poolBytes(0n), freshStakeSyncState(), { intervalMs: 0, nowMs: 1 })).kind, "refused");
  });
  it("cooldown is pre-checked locally (quiet 37); 43 NothingToSync is quiet; a non-v5 pool is skipped", async () => {
    const ctx = v22Ctx(); // read slot 5000
    const f = fakeExecConn();
    assert.equal((await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(4900n), freshStakeSyncState(), { intervalMs: 0, nowMs: 1 })).kind, "quiet");
    assert.equal(f.sims.length, 0);
    const g = fakeExecConn({ simErr: () => customAt(0, 43) });
    assert.equal((await stakeSyncOnce(execCtx(g.conn), ctx, poolBytes(0n), freshStakeSyncState(), { intervalMs: 0, nowMs: 1 })).kind, "quiet");
    assert.equal((await stakeSyncOnce(execCtx(f.conn), ctx, new Uint8Array(100), freshStakeSyncState(), { intervalMs: 0 })).kind, "skipped");
    assert.equal((await stakeSyncOnce(execCtx(f.conn), ctx, null, freshStakeSyncState(), { intervalMs: 0 })).kind, "skipped");
  });
  it("tag 31 is FIRST_LOSS + insurance-mode only: FEE_ONLY / legacy / fee-mode pools are skipped, never simulated (no InvalidPoolMode(17))", async () => {
    const ctx = v22Ctx();
    const f = fakeExecConn({ simErr: () => customAt(0, 17) });
    for (const o of [{ riskMode: 2 }, { riskMode: 0 }, { riskMode: 1, poolMode: 1 }]) {
      const r = await stakeSyncOnce(execCtx(f.conn), ctx, poolBytes(0n, 150n, o), freshStakeSyncState(), { intervalMs: 0, nowMs: 1 });
      assert.equal(r.kind, "skipped", JSON.stringify(o));
    }
    assert.equal(f.sims.length, 0, "no simulation, no send");
    assert.equal(f.sent.length, 0);
  });
});

describe("stake v5 CommitDeployTarget (tag 33, KEEPER_V22_STAKE_COMMIT_TARGET)", () => {
  function pendingPool(pendingSlot: bigint, cooldown = 150n): Uint8Array {
    const F = STAKE_POOL_FIELD_OFF_V5;
    const b = Buffer.alloc(STAKE_POOL_SIZE_V5);
    "SPOOL_V1".split("").forEach((c, i) => (b[F.reserved + i] = c.charCodeAt(0)));
    b[F.version] = 5;
    b[F.riskMode] = 1;
    b.writeBigUInt64LE(cooldown, 184); // pool.cooldown_slots (withdrawal cooldown)
    b.writeBigUInt64LE(4000n, F.pendingTargetBps);
    b.writeBigUInt64LE(pendingSlot, F.pendingTargetSlot);
    return new Uint8Array(b);
  }
  it("due slot = pending slot + max(cooldown, 216,000)", () => {
    assert.equal(commitDueSlot({ pendingTargetSlot: 1000n, cooldownSlots: 150n }), 1000n + 216_000n);
    assert.equal(commitDueSlot({ pendingTargetSlot: 1000n, cooldownSlots: 300_000n }), 1000n + 300_000n);
  });
  it("nothing pending -> skipped, never simulated", async () => {
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), v22Ctx(), pendingPool(0n), freshStakeCommitTargetState());
    assert.equal(r.kind, "skipped");
    assert.equal(f.sims.length, 0);
    assert.equal(f.sent.length, 0);
  });
  it("timelock not elapsed -> waiting with the due slot, no simulation, no send (negative control)", async () => {
    const ctx = v22Ctx(); // read slot 5000
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn), ctx, pendingPool(4000n), freshStakeCommitTargetState());
    assert.equal(r.kind, "waiting");
    if (r.kind === "waiting") assert.equal(r.dueSlot, 4000n + 216_000n);
    assert.equal(f.sims.length, 0);
    assert.equal(f.sent.length, 0);
  });
  it("timelock elapsed -> sends stake tag 33 with [signer, pool writable, clock]; a second tick sees nothing pending", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const st = freshStakeCommitTargetState();
    const g = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(g.conn), late, pendingPool(100_000n), st);
    assert.equal(r.kind, "sent");
    assert.equal(g.sent[0].tags[0], 33);
    assert.equal(g.sent[0].keys[0].length, 3);
    assert.equal(st.committed, 1);
    // exactly at the due slot minus one: still waiting (boundary control)
    const edge = v22Ctx({ currentSlot: 100_000n + 216_000n - 1n });
    assert.equal((await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), edge, pendingPool(100_000n), freshStakeCommitTargetState())).kind, "waiting");
    const atDue = v22Ctx({ currentSlot: 100_000n + 216_000n });
    assert.equal((await stakeCommitTargetOnce(execCtx(fakeExecConn().conn), atDue, pendingPool(100_000n), freshStakeCommitTargetState())).kind, "sent");
  });
  it("40 NoPendingDeployTarget (a race) is quiet and backed off; another code is a refusal", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const f = fakeExecConn({ simErr: () => customAt(0, 40) });
    const st = freshStakeCommitTargetState();
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), late, pendingPool(100_000n), st)).kind, "quiet");
    assert.equal((await stakeCommitTargetOnce(execCtx(f.conn), late, pendingPool(100_000n), st)).kind, "backoff");
    assert.equal(f.sims.length, 1, "no retry-spam");
    const g = fakeExecConn({ simErr: () => customAt(0, 38) });
    assert.equal((await stakeCommitTargetOnce(execCtx(g.conn), late, pendingPool(100_000n), freshStakeCommitTargetState())).kind, "refused");
    assert.equal(g.sent.length, 0);
  });
  it("dry-run simulates and sends nothing", async () => {
    const late = v22Ctx({ currentSlot: 400_000n });
    const f = fakeExecConn();
    const r = await stakeCommitTargetOnce(execCtx(f.conn, true), late, pendingPool(100_000n), freshStakeCommitTargetState());
    assert.equal(r.kind, "dry-run");
    assert.equal(f.sent.length, 0);
  });
});

describe("keeper-executed Earn exits (tag 77, keeper_ok)", () => {
  function request(registry: PublicKey, o: { keeperOk: boolean; floor: bigint; extended?: boolean }): Uint8Array {
    const b = Buffer.alloc(o.extended === false ? 112 : 128);
    b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
    b.writeUInt16LE(19, 8);
    b[10] = 6;
    Buffer.from(registry.toBytes()).copy(b, 16);
    Buffer.from(key(321).toBytes()).copy(b, 48);
    b.writeBigUInt64LE(1000n, 80);
    b.writeBigUInt64LE(77n, 96);
    b[104] = 1;
    if (o.extended !== false) {
      b.writeBigUInt64LE(o.floor, 112);
      b[120] = o.keeperOk ? 1 : 0;
    }
    return new Uint8Array(b);
  }
  it("only keeper_ok requests with a floor > 0 of THIS registry are selected (A4)", async () => {
    const ctx = v22Ctx();
    const { deriveLpVaultRegistry } = await import("@percolatorct/sdk");
    const reg = deriveLpVaultRegistry(ctx.programId, ctx.market)[0];
    const sel = selectKeeperRequests(
      [
        { pubkey: key(1), data: request(reg, { keeperOk: true, floor: 5n }) },
        { pubkey: key(2), data: request(reg, { keeperOk: false, floor: 5n }) },
        { pubkey: key(3), data: request(reg, { keeperOk: true, floor: 0n }) },
        { pubkey: key(4), data: request(key(77), { keeperOk: true, floor: 5n }) },
        { pubkey: key(5), data: request(reg, { keeperOk: true, floor: 5n, extended: false }) },
      ],
      reg,
    );
    assert.deepEqual(sel.map((s) => s.pubkey.toBase58()), [key(1).toBase58()]);
  });
  it("gate: loss-current book only (stale cohort, unaccrued asset, multi-asset all refuse)", () => {
    assert.equal(bookIsLossCurrent(v22Ctx()).ok, true);
    assert.equal(bookIsLossCurrent(v22Ctx({ staleLong: 2n })).ok, false);
    assert.match(bookIsLossCurrent(v22Ctx({ staleLong: 2n })).reason ?? "", /stale cohort/);
    assert.equal(bookIsLossCurrent(v22Ctx({ slots: 2 })).ok, false);
  });
  it("NEVER sent without simulating: gated = zero RPC; loss-current = sim then send; 117/118 refusals are expected and not sent", async () => {
    const { deriveLpVaultRegistry } = await import("@percolatorct/sdk");
    const ctx = v22Ctx();
    const reg = deriveLpVaultRegistry(ctx.programId, ctx.market)[0];
    const reqs = [{ pubkey: key(1), data: request(reg, { keeperOk: true, floor: 5n }) }];
    const gated = fakeExecConn();
    const g = await executeKeeperExits(execCtx(gated.conn), v22Ctx({ staleLong: 1n }), reqs);
    assert.equal(g.gate.ok, false);
    assert.equal(gated.sims.length + gated.sent.length, 0);
    const ok = fakeExecConn();
    const r = await executeKeeperExits(execCtx(ok.conn), ctx, reqs);
    assert.equal(r.outcomes.length, 1);
    assert.equal(ok.sims.length, 1);
    assert.equal(ok.sent.length, 1);
    assert.equal(ok.sent[0].tags[0], 77);
    for (const code of [117, 118]) {
      resetJobCounters();
      const refused = fakeExecConn({ simErr: () => customAt(0, code) });
      await executeKeeperExits(execCtx(refused.conn), ctx, reqs);
      assert.equal(refused.sent.length, 0, `code ${code}`);
      assert.equal(allJobCounters()["earn-exit-77"].expected, 1);
    }
  });
});

describe("band markets", () => {
  it("pin duration is surfaced; levels none / pinned / half / critical against Pmax", () => {
    assert.equal(pinLevelOf(0n, 9000n), "none");
    assert.equal(pinLevelOf(100n, 9000n), "pinned");
    assert.equal(pinLevelOf(4500n, 9000n), "half");
    assert.equal(pinLevelOf(7200n, 9000n), "critical");
    const h = bandHealthFor(v22Ctx({ band: true, pinSince: 3500n, currentSlot: 5000n }));
    assert.equal(h.band, true);
    assert.equal(h.pinned, true);
    assert.equal(h.pinDurationSlots, "1500");
    assert.equal(h.pinDurationSecs, 600);
    assert.equal(h.maxPinSlots, "9000");
    assert.equal(h.pinLevel, "pinned");
    const off = bandHealthFor(v22Ctx());
    assert.equal(off.band, false);
    assert.equal(off.pinned, false);
  });
});
