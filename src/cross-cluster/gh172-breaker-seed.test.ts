/**
 * GH#172 — the cross-cluster circuit breaker's cold-start baseline.
 *
 * `crossClusterCircuitBreakerStates` lives in memory, so after every restart every market's
 * `lastPrice` is 0 and `checkCircuitBreaker` takes its "First price — always accept" branch: the
 * first push of every market is bounded by nothing. Closed issue #33 was exactly that defect. Its
 * fix was a secondary-source cross-check inside `pushAndCrank`; that function left the tree in the
 * cross-cluster rewrite and the cross-check went with it. What survives is a REPLICA of the
 * decision in `security-fixes.test.ts` (`firstPushCheck`, defined inside the test), which keeps
 * passing because it reimplements the logic rather than importing it — so the suite reports #33 as
 * covered while production has no corroboration at all.
 *
 * The fix seeds the baseline from the asset's last PUSHED mark on chain, which costs no extra RPC
 * (`recordPushDeadline` already receives the market bytes) and uses the value `mark-smoother.ts`
 * itself calls "stale but TRUSTED".
 *
 * These tests avoid the trap that makes a seeding test worthless: asserting only that an outlier is
 * rejected would pass for unrelated reasons. The second test therefore asserts BOTH arms — seeded
 * rejects, unseeded accepts — so the unseeded arm is a live demonstration of the defect and the
 * pair cannot both hold unless the seed is what changed the outcome.
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getOnChainMarkE6, recordOnChainMarks, resetOnChainMarks } from "./push-deadline.ts";
import { PROFILE_LOT_EXP_OFF } from "./auth-mark-pusher.ts";
import { assetSlotOffset, selectMarketGroupOffset } from "../wrapper-market-group-offset.ts";
import { checkCircuitBreaker, type CircuitBreakerState } from "../circuit-breaker.ts";
import {
  getCrossClusterCircuitBreakerState,
  resetCrossClusterCircuitBreakerStates,
} from "./keeper-loop.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A REAL deployed v2.2 market account, read from devnet
 * (`FRVP35ujCY5bX4k5e5BWwpsJsiGaBeLZ6K3VckJNemEz`, wrapper `6kpg2wi7…`, 4059 bytes).
 *
 * Chosen because its asset 0 is one of only three live markets where the pushed target and the
 * engine's walked mark DIFFER — 31.000000 vs 39.744000 per LOT — which is what makes the first test
 * discriminate the offset. A decode that read `effectivePrice` (offset 25) instead of
 * `raw_oracle_target_price` (offset 17) would return the walked value and fail.
 *
 * Its lot_exp is 5 (a lot is 100,000 tokens), so the on-chain 31.000000 is $0.00031 per token: the
 * unit the breaker is fed. The seed must be divided by 10^lot_exp, exactly as the pusher multiplied.
 */
function liveMarketBytes(): Uint8Array {
  const b64 = readFileSync(join(HERE, "__fixtures__", "gh172-market-v22-frvp.b64"), "utf8").trim();
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const MARKET = "FRVP35ujCY5bX4k5e5BWwpsJsiGaBeLZ6K3VckJNemEz";
const LOT_EXP = 5;
/** On chain: 31_000_000 per lot. Per token: / 10^5. */
const EXPECTED_PUSHED_MARK_E6 = 310n;
const WALKED_MARK_E6 = 39_744_000n / 10n ** BigInt(LOT_EXP);
const TRUE_TOKEN_USD = 0.00031;

describe("GH#172 on-chain mark decode (real deployed account)", () => {
  beforeEach(() => resetOnChainMarks());

  it("decodes the asset's last PUSHED mark PER TOKEN, not the engine's walked mark", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const got = getOnChainMarkE6(MARKET, 0);
    assert.equal(got, EXPECTED_PUSHED_MARK_E6, "31_000_000 per lot / 10^5 = 310 per token");
    assert.notEqual(
      got,
      WALKED_MARK_E6,
      "reading effectivePrice (offset 25) instead of raw_oracle_target_price (offset 17)",
    );
  });

  it("leaves a unit unseeded when no market read has happened for it", () => {
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
    recordOnChainMarks(MARKET, liveMarketBytes());
    assert.equal(getOnChainMarkE6("SomeOtherMarket1111111111111111111111111111", 0), null);
    assert.equal(getOnChainMarkE6(MARKET, 3), null, "an asset slot this market does not have");
  });

  it("never throws on an account it cannot decode", () => {
    recordOnChainMarks(MARKET, new Uint8Array(8));
    recordOnChainMarks(MARKET, new Uint8Array(0));
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
  });
});

describe("GH#172 a seeded baseline bounds the first push; an unseeded one does not", () => {
  const CFG = { maxMovePct: 10, confirmTrips: 2, sustainedRelocationMs: 60_000 };

  function state(lastPrice: number): CircuitBreakerState {
    // Shape copied from keeper-loop.ts's fresh-state construction.
    return {
      symbol: "TEST",
      lastPrice,
      circuitBreakerTrips: 0,
      cbTripPrice: 0,
      cbConsecutiveTrips: 0,
    };
  }

  it("UNSEEDED (lastPrice 0) accepts a 10x outlier — this is the defect", () => {
    const s = state(0);
    const accepted = checkCircuitBreaker(s, 1_000, CFG);
    assert.equal(accepted, 1_000, "the breaker's first-price branch accepts anything");
  });

  it("SEEDED from the on-chain mark refuses the same outlier", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const seedE6 = getOnChainMarkE6(MARKET, 0);
    assert.notEqual(seedE6, null);
    const seedUsd = Number(seedE6) / 1_000_000;
    assert.equal(seedUsd, TRUE_TOKEN_USD, "the seed is in the breaker's unit: USD per TOKEN");
    const s = state(seedUsd);
    const accepted = checkCircuitBreaker(s, seedUsd * 10, CFG);
    assert.notEqual(
      accepted,
      seedUsd * 10,
      "a 10x move from the last published mark must not pass the breaker",
    );
  });

  it("SEEDED accepts the TRUE per-token price, so a restart with no price move pushes on cycle 1", () => {
    // The trap the first version of this file fell into: a seed in the wrong unit (per lot) also
    // "refuses the outlier" — it refuses everything, the real price included, until the K-3 snap
    // ~300 s later, and the band-edge relocations it publishes meanwhile are 10^lot_exp too high.
    recordOnChainMarks(MARKET, liveMarketBytes());
    const s = state(Number(getOnChainMarkE6(MARKET, 0)) / 1_000_000);
    assert.equal(checkCircuitBreaker(s, TRUE_TOKEN_USD, CFG), TRUE_TOKEN_USD);
  });

  it("SEEDED still passes a move inside the band, so the seed does not brick pushes", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const seedUsd = Number(getOnChainMarkE6(MARKET, 0)) / 1_000_000;
    const nudged = seedUsd * 1.01; // 1% — well inside maxMovePct 10
    const s = state(seedUsd);
    assert.equal(checkCircuitBreaker(s, nudged, CFG), nudged);
  });
});

describe("GH#172 the seeding WIRING, not just the decode", () => {
  beforeEach(() => {
    resetOnChainMarks();
    resetCrossClusterCircuitBreakerStates();
  });

  it("a fresh breaker state is seeded from the unit's on-chain mark", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const st = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    assert.equal(st.lastPrice, TRUE_TOKEN_USD, "raw_oracle_target_price 31.000000 per lot / 10^5 per token");
  });

  it("a fresh state is UNSEEDED when the market has not been read — behaviour is unchanged", () => {
    const st = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    assert.equal(st.lastPrice, 0, "deliberate fail-open: withholding would brick an unread market");
  });

  it("a fresh state is UNSEEDED when no seed argument is passed at all", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const st = getCrossClusterCircuitBreakerState(MARKET, "TEST");
    assert.equal(st.lastPrice, 0);
  });

  it("an existing state is never re-seeded (a live baseline is not overwritten)", () => {
    recordOnChainMarks(MARKET, liveMarketBytes());
    const first = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    first.lastPrice = 42; // as a landed push would leave it
    const again = getCrossClusterCircuitBreakerState(MARKET, "TEST", {
      marketAddress: MARKET,
      assetIndex: 0,
    });
    assert.equal(again.lastPrice, 42, "the seed must apply only on creation");
  });
});

/**
 * Regression for the per-lot seed (PR #173 review): every seeded unit must be the on-chain mark
 * divided by 10^lot_exp, and the TRUE per-token price must pass the seeded breaker unchanged.
 * Real devnet slabs from `v22-live-accounts-2026-10-17.json`; lot_exp 0 proves the division is a
 * no-op there (byte-identical to the undivided seed), 1/2/4 cover the live lot markets, and the
 * 5-slot market, with asset 1's byte mutated, proves the per-slot profile offset on a multi-asset account.
 */
describe("GH#172 the seed is PER TOKEN: on-chain mark / 10^lot_exp (real devnet slabs)", () => {
  const CFG = { maxMovePct: 10, confirmTrips: 3, sustainedRelocationMs: 300_000 };
  const live = JSON.parse(
    readFileSync(join(HERE, "__fixtures__", "v22-live-accounts-2026-10-17.json"), "utf8"),
  ) as { accounts: { symbol: string; market: string; nAssets: number; slab: string }[] };
  const slab = (symbol: string) => {
    const a = live.accounts.find((x) => x.symbol === symbol)!;
    return { market: a.market, data: new Uint8Array(Buffer.from(a.slab, "base64")), nAssets: a.nAssets };
  };

  beforeEach(() => {
    resetOnChainMarks();
    resetCrossClusterCircuitBreakerStates();
  });

  // symbol, lot_exp, raw_oracle_target_price on chain (per lot), expected seed (per token, e6)
  const CASES: [string, number, bigint, bigint][] = [
    ["SOL", 0, 104_815_992n, 104_815_992n],
    ["JUP-OLD-DO-NOT-USE", 1, 3_048_870n, 304_887n],
    ["ANSEM", 2, 11_431_388n, 114_313n],
    ["CHILLHOUSE", 4, 10_954_732n, 1_095n],
  ];
  for (const [symbol, lotExp, rawPerLot, tokenE6] of CASES) {
    it(`${symbol} lot_exp ${lotExp}: seeds ${rawPerLot} per lot as ${tokenE6} per token and accepts the true price`, () => {
      const { market, data } = slab(symbol);
      recordOnChainMarks(market, data);
      assert.equal(getOnChainMarkE6(market, 0), tokenE6);
      const st = getCrossClusterCircuitBreakerState(market, symbol, { marketAddress: market, assetIndex: 0 });
      const trueUsd = Number(tokenE6) / 1_000_000;
      assert.equal(st.lastPrice, trueUsd);
      assert.equal(checkCircuitBreaker(st, trueUsd, CFG), trueUsd, "the price the chain already holds must pass");
    });
  }

  it("a 5-slot market seeds every slot from its own profile (all lot_exp 0 on devnet today)", () => {
    const { market, data, nAssets } = slab("CAP4B-MA");
    assert.equal(nAssets, 5);
    recordOnChainMarks(market, data);
    for (let i = 0; i < nAssets; i++) {
      assert.notEqual(getOnChainMarkE6(market, i), null, `slot ${i} seeded`);
    }
    assert.equal(getOnChainMarkE6(market, 2), 81_619_978_335n, "slot 2 raw mark, lot_exp 0 = undivided");
  });

  /** The lot_exp byte of asset `i`, located the way the pusher locates it. */
  function lotExpByteOff(data: Uint8Array, i: number): number {
    const g = selectMarketGroupOffset(data);
    assert.ok(g.ok);
    return assetSlotOffset(g, i) + PROFILE_LOT_EXP_OFF;
  }

  it("multi-asset: lot_exp is per ASSET, one slot's lot_exp never scales another's seed", () => {
    // The real 5-slot market is lot_exp 0 everywhere; asset 1's byte is set to 3 so the slots differ.
    const { market, data } = slab("CAP4B-MA");
    recordOnChainMarks(market, data);
    const raw = [0, 1, 2].map((i) => getOnChainMarkE6(market, i)!);
    const mutated = slab("CAP4B-MA").data;
    assert.equal(mutated[lotExpByteOff(mutated, 1)], 0);
    mutated[lotExpByteOff(mutated, 1)] = 3;
    resetOnChainMarks();
    recordOnChainMarks(market, mutated);
    assert.equal(getOnChainMarkE6(market, 0), raw[0], "asset 0 (lot_exp 0) unchanged");
    assert.equal(getOnChainMarkE6(market, 1), raw[1] / 1000n, "asset 1 divided by 10^3");
    assert.equal(getOnChainMarkE6(market, 2), raw[2], "asset 2 (lot_exp 0) unchanged");
  });

  it("an unreadable lot_exp (byte above LOT_EXP_MAX) leaves the unit UNSEEDED, never seeded in the wrong unit", () => {
    const bytes = liveMarketBytes();
    bytes[lotExpByteOff(bytes, 0)] = 16;
    recordOnChainMarks(MARKET, bytes);
    assert.equal(getOnChainMarkE6(MARKET, 0), null);
    const st = getCrossClusterCircuitBreakerState(MARKET, "FRVP", { marketAddress: MARKET, assetIndex: 0 });
    assert.equal(st.lastPrice, 0, "fail-open, exactly like an unread market");
  });
});
