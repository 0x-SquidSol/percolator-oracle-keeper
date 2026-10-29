/**
 * Stake-fee push (tag 87 -> stake AccrueFees). Fee-flow audit 2026-09-29 F2/F3.
 *
 * Fixtures are REAL devnet account bytes captured 2026-09-29 (slot ~505.63M):
 *   sol-market-v18-fees / sol-stake-pool-v18      SOL: stake owed 4,563,668, pool 3,100,001,000 shares
 *   pengu-market-v18-fees / pengu-stake-pool-v18  PENGU: stake owed 1,224,232, pool EXACTLY 1,000 (dead only)
 *   textit-market-v18-fees / textit-stake-pool-v18 TEXTIT: stake owed 228,402, pool 0 shares
 * Those values match fee-flow-audit-2026-09-29.md §2 exactly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, VersionedTransaction } from "@solana/web3.js";
import type { SimulatedTransactionResponse } from "@solana/web3.js";
import { deriveMarketVaultAccounts, parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  STAKE_MINIMUM_LIQUIDITY,
  accruedFromLogs,
  classifyStakeFeeError,
  decideStakeFeePush,
  pushStakeFeesOnce,
} from "./stake-fee-pusher.ts";
import type { StakeFeeConfig, StakeFeeConnection } from "./stake-fee-pusher.ts";
import { nonComputeBudgetCompiled } from "./test-ix.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const MARKETS = {
  sol: { market: "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr", pool: "4AfGCk3bb4x3J3aFi67uhtfR8Cvgej74is77j42NaZTx", vault: "7dJJBeGf4u9bFkRTPf9e494PqiLfZdobjaEXi9hWRaF8", owed: 4_563_668n },
  pengu: { market: "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ", pool: "9fjdWDd8FKudFwAZXEVhDtDcKtxeXQ4iYMWryueoz7Xf", vault: "HW4tkzAdEfD9jyUBJV9uifFYk9n93qdWp4sd5DVbfNCp", owed: 1_224_232n },
  textit: { market: "DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG", pool: "3eF4i4phLHMDd9JiMZFhJ3SZiHn46WGwnj4HuZ7vMx7U", vault: "EefuxdiuVnbTRQmHaYtnVJ9VuRfQmeaMzD1AtkszdPHs", owed: 228_402n },
} as const;

const CFG: StakeFeeConfig = {
  wrapperProgramId: WRAPPER,
  stakeProgramId: STAKE,
  minRealShares: 0n,
  maxDeadShareBps: 100n,
  minPushAtoms: 1n,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 },
};
const KEEPER = Keypair.generate();

type Name = keyof typeof MARKETS;

function stub(name: Name, opts: {
  simErr?: unknown;
  simLogs?: string[];
  confirmThrows?: boolean;
  confirmErr?: unknown;
  status?: { err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" } | null;
  noPool?: boolean;
} = {}) {
  const calls = { sims: 0, sends: 0, simTx: null as VersionedTransaction | null };
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      assert.equal(keys[0].toBase58(), MARKETS[name].market, "first key must be the market");
      assert.equal(keys[1].toBase58(), MARKETS[name].pool, "second key must be the derived stake pool PDA");
      return [
        { data: fx(`${name}-market-v18-fees`), owner: WRAPPER, lamports: 1, executable: false },
        opts.noPool ? null : { data: fx(`${name}-stake-pool-v18`), owner: STAKE, lamports: 1, executable: false },
      ];
    },
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 };
    },
    async simulateTransaction(tx: VersionedTransaction) {
      calls.sims++;
      calls.simTx = tx;
      return {
        context: { slot: 1 },
        value: {
          err: opts.simErr ?? null,
          logs: opts.simLogs ?? [`Program log: AccrueFees: accrued ${MARKETS[name].owed} fees, total_fees_earned=${MARKETS[name].owed}`],
        } as SimulatedTransactionResponse,
      };
    },
    async sendRawTransaction() {
      calls.sends++;
      return "5igSig1111111111111111111111111111111111111111111111111111111111";
    },
    async getBlockHeight() {
      return Number.MAX_SAFE_INTEGER; // the blockhash has expired
    },
    async getSignatureStatuses() {
      const s = opts.status === undefined ? (opts.confirmThrows ? null : { err: opts.confirmErr ?? null, confirmationStatus: "confirmed" as const }) : opts.status;
      return { context: { slot: 3 }, value: [s ? { slot: 2, confirmations: 1, ...s } : null] };
    },
  };
  return { conn: conn as unknown as StakeFeeConnection, calls };
}

describe("decideStakeFeePush — the real-staker gate (F3)", () => {
  const market = new PublicKey(MARKETS.sol.market);
  const pool = (totalLpSupply: bigint, extra: Partial<{ poolMode: number; riskMode: number; slab: PublicKey; percolatorProgram: PublicKey }> = {}) => ({
    slab: market, poolMode: 0, totalLpSupply, isInitialized: true, percolatorProgram: WRAPPER, ...extra,
  });

  it("refuses a pool holding only the 1,000 dead shares", () => {
    const d = decideStakeFeePush({ market, owed: 1_224_232n, pool: pool(STAKE_MINIMUM_LIQUIDITY) }, CFG);
    assert.equal(d.action, "skip");
    assert.match((d as { reason: string }).reason, /no real stakers/);
  });

  it("refuses an empty pool (0 shares)", () => {
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(0n) }, CFG).action, "skip");
  });

  it("K-1: a dust deposit (1 real share) does NOT unlock the push — dead shares would take ~99.9%", () => {
    const d = decideStakeFeePush({ market, owed: 5n, pool: pool(STAKE_MINIMUM_LIQUIDITY + 1n) }, CFG);
    assert.equal(d.action, "skip");
    assert.match((d as { reason: string }).reason, /dead shares would take ~9991 bps/);
  });

  it("K-1: ratio boundary — 100,000 total shares (dead = 1.00%) pushes, 99,999 does not", () => {
    assert.deepEqual(decideStakeFeePush({ market, owed: 5n, pool: pool(100_000n) }, CFG), { action: "push", owed: 5n, realShares: 99_000n });
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(99_999n) }, CFG).action, "skip");
  });

  it("STAKE_FEE_MAX_DEAD_SHARE_BPS relaxes or tightens the ratio", () => {
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(20_000n) }, { ...CFG, maxDeadShareBps: 500n }).action, "push");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(100_000n) }, { ...CFG, maxDeadShareBps: 50n }).action, "skip");
  });

  it("honours STAKE_FEE_MIN_REAL_SHARES", () => {
    const d = decideStakeFeePush({ market, owed: 5n, pool: pool(1_000_000n) }, { ...CFG, minRealShares: 999_000n });
    assert.equal(d.action, "skip");
  });

  it("nothing owed -> nothing (no tx)", () => {
    assert.equal(decideStakeFeePush({ market, owed: 0n, pool: pool(10_000n) }, CFG).action, "nothing");
  });

  it("a pool bound to another market or wrapper is blocked, never pushed", () => {
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(10_000n, { slab: KEEPER.publicKey }) }, CFG).action, "blocked");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(10_000n, { percolatorProgram: KEEPER.publicKey }) }, CFG).action, "blocked");
  });

  it("a mode-1 (trading) pool is not a tag-87 destination", () => {
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(10_000n, { poolMode: 1 }) }, CFG).action, "skip");
    // S2-2: FEE_ONLY (risk 2) / legacy-0 v5 pools are never sent tag 87 (wrapper answers Custom(59)); FIRST_LOSS (1) still pushes.
    for (const rm of [2, 0]) {
      const d = decideStakeFeePush({ market, owed: 5n, pool: pool(1_000_000n, { riskMode: rm }) }, CFG);
      assert.equal(d.action, "skip", `riskMode ${rm}`);
      assert.match((d as { reason: string }).reason, /FIRST_LOSS/);
    }
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(1_000_000n, { riskMode: 1 }) }, CFG).action, "push");
    assert.equal(decideStakeFeePush({ market, owed: 5n, pool: pool(1_000_000n) }, CFG).action, "push", "pre-v5 pool: unchanged");
  });
});

describe("pushStakeFeesOnce — real devnet bytes", () => {
  it("PENGU (dead shares only): no simulation, no send", async () => {
    const s = stub("pengu");
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.pengu.market, false, CFG);
    assert.equal(o.kind, "skipped");
    assert.match((o as { reason: string }).reason, /total_lp_supply=1000/);
    assert.equal(s.calls.sims, 0);
    assert.equal(s.calls.sends, 0);
  });

  it("TEXTIT (0 shares): skipped, no send", async () => {
    const s = stub("textit");
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.textit.market, false, CFG);
    assert.equal(o.kind, "skipped");
    assert.equal(s.calls.sends, 0);
  });

  it("SOL (real stakers): builds [CU, tag 87, stake 12] with the verified account layouts", async () => {
    const s = stub("sol");
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.sol.market, false, CFG);
    assert.equal(o.kind, "done", JSON.stringify(o));
    assert.match((o as { detail: string }).detail, /pushed 4563668 atoms/);
    const msg = s.calls.simTx!.message;
    const keys = msg.staticAccountKeys;
    // [CU limit, payloads...]: with KEEPER_PRIORITY_FEE_MICROLAMPORTS set a trailing SetComputeUnitPrice is appended (S3-A2); it is not a payload.
    const ixs = [msg.compiledInstructions[0], ...nonComputeBudgetCompiled(msg.compiledInstructions, keys)];
    assert.equal(ixs.length, 3);
    const prog = (i: number) => keys[ixs[i].programIdIndex].toBase58();
    assert.equal(prog(1), WRAPPER.toBase58());
    assert.equal(prog(2), STAKE.toBase58());
    assert.deepEqual([...ixs[1].data], [87], "tag 87 has no payload");
    assert.deepEqual([...ixs[2].data], [12], "stake AccrueFees tag 12");

    const mint = parseWrapperConfigV17(new Uint8Array(fx("sol-market-v18-fees"))).collateralMint;
    assert.ok(mint.toBase58().startsWith("DJ54k4"), "collateral mint is sim-USDC DJ54k4… (audit §2)");
    const v = deriveMarketVaultAccounts(WRAPPER, new PublicKey(MARKETS.sol.market), mint);
    const acc = (i: number) => ixs[i].accountKeyIndexes.map((k) => keys[k].toBase58());
    assert.deepEqual(acc(1), [
      KEEPER.publicKey.toBase58(),
      MARKETS.sol.market,
      MARKETS.sol.pool,
      MARKETS.sol.vault,
      v.vaultToken.toBase58(),
      v.vaultAuthority.toBase58(),
      TOKEN.toBase58(),
    ]);
    assert.deepEqual(acc(2), [
      KEEPER.publicKey.toBase58(),
      MARKETS.sol.pool,
      MARKETS.sol.vault,
      SYSVAR_CLOCK_PUBKEY.toBase58(),
      MARKETS.sol.market,
    ], "AccrueFees must carry pool.slab at index 4 (#290)");
    const w = (k: string) => msg.isAccountWritable(keys.findIndex((x) => x.toBase58() === k));
    assert.ok(w(MARKETS.sol.market) && w(MARKETS.sol.pool) && w(MARKETS.sol.vault) && w(v.vaultToken.toBase58()));
    assert.ok(!w(v.vaultAuthority.toBase58()));
    assert.equal(s.calls.sends, 1);
  });

  it("SOL today: Custom(56) at tag 87 is BLOCKED (needs Bind tag 19), not a failure, and nothing is sent", async () => {
    const s = stub("sol", { simErr: { InstructionError: [1, { Custom: 56 }] } });
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.sol.market, false, CFG);
    assert.equal(o.kind, "blocked");
    assert.match((o as { reason: string }).reason, /BindInsuranceAuthority/);
    assert.equal(s.calls.sends, 0);
  });

  it("F6 applies here too: a push whose signature status shows it landed is DONE", async () => {
    const s = stub("sol", { confirmThrows: true, status: { err: null, confirmationStatus: "confirmed" } });
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.sol.market, false, CFG);
    assert.equal(o.kind, "done");
    assert.match((o as { detail: string }).detail, /signature-status/);
  });

  it("a push that landed but failed on chain is reported by its code", async () => {
    const s = stub("sol", { confirmErr: { InstructionError: [1, { Custom: 53 }] } });
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.sol.market, false, CFG);
    assert.equal(o.kind, "nothing");
  });

  it("dry-run simulates but never sends", async () => {
    const s = stub("sol");
    const o = await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.sol.market, true, CFG);
    assert.equal(o.kind, "skipped");
    assert.equal(s.calls.sims, 1);
    assert.equal(s.calls.sends, 0);
  });

  it("no stake pool: skipped", async () => {
    const s = stub("sol", { noPool: true });
    assert.equal((await pushStakeFeesOnce(s.conn, KEEPER, MARKETS.sol.market, false, CFG)).kind, "skipped");
  });
});

describe("classifyStakeFeeError", () => {
  it("53 at tag 87 is healthy (drained)", () => {
    assert.equal(classifyStakeFeeError({ InstructionError: [1, { Custom: 53 }] }, null).kind, "nothing");
  });
  it("21 at tag 87 is 'not Live'", () => {
    assert.equal(classifyStakeFeeError({ InstructionError: [1, { Custom: 21 }] }, null).kind, "skipped");
  });
  for (const c of [54, 55, 56, 57, 58, 59, 60]) {
    it(`${c} at tag 87 is blocked`, () => {
      assert.equal(classifyStakeFeeError({ InstructionError: [1, { Custom: c }] }, null).kind, "blocked");
    });
  }
  it("the same code at the STAKE instruction is a failure, not a wrapper meaning", () => {
    const o = classifyStakeFeeError({ InstructionError: [2, { Custom: 56 }] }, ["Program log: #290: slab account does not match pool.slab"]);
    assert.equal(o.kind, "failed");
    assert.match((o as { error: string }).error, /stake AccrueFees Custom\(56\).*#290/);
  });
});

describe("accruedFromLogs", () => {
  it("reads the stake program's accrual line", () => {
    assert.equal(accruedFromLogs(["x", "Program log: AccrueFees: accrued 4563668 fees, total_fees_earned=9"]), 4_563_668n);
    assert.equal(accruedFromLogs(["nothing"]), null);
  });
});
