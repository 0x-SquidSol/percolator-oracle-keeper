/**
 * R3.20 — the lp-fee job failed on cycle 0 after every keeper boot with
 *   "Simulation failed. Message: Transaction simulation failed: Error processing Instruction 1: custom p"
 *
 * Root cause (percolator-prog 153c62fc): tag 78 `handle_lp_vault_crank_fees` calls
 * `reject_permissionless_resolve_matured_live_view` (src/v16_program.rs:32899 -> :13546), which answers
 * OracleStale = 27 (= 0x1b) on a LIVE market once `now - config.last_good_oracle_slot >= permissionless_resolve_stale_slots`
 * (18,000 on every v2.2 market). Only a mark push advances `last_good_oracle_slot`, and the fee loop starts at boot
 * concurrently with the push loop, so a market not pushed for > 18,000 slots (a 12 h outage; CHILLHOUSE-T / swordcat-T
 * seeded at 15:35Z and first pushed by the keeper at 18:03:32Z, 15 s AFTER the fee job's 18:03:17Z cycle 0) meets 27
 * until the first push lands. The cycle line's `.slice(0, 100)` (fee-jobs.ts) then cut "custom program error: 0x1b" to "custom p".
 *
 * Fix: that exact refusal, confirmed from the market bytes + cluster slot, is "waiting" (retry next cycle), and every
 * fee-job error carries its code first, never clipped. Any other code, or a 27 without a matured window, is "failed".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { V17_EXPECTED_VERSION } from "@percolatorct/sdk";
import { crankLpFeesOnce, makeLpFeeJob } from "./lp-fee-cranker.ts";
import { LP_VAULT_REGISTRY_BOUND_FLAG_OFF } from "./registry-flags.ts";
import { clipKeepingCode, describeProgramError, programErrorCode, staleResolveWait } from "./fee-error.ts";
import { CFG_LAST_GOOD_ORACLE_SLOT, CONFIG_OFF } from "./market-state.ts";
import { FeeJobFailureTracker, FEE_JOB_WAITING_ALERT_AFTER, runFeeJobSweep, summarizeSweep } from "./fee-jobs.ts";
import type { FeeJob } from "./fee-jobs.ts";
import { classifyStakeFeeError } from "./stake-fee-pusher.ts";

const KEEPER = Keypair.generate();
const MARKET = () => Keypair.generate().publicKey.toBase58();
const FAST = { statusRetries: 0, statusRetryDelayMs: 0 };

/** The exact SendTransactionError text web3.js produced for the 27 (the log line is this, cut at 140). */
const SIM_FAILED_27 =
  "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1b. \n" +
  "Logs: \n[\n  \"Program ComputeBudget111111111111111111111111111111 invoke [1]\",\n  \"Program 6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM failed: custom program error: 0x1b\"\n]. \n" +
  "Catch the `SendTransactionError` and call `getLogs()` on it for full details.";

/** A real v2.2 Live market (CHILLHOUSE, 18,000-slot stale-resolve window), with last_good_oracle_slot forged. */
const LAST_GOOD = 511_396_225n; // CHILLHOUSE-T's last seeding tx slot, 15:35:28Z
const AT_FEE_CYCLE0 = 511_433_430n; // ~18:03:17Z: 37,205 slots later, first keeper push at 511_433_469
function liveMarket(lastGood = LAST_GOOD): Buffer {
  const d = Buffer.from(readFileSync(new URL("./__fixtures__/v22-chillhouse-market-v19.b64", import.meta.url), "utf8").trim(), "base64");
  d.writeBigUInt64LE(lastGood, CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT);
  return d;
}

function registryBuf(bound: boolean): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  b.writeUInt16LE(V17_EXPECTED_VERSION, 8);
  b.writeUInt8(5, 10);
  b.writeBigUInt64LE(1_000_000n, 16 + 64);
  b.writeUInt16LE(0, 16 + 132);
  if (bound) b[LP_VAULT_REGISTRY_BOUND_FLAG_OFF] = 1;
  return b;
}

function conn(o: { market: Buffer; slot?: bigint | "throws"; sendError?: unknown; simErr?: unknown; bound?: boolean }) {
  let sends = 0;
  let slotReads = 0;
  return {
    get sends() { return sends; },
    get slotReads() { return slotReads; },
    c: {
      async getMultipleAccountsInfo() { return [{ data: registryBuf(!!o.bound) }, { data: o.market }]; },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async simulateTransaction() { return { value: { err: o.simErr ?? null, logs: [] } }; },
      async sendRawTransaction() { sends++; if (o.sendError) throw o.sendError; return "sig"; },
      async confirmTransaction(): Promise<{ value: { err: unknown } }> { return { value: { err: null } }; },
      async getSignatureStatuses() { return { value: [null] }; },
      async getSlot() {
        slotReads++;
        if (o.slot === "throws") throw new Error("429");
        return Number(o.slot ?? AT_FEE_CYCLE0);
      },
    },
  };
}

describe("R3.20 fee-error: the custom code is never cut off", () => {
  it("the cycle line's .slice(0, 100) (fee-jobs.ts:194) lost the code; describeProgramError keeps it first", () => {
    const old = SIM_FAILED_27.slice(0, 100);
    assert.ok(old.endsWith("Error processing Instruction 1: custom p"), `the logged line reproduced: ${JSON.stringify(old)}`);
    assert.equal(programErrorCode(old), null, "the code is gone from the old log line");
    const d = describeProgramError("tag 78", new Error(SIM_FAILED_27));
    assert.ok(d.startsWith("tag 78 OracleStale(27) — Transaction simulation failed"), d);
    assert.ok(d.length < 160, d);
  });

  it("decodes the code from the message, a JSON tx error and a SendTransactionError's logs", () => {
    assert.equal(programErrorCode(new Error(SIM_FAILED_27)), 27);
    assert.equal(programErrorCode({ InstructionError: [1, { Custom: 38 }] }), 38);
    const e = Object.assign(new Error("Simulation failed."), { logs: ["Program X failed: custom program error: 0x15"] });
    assert.equal(programErrorCode(e), 21);
    assert.equal(programErrorCode(new Error("fetch failed")), null);
  });

  it("clipKeepingCode appends the code when the clip would drop it, and is a no-op otherwise", () => {
    assert.equal(clipKeepingCode(SIM_FAILED_27, 100), `${SIM_FAILED_27.slice(0, 100)}… [OracleStale(27)]`);
    assert.equal(clipKeepingCode("tag 87 OracleStale(27) — x".repeat(10), 30), "tag 87 OracleStale(27) — xtag ");
    assert.equal(clipKeepingCode("short", 100), "short");
    assert.equal(clipKeepingCode("no code here ".repeat(20), 20), "no code here no code");
    assert.ok(clipKeepingCode("x".repeat(120) + " custom program error: 0x3e7", 50).endsWith("[Custom(999)]"));
  });
});

describe("R3.20 staleResolveWait: only OracleStale on a Live market whose window has matured", () => {
  const m = liveMarket();
  it("matured (the 18:03:17Z boot: 37,205 slots >= 18,000) -> waiting", () => {
    const r = staleResolveWait(27, m, AT_FEE_CYCLE0);
    assert.ok(r && /window matured/.test(r) && /37205 slots ago >= 18000/.test(r), String(r));
  });
  it("not matured -> null (a 27 there is a real failure)", () => {
    assert.equal(staleResolveWait(27, m, LAST_GOOD + 100n), null);
    assert.equal(staleResolveWait(27, m, LAST_GOOD + 17_000n), null);
  });
  it("tolerates a few slots of RPC skew at the boundary only", () => {
    assert.ok(staleResolveWait(27, m, LAST_GOOD + 18_000n - 10n));
    assert.equal(staleResolveWait(27, m, LAST_GOOD + 18_000n - 100n), null);
  });
  it("any other code, no slot, no market, or a non-Live market -> null", () => {
    assert.equal(staleResolveWait(38, m, AT_FEE_CYCLE0), null);
    assert.equal(staleResolveWait(41, m, AT_FEE_CYCLE0), null);
    assert.equal(staleResolveWait(null, m, AT_FEE_CYCLE0), null);
    assert.equal(staleResolveWait(27, m, null), null);
    assert.equal(staleResolveWait(27, null, AT_FEE_CYCLE0), null);
    const resolved = Buffer.from(readFileSync(new URL("./__fixtures__/v22-codec-market-v19-resolved.b64", import.meta.url), "utf8").trim(), "base64");
    assert.equal(staleResolveWait(27, resolved, AT_FEE_CYCLE0 + 10_000_000n), null);
  });
  it("a market with the window disabled (stale slots 0) -> null", () => {
    const d = liveMarket();
    d.writeBigUInt64LE(0n, CONFIG_OFF + 136);
    assert.equal(staleResolveWait(27, d, AT_FEE_CYCLE0), null);
  });
});

describe("R3.20 lp-fee: the boot-time 27 is waiting, everything else still fails with its code", () => {
  it("unbound (preflight throws): matured 27 -> { waiting }, reason carries the code", async () => {
    const f = conn({ market: liveMarket(), sendError: new Error(SIM_FAILED_27) });
    const r = await crankLpFeesOnce(f.c as never, KEEPER, MARKET(), false, FAST);
    assert.ok(typeof r === "object" && r.waiting === true, JSON.stringify(r));
    assert.ok(typeof r === "object" && r.error.startsWith("tag 78 OracleStale(27): stale-resolve window matured"), JSON.stringify(r));
    assert.equal(f.slotReads, 1);
  });

  it("bound (the v2.2 markets; simulated first by the fee job): matured 27 -> job outcome 'waiting', nothing sent", async () => {
    const f = conn({ market: liveMarket(), bound: true, simErr: { InstructionError: [1, { Custom: 27 }] } });
    const o = await makeLpFeeJob(FAST).run({ conn: f.c as never, keeper: KEEPER, dryRun: false }, { marketAddress: MARKET(), label: "CHILLHOUSE-T/USDC — pumpswap" });
    assert.equal(o.kind, "waiting", JSON.stringify(o));
    assert.equal(f.sends, 0);
  });

  it("27 on a market whose window has NOT matured stays 'failed', with the code", async () => {
    const f = conn({ market: liveMarket(AT_FEE_CYCLE0 - 50n), sendError: new Error(SIM_FAILED_27) });
    const o = await makeLpFeeJob(FAST).run({ conn: f.c as never, keeper: KEEPER, dryRun: false }, { marketAddress: MARKET(), label: "M" });
    assert.equal(o.kind, "failed");
    assert.ok(o.kind === "failed" && o.error.startsWith("tag 78 OracleStale(27) — "), JSON.stringify(o));
  });

  it("27 when the slot read fails stays 'failed' (never assumed)", async () => {
    const f = conn({ market: liveMarket(), sendError: new Error(SIM_FAILED_27), slot: "throws" });
    const o = await makeLpFeeJob(FAST).run({ conn: f.c as never, keeper: KEEPER, dryRun: false }, { marketAddress: MARKET(), label: "M" });
    assert.equal(o.kind, "failed");
  });

  it("an unknown code on a stale market is 'failed' with its full code; the slot is not even read", async () => {
    const msg = SIM_FAILED_27.replace(/0x1b/g, "0x3e7");
    const f = conn({ market: liveMarket(), sendError: new Error(msg) });
    const o = await makeLpFeeJob(FAST).run({ conn: f.c as never, keeper: KEEPER, dryRun: false }, { marketAddress: MARKET(), label: "M" });
    assert.ok(o.kind === "failed" && o.error.startsWith("tag 78 Custom(999) — "), JSON.stringify(o));
    assert.equal(f.slotReads, 0);
  });

  it("a landed-but-failed tx names its code (was JSON clipped at 100)", async () => {
    const f = conn({ market: liveMarket(AT_FEE_CYCLE0), slot: AT_FEE_CYCLE0 });
    f.c.confirmTransaction = async () => ({ value: { err: { InstructionError: [1, { Custom: 41 }] } } });
    const r = await crankLpFeesOnce(f.c as never, KEEPER, MARKET(), false, FAST);
    assert.ok(typeof r === "object" && !r.waiting && /^tag 78 landed but failed on chain: LpVaultZeroSharesMinted\(41\)/.test(r.error), JSON.stringify(r));
  });
});

describe("R3.20 stake-fee (tag 87 has the same matured gate)", () => {
  const ie27 = { InstructionError: [1, { Custom: 27 }] };
  it("27 at tag 87 with a confirmed matured window -> waiting", () => {
    const o = classifyStakeFeeError(ie27, null, "OracleStale(27): stale-resolve window matured …");
    assert.equal(o.kind, "waiting");
  });
  it("27 at tag 87 without it -> failed, named", () => {
    const o = classifyStakeFeeError(ie27, null);
    assert.ok(o.kind === "failed" && o.error.startsWith("tag 87 OracleStale(27)"), JSON.stringify(o));
  });
  it("27 from the STAKE program (ix 2) is never the wrapper wait", () => {
    const o = classifyStakeFeeError({ InstructionError: [2, { Custom: 27 }] }, null, "matured");
    assert.ok(o.kind === "failed" && o.error.startsWith("stake AccrueFees Custom(27)"), JSON.stringify(o));
  });
});

describe("R3.20 fee-jobs: 'waiting' is counted, not alerted, and escalates if it never clears", () => {
  const waitJob: FeeJob = { name: "lp-fee", async run() { return { kind: "waiting", reason: "tag 78 OracleStale(27): stale-resolve window matured" }; } };
  const ctx = { conn: {} as never, keeper: KEEPER, dryRun: false };
  const markets = [{ marketAddress: "M1", label: "CHILLHOUSE-T" }];

  it("a waiting market is not a failure and appears in the summary", async () => {
    const r = await runFeeJobSweep(waitJob, ctx, markets);
    assert.equal(r.failed.length, 0);
    assert.equal(r.waiting?.length, 1);
    assert.deepEqual(summarizeSweep(r), { done: 0, nothing: 0, skipped: 0, blocked: 0, waiting: 1, failed: 0 });
  });

  it("no alert for a one-cycle boot wait; a warn once it persists FEE_JOB_WAITING_ALERT_AFTER cycles; reset when it clears", async () => {
    const t = new FeeJobFailureTracker();
    const r = await runFeeJobSweep(waitJob, ctx, markets);
    for (let i = 1; i < FEE_JOB_WAITING_ALERT_AFTER; i++) assert.deepEqual(t.alertsFor(r), [], `cycle ${i}`);
    const a = t.alertsFor(r);
    assert.equal(a.length, 1);
    assert.equal(a[0].severity, "warn");
    assert.match(a[0].message, /still waiting after 6 consecutive cycles.*OracleStale\(27\)/);
    const cleared = { ...r, waiting: [] };
    assert.deepEqual(t.alertsFor(cleared), []);
    assert.deepEqual(t.alertsFor(r), [], "streak restarted");
  });

  it("the failure alert keeps the code even when the error is long", async () => {
    const failJob: FeeJob = { name: "lp-fee", async run() { return { kind: "failed", error: `ext tail: ${"x".repeat(200)} ${SIM_FAILED_27}` }; } };
    const t = new FeeJobFailureTracker();
    const r = await runFeeJobSweep(failJob, ctx, markets);
    t.alertsFor(r);
    t.alertsFor(r);
    const a = t.alertsFor(r);
    assert.match(a[0].message, /\[OracleStale\(27\)\]$/);
  });
});
