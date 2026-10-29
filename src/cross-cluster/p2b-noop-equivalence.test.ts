/**
 * NO-OP ON TODAY'S PROGRAMS: the keeper's affected code paths, run against today's-program
 * fixtures (real v18 bytes in __fixtures__), produce the SAME instructions / accounts / RPC
 * pattern / /health payload as before the v2.1 work, and the lock-code split changes nothing
 * for codes today's program emits.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_LP_VAULT_CRANK_FEES,
  buildAccountMetas,
  deriveLpBackingLedger,
  encodeLpVaultCrankFees,
} from "@percolatorct/sdk";
import { crankLpFeesOnce, makeLpFeeJob } from "./lp-fee-cranker.ts";
import { makeHealthHandler } from "./keeper-loop.ts";
import { p2bHealthFields, setP2bHealthProvider } from "./p2b-health.ts";
import { revertAdvice, refreshPruneBudget, MAX_REFRESH_PRUNE_BUDGET } from "./recovery-cranker.ts";
import { ENGINE_ADL_REDUCE_ONLY, ENGINE_LOSS_STALE, EARN_EXIT_WOULD_UNDER_BACK_CLAIMS, ENGINE_LOCK_ACTIVE, LOCK_FAMILY_CODES, isLockFamilyCode } from "./lock-codes.ts";
import { setP2bGate } from "./p2b-feature.ts";
import { KEEPER, PROGRAM, deriveLpVaultRegistry, deriveVaultLpState, fx } from "./p2b-test-helpers.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";

afterEach(() => {
  setP2bGate(null);
  setP2bHealthProvider(null);
});

const SOLCAT = "7mgX3bkzEivRrCffCJ7XzqfAp3gpjm63RNinwDhr7b41";

/** Today's registry fixtures, flipped bound or not (byte 160); byte 161 is untouched (0 on every pre-P2b program). */
function registryFx(bound: boolean): Buffer {
  const b = Buffer.from(fx("solcat-lp-vault-registry-v18"));
  b[160] = bound ? 1 : 0;
  return b;
}

describe("tag 78 on today's registries: instructions, accounts and RPC pattern", () => {
  for (const bound of [false, true]) {
    it(`${bound ? "bound" : "unbound"}: identical keys/flags/data to the pre-P2b construction, one read, one blockhash, one send`, async () => {
      const market = new PublicKey(SOLCAT);
      const reg = registryFx(bound);
      assert.equal(reg[161], 0, "today's registry: the ext flag byte is 0");
      const calls: string[] = [];
      const sent: TransactionInstruction[][] = [];
      const conn = {
        async getMultipleAccountsInfo(keys: PublicKey[]) { calls.push(`read:${keys.length}`); return [{ data: reg }, null]; },
        async getLatestBlockhash() { calls.push("blockhash"); return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
        async simulateTransaction() { calls.push("sim"); return { value: { err: null, logs: [] } }; },
        async sendRawTransaction(raw: Buffer) {
          calls.push("send");
          const { Transaction } = await import("@solana/web3.js");
          sent.push(Transaction.from(raw).instructions);
          return "sig";
        },
        async getSignatureStatuses() { calls.push("status"); return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
      };
      assert.equal(await crankLpFeesOnce(conn as never, KEEPER, SOLCAT, false), "cranked");
      assert.deepEqual(calls, ["read:2", "blockhash", "send", "status"], "the same RPC pattern, call for call (the confirm is a status poll)");
      const ix = sent[0].find((i) => i.programId.equals(PROGRAM))!;
      const [reg0] = deriveLpVaultRegistry(PROGRAM, market);
      const expected = new TransactionInstruction({
        programId: PROGRAM,
        keys: buildAccountMetas(ACCOUNTS_LP_VAULT_CRANK_FEES, {
          cranker: KEEPER.publicKey, market, registry: reg0,
          ledger: deriveLpBackingLedger(PROGRAM, market, 0)[0], siblingLedger: deriveLpBackingLedger(PROGRAM, market, 1)[0],
          systemProgram: SystemProgram.programId,
        }).concat(bound ? [{ pubkey: deriveVaultLpState(PROGRAM, market), isSigner: false, isWritable: true }] : []),
        data: Buffer.from(encodeLpVaultCrankFees({ domain: 0 })),
      });
      assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), expected.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
      assert.deepEqual([...ix.data], [...expected.data]);
      assert.equal(ix.keys.length, bound ? 7 : 6);
    });
  }

  it("the fee job's outcome mapping is unchanged (cranked -> done)", async () => {
    const reg = registryFx(false);
    const conn = {
      async getMultipleAccountsInfo() { return [{ data: reg }, null]; },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async sendRawTransaction() { return "sig"; },
      async getSignatureStatuses() { return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    };
    const o = await makeLpFeeJob().run({ conn: conn as never, keeper: KEEPER, dryRun: false }, { marketAddress: SOLCAT, label: "SOLCAT" });
    assert.equal(o.kind, "done");
  });
});

describe("the prune budget on today's programs", () => {
  it("is the capped budget (gate off by default)", () => {
    assert.equal(refreshPruneBudget(100), MAX_REFRESH_PRUNE_BUDGET);
  });
});

describe("lock-code split (21 -> 21 | 120 | 121 | 122)", () => {
  const ADVICE_21 = revertAdvice(21, false);
  it("revertAdvice(21) is unchanged and the three new codes read the same", () => {
    assert.match(ADVICE_21, /drifting toward an unrecoverable deep-stale state/);
    for (const c of [ENGINE_ADL_REDUCE_ONLY, ENGINE_LOSS_STALE, EARN_EXIT_WOULD_UNDER_BACK_CLAIMS]) assert.equal(revertAdvice(c, false), ADVICE_21, `code ${c}`);
    assert.equal(revertAdvice(19, false), ADVICE_21);
  });
  it("other codes and null stay unclassified; compute exhaustion still wins", () => {
    for (const c of [22, 27, 100, 101, 102, 103, 0, null]) assert.match(revertAdvice(c, false), /Unclassified revert/, String(c));
    assert.match(revertAdvice(121, true), /ran out of compute/);
  });
  it("isLockFamilyCode", () => {
    assert.deepEqual([...LOCK_FAMILY_CODES], [21, 120, 121, 122]);
    assert.equal(isLockFamilyCode(ENGINE_LOCK_ACTIVE), true);
    for (const c of [null, undefined, 19, 22, 100, 119, 123]) assert.equal(isLockFamilyCode(c as number | null), false);
  });
});

describe("/health payload", () => {
  function payload(): Record<string, unknown> {
    const state = {
      startedAt: Date.now(),
      lastCycleAt: null,
      cycleCount: 3,
      timeoutCount: 0,
      stats: new Map(),
      lastSuccessfulPushAt: null,
      consecutiveBatchReadFailures: 0,
      lastBatchReadError: null,
      wallet: createWalletBalanceState(),
      cycleAttempted: 0,
      cyclePushed: 0,
      zeroPushStreak: 0,
      terminalMarkets: new Set<string>(),
      landedThisCycle: new Set<string>(),
      tickPublisher: { counters: () => ({ published: 0 }) },
    };
    let body = "";
    const handler = makeHealthHandler(state as never, { intervalMs: 1500, healthPort: 0, healthBind: "127.0.0.1", dryRun: false, minKeeperBalanceLamports: 1, balanceCheckIntervalMs: 1 } as never, { markets: [] } as never);
    handler({ url: "/health" } as never, { writeHead() {}, end(b: string) { body = b; } } as never);
    return JSON.parse(body) as Record<string, unknown>;
  }
  const BASE_KEYS = [
    "walletLow", "walletBalanceSol", "status", "lastSuccessfulPushAgo", "consecutiveBatchReadFailures", "lastBatchReadError",
    "quarantinedMarkets", "lossStaleMarkets", "noPushMarkets", "markLaggingMarkets", "uptimeSec", "cycleCount", "timeoutCount",
    "tickPublisher", "rpc", "lastCycleAgo", "dryRun", "intervalMs", "markets",
  ];

  it("no provider installed (today's programs): exactly the existing fields, in the existing order", () => {
    assert.deepEqual(Object.keys(payload()), BASE_KEYS);
    assert.deepEqual(p2bHealthFields(), {});
  });

  it("a provider that reports nothing adds nothing; a throwing provider is contained", () => {
    setP2bHealthProvider(() => null);
    assert.deepEqual(Object.keys(payload()), BASE_KEYS);
    setP2bHealthProvider(() => { throw new Error("boom"); });
    assert.deepEqual(Object.keys(payload()), BASE_KEYS);
  });

  it("with the layer on: ADDITIVE only; every existing field keeps its value and position", () => {
    const before = payload();
    setP2bHealthProvider(() => ({ earnVaults: [{ market: "m", parMinusE3Bps: 0 }], p2b: { gate: { supported: true } } }));
    const after = payload();
    assert.deepEqual(Object.keys(after), [...BASE_KEYS, "earnVaults", "p2b"]);
    for (const k of BASE_KEYS) if (k !== "uptimeSec") assert.deepEqual(after[k], before[k], k);
    assert.deepEqual(after.earnVaults, [{ market: "m", parMinusE3Bps: 0 }]);
  });

});
