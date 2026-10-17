/**
 * Stake-fee push vs per-sub-pool dead-share floors (percolator-stake R-1,
 * fix/v22-stake-last-junior-residual @ aebbff6). A tranche pool can hold 2,000 dead shares; the
 * pusher must key off real_lp_supply(), and behave EXACTLY as before on the deployed (pre-fix)
 * program, where `_reserved[61]` is 0 (legacy: total - 1000).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { SimulatedTransactionResponse, VersionedTransaction } from "@solana/web3.js";
import {
  STAKE_FLOOR_JUNIOR,
  STAKE_FLOOR_SENIOR,
  STAKE_MINIMUM_LIQUIDITY,
  decideStakeFeePush,
  pushStakeFeesOnce,
  readStakeFloorFlags,
} from "./stake-fee-pusher.ts";
import type { StakeFeeConfig, StakeFeeConnection } from "./stake-fee-pusher.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const SOL_MARKET = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const PENGU_MARKET = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ";
const TEXTIT_MARKET = "DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG";
const CFG: StakeFeeConfig = {
  wrapperProgramId: WRAPPER, stakeProgramId: STAKE, minRealShares: 0n, maxDeadShareBps: 100n, minPushAtoms: 1n,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 },
};
const KEEPER = Keypair.generate();
import { stakeRealLpSupply } from "@percolatorct/sdk";
const realLp = (totalLpSupply: bigint, floorFlags: number): bigint => stakeRealLpSupply({ totalLpSupply, floorFlags });
const BOTH = STAKE_FLOOR_SENIOR | STAKE_FLOOR_JUNIOR;
const market = new PublicKey(SOL_MARKET);
const pool = (totalLpSupply: bigint, floorFlags?: number) => ({
  slab: market, poolMode: 0, totalLpSupply, floorFlags, isInitialized: true, percolatorProgram: WRAPPER,
});

/** The pre-fix rule, verbatim from 85c6f23 (single 1,000 floor). */
function oldDecidePool(total: bigint, cfg: StakeFeeConfig): "push" | "skip" {
  const real = total > STAKE_MINIMUM_LIQUIDITY ? total - STAKE_MINIMUM_LIQUIDITY : 0n;
  if (real > cfg.minRealShares && STAKE_MINIMUM_LIQUIDITY * 10_000n > cfg.maxDeadShareBps * total) return "skip";
  if (real <= cfg.minRealShares) return "skip";
  return "push";
}

function stubWithPool(poolBytes: Buffer, marketFixture = "sol-market-v18-fees") {
  const calls = { sims: 0, sends: 0 };
  const conn = {
    async getMultipleAccountsInfo() {
      return [
        { data: fx(marketFixture), owner: WRAPPER, lamports: 1, executable: false },
        { data: poolBytes, owner: STAKE, lamports: 1, executable: false },
      ];
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 }; },
    async simulateTransaction(_tx: VersionedTransaction) {
      calls.sims++;
      return { context: { slot: 1 }, value: { err: null, logs: ["Program log: AccrueFees: accrued 4563668 fees, total_fees_earned=4563668"] } as SimulatedTransactionResponse };
    },
    async sendRawTransaction() { calls.sends++; return "5igSig1111111111111111111111111111111111111111111111111111111111"; },
    async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
    async getSignatureStatuses() { return { context: { slot: 3 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" as const }] }; },
  };
  return { conn: conn as unknown as StakeFeeConnection, calls };
}

function patched(base: Buffer, total: bigint, flags: number): Buffer {
  const b = Buffer.from(base);
  b.writeBigUInt64LE(total, 176); // total_lp_supply
  b[320 + 61] = flags; // _reserved[61]
  return b;
}

describe("stakeRealLpSupply mirrors state.rs real_lp_supply", () => {
  it("legacy (0): total-1000 saturating; senior-only: same; junior-only / both: per-floor", () => {
    assert.equal(realLp(5000n, 0), 4000n);
    assert.equal(realLp(1000n, 0), 0n);
    assert.equal(realLp(0n, 0), 0n);
    assert.equal(realLp(5000n, STAKE_FLOOR_SENIOR), 4000n);
    assert.equal(realLp(5000n, STAKE_FLOOR_JUNIOR), 4000n);
    assert.equal(realLp(5000n, BOTH), 3000n);
    assert.equal(realLp(2000n, BOTH), 0n);
    assert.equal(realLp(1500n, BOTH), 0n);
  });
  it("reads the flags byte at absolute 381 (v2+)", () => {
    const b = patched(fx("sol-stake-pool-v18"), 5000n, 3);
    assert.equal(readStakeFloorFlags(b), 3);
    b[380] = 0xff; b[382] = 0xff; b[381] = 0;
    assert.equal(readStakeFloorFlags(b), 0);
  });
});

describe("decideStakeFeePush with two dead floors", () => {
  it("a pool holding only 2,000 dead shares (both floors) is refused: no real stakers", () => {
    const d = decideStakeFeePush({ market, owed: 5n, pool: pool(2000n, BOTH) }, CFG);
    assert.equal(d.action, "skip");
    assert.match((d as { reason: string }).reason, /no real stakers/);
  });
  it("junior-only floor (senior sub-pool empty) with only the 1,000 dead junior shares is refused", () => {
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(1000n, STAKE_FLOOR_JUNIOR) }, CFG).action, "skip");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(1000n, STAKE_FLOOR_SENIOR) }, CFG).action, "skip");
  });
  it("K-1 ratio counts both floors: at 100,000 total a legacy single floor pushes, two floors skip", () => {
    // 100,000 total: legacy dead = 1.00% -> push; two floors dead = 2.00% -> skip at the default 100 bps
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(100_000n, 0) }, CFG).action, "push");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(100_000n, BOTH) }, CFG).action, "skip");
  });
  it("two floors: ratio boundary at 200,000 total (dead = 1.00%); realShares excludes both floors", () => {
    assert.deepEqual(decideStakeFeePush({ market, owed: 5n, pool: pool(200_000n, BOTH) }, CFG), { action: "push", owed: 5n, realShares: 198_000n });
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(199_999n, BOTH) }, CFG).action, "skip");
  });
  it("minRealShares applies to real_lp_supply", () => {
    const cfg = { ...CFG, minRealShares: 197_999n };
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(200_000n, BOTH) }, cfg).action, "push");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(200_000n, BOTH) }, { ...cfg, minRealShares: 198_000n }).action, "skip");
  });
});

describe("pushStakeFeesOnce: never pushes (no sim, no send) when real supply is 0", () => {
  for (const [name, total, flags] of [
    ["both floors, 2,000 shares", 2000n, BOTH],
    ["junior floor only, 1,000 shares", 1000n, STAKE_FLOOR_JUNIOR],
    ["senior floor only, 1,000 shares", 1000n, STAKE_FLOOR_SENIOR],
    ["both floors, below 2,000 (inconsistent, saturates)", 1500n, BOTH],
  ] as const) {
    it(name, async () => {
      const s = stubWithPool(patched(fx("sol-stake-pool-v18"), total, flags));
      const o = await pushStakeFeesOnce(s.conn, KEEPER, SOL_MARKET, false, CFG);
      assert.equal(o.kind, "skipped", JSON.stringify(o));
      assert.equal(s.calls.sims, 0);
      assert.equal(s.calls.sends, 0);
    });
  }
  it("both floors with real stakers still pushes", async () => {
    const s = stubWithPool(patched(fx("sol-stake-pool-v18"), 3_100_002_000n, BOTH));
    const o = await pushStakeFeesOnce(s.conn, KEEPER, SOL_MARKET, false, CFG);
    assert.equal(o.kind, "done", JSON.stringify(o));
    assert.match((o as { detail: string }).detail, /3100000000 real shares/);
    assert.equal(s.calls.sends, 1);
  });
});

describe("current LIVE (pre-fix) stake program: flags byte is 0 -> behaviour unchanged", () => {
  it("captured live pool bytes carry flags 0", () => {
    for (const n of ["sol", "pengu", "textit"]) assert.equal(readStakeFloorFlags(fx(`${n}-stake-pool-v18`)), 0, n);
  });
  it("decision == the pre-fix formula for every total across the boundaries, flags 0 and omitted", () => {
    const totals = [0n, 1n, 999n, 1000n, 1001n, 1002n, 2000n, 2001n, 50_000n, 99_999n, 100_000n, 100_001n, 3_100_001_000n];
    for (const cfg of [CFG, { ...CFG, maxDeadShareBps: 500n }, { ...CFG, minRealShares: 5n }]) {
      for (const t of totals) {
        for (const flags of [0, undefined]) {
          const d = decideStakeFeePush({ market, owed: 5n, pool: pool(t, flags) }, cfg);
          assert.equal(d.action, oldDecidePool(t, cfg), `total=${t} flags=${flags}`);
          if (d.action === "push") assert.equal(d.realShares, t - STAKE_MINIMUM_LIQUIDITY);
        }
      }
    }
  });
  it("end to end on the live SOL / PENGU / TEXTIT bytes: SOL pushes, PENGU and TEXTIT do not", async () => {
    const sol = stubWithPool(fx("sol-stake-pool-v18"));
    assert.equal((await pushStakeFeesOnce(sol.conn, KEEPER, SOL_MARKET, false, CFG)).kind, "done");
    const pengu = stubWithPool(fx("pengu-stake-pool-v18"), "pengu-market-v18-fees");
    assert.equal((await pushStakeFeesOnce(pengu.conn, KEEPER, PENGU_MARKET, false, CFG)).kind, "skipped");
    assert.equal(pengu.calls.sims, 0);
    const textit = stubWithPool(fx("textit-stake-pool-v18"), "textit-market-v18-fees");
    assert.equal((await pushStakeFeesOnce(textit.conn, KEEPER, TEXTIT_MARKET, false, CFG)).kind, "skipped");
    assert.equal(textit.calls.sims, 0);
  });
});
