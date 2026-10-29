/**
 * Stake F-9 wind-down (stake tag 29 RecoverTerminalInsurance), ledger
 * stake-f9-fix-2026-09-30.md / draft percolator-stake#301 @ f9b9190.
 *
 * Real bytes: TEXTIT market + stake pool captured 2026-09-29 (stake-BOUND: its
 * asset-0 insurance authority is the pool's vault_auth). Resolved / tombstone
 * states are that account with the engine mode byte (abs 1218) or the header
 * kind patched — offsets computed from engine 35ddd692 source and the same
 * ones the stake program gates on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveStakePool, deriveStakeVaultAuth } from "@percolatorct/sdk";
import {
  asset0InsuranceAuthority,
  buildRecoverTerminalInsuranceIx,
  classifyTag29Probe,
  decodeTerminalState,
  encodeRecoverTerminalInsurance,
  TerminalInsuranceState,
  windDownOnce,
} from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";
import { FeeJobFailureTracker, runFeeJobSweep } from "./fee-jobs.ts";
import { drainFeeLegsBeforeResolve, windDownAfterResolve } from "./pre-resolve.ts";
import type { PreResolveConnection, PreResolveDeps } from "./pre-resolve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");

const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const TEXTIT = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
const SOL = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const MODE_ABS = 592 + 626; // 1218
const BUDGET_ABS = 592 + 461;
const KEEPER = Keypair.generate();
const DEPLOYED_PRE_F9_ERR = { InstructionError: [1, "InvalidInstructionData"] }; // exactly what live devnet returned 2026-09-30

const PORTFOLIOS_ABS = 592 + 517;
/** Resolved copy of a real market; `portfolios` overrides materialized_portfolio_count (u64 @ group+517). */
function resolved(name = "textit", budget?: bigint, portfolios?: bigint): Buffer {
  const b = Buffer.from(fx(`${name}-market-v18-fees`));
  b[MODE_ABS] = 1;
  if (portfolios !== undefined) b.writeBigUInt64LE(portfolios, PORTFOLIOS_ABS);
  if (budget !== undefined) {
    b.writeBigUInt64LE(budget & 0xffff_ffff_ffff_ffffn, BUDGET_ABS);
    b.writeBigUInt64LE(budget >> 64n, BUDGET_ABS + 8);
  }
  return b;
}
function tombstone(): Buffer {
  const b = Buffer.from(fx("textit-market-v18-fees"));
  b[10] = 8;
  return b;
}

const CFG: TerminalInsuranceConfig = {
  wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0,
};

type SimReply = { err: unknown; logs?: string[] };
/** Stub: `reply(amount, hasStray)` decides each simulation's answer. */
function stub(market: Buffer, marketKey: PublicKey, poolName: string | null, reply: (amount: bigint, hasStray: boolean) => SimReply, opts: { stray?: PublicKey } = {}) {
  const calls = { sims: [] as Array<{ amount: bigint; stray: boolean; keys: string[] }>, sends: 0, reads: 0 };
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.reads++;
      assert.equal(keys[0].toBase58(), marketKey.toBase58());
      assert.equal(keys[1].toBase58(), deriveStakePool(marketKey, STAKE)[0].toBase58());
      return [
        { data: market, owner: WRAPPER, lamports: 1, executable: false },
        poolName ? { data: fx(`${poolName}-stake-pool-v18`), owner: STAKE, lamports: 1, executable: false } : null,
      ];
    },
    async getAccountInfo() { return { data: market, owner: WRAPPER, lamports: 1, executable: false }; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      const m = tx.message;
      const ix = m.compiledInstructions[1];
      const data = Buffer.from(ix.data);
      const amount = data.readBigUInt64LE(1);
      const keys = ix.accountKeyIndexes.map((k) => m.staticAccountKeys[k].toBase58());
      calls.sims.push({ amount, stray: keys.length === 10, keys });
      const r = reply(amount, keys.length === 10);
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [] } };
    },
    async sendRawTransaction() { calls.sends++; return "5ig111111111111111111111111111111111111111111111111111111111111"; },
    async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
    async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: opts.stray ? [{ pubkey: opts.stray, account: {} }] : [] }; },
  };
  return { conn: conn as unknown as TerminalConnection & PreResolveConnection, calls };
}

describe("decodeTerminalState (real TEXTIT bytes)", () => {
  it("live today, with its insurance domain budget", () => {
    const s = decodeTerminalState(new Uint8Array(fx("textit-market-v18-fees")));
    assert.equal(s?.kind, "live");
    assert.ok(s && s.kind === "live" && s.budget > 0n, "TEXTIT carries a domain budget");
  });
  it("materialized_portfolio_count @ group+517 matches devnet (TEXTIT 5 = its 5 portfolio accounts, read 2026-09-30)", () => {
    assert.equal((decodeTerminalState(new Uint8Array(fx("textit-market-v18-fees"))) as { materializedPortfolios: bigint }).materializedPortfolios, 5n);
    assert.equal((decodeTerminalState(new Uint8Array(fx("sol-market-v18-fees"))) as { materializedPortfolios: bigint }).materializedPortfolios, 8n);
  });
  it("mode byte 1 at abs 1218 = resolved, keeping the budget", () => {
    const live = decodeTerminalState(new Uint8Array(fx("textit-market-v18-fees")));
    const s = decodeTerminalState(new Uint8Array(resolved()));
    assert.equal(s?.kind, "resolved");
    assert.equal((s as { budget: bigint }).budget, (live as { budget: bigint }).budget);
  });
  it("kind 8 = closed-market tombstone", () => {
    assert.deepEqual(decodeTerminalState(new Uint8Array(tombstone())), { kind: "closed" });
  });
  it("refuses a non-v18 header, a non-market kind, or a short buffer", () => {
    const v17 = Buffer.from(resolved()); v17.writeUInt16LE(17, 8);
    assert.equal(decodeTerminalState(new Uint8Array(v17)), null);
    const k2 = Buffer.from(resolved()); k2[10] = 2;
    assert.equal(decodeTerminalState(new Uint8Array(k2)), null);
    assert.equal(decodeTerminalState(new Uint8Array(resolved().subarray(0, 900))), null);
  });
  it("fixture sanity: TEXTIT is stake-bound, SOL is not (F2a)", () => {
    const [tp] = deriveStakePool(TEXTIT, STAKE);
    assert.ok(asset0InsuranceAuthority(new Uint8Array(fx("textit-market-v18-fees")))?.equals(deriveStakeVaultAuth(tp, STAKE)[0]));
    const [sp] = deriveStakePool(SOL, STAKE);
    assert.ok(!asset0InsuranceAuthority(new Uint8Array(fx("sol-market-v18-fees")))?.equals(deriveStakeVaultAuth(sp, STAKE)[0]));
  });
});

describe("tag 29 wire and probe classification", () => {
  it("data is [29][amount u64 LE]", () => {
    assert.deepEqual([...encodeRecoverTerminalInsurance(0x0102n)], [29, 2, 1, 0, 0, 0, 0, 0, 0]);
    assert.throws(() => encodeRecoverTerminalInsurance(-1n));
  });
  it("accounts 0..8 (+9 stray) in the f9b9190 order and flags; caller is not a signer", () => {
    const [pool] = deriveStakePool(TEXTIT, STAKE);
    const stray = Keypair.generate().publicKey;
    const ix = buildRecoverTerminalInsuranceIx({
      stakeProgramId: STAKE, wrapperProgramId: WRAPPER, caller: KEEPER.publicKey, market: TEXTIT, pool,
      poolVault: new PublicKey("EefuxdiuVnbTRQmHaYtnVJ9VuRfQmeaMzD1AtkszdPHs"), collateralMint: new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC"), amount: 5n, stray,
    });
    assert.equal(ix.keys.length, 10);
    assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [
      [false, false], [false, true], [false, true], [false, false], [false, true], [false, true], [false, false], [false, false], [false, false], [false, true],
    ]);
    assert.ok(ix.keys[3].pubkey.equals(deriveStakeVaultAuth(pool, STAKE)[0]));
    assert.ok(ix.keys[8].pubkey.equals(WRAPPER));
    assert.ok(ix.keys[9].pubkey.equals(stray));
  });
  it("the deployed (pre-F-9) answer is 'unsupported'; anything past unpack is 'supported'; RPC-shaped is 'unknown'", () => {
    assert.equal(classifyTag29Probe(DEPLOYED_PRE_F9_ERR, false), "unsupported");
    assert.equal(classifyTag29Probe({ InstructionError: [1, { Custom: 30 }] }, false), "supported");
    assert.equal(classifyTag29Probe(null, true), "supported");
    assert.equal(classifyTag29Probe("AccountNotFound", false), "unknown");
    assert.equal(classifyTag29Probe({ InstructionError: [0, "InvalidInstructionData"] }, false), "unknown", "index 0 is the compute-budget ix, not stake");
  });
});

/** First simulation = the tag-29 capability probe (answered "past unpack": Custom(30)); later ones by `rest`. */
const probeOk = (_: bigint, rest: (a: bigint, s: boolean) => SimReply) => {
  let n = 0;
  return (a: bigint, s: boolean): SimReply => (n++ === 0 ? { err: { InstructionError: [1, { Custom: 30 }] } } : rest(a, s));
};

describe("windDownOnce — resolved stake-bound market", () => {
  it("pre-F-9 stake: a NO-OP (no send) that alerts terminal-budget-unbooked after N cycles", async () => {
    const st = new TerminalInsuranceState();
    const s = stub(resolved(), TEXTIT, "textit", () => ({ err: DEPLOYED_PRE_F9_ERR }));
    const kinds: string[] = [];
    for (let i = 0; i < CFG.unbookedAlertCycles; i++) {
      const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
      kinds.push(r.outcome.kind);
      assert.equal(r.support, "unsupported");
    }
    assert.deepEqual(kinds, ["skipped", "skipped", "blocked"]);
    assert.equal(s.calls.sends, 0, "never sends while unsupported");
    assert.equal(s.calls.sims.length, 1, "the probe is cached (TTL), not repeated every cycle");
  });

  it("supported: step 1 sends tag 29 with amount = the asset-0 insurance budget", async () => {
    const budget = (decodeTerminalState(new Uint8Array(resolved())) as { budget: bigint }).budget;
    const s = stub(resolved("textit", undefined, 0n), TEXTIT, "textit", probeOk(-1n, () => ({ err: null })));
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
    assert.equal(s.calls.sims[1].amount, budget);
  });

  it("B14: after tag 29(budget) lands it ALWAYS runs tag 29(0), and marks done only on 31", async () => {
    const st = new TerminalInsuranceState();
    const budget = (decodeTerminalState(new Uint8Array(resolved())) as { budget: bigint }).budget;
    // tag 29(0) books something this pass (a third-party tag-41 push) -> sent, NOT done yet.
    const s = stub(resolved("textit", undefined, 0n), TEXTIT, "textit", probeOk(-1n, () => ({ err: null })));
    const r1 = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.deepEqual(s.calls.sims.map((c) => c.amount), [0n, budget, 0n], "probe, step 1, step 2");
    assert.equal(s.calls.sends, 2, "both steps sent");
    assert.equal(r1.outcome.kind, "done");
    assert.equal(st.done.has(TEXTIT.toBase58()), false, "not done: step 2 did not return 31");
    // next cycle (budget now 0 on chain): step 2 -> 31 -> done.
    const s2 = stub(resolved("textit", 0n, 0n), TEXTIT, "textit", () => ({ err: { InstructionError: [1, { Custom: 31 }] } }));
    await windDownOnce(s2.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(st.done.has(TEXTIT.toBase58()), true);
  });

  it("B14: tag 29(budget) lands and tag 29(0) returns 31 in the same pass -> done", async () => {
    const st = new TerminalInsuranceState();
    const s = stub(resolved("textit", undefined, 0n), TEXTIT, "textit", probeOk(-1n, (a) => (a === 0n ? { err: { InstructionError: [1, { Custom: 31 }] } } : { err: null })));
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(r.outcome.kind, "done");
    assert.match((r.outcome as { detail: string }).detail, /recovered .* Custom\(31\): wind-down complete/);
    assert.equal(st.done.has(TEXTIT.toBase58()), true);
  });

  it("B12: tag 29 -> 21 with materialized portfolios is a CRITICAL blocked alert at once, naming the count", async () => {
    const s = stub(resolved("textit", undefined, 5n), TEXTIT, "textit", probeOk(-1n, (a) => (a > 0n ? { err: { InstructionError: [1, { Custom: 21 }] } } : { err: null })));
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "blocked");
    const o = r.outcome as { alertKind?: string; reason: string };
    assert.equal(o.alertKind, "terminal-recovery-blocked-portfolios");
    assert.match(o.reason, /5 materialized portfolio\(s\) remain/);
    assert.equal(s.calls.sends, 0);
    const a = new FeeJobFailureTracker().alertsFor({ job: "terminal-insurance", done: [], nothing: 0, skipped: [], failed: [], events: [], blocked: [{ market: "T", label: "TEXTIT", reason: o.reason, alertKind: "terminal-recovery-blocked-portfolios" }] });
    assert.equal(a[0].severity, "critical");
    assert.match(a[0].message, /5 materialized portfolio/);
  });

  it("Custom(21) on step 1 with 0 portfolios = cooldown: retried later, never a failure; alerts only after N cycles", async () => {
    const st = new TerminalInsuranceState();
    const s = stub(resolved("textit", undefined, 0n), TEXTIT, "textit", probeOk(-1n, (a) => (a > 0n ? { err: { InstructionError: [1, { Custom: 21 }] } } : { err: null })));
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) kinds.push((await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st)).outcome.kind);
    assert.deepEqual(kinds, ["skipped", "skipped", "blocked"]);
    assert.equal(s.calls.sends, 0);
  });

  it("budget already 0: step 2 (amount 0) books; Custom(31) means done and the market is not touched again", async () => {
    const st = new TerminalInsuranceState();
    const s = stub(resolved("textit", 0n, 0n), TEXTIT, "textit", probeOk(-1n, () => ({ err: { InstructionError: [1, { Custom: 31 }] } })));
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(r.outcome.kind, "nothing");
    assert.ok(s.calls.sims.every((c) => c.amount === 0n));
    const reads = s.calls.reads;
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(s.calls.reads, reads, "done markets cost no RPC");
  });

  it("step 2 sweeps a stray vault_auth-owned token account at index 9", async () => {
    const stray = Keypair.generate().publicKey;
    const s = stub(resolved("textit", 0n), TEXTIT, "textit", probeOk(-1n, () => ({ err: null })), { stray });
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "done");
    const last = s.calls.sims[s.calls.sims.length - 1];
    assert.ok(last.stray && last.keys[9] === stray.toBase58());
  });

  it("tombstone: amount-0 only", async () => {
    const s = stub(tombstone(), TEXTIT, "textit", probeOk(-1n, () => ({ err: { InstructionError: [1, { Custom: 31 }] } })));
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "nothing");
    assert.ok(s.calls.sims.every((c) => c.amount === 0n));
  });

  it("dry-run never sends", async () => {
    const s = stub(resolved(), TEXTIT, "textit", probeOk(-1n, () => ({ err: null })));
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), true, CFG, new TerminalInsuranceState());
    assert.equal(s.calls.sends, 0);
  });
});

describe("windDownOnce — not applicable", () => {
  it("a Live market is left alone (no probe, no tx)", async () => {
    const s = stub(fx("textit-market-v18-fees"), TEXTIT, "textit", () => ({ err: null }));
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "nothing");
    assert.equal(s.calls.sims.length, 0);
  });
  it("a resolved market that is NOT stake-bound (SOL, F2a) is skipped", async () => {
    const s = stub(resolved("sol"), SOL, "sol", () => ({ err: null }));
    const r = await windDownOnce(s.conn, KEEPER, SOL.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "skipped");
    assert.equal(s.calls.sims.length, 0);
  });
});

describe("alerting + pre-resolve integration", () => {
  it("the fee loop turns the unbooked outcome into a CRITICAL terminal-budget-unbooked alert", async () => {
    const r = await runFeeJobSweep(
      { name: "terminal-insurance", run: async () => ({ kind: "blocked", reason: "x", alertKind: "terminal-budget-unbooked" }) },
      { conn: {} as never, keeper: KEEPER, dryRun: false },
      [{ marketAddress: "T", label: "TEXTIT" }],
    );
    const a = new FeeJobFailureTracker().alertsFor(r);
    assert.deepEqual(a.map((x) => [x.kind, x.severity]), [["terminal-budget-unbooked", "critical"]]);
  });

  const noLegs: PreResolveDeps = {
    crankLp: async () => "cranked",
    pushStake: async () => ({ kind: "nothing" }),
  };
  it("pre-resolve BLOCKS a stake-bound market with a budget when the deployed stake has no tag 29", async () => {
    const empty = Buffer.from(fx("textit-market-v18-fees"));
    for (const o of [496, 512, 528, 544]) empty.copy(empty, 16 + o, 16 + (o === 512 ? 496 : o === 544 ? 528 : o), 16 + (o === 512 ? 512 : o === 544 ? 544 : o + 16));
    const s = stub(empty, TEXTIT, "textit", () => ({ err: DEPLOYED_PRE_F9_ERR }));
    const r = await drainFeeLegsBeforeResolve(s.conn, KEEPER, TEXTIT.toBase58(), true, { wrapperProgramId: WRAPPER, stakeProgramId: STAKE, minRealShares: 0n, maxDeadShareBps: 100n, minPushAtoms: 1n }, undefined,
      { ...noLegs, inspectTerminal: (await import("./terminal-insurance.ts")).inspectStakeBoundBudget }, CFG);
    assert.equal(r.terminal?.stakeBound, true);
    assert.equal(r.terminal?.support, "unsupported");
    assert.ok(r.blockers.some((b) => /would be STRANDED at resolve.*no tag 29/.test(b)), JSON.stringify(r.blockers));
    assert.equal(r.safeToResolve, false);
  });
  it("…and only WARNS (run the wind-down after resolve) once tag 29 is supported", async () => {
    const s = stub(fx("textit-market-v18-fees"), TEXTIT, "textit", () => ({ err: { InstructionError: [1, { Custom: 30 }] } }));
    const r = await drainFeeLegsBeforeResolve(s.conn, KEEPER, TEXTIT.toBase58(), true, { wrapperProgramId: WRAPPER, stakeProgramId: STAKE, minRealShares: 0n, maxDeadShareBps: 100n, minPushAtoms: 1n }, undefined,
      { ...noLegs, inspectTerminal: (await import("./terminal-insurance.ts")).inspectStakeBoundBudget }, CFG);
    assert.ok(!r.blockers.some((b) => /STRANDED/.test(b)));
    assert.ok(r.warnings.some((w) => /tag 29 RecoverTerminalInsurance/.test(w)));
    assert.ok(r.warnings.some((w) => /ALL 5 materialized portfolio\(s\) are closed by their owners/.test(w)), "B12 heads-up names the live count");
  });
  it("windDownAfterResolve: complete only when no stake-bound budget is left unbooked", async () => {
    const pre = stub(resolved(), TEXTIT, "textit", () => ({ err: DEPLOYED_PRE_F9_ERR }));
    assert.equal((await windDownAfterResolve(pre.conn, KEEPER, TEXTIT.toBase58(), false, CFG)).complete, false);
    const ok = stub(resolved(), TEXTIT, "textit", probeOk(-1n, () => ({ err: null })));
    assert.equal((await windDownAfterResolve(ok.conn, KEEPER, TEXTIT.toBase58(), false, CFG)).complete, true);
  });
});
