/**
 * Tests for the cranker's "accrue, then refresh every positioned portfolio"
 * transaction, against real devnet account bytes captured 2026-09-28:
 *
 *   cate-market-v18      CATE CjdnH8fT… (max_portfolio_assets 14, max_accrual_dt 100),
 *                        loss_stale_active=1, stale 1L/1S, stored 1L/1S
 *   cate-lp-portfolio    JAbvCce1… LP (matcher enabled), long 6400773782
 *   cate-trader-portfolio 6c7hV3Km… short 6400773782
 *   cate-flat-portfolio  65iKyg4c… no legs
 *   sol-market-v18       SOL Azagguvr… (max_accrual_dt 500), positioned, NOT loss-stale
 *   jup-market-v18       JUP HvCDVSx5…, no positions, not loss-stale
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/positioned-refresh.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { IX_TAG } from "@percolatorct/sdk";
import {
  catchupCrankCount,
  decodeMarketRefreshState,
  isAssetLossStale,
  marketHasPositions,
  parseInstructionError,
  planCrankTx,
  positionedSetMatchesMarket,
  selectPositionedPortfolios,
} from "./positioned-refresh.ts";
import type { CrankPlan, PositionedPortfolio } from "./positioned-refresh.ts";
import { resolveCrankPlan } from "./recovery-cranker.ts";
import type { SimOutcome } from "./recovery-cranker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(join(here, "__fixtures__", `${name}.b64`), "utf8").trim(), "base64");

const CATE = new PublicKey("CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE");
const CATE_LP = new PublicKey("JAbvCce1twNVzpeLGMkgzdE2TqbRPz2oHeod9kaMFsum");
const CATE_TRADER = new PublicKey("6c7hV3Km5hDkNSrqn3ievcShwkg8fB9agZy8PnVfHVFG");
const CATE_FLAT = new PublicKey("65iKyg4cie2aJu2tQT23UckWWANVvurxDMeRJyyeMEo7");

const catePortfolios = () => [
  { pubkey: CATE_LP, data: fixture("cate-lp-portfolio-v18") },
  { pubkey: CATE_TRADER, data: fixture("cate-trader-portfolio-v18") },
  { pubkey: CATE_FLAT, data: fixture("cate-flat-portfolio-v18") },
];

function crankKind(data: Uint8Array): "obs" | "noobs" {
  assert.equal(data[0], IX_TAG.PermissionlessCrank);
  const n = data[9];
  assert.equal(data.length, 10 + 3 * n);
  return n === 0 ? "noobs" : "obs";
}

describe("decodeMarketRefreshState (v18 devnet bytes)", () => {
  it("CATE: loss-stale market with a stale cohort on both sides", () => {
    const s = decodeMarketRefreshState(fixture("cate-market-v18"));
    assert.equal(s.maxAccrualDtSlots, 100n);
    assert.equal(s.lifecycle, 2);
    assert.equal(s.storedPosLong, 1n);
    assert.equal(s.storedPosShort, 1n);
    assert.equal(s.staleLong, 1n);
    assert.equal(s.staleShort, 1n);
    assert.equal(s.lossStaleActive, true);
    // The mirrored predicate agrees with the byte the engine wrote.
    assert.equal(isAssetLossStale(s), true);
    assert.equal(marketHasPositions(s), true);
  });

  it("SOL: positioned but fully refreshed -> not loss-stale", () => {
    const s = decodeMarketRefreshState(fixture("sol-market-v18"));
    assert.equal(s.maxAccrualDtSlots, 500n);
    assert.equal(s.storedPosLong, 1n);
    assert.equal(s.storedPosShort, 1n);
    assert.equal(s.staleLong, 0n);
    assert.equal(s.staleShort, 0n);
    assert.equal(s.lossStaleActive, false);
    assert.equal(isAssetLossStale(s), false);
    assert.equal(marketHasPositions(s), true);
  });

  it("JUP: no positions -> nothing to refresh", () => {
    const s = decodeMarketRefreshState(fixture("jup-market-v18"));
    assert.equal(s.lossStaleActive, false);
    assert.equal(isAssetLossStale(s), false);
    assert.equal(marketHasPositions(s), false);
  });

  it("rejects a truncated account", () => {
    assert.throws(() => decodeMarketRefreshState(fixture("cate-market-v18").subarray(0, 2000)));
  });
});

describe("selectPositionedPortfolios", () => {
  it("CATE: LP (long) and trader (short); flat portfolio skipped", () => {
    const set = selectPositionedPortfolios(catePortfolios());
    assert.deepEqual(
      set.map((p) => [p.pubkey.toBase58(), p.longLegs, p.shortLegs, p.isLp]),
      [
        [CATE_LP.toBase58(), 1, 0, true],
        [CATE_TRADER.toBase58(), 0, 1, false],
      ],
    );
  });

  it("skips non-portfolio-sized accounts (240-byte kind-3)", () => {
    const set = selectPositionedPortfolios([{ pubkey: PublicKey.unique(), data: fixture("sol-kind3-240b-v18") }]);
    assert.equal(set.length, 0);
  });

  it("set matches stored_pos_count only when every positioned portfolio is present", () => {
    const s = decodeMarketRefreshState(fixture("cate-market-v18"));
    const set = selectPositionedPortfolios(catePortfolios());
    assert.equal(positionedSetMatchesMarket(set, s), true);
    // Missing the trader (e.g. it opened after discovery) must force a re-read.
    assert.equal(positionedSetMatchesMarket(set.filter((p) => p.isLp), s), false);
  });
});

describe("planCrankTx", () => {
  const owner = PublicKey.unique();
  const targets = (): PositionedPortfolio[] => selectPositionedPortfolios(catePortfolios());

  it("accrue on the LP with an observation, then no-observation refreshes: trader first, LP last", () => {
    const plan = planCrankTx({ owner, market: CATE, lpPortfolio: CATE_LP, catchup: 0, refreshTargets: targets() });
    assert.deepEqual(
      plan.cranks.map((c) => [c.kind, c.portfolio.toBase58(), crankKind(c.ix.data)]),
      [
        ["accrue", CATE_LP.toBase58(), "obs"],
        ["refresh", CATE_TRADER.toBase58(), "noobs"],
        ["refresh", CATE_LP.toBase58(), "noobs"],
      ],
    );
    for (const c of plan.cranks) {
      assert.equal(c.ix.keys[1].pubkey.toBase58(), CATE.toBase58());
      assert.equal(c.ix.keys[2].pubkey.toBase58(), c.portfolio.toBase58());
    }
    assert.equal(plan.overflow.length, 0);
  });

  it("puts bounded catch-up cranks before the full accrual", () => {
    const plan = planCrankTx({ owner, market: CATE, lpPortfolio: CATE_LP, catchup: 3, refreshTargets: targets() });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["catchup", "catchup", "catchup", "accrue", "refresh", "refresh"]);
  });

  it("too far behind: catch-up cranks only (no accrual/refresh), fits one packet and the CU cap", () => {
    const plan = planCrankTx({ owner, market: CATE, lpPortfolio: CATE_LP, catchup: 40, refreshTargets: targets() });
    // v22price 2026-10-22: CU-capped, floor(1.3M / 45k) = 28 (40 at the measured 36.35k-42.5k v2.2 cost overflowed 1.4M)
    assert.equal(plan.cranks.length, 28);
    assert.ok(plan.cranks.every((c) => c.kind === "catchup" && crankKind(c.ix.data) === "obs"));
    assert.ok(plan.computeUnits <= 1_400_000);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits }));
    for (const c of plan.cranks) tx.add(c.ix);
    tx.feePayer = owner;
    tx.recentBlockhash = PublicKey.unique().toBase58();
    assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232);
  });

  it("no positions -> the single accrual crank the loop always sent", () => {
    const plan = planCrankTx({ owner, market: CATE, lpPortfolio: CATE_LP, catchup: 0, refreshTargets: [] });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["accrue"]);
  });

  it("caps refreshes by the CU budget and reports the overflow", () => {
    const many: PositionedPortfolio[] = Array.from({ length: 20 }, () => ({
      pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false,
    }));
    const plan = planCrankTx({ owner, market: CATE, lpPortfolio: CATE_LP, catchup: 0, refreshTargets: many });
    const refreshes = plan.cranks.filter((c) => c.kind === "refresh").length;
    assert.equal(refreshes, 7, `refreshes=${refreshes} (7 at REFRESH_CRANK_CU 145k beside the accrual)`);
    assert.equal(refreshes + plan.overflow.length, 20);
    assert.ok(plan.computeUnits <= 1_400_000);
    // The planned transaction must also fit the 1232-byte packet.
    const tx = new Transaction();
    for (const c of plan.cranks) tx.add(c.ix);
    tx.feePayer = owner;
    tx.recentBlockhash = PublicKey.unique().toBase58();
    assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232);
  });
});

describe("catchupCrankCount", () => {
  it("floor(gap / max_accrual_dt), capped", () => {
    assert.equal(catchupCrankCount(50n, 100n), 0);
    assert.equal(catchupCrankCount(100n, 100n), 1);
    assert.equal(catchupCrankCount(2683n, 100n), 26);
    assert.equal(catchupCrankCount(169481n, 100n), 40); // capped at MAX_CATCHUP_CRANKS
    assert.equal(catchupCrankCount(737n, 500n), 1);
    assert.equal(catchupCrankCount(-5n, 100n), 0);
    assert.equal(catchupCrankCount(500n, 0n), 0);
  });
});

describe("parseInstructionError", () => {
  it("reads index and custom code", () => {
    assert.deepEqual(parseInstructionError({ InstructionError: [2, { Custom: 22 }] }), { index: 2, custom: 22 });
    assert.deepEqual(parseInstructionError({ InstructionError: [1, "InvalidAccountData"] }), { index: 1, custom: null });
    assert.equal(parseInstructionError("BlockhashNotFound"), null);
  });
});

describe("resolveCrankPlan (simulate + prune)", () => {
  const owner = PublicKey.unique();
  const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan =>
    planCrankTx({ owner, market: CATE, lpPortfolio: CATE_LP, catchup: 0, refreshTargets: t });
  const ok: SimOutcome = { err: null, logs: [], marketData: null };

  it("clean first simulation: no prune", async () => {
    let sims = 0;
    const r = await resolveCrankPlan(build, selectPositionedPortfolios(catePortfolios()), async () => { sims++; return ok; });
    assert.equal(sims, 1);
    assert.equal(r.pruned.length, 0);
    assert.equal(r.plan.cranks.filter((c) => c.kind === "refresh").length, 2);
  });

  it("prunes a refresh the engine rejects (NoAction -> Custom(22)) and keeps the rest", async () => {
    const r = await resolveCrankPlan(build, selectPositionedPortfolios(catePortfolios()), async (plan) => {
      // ix 0 = compute budget, so plan.cranks[i] is simulation index i + 1.
      const i = plan.cranks.findIndex((c) => c.kind === "refresh" && c.portfolio.equals(CATE_LP));
      return i >= 0 ? { err: { InstructionError: [i + 1, { Custom: 22 }] }, logs: [], marketData: null } : ok;
    });
    assert.equal(r.sim.err, null);
    assert.deepEqual(r.pruned.map((p) => [p.pubkey.toBase58(), p.code]), [[CATE_LP.toBase58(), 22]]);
    assert.deepEqual(
      r.plan.cranks.map((c) => [c.kind, c.portfolio.toBase58()]),
      [["accrue", CATE_LP.toBase58()], ["refresh", CATE_TRADER.toBase58()]],
    );
  });

  it("an accrual failure is returned for the revert path, not pruned", async () => {
    const r = await resolveCrankPlan(build, selectPositionedPortfolios(catePortfolios()), async () => ({
      err: { InstructionError: [1, { Custom: 21 }] }, logs: [], marketData: null,
    }));
    assert.deepEqual(r.sim.err, { InstructionError: [1, { Custom: 21 }] });
    assert.equal(r.pruned.length, 0);
  });

  it("gives up refreshing after the prune budget and falls back to accrual only", async () => {
    const many: PositionedPortfolio[] = Array.from({ length: 6 }, () => ({
      pubkey: PublicKey.unique(), longLegs: 1, shortLegs: 0, isLp: false,
    }));
    let sims = 0;
    const r = await resolveCrankPlan(build, many, async (plan) => {
      sims++;
      const i = plan.cranks.findIndex((c) => c.kind === "refresh");
      return i >= 0 ? { err: { InstructionError: [i + 1, { Custom: 22 }] }, logs: [], marketData: null } : ok;
    });
    assert.equal(r.sim.err, null);
    assert.deepEqual(r.plan.cranks.map((c) => c.kind), ["accrue"]);
    assert.equal(r.pruned.length, 6);
    assert.ok(sims <= 5, `sims=${sims}`);
  });
});
