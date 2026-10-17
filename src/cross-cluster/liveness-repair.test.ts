/**
 * Liveness repairs (ExpireBackingBucket tag 89, FinalizeResetSide tag 45).
 *
 * Fixtures are live devnet market bytes captured 2026-09-29 at slot 505580400:
 *   paid     — domain-1 backing bucket Fresh but LAPSED (expiry 505460821):
 *              every keeper crank reverted Custom(19), engine clock hundreds of
 *              slots behind, UI "engine behind".
 *   murphy   — both buckets lapsed + short side stuck ResetPending (0 positions):
 *              every open and every Earn deposit reverted Custom(21).
 *   collect  — domain-1 lapsed + short side ResetPending: every open Custom(21).
 *   pengu    — healthy control (LP-vault buckets, expiry u64::MAX/2-ish).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/liveness-repair.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { IX_TAG, parseBackingBucketsV17 } from "@percolatorct/sdk";
import {
  FINALIZE_RESET_SIDE_TAG,
  buildExpireBackingBucketIx,
  buildFinalizeResetSideIx,
  decodeLivenessState,
  planLivenessRepairs,
} from "./liveness-repair.ts";
import type { LivenessState } from "./liveness-repair.ts";
import { planCrankTx } from "./positioned-refresh.ts";
import { crankAllOnce, resolveCrankPlan } from "./recovery-cranker.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const CAPTURE_SLOT = 505580400n;
const MARKETS = [
  "paid-market-v18-lapsed",
  "murphy-market-v18-lapsed",
  "collect-market-v18-lapsed",
  "pengu-market-v18-healthy",
  "cate-market-v18",
  "sol-market-v18",
];

describe("decodeLivenessState", () => {
  for (const name of MARKETS) {
    it(`${name}: backing buckets match the SDK decoder`, () => {
      const data = fixture(name);
      const ours = decodeLivenessState(data).buckets;
      const sdk = parseBackingBucketsV17(data).buckets.slice(0, 2);
      assert.deepEqual(
        ours.map((b) => [b.domain, b.status, b.expirySlot]),
        sdk.map((b) => [b.domain, b.status, BigInt(b.expirySlot)]),
      );
    });
  }

  it("reads the live ResetPending short side on COLLECT and Murphy", () => {
    for (const name of ["collect-market-v18-lapsed", "murphy-market-v18-lapsed"]) {
      const s = decodeLivenessState(fixture(name));
      assert.equal(s.sides[1].mode, 2, `${name} short side ResetPending`);
      assert.equal(s.sides[1].storedPos, 0n);
      assert.equal(s.sides[0].mode, 0, `${name} long side Normal`);
    }
  });
});

describe("planLivenessRepairs on live 2026-09-29 state", () => {
  const plan = (name: string) => planLivenessRepairs(decodeLivenessState(fixture(name)), CAPTURE_SLOT);

  it("PAID: expire the lapsed domain-1 bucket only", () => {
    assert.deepEqual(plan("paid-market-v18-lapsed"), [{ kind: "expire", domain: 1 }]);
  });
  it("Murphy: expire both lapsed buckets and finalize the short reset", () => {
    assert.deepEqual(plan("murphy-market-v18-lapsed"), [
      { kind: "expire", domain: 0 },
      { kind: "expire", domain: 1 },
      { kind: "finalize", assetIndex: 0, side: 1 },
    ]);
  });
  it("COLLECT: expire domain 1 (domain 0 still inside its window) and finalize the short reset", () => {
    assert.deepEqual(plan("collect-market-v18-lapsed"), [
      { kind: "expire", domain: 1 },
      { kind: "finalize", assetIndex: 0, side: 1 },
    ]);
  });
  it("healthy PENGU / SOL: nothing", () => {
    assert.deepEqual(plan("pengu-market-v18-healthy"), []);
    assert.deepEqual(plan("sol-market-v18"), []);
  });
});

describe("planLivenessRepairs gates mirror the engine", () => {
  const base = (): LivenessState => ({
    assetIndex: 0,
    buckets: [
      { domain: 0, status: 1, expirySlot: 100n },
      { domain: 1, status: 0, expirySlot: 0n },
    ],
    sides: [
      { side: 0, mode: 0, storedPos: 0n, stale: 0n, pendingObligations: 0n, pendingDomainLossBarrier: 0n },
      { side: 1, mode: 2, storedPos: 0n, stale: 0n, pendingObligations: 0n, pendingDomainLossBarrier: 0n },
    ],
  });

  it("expires only a Fresh bucket strictly past its expiry", () => {
    assert.deepEqual(planLivenessRepairs(base(), 100n).filter((r) => r.kind === "expire"), []);
    assert.deepEqual(planLivenessRepairs(base(), 101n).filter((r) => r.kind === "expire"), [{ kind: "expire", domain: 0 }]);
    const expired = base();
    expired.buckets[0].status = 2; // Expired
    assert.deepEqual(planLivenessRepairs(expired, 10_000n).filter((r) => r.kind === "expire"), []);
    const lp = base();
    lp.buckets[0].expirySlot = (1n << 63n) - 1n; // LP_VAULT_BACKING_EXPIRY_SLOT
    assert.deepEqual(planLivenessRepairs(lp, 10_000n).filter((r) => r.kind === "expire"), []);
  });

  it("finalizes only a ResetPending side with no positions, stale accounts, obligations or barrier", () => {
    const fin = (s: LivenessState) => planLivenessRepairs(s, 0n).filter((r) => r.kind === "finalize");
    assert.deepEqual(fin(base()), [{ kind: "finalize", assetIndex: 0, side: 1 }]);
    for (const field of ["storedPos", "stale", "pendingObligations", "pendingDomainLossBarrier"] as const) {
      const s = base();
      s.sides[1][field] = 1n;
      assert.deepEqual(fin(s), [], `${field} != 0 must block finalize (engine returns Stale)`);
    }
    const drain = base();
    drain.sides[1].mode = 1; // DrainOnly: engine returns LockActive, not repairable here
    assert.deepEqual(fin(drain), []);
  });
});

describe("instruction wire", () => {
  const market = PublicKey.unique();
  it("FinalizeResetSide = [45, asset u16 LE, side u8], market writable only", () => {
    const ix = buildFinalizeResetSideIx(market, 0, 1);
    assert.deepEqual([...ix.data], [FINALIZE_RESET_SIDE_TAG, 0, 0, 1]);
    assert.equal(ix.keys.length, 1);
    assert.ok(ix.keys[0].pubkey.equals(market));
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[0].isSigner, false);
  });
  it("ExpireBackingBucket = [89, domain u16 LE], market writable only", () => {
    const ix = buildExpireBackingBucketIx(market, 1);
    assert.deepEqual([...ix.data], [IX_TAG.ExpireBackingBucket, 1, 0]);
    assert.equal(ix.keys.length, 1);
    assert.equal(ix.keys[0].isWritable, true);
  });
});

describe("crank transaction carries the repairs", () => {
  const PAID = new PublicKey("BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY");
  const PAID_LP = new PublicKey("AZXj9a8gxzFuRYvdUxFERvvkzLMkVXPQtDn9hpFsGqp7");
  const PAID_PFS: [string, string][] = [
    ["paid-lp-AZXj9a8g", PAID_LP.toBase58()],
    ["paid-pf-22hRxRE6", "22hRxRE653dGdWifTpjA43Yipct5xBkksmFD4HDAYTEh"],
    ["paid-pf-3i2WWX7Z", "3i2WWX7Z91ZVbn3ZxRr8QYa2UvKE6ZapwbEC9d5QWUZZ"],
    ["paid-pf-4tVr9mrU", "4tVr9mrUc7npEJH4UhbvwPtqZ9ypN9cTFMmmxSZpJS7Q"],
    ["paid-pf-9L8gLAxb", "9L8gLAxbrsTc97gmXJxwwcFiZ9MWfxQefyT1vP6hpoef"],
  ];

  function fakeConn(simErrAtFirstIx: unknown = null) {
    const sent: Transaction[] = [];
    let sims = 0;
    const conn = {
      async getAccountInfoAndContext(pk: PublicKey) {
        assert.ok(pk.equals(PAID));
        return { context: { slot: Number(CAPTURE_SLOT) }, value: { data: fixture("paid-market-v18-lapsed") } };
      },
      async getAccountInfo() {
        return { data: fixture("paid-market-v18-lapsed") };
      },
      async getProgramAccounts() {
        return PAID_PFS.map(([f, pk]) => ({ pubkey: new PublicKey(pk), account: { data: fixture(f) } }));
      },
      async getSlot() {
        return Number(CAPTURE_SLOT);
      },
      async getLatestBlockhash() {
        return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 };
      },
      async simulateTransaction(_tx: Transaction | VersionedTransaction) {
        sims++;
        const err = sims === 1 ? simErrAtFirstIx : null;
        return { context: { slot: Number(CAPTURE_SLOT) }, value: { err, logs: [], accounts: null } };
      },
      async sendRawTransaction(raw: Buffer) {
        sent.push(Transaction.from(raw));
        return "sig" + sent.length;
      },
    };
    return { conn, sent };
  }

  const run = async (conn: unknown) =>
    crankAllOnce(
      conn as never,
      Keypair.generate(),
      { markets: [{ marketAddress: PAID.toBase58(), label: "PAID", lpPortfolio: PAID_LP.toBase58() }] } as never,
      false,
    );

  it("PAID: ExpireBackingBucket(d1) lands before the accrual crank in the same transaction", async () => {
    const { conn, sent } = fakeConn();
    await run(conn);
    assert.equal(sent.length, 1);
    const tags = sent[0].instructions
      .filter((ix) => ix.programId.equals(WRAPPER_PROGRAM_ID))
      .map((ix) => ix.data[0]);
    assert.equal(tags[0], IX_TAG.ExpireBackingBucket, `first wrapper ix must be the expiry, got tags ${tags.join(",")}`);
    assert.deepEqual([...sent[0].instructions.find((ix) => ix.data[0] === IX_TAG.ExpireBackingBucket)!.data], [89, 1, 0]);
    assert.ok(tags.slice(1).every((t) => t === IX_TAG.PermissionlessCrank), "the rest are cranks");
  });

  it("a repair the engine rejects is dropped and the ordinary crank still goes", async () => {
    // Index 1 = first instruction after the compute-budget ix = the repair.
    const { conn, sent } = fakeConn({ InstructionError: [1, { Custom: 19 }] });
    await run(conn);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].instructions.some((ix) => ix.data[0] === IX_TAG.ExpireBackingBucket));
    assert.ok(sent[0].instructions.some((ix) => ix.data[0] === IX_TAG.PermissionlessCrank));
  });

  it("resolveCrankPlan without a drop hook keeps the old behaviour (returns the repair failure)", async () => {
    const market = PublicKey.unique();
    const lp = PublicKey.unique();
    const build = () =>
      planCrankTx({ owner: lp, market, lpPortfolio: lp, catchup: 0, refreshTargets: [], repairs: [{ kind: "expire", domain: 1 }] });
    const r = await resolveCrankPlan(build, [], async () => ({ err: { InstructionError: [1, { Custom: 19 }] }, logs: null, marketData: null }));
    assert.ok(r.sim.err);
    assert.equal(r.plan.cranks[0].kind, "repair");
  });
});
