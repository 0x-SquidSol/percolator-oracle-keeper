/**
 * K-6 (R3.22): multi-asset markets. The v2.2 keeper pushed and cranked asset 0 only, so the 5-asset QA fixtures
 * (2xhs…, 3vW8…) went stale within minutes and became tag-39 resolvable ~2 h after their last push.
 *
 * Covered here: registry rows -> price units, per-asset push batching (incl. the REAL 2xhs account bytes, slot
 * 511,456,771: all 5 assets pushed), crank ordering / hint lists / CU, refresh selection over every asset, health.
 * Single-asset markets must stay byte-identical: several tests below pin that explicitly.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/k6-multi-asset.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { encodePermissionlessCrank, parsePortfolioV17 } from "@percolatorct/sdk";
import type { MarketEntry } from "./registry.ts";
import {
  bindObservationRegistry,
  catchupCrankCuFor,
  decodeMarketRefreshStateFor,
  isMultiAssetMarket,
  laggingAssets,
  maxCatchupCranksFor,
  observationAssetsFor,
  observationHints,
  parseFixedPriceE6,
  priceUnitsOf,
  priceUnitsOfRegistry,
  recordMarketAccrual,
  getMarketAccrual,
  resetMultiAssetState,
  sampleAssetAccrual,
  validateMultiAssetEntry,
  SINGLE_ASSET_OBSERVATION,
} from "./multi-asset.ts";
import {
  ACCRUAL_TX_CU_HEADROOM,
  ACCRUE_CRANK_CU,
  CATCHUP_CRANK_CU,
  MAX_CATCHUP_CRANKS,
  MAX_TX_CU,
  V22_LEG_COST,
  buildObservationCrankIx,
  buildRefreshCrankIx,
  catchupCrankCount,
  decodeMarketRefreshState,
  isAssetLossStale,
  planCrankTx,
  positionedSetMatchesMarket,
  selectPositionedPortfolios,
} from "./positioned-refresh.ts";
import type { PositionedPortfolio } from "./positioned-refresh.ts";
import { analysePortfolios } from "./v22/positioned.ts";
import { pushAuthMarkBatch, getQuarantinedMarkets } from "./auth-mark-pusher.ts";
import { detectLayout, engineSlotBase, assetSlotsOff } from "./market-layout.ts";
import { fixedPushFor, landedPushes, multiAssetMarketHealth, newMarketStat, recordMultiAssetPushOutcome, makeHealthHandler } from "./keeper-loop.ts";
import { DEFAULT_THRESHOLDS } from "./alerting.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Uint8Array => new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));
const ADDITIONS = JSON.parse(readFileSync(join(here, "..", "..", "registry-additions-v22-multiasset.json"), "utf8")) as { markets: MarketEntry[] };

const M2XHS = "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw";
const M3VW8 = "3vW8VARnfB4y3QdJaWYebSv5WQvChnAHFL3MNLSH4JAy";
const LP = "6w14eZR3S4e1AxkWEtruGZ6dRSj2mDaNsWtfcKZ3Dg4W";
const TAKER = "GV86syBheFoAZkCB9EXEHfphAoKJSgQ3dvfwCwiK7QJ4";
const FLAT = "JB5PkWDsANuC6xq1sHP6oN1UvzNPYRKDNXQfgMWFGsX3";
const FIXTURE_SLOT = 511_456_771n;
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
const PUSH_TAG = 63;
const CRANK_TAG = 5;

const row2xhs = (): MarketEntry => structuredClone(ADDITIONS.markets.find((m) => m.marketAddress === M2XHS)!);
const row3vw8 = (): MarketEntry => structuredClone(ADDITIONS.markets.find((m) => m.marketAddress === M3VW8)!);
const SINGLE: MarketEntry = {
  label: "SOL/USDC — meteora-dlmm",
  marketAddress: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5",
  poolAddress: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  dexType: "meteora-dlmm",
  assetIndex: 0,
  symbol: "SOL",
  lpPortfolio: "59N7KL3PPm5jxLqQ4WacLcsae1g5QPq31SZKDLWpxv78",
};

afterEach(() => resetMultiAssetState());

// ── registry rows -> price units ───────────────────────────────────────────────────────────────────────────────────
describe("K-6 registry: price units", () => {
  it("a single-asset row is ONE unit keyed by the market address, with the row's own fields (pre-K-6 state keys)", () => {
    const u = priceUnitsOf(SINGLE);
    assert.equal(u.length, 1);
    assert.deepEqual(u[0], {
      key: SINGLE.marketAddress,
      marketAddress: SINGLE.marketAddress,
      assetIndex: 0,
      label: SINGLE.label,
      multi: false,
      source: "pool",
      poolAddress: SINGLE.poolAddress,
      dexType: "meteora-dlmm",
      symbol: "SOL",
    });
  });

  it("2xhs: one pool unit per asset 0..4 with the fixtures-ledger mapping (SOL, LINK, cbBTC, SOL, LINK)", () => {
    const u = priceUnitsOf(row2xhs());
    assert.deepEqual(u.map((x) => x.key), [0, 1, 2, 3, 4].map((i) => `${M2XHS}#${i}`));
    assert.ok(u.every((x) => x.multi && x.source === "pool" && x.dexType === "meteora-dlmm"));
    assert.deepEqual(u.map((x) => x.poolAddress.slice(0, 4)), ["5rCf", "6BA6", "7ubS", "5rCf", "6BA6"]);
    // assets 0 and 3 are the SOL/USD reference the reader needs for the WSOL-quoted LINK pool
    assert.deepEqual(u.filter((x) => x.symbol === "SOL/USDC").map((x) => x.assetIndex), [0, 3]);
  });

  it("3vW8: five fixed units at 100.000000, no pool to read", () => {
    const u = priceUnitsOf(row3vw8());
    assert.equal(u.length, 5);
    for (const x of u) {
      assert.equal(x.source, "fixed");
      assert.equal(x.fixedPriceE6, 100_000_000n);
      assert.equal(fixedPushFor(x), 100_000_000n);
      assert.ok(x.poolAddress.startsWith("fixed:"));
    }
  });

  it("the prepared additions file validates clean; malformed rows are refused, never guessed", () => {
    for (const m of ADDITIONS.markets) assert.deepEqual(validateMultiAssetEntry(m), [], m.label);
    assert.deepEqual(validateMultiAssetEntry(SINGLE), []);
    const bad = (assets: unknown[]) => validateMultiAssetEntry({ ...row2xhs(), assets: assets as MarketEntry["assets"] });
    assert.equal(bad([]).length, 1);
    assert.match(bad([{ assetIndex: 0, source: "pool", poolAddress: "x", dexType: "meteora-dlmm" }])[0], /base58 poolAddress/);
    assert.match(bad([{ assetIndex: 0, source: "pool", poolAddress: SINGLE.poolAddress, dexType: "orca" }])[0], /unknown dexType/);
    assert.match(bad([{ assetIndex: 0, source: "fixed", fixedPriceE6: "0" }])[0], /positive integer/);
    assert.match(bad([{ assetIndex: 0, source: "oracle" }])[0], /unknown source/);
    assert.match(bad([{ assetIndex: 16, source: "fixed", fixedPriceE6: 1 }])[0], /assetIndex/);
    assert.ok(bad([{ assetIndex: 1, source: "fixed", fixedPriceE6: 1 }, { assetIndex: 1, source: "fixed", fixedPriceE6: 2 }]).some((p) => /twice/.test(p)));
    // an invalid asset is skipped by the units (and the boot validator refuses the registry)
    const units = priceUnitsOf({ ...row3vw8(), assets: [{ assetIndex: 0, source: "fixed", fixedPriceE6: "1" }, { assetIndex: 1, source: "fixed", fixedPriceE6: "-5" }] });
    assert.deepEqual(units.map((x) => x.assetIndex), [0]);
  });

  it("parseFixedPriceE6", () => {
    assert.equal(parseFixedPriceE6("100000000"), 100_000_000n);
    assert.equal(parseFixedPriceE6(42), 42n);
    for (const v of ["", "1.5", "-1", "0", 0, 1.5, null, undefined, "abc"]) assert.equal(parseFixedPriceE6(v), null, String(v));
  });

  it("units of a mixed registry keep registry order (11 single-asset rows + 2 multi-asset rows = 21 units)", () => {
    const singles = Array.from({ length: 11 }, (_, i) => ({ ...SINGLE, marketAddress: Keypair.generate().publicKey.toBase58(), label: `s${i}` }));
    const u = priceUnitsOfRegistry([...singles, row2xhs(), row3vw8()]);
    assert.equal(u.length, 21);
    assert.deepEqual(u.slice(0, 11).map((x) => x.key), singles.map((s) => s.marketAddress));
  });
});

// ── observation hints and crank ordering ─────────────────────────────────────────────────────────────────────────
describe("K-6 cranks: observation hints, ordering, CU", () => {
  const owner = Keypair.generate().publicKey;
  const lp = new PublicKey(LP);

  it("unbound / single-asset market: the crank is byte-identical to the pre-K-6 hint {asset 0}", () => {
    const old = encodePermissionlessCrank({ nowSlot: 0n, observations: [{ assetIndex: 0, oracleAccounts: 0 }] });
    assert.deepEqual(observationAssetsFor(SINGLE.marketAddress), [0]);
    assert.deepEqual([...buildObservationCrankIx(owner, new PublicKey(SINGLE.marketAddress), lp).data], [...old]);
    bindObservationRegistry(() => [SINGLE, row2xhs()]);
    assert.equal(observationAssetsFor(SINGLE.marketAddress), SINGLE_ASSET_OBSERVATION);
    assert.equal(isMultiAssetMarket(SINGLE.marketAddress), false);
    assert.deepEqual([...buildObservationCrankIx(owner, new PublicKey(SINGLE.marketAddress), lp).data], [...old]);
  });

  it("multi-asset market: every observation crank carries one hint per asset, ascending (25 B: tag, now_slot, n=5, 5 x 3 B)", () => {
    bindObservationRegistry(() => [SINGLE, row2xhs()]);
    assert.deepEqual(observationAssetsFor(M2XHS), [0, 1, 2, 3, 4]);
    const ix = buildObservationCrankIx(owner, new PublicKey(M2XHS), lp);
    const want = encodePermissionlessCrank({ nowSlot: 0n, observations: [0, 1, 2, 3, 4].map((assetIndex) => ({ assetIndex, oracleAccounts: 0 })) });
    assert.deepEqual([...ix.data], [...want]);
    assert.equal(ix.data.length, 25);
    assert.equal(ix.data[0], CRANK_TAG);
    assert.equal(ix.data[9], 5);
    // a refresh (no-observation) crank stays observation-free on every market
    assert.deepEqual([...buildRefreshCrankIx(owner, new PublicKey(M2XHS), lp).data], [...encodePermissionlessCrank({ nowSlot: 0n, observations: [] })]);
  });

  it("the hot-reloaded registry is read live: a row gaining `assets` switches its hints without a restart", () => {
    const markets: MarketEntry[] = [{ ...SINGLE, marketAddress: M3VW8 }];
    bindObservationRegistry(() => markets);
    assert.deepEqual(observationAssetsFor(M3VW8), [0]);
    markets[0] = row3vw8();
    assert.deepEqual(observationAssetsFor(M3VW8), [0, 1, 2, 3, 4]);
  });

  it("assets are hinted in ascending order whatever the registry order; a Hybrid oracle tail rides on the first hint only", () => {
    const r = row3vw8();
    r.assets = [...r.assets!].reverse();
    bindObservationRegistry(() => [r]);
    assert.deepEqual(observationAssetsFor(M3VW8), [0, 1, 2, 3, 4]);
    assert.deepEqual(observationHints([0, 2], 2), [{ assetIndex: 0, oracleAccounts: 2 }, { assetIndex: 2, oracleAccounts: 0 }]);
  });

  it("single-asset planCrankTx is unchanged: [catch-up x n, accrue(LP), refresh non-LP first, LP last] at the old CU", () => {
    bindObservationRegistry(() => [SINGLE]);
    const market = new PublicKey(SINGLE.marketAddress);
    const t = { pubkey: Keypair.generate().publicKey, longLegs: 1, shortLegs: 0, isLp: false };
    const l = { pubkey: lp, longLegs: 0, shortLegs: 1, isLp: true };
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 3, refreshTargets: [l, t] });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["catchup", "catchup", "catchup", "accrue", "refresh", "refresh"]);
    assert.deepEqual(plan.cranks.slice(4).map((c) => c.portfolio.toBase58()), [t.pubkey.toBase58(), LP]);
    assert.equal(plan.computeUnits, 3 * CATCHUP_CRANK_CU + ACCRUE_CRANK_CU + 2 * 145_000 + ACCRUAL_TX_CU_HEADROOM);
    for (const c of plan.cranks.filter((c) => c.kind !== "refresh")) assert.equal(c.ix.data[9], 1); // one hint
  });

  it("multi-asset planCrankTx: same order, 5 hints per observation crank, CU grows per hint", () => {
    bindObservationRegistry(() => [row2xhs()]);
    const market = new PublicKey(M2XHS);
    const t = { pubkey: Keypair.generate().publicKey, longLegs: 1, shortLegs: 0, isLp: false };
    const plan = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 2, refreshTargets: [t] });
    assert.deepEqual(plan.cranks.map((c) => c.kind), ["catchup", "catchup", "accrue", "refresh"]);
    for (const c of plan.cranks.slice(0, 3)) assert.equal(c.ix.data[9], 5);
    assert.equal(plan.cranks[3].ix.data[9], 0);
    const catchupCu = catchupCrankCuFor(CATCHUP_CRANK_CU, 5);
    assert.equal(plan.computeUnits, 2 * catchupCu + (ACCRUE_CRANK_CU + 4 * 40_000) + 145_000 + ACCRUAL_TX_CU_HEADROOM);
  });

  it("multi-asset catch-up never overflows the transaction: capped by CU, catch-up only when the accrual would not fit", () => {
    bindObservationRegistry(() => [row2xhs()]);
    const market = new PublicKey(M2XHS);
    const cap = maxCatchupCranksFor(MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, 5, MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM);
    assert.equal(cap, Math.floor((MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM) / catchupCrankCuFor(CATCHUP_CRANK_CU, 5)));
    assert.ok(cap >= 11, "3vW8 needed 11 at 5,727 slots behind; one tx carried them (640,807 CU simulated)");
    const far = planCrankTx({ owner, market, lpPortfolio: lp, catchup: MAX_CATCHUP_CRANKS, refreshTargets: [] });
    assert.equal(far.cranks.length, cap);
    assert.ok(far.cranks.every((c) => c.kind === "catchup"));
    assert.ok(far.computeUnits <= MAX_TX_CU);
    // a heavy (4-leg) LP: its accrual settle does not fit beside 3 catch-ups -> catch-up only this cycle
    const heavyLp: PositionedPortfolio = { pubkey: lp, longLegs: 0, shortLegs: 4, isLp: true, activeLegs: 4 };
    const p = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 3, refreshTargets: [heavyLp], cost: V22_LEG_COST, lp: heavyLp });
    assert.deepEqual(p.cranks.map((c) => c.kind), ["catchup", "catchup", "catchup"]);
    // the same with the single-asset hint keeps the pre-K-6 plan (catch-up + accrue)
    bindObservationRegistry(() => [SINGLE]);
    const s = planCrankTx({ owner, market, lpPortfolio: lp, catchup: 3, refreshTargets: [heavyLp], cost: V22_LEG_COST, lp: heavyLp });
    assert.deepEqual(s.cranks.map((c) => c.kind), ["catchup", "catchup", "catchup", "accrue"]);
  });

  it("CU helpers: one hint costs exactly the single-asset figure", () => {
    assert.equal(catchupCrankCuFor(CATCHUP_CRANK_CU, 1), CATCHUP_CRANK_CU);
    // v22price 2026-10-22: one hint is CU-capped too (it used to ignore the budget and return 40 = 1.454M at v2.2 cost)
    assert.equal(maxCatchupCranksFor(MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, 1, MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM), 34);
    assert.equal(maxCatchupCranksFor(MAX_CATCHUP_CRANKS, CATCHUP_CRANK_CU, 1, 1), 1);
  });
});

// ── refresh state and refresh selection over every asset ─────────────────────────────────────────────────────────
describe("K-6 refresh: state and selection over every asset (real 2xhs bytes)", () => {
  const market = fx("k6-2xhs-market-v22");
  const portfolios = [
    { pubkey: new PublicKey(LP), data: fx("k6-2xhs-lp-6w14eZR3-v22") },
    { pubkey: new PublicKey(TAKER), data: fx("k6-2xhs-taker-GV86syBh-v22") },
    { pubkey: new PublicKey(FLAT), data: fx("k6-2xhs-flat-JB5PkWDs-v22") },
  ];

  it("the fixture is the live 2xhs: v2.2-b, 5 Active assets, LP and taker hold 4 legs each on assets 0-3", () => {
    const det = detectLayout(market);
    assert.ok(det.known && det.layout.id === "v2.2-b" && det.slots === 5);
    for (let i = 0; i < 5; i++) assert.equal(decodeMarketRefreshState(market, i).lifecycle, 2);
    assert.deepEqual(parsePortfolioV17(portfolios[0].data).legs.filter((l) => l.active).map((l) => `${l.assetIndex}${l.side}`).sort(), ["01", "11", "21", "31"]);
    assert.deepEqual(parsePortfolioV17(portfolios[1].data).legs.filter((l) => l.active).map((l) => `${l.assetIndex}${l.side}`).sort(), ["00", "10", "20", "30"]);
  });

  it("[0] is exactly decodeMarketRefreshState (single-asset behaviour)", () => {
    assert.deepEqual(decodeMarketRefreshStateFor(market, [0]), decodeMarketRefreshState(market));
  });

  it("over 0..4: stored counts summed (4L/4S), oldest Active slot_last, loss-stale iff some asset is", () => {
    const all = decodeMarketRefreshStateFor(market, [0, 1, 2, 3, 4]);
    assert.equal(all.storedPosLong, 4n);
    assert.equal(all.storedPosShort, 4n);
    const per = [0, 1, 2, 3, 4].map((i) => decodeMarketRefreshState(market, i));
    assert.equal(all.slotLast, per.reduce((m, s) => (s.slotLast < m ? s.slotLast : m), per[0].slotLast));
    assert.equal(isAssetLossStale(all), per.some((s) => isAssetLossStale(s)));
    // an asset 2,000 slots behind drives the catch-up count of the whole market
    const lagged = new Uint8Array(market);
    const det = detectLayout(lagged);
    assert.ok(det.known);
    const off = engineSlotBase(det.layout, 3) + det.layout.asset.slotLast;
    new DataView(lagged.buffer).setBigUint64(off, per[3].slotLast - 2_000n, true);
    const st = decodeMarketRefreshStateFor(lagged, [0, 1, 2, 3, 4]);
    assert.equal(st.slotLast, per[3].slotLast - 2_000n);
    assert.equal(catchupCrankCount(per[0].slotLast - st.slotLast, st.maxAccrualDtSlots), 4);
    assert.equal(decodeMarketRefreshState(lagged).slotLast, per[0].slotLast, "asset 0 alone never saw the lag (the K-6 bug)");
  });

  it("selection: a leg on ANY observed asset positions a portfolio; counts match the summed market state", () => {
    const multi = selectPositionedPortfolios(portfolios, [0, 1, 2, 3, 4]);
    assert.deepEqual(multi.map((p) => p.pubkey.toBase58()).sort(), [LP, TAKER].sort());
    assert.ok(positionedSetMatchesMarket(multi, decodeMarketRefreshStateFor(market, [0, 1, 2, 3, 4])));
    // legs on assets 1..3 alone (asset 0 excluded) still position both: not just asset 0
    const noZero = selectPositionedPortfolios(portfolios, [1, 2, 3]);
    assert.deepEqual(noZero.map((p) => [p.pubkey.toBase58(), p.longLegs + p.shortLegs]).sort(), [[LP, 3], [TAKER, 3]].sort());
    assert.deepEqual(selectPositionedPortfolios(portfolios, [4]), []);
    // the pre-K-6 asset-0 set does NOT account for the market's other legs
    assert.equal(positionedSetMatchesMarket(selectPositionedPortfolios(portfolios), decodeMarketRefreshStateFor(market, [0, 1, 2, 3, 4])), false);
    assert.deepEqual(selectPositionedPortfolios(portfolios, 0), selectPositionedPortfolios(portfolios));
  });

  it("v2.2 sweep set (analysePortfolios): LP + taker counterparty over every asset; the flat portfolio is not positioned", () => {
    const r = analysePortfolios(portfolios, { assetIndices: [0, 1, 2, 3, 4], lpPortfolio: new PublicKey(LP), portfolioLen: 10_603 });
    assert.equal(r.lp?.pubkey.toBase58(), LP);
    assert.equal(r.lp?.shortLegs, 4);
    assert.deepEqual(r.counterparties.map((c) => [c.pubkey.toBase58(), c.longLegs]), [[TAKER, 4]]);
    const only4 = analysePortfolios(portfolios, { assetIndices: [4], lpPortfolio: new PublicKey(LP), portfolioLen: 10_603 });
    assert.deepEqual(only4.counterparties, []);
  });
});

// ── per-asset push batching, with the real 2xhs bytes ────────────────────────────────────────────────────────────
type Sent = { tx: Transaction; bytes: number };
function fakeConn(accounts: Map<string, Uint8Array>, opts: { simErr?: (tx: Transaction) => unknown } = {}) {
  const sent: Sent[] = [];
  const simulated: Transaction[] = [];
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        const d = accounts.get(k.toBase58());
        return d ? { data: Buffer.from(d), owner: PublicKey.default, lamports: 1, executable: false } : null;
      });
    },
    async simulateTransaction(tx: Transaction) {
      simulated.push(tx);
      return { context: { slot: 1 }, value: { err: opts.simErr ? opts.simErr(tx) : null, logs: [] } };
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      sent.push({ tx: Transaction.from(Buffer.from(raw)), bytes: raw.length });
      return `sig${sent.length}`;
    },
    async getSignatureStatuses() {
      return { value: [] };
    },
  };
  return { conn: conn as never, sent, simulated };
}
const u64At = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

describe("K-6 push: every asset of the real 2xhs account is pushed", () => {
  let keeper: Keypair;
  beforeEach(() => {
    keeper = Keypair.generate();
  });

  it("5 assets -> ONE tx of 5 x 35 B PushAuthMark (tag 63), asset 0..4, live market_id, nonce = stored + 1", async () => {
    const market = fx("k6-2xhs-market-v22");
    const { conn, sent } = fakeConn(new Map([[M2XHS, market]]));
    const units = priceUnitsOf(row2xhs());
    const prices = [105_742_257n, 12_492_640n, 82_341_258_879n, 105_742_257n, 12_492_640n];
    const pushes = units.map((u, i) => ({ marketAddress: u.marketAddress, assetIndex: u.assetIndex, multi: u.multi, priceE6: prices[i], depth: null }));
    const res = await pushAuthMarkBatch(conn, keeper, pushes, FIXTURE_SLOT, BLOCKHASH, false);
    assert.deepEqual(res.pushedKeys, [0, 1, 2, 3, 4].map((i) => `${M2XHS}:${i}`));
    assert.deepEqual(res.skippedMarkets, []);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].bytes <= 1232);
    const ixs = sent[0].tx.instructions.filter((ix) => ix.data[0] === PUSH_TAG);
    assert.equal(ixs.length, 5);
    const det = detectLayout(market);
    assert.ok(det.known);
    ixs.forEach((ix, i) => {
      assert.equal(ix.data.length, 35, "35 B form (no depth)");
      assert.equal(ix.keys[1].pubkey.toBase58(), M2XHS);
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      assert.equal(dv.getUint16(1, true), i, "asset_index");
      assert.equal(dv.getBigUint64(3, true), u64At(market, engineSlotBase(det.layout, i)), "market_id of THIS asset");
      assert.equal(dv.getBigUint64(19, true), prices[i], "mark_e6");
      assert.ok(dv.getBigUint64(27, true) > 0n, "observation_sequence");
    });
    // per-asset nonce lanes are independent (each = its own stored watermark + 1)
    const seqs = ixs.map((ix) => new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(27, true));
    const { parseAssetControlSequencesV17 } = await import("@percolatorct/sdk");
    seqs.forEach((s, i) => assert.equal(s, parseAssetControlSequencesV17(market, assetSlotsOff(det.layout) + i * det.layout.slotStride).oracleObservation + 1n));
  });

  it("the keeper-loop records each asset on its own stat (landed = its own generation key)", () => {
    const units = priceUnitsOf(row2xhs());
    const stats = new Map(units.map((u) => [u.key, newMarketStat(u)]));
    const state = { stats, landedThisCycle: new Set<string>() };
    const res = { pushedKeys: [`${M2XHS}:0`, `${M2XHS}:1`, `${M2XHS}:2`, `${M2XHS}:4`], signature: "sig" };
    const out = units.map((u) => recordMultiAssetPushOutcome(state, { key: u.key, marketAddress: u.marketAddress, assetIndex: u.assetIndex }, res, { dryRun: false, stamp: 1 }));
    assert.deepEqual(out, ["landed", "landed", "landed", "dropped", "landed"]);
    assert.deepEqual([...state.landedThisCycle].sort(), [0, 1, 2, 4].map((i) => `${M2XHS}#${i}`).sort());
    assert.equal(stats.get(`${M2XHS}#3`)!.totalErrors, 1);
    // landedPushes / ticks: per asset for multi, per market for single (unchanged)
    const pushes = [
      { marketAddress: M2XHS, assetIndex: 3, multi: true, priceE6: 1n },
      { marketAddress: M2XHS, assetIndex: 4, multi: true, priceE6: 1n },
      { marketAddress: SINGLE.marketAddress, assetIndex: 0, priceE6: 1n },
    ];
    const landed = landedPushes(pushes, { pushedMarkets: [M2XHS, SINGLE.marketAddress], pushedKeys: [`${M2XHS}:4`, `${SINGLE.marketAddress}:0`], signature: "s" });
    assert.deepEqual(landed.map((p) => `${p.marketAddress.slice(0, 4)}:${p.assetIndex}`), ["2xhs:4", "BYFu:0"]);
  });

  it("2xhs + 3vW8 + 11 single-asset markets: size-chunked under 1,232 B, every one of the 21 pushes goes out", async () => {
    const m2 = fx("k6-2xhs-market-v22");
    const accounts = new Map<string, Uint8Array>([[M2XHS, m2], [M3VW8, m2]]);
    const singles = Array.from({ length: 11 }, () => Keypair.generate().publicKey.toBase58());
    for (const s of singles) accounts.set(s, m2); // a Live v2.2 account: asset 0 is pushable
    const { conn, sent } = fakeConn(accounts);
    const units = priceUnitsOfRegistry([...singles.map((s, i) => ({ ...SINGLE, marketAddress: s, label: `s${i}` })), row2xhs(), row3vw8()]);
    const pushes = units.map((u) => ({ marketAddress: u.marketAddress, assetIndex: u.assetIndex, multi: u.multi, priceE6: u.fixedPriceE6 ?? 1_000_000n, depth: null }));
    const res = await pushAuthMarkBatch(conn, keeper, pushes, FIXTURE_SLOT, BLOCKHASH, false);
    assert.equal(res.pushedKeys!.length, 21);
    assert.ok(sent.length >= 2, `chunked (${sent.length} txs)`);
    for (const s of sent) assert.ok(s.bytes <= 1232 - 32, `${s.bytes} B`);
    const pushed = sent.flatMap((s) => s.tx.instructions.filter((ix) => ix.data[0] === PUSH_TAG).map((ix) => `${ix.keys[1].pubkey.toBase58()}:${ix.data[1]}`));
    for (const m of [M2XHS, M3VW8]) for (let i = 0; i < 5; i++) assert.ok(pushed.includes(`${m}:${i}`), `${m.slice(0, 4)} asset ${i}`);
  });

  it("an asset that is not Active/DrainOnly is skipped (not struck, never quarantines its market); the others push", async () => {
    const market = new Uint8Array(fx("k6-2xhs-market-v22"));
    const det = detectLayout(market);
    assert.ok(det.known);
    market[engineSlotBase(det.layout, 3) + det.layout.asset.lifecycle] = 1;
    const { conn, sent } = fakeConn(new Map([[M2XHS, market]]));
    const pushes = priceUnitsOf(row2xhs()).map((u) => ({ marketAddress: u.marketAddress, assetIndex: u.assetIndex, multi: u.multi, priceE6: 1_000_000n, depth: null }));
    for (let cycle = 0; cycle < 4; cycle++) {
      const res = await pushAuthMarkBatch(conn, keeper, pushes, FIXTURE_SLOT, BLOCKHASH, false);
      assert.deepEqual(res.inactiveKeys, [`${M2XHS}:3`]);
      assert.deepEqual(res.pushedKeys, [0, 1, 2, 4].map((i) => `${M2XHS}:${i}`));
    }
    assert.equal(getQuarantinedMarkets().includes(M2XHS), false);
    assert.ok(sent.every((s) => s.tx.instructions.filter((ix) => ix.data[0] === PUSH_TAG).every((ix) => ix.data[1] !== 3)));
    // a single-asset push is NOT gated (byte-identical behaviour): it goes to the program, which decides
    const single = await pushAuthMarkBatch(conn, keeper, [{ marketAddress: M2XHS, assetIndex: 3, priceE6: 1n, depth: null }], FIXTURE_SLOT, BLOCKHASH, false);
    assert.deepEqual(single.inactiveKeys, []);
    assert.deepEqual(single.pushedKeys, [`${M2XHS}:3`]);
  });
});

// ── health ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("K-6 health: per-asset staleness, one stale asset degrades the market", () => {
  const thresholds = DEFAULT_THRESHOLDS;
  const statsFor = () => priceUnitsOf(row2xhs()).map((u) => {
    const s = newMarketStat(u);
    s.lastPushAt = Date.now();
    s.totalPushes = 10;
    return s;
  });

  it("all assets fresh -> ok", () => {
    const h = multiAssetMarketHealth(M2XHS, "2xhs", statsFor(), { terminal: false, thresholds, nowMs: Date.now(), accrualLagWarnSlots: 300 });
    assert.equal(h.row.status, "ok");
    assert.deepEqual(h.row.staleAssets, []);
    assert.equal((h.row.assets as unknown[]).length, 5);
  });

  it("one asset without pushes -> the market is no-push, the asset is named", () => {
    const stats = statsFor();
    stats[3].noPushCycles = thresholds.marketNoPushCycles;
    const h = multiAssetMarketHealth(M2XHS, "2xhs", stats, { terminal: false, thresholds, nowMs: Date.now(), accrualLagWarnSlots: 300 });
    assert.equal(h.row.status, "no-push");
    assert.deepEqual(h.row.staleAssets, [3]);
    assert.deepEqual(h.noPush, [stats[3].label]);
  });

  it("one asset whose accrual lags (cranker read, real bytes) -> accrual-lagging; terminal markets are never flagged", () => {
    bindObservationRegistry(() => [row2xhs()]);
    const market = new Uint8Array(fx("k6-2xhs-market-v22"));
    const det = detectLayout(market);
    assert.ok(det.known);
    const s1 = decodeMarketRefreshState(market, 1).slotLast;
    new DataView(market.buffer).setBigUint64(engineSlotBase(det.layout, 1) + det.layout.asset.slotLast, s1 - 1_000n, true);
    recordMarketAccrual(M2XHS, market, s1 + 10n, Date.now());
    assert.deepEqual(laggingAssets(getMarketAccrual(M2XHS), 300), [1]);
    const h = multiAssetMarketHealth(M2XHS, "2xhs", statsFor(), { terminal: false, thresholds, nowMs: Date.now(), accrualLagWarnSlots: 300 });
    assert.equal(h.row.status, "accrual-lagging");
    assert.deepEqual(h.row.staleAssets, [1]);
    assert.equal(h.accrualLagging.length, 1);
    const t = multiAssetMarketHealth(M2XHS, "2xhs", statsFor(), { terminal: true, thresholds, nowMs: Date.now(), accrualLagWarnSlots: 300 });
    assert.equal(t.row.status, "ok");
    // single-asset markets are never sampled
    recordMarketAccrual(SINGLE.marketAddress, market, s1, Date.now());
    assert.equal(getMarketAccrual(SINGLE.marketAddress), undefined);
    assert.deepEqual(sampleAssetAccrual(market, [1], s1 + 10n, 0).assets[0].lagSlots, 1_010);
  });

  it("/health: one stale asset -> keeper status degraded-markets, ONE row for the market with its assets", () => {
    const stats = new Map(statsFor().map((s) => [s.key, s]));
    stats.get(`${M2XHS}#2`)!.noPushCycles = thresholds.marketNoPushCycles + 1;
    const state = {
      startedAt: Date.now(),
      lastCycleAt: null,
      cycleCount: 3,
      timeoutCount: 0,
      stats,
      lastSuccessfulPushAt: Date.now(),
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
    const handler = makeHealthHandler(state as never, { intervalMs: 1500, healthPort: 0, healthBind: "127.0.0.1", dryRun: false, minKeeperBalanceLamports: 1, balanceCheckIntervalMs: 1 } as never, { markets: [row2xhs()] } as never);
    handler({ url: "/health" } as never, { writeHead() {}, end(b: string) { body = b; } } as never);
    const p = JSON.parse(body) as { status: string; noPushMarkets: string[]; markets: Record<string, { status: string; staleAssets: number[]; assets: Array<{ assetIndex: number; status: string }> }>; accrualLaggingAssets: string[] };
    assert.equal(p.status, "degraded-markets");
    assert.deepEqual(Object.keys(p.markets), [M2XHS]);
    assert.equal(p.markets[M2XHS].status, "no-push");
    assert.deepEqual(p.markets[M2XHS].staleAssets, [2]);
    assert.deepEqual(p.markets[M2XHS].assets.map((a) => a.status), ["ok", "ok", "no-push", "ok", "ok"]);
    assert.equal(p.noPushMarkets.length, 1);
    assert.deepEqual(p.accrualLaggingAssets, []);
  });
});

// ── v2.2 sweep delegate: bounded multi-asset catch-up before the round ───────────────────────────────────────────
describe("K-6 v2.2 delegate: a multi-asset market a window or more behind gets catch-up cranks, never a doomed round", () => {
  const READ_SLOT = 5_000n; // fakeLoopConn's context slot
  function laggedMarket(gap: bigint): Uint8Array {
    const m = new Uint8Array(fx("k6-2xhs-market-v22"));
    const det = detectLayout(m);
    assert.ok(det.known);
    const dv = new DataView(m.buffer);
    for (let i = 0; i < 5; i++) dv.setBigUint64(engineSlotBase(det.layout, i) + det.layout.asset.slotLast, READ_SLOT - gap, true);
    return m;
  }
  const portfolios = () => [
    { pubkey: new PublicKey(LP), data: fx("k6-2xhs-lp-6w14eZR3-v22") },
    { pubkey: new PublicKey(TAKER), data: fx("k6-2xhs-taker-GV86syBh-v22") },
  ];
  async function delegate(row: MarketEntry, gap: bigint) {
    const { V22Loop } = await import("./v22/loop.ts");
    const { v22FlagsFromEnv } = await import("./v22/flags.ts");
    const { fakeLoopConn } = await import("./v22/test-helpers.ts");
    const { WRAPPER_PROGRAM_ID } = await import("../program-ids.ts");
    bindObservationRegistry(() => [row]);
    const f = fakeLoopConn({ market: laggedMarket(gap), portfolios: portfolios() });
    const logs: string[] = [];
    const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [row], flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on" }), dryRun: false, log: (s) => logs.push(s) });
    const handled = await loop.sweepDelegate({ conn: f.conn as never, keeper: Keypair.generate(), entry: row, marketData: new Uint8Array(), slot: Number(READ_SLOT), dryRun: false } as never);
    return { handled, sims: f.sims, sent: f.sent, logs };
  }

  it("2,600 slots behind: ONE tx of 5 catch-up cranks on the LP (simulated, then sent), no settle round this cycle", async () => {
    const r = await delegate(row2xhs(), 2_600n);
    assert.equal(r.handled, true, "handled: the legacy cranker must not run (it would flag a v2.2-b layout problem)");
    assert.equal(r.sims.length, 1);
    assert.deepEqual(r.sims[0].tags, [CRANK_TAG, CRANK_TAG, CRANK_TAG, CRANK_TAG, CRANK_TAG]);
    assert.ok(r.sims[0].keys.every((k) => k[2] === LP));
    assert.equal(r.sent.length, 1);
    assert.ok(r.logs.some((l) => /\[v22\]\[catchup\].*5 assets.*5 catch-up crank\(s\)/.test(l)), r.logs.join("\n"));
  });

  it("inside one window: no catch-up, the paired round is ONE atomic tx (counterparty observes all 5 assets, LP refreshed last)", async () => {
    const r = await delegate(row2xhs(), 120n);
    assert.equal(r.handled, true);
    assert.ok(!r.logs.some((l) => /\[v22\]\[catchup\]/.test(l)));
    assert.ok(r.sims.length >= 1, r.logs.join("\n"));
    assert.equal(r.sent.length, 1, "MERGED_ROUND: one transaction");
    assert.deepEqual(r.sent[0].tags, [CRANK_TAG, CRANK_TAG]);
    assert.equal(r.sent[0].keys[0][2], TAKER, "the counterparty's observation crank first");
    assert.equal(r.sent[0].keys[1][2], LP, "the LP settles last");
    // the sweep summary says what was SENT (one merged tx), not only what the phased plan would have been
    assert.ok(r.logs.some((l) => /\[v22\]\[sweep\].*PAIRED MERGED 1 tx \(phased plan was 2\)/.test(l)), r.logs.join("\n"));
  });

  it("a single-asset row on the same lagged account ALSO gets catch-up cranks (LIQ-DIAG 2026-10-17: otherwise every refresh is refused 22 and a bankrupt unrefreshed account cannot be liquidated)", async () => {
    const r = await delegate({ ...SINGLE, marketAddress: M2XHS, lpPortfolio: LP }, 2_600n);
    assert.ok(r.logs.some((l) => /\[v22\]\[catchup\].*1 assets.*catch-up crank\(s\)/.test(l)), r.logs.join("\n"));
    assert.ok(r.sent.every((s) => s.tags.every((t) => t === CRANK_TAG)), "catch-up cranks only, no refresh this cycle");
  });
});

describe("K-6 registry hot-reload", () => {
  it("a malformed multi-asset row on disk is refused; the in-memory registry is kept", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { reloadRegistryOnce } = await import("./registry-reload.ts");
    const dir = mkdtempSync(join(tmpdir(), "k6-reload-"));
    const path = join(dir, "registry.json");
    const registry = { version: 1, description: "t", markets: [SINGLE] };
    const bad = { ...row3vw8(), assets: [{ assetIndex: 0, source: "fixed", fixedPriceE6: "nope" }] };
    writeFileSync(path, JSON.stringify({ version: 1, description: "t", markets: [SINGLE, bad] }));
    assert.deepEqual(reloadRegistryOnce(registry as never, path), { added: 0, removed: 0, updated: 0 });
    assert.equal(registry.markets.length, 1);
    writeFileSync(path, JSON.stringify({ version: 1, description: "t", markets: [SINGLE, row3vw8()] }));
    assert.deepEqual(reloadRegistryOnce(registry as never, path), { added: 1, removed: 0, updated: 0 });
    assert.equal(registry.markets.length, 2);
  });
});

// ── R3.22b: the 2xhs flap (delegate backs off -> legacy layout alert, AlreadyProcessed counted as a revert) ──────────
describe("R3.22b: a v2.2 market the v2.2 layer owns never reaches the legacy layout check", () => {
  async function cycle(o: { delegate: boolean; simErrs: unknown[] }) {
    const { crankOneMarket, freshCrankMarketState } = await import("./recovery-cranker.ts");
    const { setSweepDelegate } = await import("./v22/delegation.ts");
    const { getLayoutProblemCounts, getCrankRefreshHealth } = await import("./refresh-coordination.ts");
    const { invalidateBlockhash } = await import("./blockhash-cache.ts");
    bindObservationRegistry(() => [row2xhs()]);
    const market = fx("k6-2xhs-market-v22");
    const slot = Number(decodeMarketRefreshState(market).currentSlot) + 30; // inside one window
    const sims: Array<{ hints: number[]; n: number }> = [];
    let sent = 0;
    let delegateCalls = 0;
    const conn = {
      async getLatestBlockhash() {
        return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
      },
      async simulateTransaction(tx: { message: { compiledInstructions: Array<{ data: Uint8Array }> } }) {
        const cranks = tx.message.compiledInstructions.filter((i) => i.data[0] === CRANK_TAG);
        sims.push({ n: cranks.length, hints: cranks.map((i) => i.data[9]) });
        const err = o.simErrs.length > 0 ? o.simErrs.shift() : null;
        return { context: { slot }, value: { err, logs: [], accounts: [] } };
      },
      async sendRawTransaction() {
        sent++;
        return `sig${sent}`;
      },
    };
    invalidateBlockhash(conn as never);
    setSweepDelegate(o.delegate ? async () => { delegateCalls++; return false; } : null); // false = the round backed off
    const state = freshCrankMarketState();
    const before = getLayoutProblemCounts();
    const prefetched = { value: { data: Buffer.from(market), owner: PublicKey.default, lamports: 1, executable: false }, context: { slot } };
    const entry = { marketAddress: M2XHS, label: "2xhs", lpPortfolio: LP };
    try {
      await crankOneMarket(conn as never, Keypair.generate(), entry, state, false, prefetched as never);
      const first = { totalReverts: state.totalReverts, sent };
      state.lastCrankSlot = null;
      await crankOneMarket(conn as never, Keypair.generate(), entry, state, false, { ...prefetched, context: { slot: slot + 1 } } as never);
      const after = getLayoutProblemCounts();
      return { state, first, sims, sent, delegateCalls, newLayoutProblems: after.unknown + after.unsupported - (before.unknown + before.unsupported), health: getCrankRefreshHealth(M2XHS) };
    } finally {
      setSweepDelegate(null);
    }
  }

  it("backed-off round + a duplicate (AlreadyProcessed) crank: no layout alert, no revert, accrual crank observes all 5 assets", async () => {
    const r = await cycle({ delegate: true, simErrs: ["AlreadyProcessed"] });
    assert.equal(r.delegateCalls, 2);
    assert.equal(r.newLayoutProblems, 0, "no variant-B-on-legacy verdict");
    assert.equal(r.state.lastLayoutProblem, null);
    assert.equal(r.first.totalReverts, 0, "AlreadyProcessed is a duplicate of a landed tx, not a revert");
    assert.equal(r.first.sent, 0);
    assert.equal(r.state.totalReverts, 0);
    assert.equal(r.state.consecutiveReverts, 0);
    assert.equal(r.sent, 1, "the second cycle's clean accrual crank is sent");
    // accrual only: observation cranks with 5 hints, never a no-observation (legacy refresh) crank
    for (const s of r.sims) for (const h of s.hints) assert.equal(h, 5);
    assert.ok(r.state.obs?.layout?.problem == null);
    assert.equal(r.health?.layout?.problem ?? null, null, "the legacy path publishes no crank-health record over the v2.2 layer's");
  });

  it("isDuplicateOfLandedTx: only the runtime's AlreadyProcessed", async () => {
    const { isDuplicateOfLandedTx } = await import("./recovery-cranker.ts");
    assert.equal(isDuplicateOfLandedTx("AlreadyProcessed"), true);
    assert.equal(isDuplicateOfLandedTx({ AlreadyProcessed: null }), true);
    for (const e of [null, "BlockhashNotFound", { InstructionError: [1, { Custom: 19 }] }, { InstructionError: [1, { Custom: 22 }] }]) assert.equal(isDuplicateOfLandedTx(e), false);
  });

  it("control: WITHOUT the v2.2 layer a variant-B market still gets the loud unsupported verdict (unchanged)", async () => {
    const r = await cycle({ delegate: false, simErrs: [] });
    assert.ok(r.newLayoutProblems > 0);
    assert.match(r.state.lastLayoutProblem ?? "", /variant-B/);
  });
});
