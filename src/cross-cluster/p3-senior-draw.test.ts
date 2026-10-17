/**
 * P3 FINAL d119eebd senior draw + security's `p3-senior-backing-exhausted`.
 *
 * Real bytes: the live SOL v18 market (Azagguvr…, captured 2026-09-24/30) for the mode
 * byte and the WrapperConfigV16 fields the tag 39 window reads (stale_slots @16+136,
 * last_good_oracle_slot @16+152 — the live value is 0 / 505,231,142). The vault-LP state
 * is built at the d119eebd VaultLpStateV18 offsets (:5678, 256 B; no bound vault exists
 * on devnet yet). The log lines are the d119eebd format strings verbatim
 * (v16_program.rs :26754, :26814, :26915, :27019) behind the RPC's "Program log: " prefix.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { exhaustionOf, parseSeniorDrawLogs, reportSeniorDraw, seniorDrawAlerts, VaultLpCranker } from "./vault-lp-crank.ts";
import { ExhaustedRegistry, buildResolveStalePermissionlessIx, makeExhaustedResolveJob } from "./p3-exhausted-resolve.ts";
import { CFG_LAST_GOOD_ORACLE_SLOT, CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS, CONFIG_OFF, staleResolveWindow } from "./market-state.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { landedPushes, withheldFromPush } from "./keeper-loop.ts";
import { makeLpFeeJob } from "./lp-fee-cranker.ts";
import type { Alert } from "./alerting.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
// The wrapper the keeper builders actually target (env override, else the pinned default) - never a stale literal.
const WRAPPER = WRAPPER_PROGRAM_ID;
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const SOLK = new PublicKey(SOL);
const KEEPER = Keypair.generate();
const VAULT_LP = Keypair.generate().publicKey;
const REG = Keypair.generate().publicKey;
const JUNIOR = Keypair.generate().publicKey;
const LIVE_LAST_GOOD = 505_231_142n;

const L = (s: string) => `Program log: ${s}`;
const DRAW_OK = L("p3_senior_draw deficit=5000 moved=5000 unfunded=0 even=3000 odd=2000");
const DRAW_SHORT = L("p3_senior_draw deficit=9000 moved=4000 unfunded=5000 even=4000 odd=0");
const DRAW_ZERO = L("p3_senior_draw deficit=7000 moved=0 unfunded=7000");
const BOOKED = L("p3_senior_draw_booked moved=5000 junior_cover=1200 senior_loss=3800 C=96200 outstanding=3800");
const BOOKED_JUNIOR_ONLY = L("p3_senior_draw_booked moved=900 junior_cover=900 senior_loss=0 C=100000 outstanding=0");
const RESTORED = L("p3_senior_draw_restored to_seniors=800 C=97000 outstanding=3000");

function market(o: { staleSlots?: bigint; lastGood?: bigint; mode?: number } = {}): Buffer {
  const b = Buffer.from(fx("sol-market-v18"));
  if (o.staleSlots !== undefined) b.writeBigUInt64LE(o.staleSlots, CONFIG_OFF + CFG_PERMISSIONLESS_RESOLVE_STALE_SLOTS);
  if (o.lastGood !== undefined) b.writeBigUInt64LE(o.lastGood, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  if (o.mode !== undefined) b[592 + 626] = o.mode;
  return b;
}

/** VaultLpStateV18 (kind 9, version 1) at the d119eebd offsets. */
function vaultLpState(o: { drawn?: bigint; outstanding?: bigint } = {}): Buffer {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
  SOLK.toBuffer().copy(b, 16); REG.toBuffer().copy(b, 16 + 32); VAULT_LP.toBuffer().copy(b, 16 + 64); JUNIOR.toBuffer().copy(b, 16 + 96);
  b[16 + 214] = 1;
  b.writeBigUInt64LE(o.drawn ?? 0n, 16 + 224);
  b.writeBigUInt64LE(o.outstanding ?? 0n, 16 + 240);
  return b;
}

class Sink {
  fired: Array<{ scope: string; a: Alert }> = [];
  async fire(scope: string, a: Alert) { this.fired.push({ scope, a }); return true; }
}

function stub(o: { bound?: boolean; logs?: string[]; simErr?: unknown; mkt?: Buffer; slot?: bigint; simFor?: (tx: { instructions: Array<{ data: Uint8Array; programId: PublicKey; keys: Array<{ pubkey: PublicKey; isWritable: boolean }> }> }) => { err: unknown; logs: string[] } }) {
  const sent: Transaction[] = [];
  const reads: string[] = [];
  let sims = 0;
  const statePda = deriveVaultLpState(WRAPPER, SOLK).toBase58();
  return {
    sent, reads, sims: () => sims,
    conn: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        return keys.map((k) => {
          reads.push(k.toBase58());
          if (k.toBase58() === statePda) return o.bound === false ? null : { data: vaultLpState() };
          if (k.toBase58() === SOL) return { data: o.mkt ?? market() };
          return null;
        });
      },
      async getSlot() { return Number(o.slot ?? LIVE_LAST_GOOD + 10n); },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async simulateTransaction(vtx: { message: { compiledInstructions: Array<{ data: Uint8Array; programIdIndex: number; accountKeyIndexes: number[] }>; staticAccountKeys: PublicKey[]; isAccountWritable: (i: number) => boolean } }) {
        sims++;
        if (o.simFor) {
          const m = vtx.message;
          const ixs = m.compiledInstructions.map((ci) => ({
            data: ci.data,
            programId: m.staticAccountKeys[ci.programIdIndex],
            keys: ci.accountKeyIndexes.map((i) => ({ pubkey: m.staticAccountKeys[i], isWritable: m.isAccountWritable(i) })),
          }));
          const r = o.simFor({ instructions: ixs });
          return { value: { err: r.err, logs: r.logs } };
        }
        return { value: { err: o.simErr ?? null, logs: o.logs ?? [] } };
      },
      async sendRawTransaction(raw: Buffer) { sent.push(Transaction.from(raw)); return `sig${sent.length}`; },
      async confirmTransaction() { return { value: { err: null } }; },
      async getSignatureStatuses() { return { value: [null] }; },
    },
  };
}
const noSleep = async () => {};
const cranker = (c: ReturnType<typeof stub>, sink: Sink, reg = new ExhaustedRegistry()) =>
  new VaultLpCranker(c.conn as never, KEEPER, sink, { wrapperProgramId: WRAPPER, lookupTtlMs: 60_000, sleep: noSleep, registry: reg });

describe("p3_senior_draw log parser (d119eebd format strings)", () => {
  it("parses draw / moved=0 / booked / restored and ignores other lines", () => {
    const ev = parseSeniorDrawLogs([L("Program GnwdeQr… invoke [1]"), DRAW_OK, DRAW_ZERO, BOOKED, RESTORED, L("p3_other x=1")]);
    assert.deepEqual(ev, [
      { kind: "draw", deficit: 5000n, moved: 5000n, unfunded: 0n },
      { kind: "draw", deficit: 7000n, moved: 0n, unfunded: 7000n },
      { kind: "booked", moved: 5000n, juniorCover: 1200n, seniorLoss: 3800n, seniorClaim: 96200n, outstanding: 3800n },
      { kind: "restored", toSeniors: 800n, seniorClaim: 97000n, outstanding: 3000n },
    ]);
    assert.deepEqual(parseSeniorDrawLogs(null), []);
  });
  it("'Earn absorbed X' on a booked senior loss; nothing when the junior covered it all", () => {
    const a = seniorDrawAlerts(SOL, "SOL", parseSeniorDrawLogs([BOOKED]));
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "p3-senior-draw");
    assert.equal(a[0].severity, "warn");
    assert.match(a[0].message, /^Earn absorbed 3800 atoms on /);
    assert.equal(a[0].data?.outstanding, "3800");
    assert.deepEqual(seniorDrawAlerts(SOL, "SOL", parseSeniorDrawLogs([BOOKED_JUNIOR_ONLY, DRAW_OK, RESTORED])), []);
  });
  it("two distinct bookings on one market are not swallowed by the fire() cooldown (distinct dedupe)", () => {
    const b2 = L("p3_senior_draw_booked moved=100 junior_cover=0 senior_loss=100 C=96100 outstanding=3900");
    const [x] = seniorDrawAlerts(SOL, "SOL", parseSeniorDrawLogs([BOOKED]));
    const [y] = seniorDrawAlerts(SOL, "SOL", parseSeniorDrawLogs([b2]));
    assert.notEqual(x.dedupe, y.dedupe);
  });
  it("exhaustion = a draw line with unfunded > 0 (partial and moved=0 forms)", () => {
    assert.deepEqual(exhaustionOf(parseSeniorDrawLogs([DRAW_SHORT])), { deficit: 9000n, unfunded: 5000n });
    assert.deepEqual(exhaustionOf(parseSeniorDrawLogs([DRAW_ZERO])), { deficit: 7000n, unfunded: 7000n });
    assert.equal(exhaustionOf(parseSeniorDrawLogs([DRAW_OK, BOOKED])), null);
  });
});

describe("VaultLpStateV18 d119eebd senior-draw fields", () => {
  it("senior_drawn @16+224 and senior_draw_outstanding @16+240", () => {
    const st = decodeVaultLpState(new Uint8Array(vaultLpState({ drawn: 12_345n, outstanding: 678n })));
    assert.ok(st && st.lpPortfolio.equals(VAULT_LP));
    assert.equal(st.seniorDrawnAtoms, 12_345n);
    assert.equal(st.seniorDrawOutstandingAtoms, 678n);
  });
});

describe("crank the bound vault LP after EVERY mark move", () => {
  it("a landed move on a bound market sends a PermissionlessCrank whose portfolio is the vault LP", async () => {
    const c = stub({ logs: [DRAW_OK] });
    const r = await cranker(c, new Sink()).onPushLanded(SOL, 150_000_000n, "SOL");
    assert.equal(r, "cranked");
    assert.equal(c.sent.length, 1);
    const ix = c.sent[0].instructions[1];
    assert.ok(ix.programId.equals(WRAPPER));
    assert.ok(ix.keys.some((k) => k.pubkey.equals(VAULT_LP) && k.isWritable), "vault LP portfolio passed writable");
    assert.ok(ix.keys.some((k) => k.pubkey.equals(SOLK) && k.isWritable), "market writable");
  });
  it("every distinct move cranks; the same mark again does not", async () => {
    const c = stub({});
    const k = cranker(c, new Sink());
    assert.equal(await k.onPushLanded(SOL, 1n), "cranked");
    assert.equal(await k.onPushLanded(SOL, 1n), "no-move");
    assert.equal(await k.onPushLanded(SOL, 2n), "cranked");
    assert.equal(await k.onPushLanded(SOL, 1n), "cranked");
    assert.equal(c.sent.length, 3);
  });
  it("unbound market (no vault-LP state): nothing sent, lookup cached", async () => {
    const c = stub({ bound: false });
    const k = cranker(c, new Sink());
    assert.equal(await k.onPushLanded(SOL, 1n), "not-bound");
    assert.equal(await k.onPushLanded(SOL, 2n), "not-bound");
    assert.equal(c.sent.length, 0);
    assert.equal(c.reads.length, 1, "one state read within the TTL");
  });
  it("Custom(22) non-progress is benign; any other refusal is a failure and retries at the same mark", async () => {
    const c = stub({ simErr: { InstructionError: [1, { Custom: 22 }] } });
    assert.equal(await cranker(c, new Sink()).onPushLanded(SOL, 1n), "benign");
    assert.equal(c.sent.length, 0);
    const d = stub({ simErr: { InstructionError: [1, { Custom: 19 }] } });
    const k = cranker(d, new Sink());
    assert.equal(await k.onPushLanded(SOL, 1n), "failed");
    assert.equal(await k.onPushLanded(SOL, 1n), "failed", "not 'no-move': a failed crank is retried on the next push");
  });
  it("the crank waits for the push to settle before simulating (settleMs)", async () => {
    const c = stub({});
    const slept: number[] = [];
    const k = new VaultLpCranker(c.conn as never, KEEPER, new Sink(), { wrapperProgramId: WRAPPER, lookupTtlMs: 1, settleMs: 1234, sleep: async (ms) => { slept.push(ms); } });
    await k.onPushLanded(SOL, 1n);
    assert.deepEqual(slept, [1234]);
  });
});

describe("landed pushes drive the hook; dropped / terminal ones do not", () => {
  const pushes = [{ marketAddress: "A", priceE6: 1n }, { marketAddress: "B", priceE6: 2n }, { marketAddress: "C", priceE6: 3n }];
  it("only markets in the pushed set of a signed batch", () => {
    assert.deepEqual(landedPushes(pushes, { pushedMarkets: ["A", "C"], terminalMarkets: ["C"], signature: "s" }).map((p) => p.marketAddress), ["A"]);
    assert.deepEqual(landedPushes(pushes, { pushedMarkets: ["A", "B"], signature: null }), []);
  });
});

describe("p3-senior-backing-exhausted", () => {
  it("tag 39 window on REAL SOL bytes: live config has permissionless resolve disabled (stale_slots 0)", () => {
    const w = staleResolveWindow(new Uint8Array(fx("sol-market-v18")), LIVE_LAST_GOOD + 1_000_000n);
    assert.deepEqual(w, { enabled: false, lastGoodOracleSlot: LIVE_LAST_GOOD });
  });
  it("window arithmetic: remaining = stale_slots - (slot - last_good); matured exactly at the boundary", () => {
    const d = new Uint8Array(market({ staleSlots: 1_000n }));
    assert.deepEqual(staleResolveWindow(d, LIVE_LAST_GOOD + 400n), { enabled: true, staleSlots: 1_000n, lastGoodOracleSlot: LIVE_LAST_GOOD, remaining: 600n, matured: false });
    assert.equal(staleResolveWindow(d, LIVE_LAST_GOOD + 999n)?.enabled && (staleResolveWindow(d, LIVE_LAST_GOOD + 999n) as { matured: boolean }).matured, false);
    assert.equal((staleResolveWindow(d, LIVE_LAST_GOOD + 1_000n) as { matured: boolean }).matured, true);
    assert.equal(staleResolveWindow(new Uint8Array(market({ staleSlots: 1_000n, mode: 1 })), LIVE_LAST_GOOD), null, "not Live");
  });
  it("a crank that logs unfunded > 0 fires a CRITICAL alert with the slots until tag 39, and marks the market", async () => {
    const reg = new ExhaustedRegistry();
    const sink = new Sink();
    const c = stub({ logs: [DRAW_SHORT], mkt: market({ staleSlots: 1_000n }), slot: LIVE_LAST_GOOD + 250n });
    await cranker(c, sink, reg).onPushLanded(SOL, 9n, "SOL");
    const ex = sink.fired.filter((f) => f.a.kind === "p3-senior-backing-exhausted");
    assert.equal(ex.length, 1);
    assert.equal(ex[0].a.severity, "critical");
    assert.match(ex[0].a.message, /5000 of a 9000-atom vault-LP deficit/);
    assert.match(ex[0].a.message, /becomes possible in 750 slots/);
    assert.equal(ex[0].a.data?.slotsUntilTag39, "750");
    assert.ok(reg.has(SOL));
    assert.equal(reg.shouldWithholdPush(SOL, true), true, "window enabled -> withhold pushes so it can run");
    assert.equal(reg.shouldWithholdPush(SOL, false), false, "operator opt-out");
  });
  it("disabled window: alert says admin-only and pushes are NOT withheld", async () => {
    const reg = new ExhaustedRegistry();
    const sink = new Sink();
    await cranker(stub({ logs: [DRAW_ZERO] }), sink, reg).onPushLanded(SOL, 9n, "SOL");
    const [ex] = sink.fired.filter((f) => f.a.kind === "p3-senior-backing-exhausted");
    assert.match(ex.a.message, /only the market admin can resolve it/);
    assert.equal(ex.a.data?.slotsUntilTag39, null);
    assert.equal(reg.shouldWithholdPush(SOL, true), false);
  });
  it("a fully funded draw is NOT exhaustion (control)", async () => {
    const reg = new ExhaustedRegistry();
    const sink = new Sink();
    await cranker(stub({ logs: [DRAW_OK, BOOKED] }), sink, reg).onPushLanded(SOL, 9n, "SOL");
    assert.equal(sink.fired.filter((f) => f.a.kind === "p3-senior-backing-exhausted").length, 0);
    assert.equal(reg.has(SOL), false);
  });
  it("the accrual cranker path (reportSeniorDraw without a window) still marks + alerts", async () => {
    const reg = new ExhaustedRegistry();
    const sink = new Sink();
    await reportSeniorDraw(sink, SOL, "SOL", [DRAW_SHORT], { registry: reg });
    assert.ok(reg.has(SOL));
    assert.match(sink.fired[0].a.message, /reported by the p3-exhausted job/);
  });
  it("push gate: withheld only for a marked market with an enabled window; a throwing gate never blocks", () => {
    const reg = new ExhaustedRegistry();
    reg.mark(SOL, 1n, 1n);
    assert.equal(withheldFromPush(SOL, (m) => reg.shouldWithholdPush(m, true)), false, "window unknown yet");
    reg.setWindow(SOL, true);
    assert.equal(withheldFromPush(SOL, (m) => reg.shouldWithholdPush(m, true)), true);
    assert.equal(withheldFromPush("other", (m) => reg.shouldWithholdPush(m, true)), false);
    assert.equal(withheldFromPush(SOL, () => { throw new Error("x"); }), false);
    assert.equal(withheldFromPush(SOL, undefined), false);
  });
});

describe("p3-exhausted job: tag 39 once the stale window has passed", () => {
  const ctx = (c: ReturnType<typeof stub>, dryRun = false) => ({ conn: c.conn as never, keeper: KEEPER, dryRun });
  const job = (reg: ExhaustedRegistry, vaultLpFor?: (m: PublicKey) => Promise<PublicKey | null>) =>
    makeExhaustedResolveJob({ wrapperProgramId: WRAPPER, registry: reg, vaultLpFor, withholdPushes: true, confirmOpts: { statusRetries: 0, statusRetryDelayMs: 0 } });
  const marked = () => { const r = new ExhaustedRegistry(); r.mark(SOL, 9000n, 5000n); return r; };

  it("window not yet passed: blocked CRITICAL with the remaining slots, nothing sent", async () => {
    const c = stub({ mkt: market({ staleSlots: 1_000n }), slot: LIVE_LAST_GOOD + 100n });
    const o = await job(marked()).run(ctx(c), { marketAddress: SOL, label: "SOL" });
    assert.equal(o.kind, "blocked");
    assert.ok(o.kind === "blocked" && o.alertKind === "p3-senior-backing-exhausted" && o.severity === "critical");
    assert.match((o as { reason: string }).reason, /in 900 slots/);
    assert.equal(c.sent.length, 0);
  });
  it("window disabled (live config): blocked CRITICAL naming the admin, nothing sent", async () => {
    const c = stub({});
    const o = await job(marked()).run(ctx(c), { marketAddress: SOL, label: "SOL" });
    assert.equal(o.kind, "blocked");
    assert.match((o as { reason: string }).reason, /only the market admin/);
    assert.equal(c.sent.length, 0);
  });
  it("window passed: simulates, then SENDS tag 39 [39][now_slot u64 = 0] on the market (writable), and clears the mark", async () => {
    const reg = marked();
    const c = stub({ mkt: market({ staleSlots: 1_000n }), slot: LIVE_LAST_GOOD + 1_000n });
    const o = await job(reg).run(ctx(c), { marketAddress: SOL, label: "SOL" });
    assert.equal(o.kind, "done");
    assert.equal(c.sent.length, 1);
    const ix = c.sent[0].instructions[1];
    assert.ok(ix.programId.equals(WRAPPER));
    assert.deepEqual([...ix.data], [39, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(ix.keys.length, 1);
    assert.ok(ix.keys[0].pubkey.equals(SOLK) && ix.keys[0].isWritable && !ix.keys[0].isSigner);
    assert.equal(reg.has(SOL), false);
    assert.equal(o.events?.[0].kind, "p3-senior-backing-exhausted");
  });
  it("window passed but dry-run: blocked, nothing sent", async () => {
    const c = stub({ mkt: market({ staleSlots: 1_000n }), slot: LIVE_LAST_GOOD + 5_000n });
    assert.equal((await job(marked()).run(ctx(c, true), { marketAddress: SOL, label: "SOL" })).kind, "blocked");
    assert.equal(c.sent.length, 0);
  });
  it("tag 39 refused in simulation: failed, nothing sent, mark kept", async () => {
    const reg = marked();
    const c = stub({ mkt: market({ staleSlots: 1_000n }), slot: LIVE_LAST_GOOD + 5_000n, simErr: { InstructionError: [1, { Custom: 12 }] } });
    assert.equal((await job(reg).run(ctx(c), { marketAddress: SOL, label: "SOL" })).kind, "failed");
    assert.equal(c.sent.length, 0);
    assert.ok(reg.has(SOL));
  });
  it("market no longer Live (resolved by admin or the valve): mark cleared, pushes resume", async () => {
    const reg = marked();
    reg.setWindow(SOL, true);
    const c = stub({ mkt: market({ mode: 1 }) });
    assert.equal((await job(reg).run(ctx(c), { marketAddress: SOL, label: "SOL" })).kind, "done");
    assert.equal(reg.has(SOL), false);
    assert.equal(reg.shouldWithholdPush(SOL, true), false);
  });
  it("restart-safe: an unmarked bound market is re-detected by simulating the vault-LP crank", async () => {
    const reg = new ExhaustedRegistry();
    const c = stub({ logs: [DRAW_SHORT], mkt: market({ staleSlots: 1_000n }), slot: LIVE_LAST_GOOD + 10n });
    const o = await job(reg, async () => VAULT_LP).run(ctx(c), { marketAddress: SOL, label: "SOL" });
    assert.equal(o.kind, "blocked");
    assert.ok(reg.has(SOL));
    assert.equal(c.sent.length, 0, "detection is simulation only");
  });
  it("unmarked market whose vault LP is solvent: nothing (control)", async () => {
    const reg = new ExhaustedRegistry();
    const c = stub({ logs: [DRAW_OK], mkt: market({ staleSlots: 1_000n }) });
    assert.equal((await job(reg, async () => VAULT_LP).run(ctx(c), { marketAddress: SOL, label: "SOL" })).kind, "nothing");
    assert.equal(reg.has(SOL), false);
  });
  it("builder is the one the job sends", () => {
    const ix = buildResolveStalePermissionlessIx(WRAPPER, SOLK);
    assert.deepEqual([...ix.data], [39, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("tag 78 books the pending draw: 'Earn absorbed' only when the booking landed", () => {
  /** A bound registry (flag @160) with shares, over the real SOLCAT registry bytes. */
  const regBytes = () => { const b = Buffer.from(fx("solcat-lp-vault-registry-v18")); b[160] = 1; return b; };
  function lpStub(simLogs: string[], simErr: unknown = null) {
    const sent: Transaction[] = [];
    return {
      sent,
      conn: {
        async getMultipleAccountsInfo() { return [{ data: regBytes() }, { data: fx("sol-market-v18-fees") }]; },
        async simulateTransaction() { return { value: { err: simErr, logs: simLogs } }; },
        async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
        async sendRawTransaction(raw: Buffer) { sent.push(Transaction.from(raw)); return "sig"; },
        async confirmTransaction() { return { value: { err: null } }; },
        async getSignatureStatuses() { return { value: [null] }; },
      },
    };
  }
  it("bound Live market: booking lines in the pre-send simulation become the event", async () => {
    const c = lpStub([BOOKED]);
    const o = await makeLpFeeJob({ statusRetries: 0, statusRetryDelayMs: 0 }).run({ conn: c.conn as never, keeper: KEEPER, dryRun: false }, { marketAddress: SOL, label: "SOL" });
    assert.equal(o.kind, "done");
    assert.equal(c.sent.length, 1);
    assert.equal(o.events?.length, 1);
    assert.match(o.events![0].message, /^Earn absorbed 3800 atoms/);
    // both pot ledgers writable (the per-pot split + booking need them)
    const keys = c.sent[0].instructions[1].keys;
    assert.ok(keys[3].isWritable && keys[4].isWritable, "own + sibling ledger writable");
  });
  it("no fees and nothing to book (Custom 38 in simulation): no send, no event (control)", async () => {
    const c = lpStub([], { InstructionError: [1, { Custom: 38 }] });
    const o = await makeLpFeeJob().run({ conn: c.conn as never, keeper: KEEPER, dryRun: false }, { marketAddress: SOL, label: "SOL" });
    assert.equal(o.kind, "nothing");
    assert.equal(c.sent.length, 0);
    assert.equal(o.events, undefined);
  });
});
