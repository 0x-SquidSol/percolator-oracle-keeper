/**
 * K-1..K-4 (v2.2 fresh devnet bring-up, 2026-10-10): the keeper against REAL VERSION-19 account bytes.
 *
 * Fixtures (`__fixtures__/v22-*.b64`) are public devnet accounts of the fresh v2.2 programs, read 2026-10-10 at slot
 * ~509,453,100: the SOL / JUP / CHILLHOUSE markets (wrapper 6kpg2wi7, 4,059 B, lot_exp 0 / 1 / 4), their vault_lp state
 * PDAs, their stake v5 pools (480 B) and SOL's vault-LP portfolio (10,603 B).
 *
 *   K-1  PushAuthMark carries price x 10^lot_exp, lot_exp read from the market account.
 *   K-2  VERSION 19 is decoded with ITS geometry (592 / 806 / 2,661 / 1,024), not the v2.1 group length.
 *   K-3  a registry entry without lpPortfolio still resolves the vault-LP portfolio on chain (vault_lp PDA, then a
 *        scan over every SDK portfolio length).
 *   K-4  terminal-insurance / stake-fee decode a v5 pool.
 *
 * Every positive test has a negative control next to it.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/v22-fresh-k1-k4.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  LAYOUTS_BY_VERSION,
  V17_MARKET_GROUP_LEN,
  decodeStakePool,
  lotExpOfMarketV22,
  parseAssetOracleProfileV17,
} from "@percolatorct/sdk";
import {
  MARKET_GEOMETRY_BY_VERSION,
  MARKET_GROUP_OFF_BY_VERSION,
  VERSION_19,
  assetSlotOffset,
  selectMarketGroupOffset,
} from "../wrapper-market-group-offset.ts";
import {
  fetchOracleAuthority,
  parsePushAuthMarkGenerationFields,
  perLotMarkE6,
  pushAuthMarkBatch,
  readMarketLotExp,
  resetPushLandingState,
  MAX_ORACLE_PRICE_E6,
} from "./auth-mark-pusher.ts";
import { decodeTerminalState, isLiveMarket, marketMode } from "./market-state.ts";
import { readFeeLegs } from "./fee-legs.ts";
import { findLpPortfolio } from "./recovery-cranker.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { decodeStakePoolAnyVersion, isStakePoolV5 } from "./stake-pool-decode.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { nonComputeBudget } from "./test-ix.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Uint8Array => new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));

const ORACLE_AUTHORITY = "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7";
const MARKETS = {
  sol: { addr: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5", lotExp: 0, lp: "59N7KL3PPm5jxLqQ4WacLcsae1g5QPq31SZKDLWpxv78", pool: "CcRu14fpgk14xUytK88Cg49ehGygZNbQG2LpXuc27kAJ" },
  jup: { addr: "ARSMzcMZzgZT2f4GJVbyJsLSuvyuTHvkbaS3fYeoMrvK", lotExp: 1, lp: "tWqU9aT7WY4uBFb7nY2zk9LenzsSgBbZuLbyf24Lb6o", pool: "3ZaeDDWx86PgeNBUWXPNkRNbVdcKjXZNSPyfAxiXTE8F" },
  chillhouse: { addr: "ALdzXdcRjbHfKyf3XKHDAGWPvDD1Dt1qHBjsaEdN76PA", lotExp: 4, lp: "DpgKpbzFcf3DT6dnsdEtB5ZiTnk2sfYxNphsUm7247ck", pool: "6JybCYrJXWeqXo8shySy2pouDdeFz6M2kCXFKt3uA64n" },
} as const;
type Sym = keyof typeof MARKETS;
const market = (s: Sym) => fx(`v22-${s}-market-v19`);

/** Copy of a fixture with the header VERSION rewritten (negative controls). */
function withVersion(d: Uint8Array, version: number): Uint8Array {
  const c = new Uint8Array(d);
  new DataView(c.buffer).setUint16(8, version, true);
  return c;
}

// ════════════════════════════════════════════════════════════════════════════
// K-2: VERSION 19 geometry
// ════════════════════════════════════════════════════════════════════════════
describe("K-2: VERSION 19 market geometry", () => {
  it("the fixtures are what they claim: 4,059 B VERSION-19 kind-1 markets", () => {
    for (const s of Object.keys(MARKETS) as Sym[]) {
      const d = market(s);
      assert.equal(d.length, 4059, s);
      assert.equal(new DataView(d.buffer).getUint16(8, true), 19, s);
      assert.equal(d[10], 1, s);
    }
  });

  it("selects 592 / 806 / 2,661 / 1,024 for VERSION 19, equal to the SDK's LAYOUT_V22 row, and 4,059 = 592 + 806 + 2,661", () => {
    const g = selectMarketGroupOffset(market("sol"));
    assert.ok(g.ok);
    assert.deepEqual(
      { version: g.version, off: g.marketGroupOff, len: g.marketGroupLen, stride: g.assetSlotStride, w: g.wrapperSlotLen },
      { version: 19, off: 592, len: 806, stride: 2661, w: 1024 },
    );
    const t = LAYOUTS_BY_VERSION.get(19)!;
    assert.deepEqual(
      [t.marketGroupOff, t.marketGroupLen, t.assetSlotStride, t.wrapperSlotLen],
      [g.marketGroupOff, g.marketGroupLen, g.assetSlotStride, g.wrapperSlotLen],
    );
    assert.equal(g.marketGroupOff + g.marketGroupLen + g.assetSlotStride, 4059);
    assert.equal(MARKET_GROUP_OFF_BY_VERSION[VERSION_19], 592);
  });

  it("v2.1 (VERSION 18) geometry is unchanged: 592 / 758 / 2,325", () => {
    const g = MARKET_GEOMETRY_BY_VERSION[18];
    assert.deepEqual([g.marketGroupOff, g.marketGroupLen, g.assetSlotStride, g.wrapperSlotLen], [592, 758, 2325, 1024]);
  });

  it("reads oracle_authority = the keeper and oracle_mode 3 (AuthMark) at the VERSION-19 slot base on every fixture", async () => {
    for (const s of Object.keys(MARKETS) as Sym[]) {
      const d = market(s);
      const conn = { getAccountInfo: async () => ({ data: Buffer.from(d) }) };
      const auth = await fetchOracleAuthority(conn as never, MARKETS[s].addr, 0);
      assert.equal(auth?.toBase58(), ORACLE_AUTHORITY, s);
      const g = selectMarketGroupOffset(d);
      assert.ok(g.ok);
      assert.equal(parseAssetOracleProfileV17(d, assetSlotOffset(g, 0)).oracleMode, 3, s);
    }
  });

  it("NEGATIVE CONTROL: the K-2 trap — VERSION 19 with the v2.1 group length (758) reads a garbage authority", () => {
    const d = market("sol");
    const wrong = parseAssetOracleProfileV17(d, 592 + V17_MARKET_GROUP_LEN);
    assert.notEqual(wrong.oracleAuthority.toBase58(), ORACLE_AUTHORITY);
  });

  it("NEGATIVE CONTROL: an unknown VERSION (20) is refused, never guessed", async () => {
    const d = withVersion(market("sol"), 20);
    const g = selectMarketGroupOffset(d);
    assert.equal(g.ok, false);
    assert.equal(!g.ok && g.reason, "unrecognized-version");
    const conn = { getAccountInfo: async () => ({ data: Buffer.from(d) }) };
    assert.equal(await fetchOracleAuthority(conn as never, MARKETS.sol.addr, 0), null);
    assert.equal(parsePushAuthMarkGenerationFields(d, 0), null);
  });

  it("market-state decodes VERSION 19 as Live (mode byte at group + 674), so the push path no longer drops it", () => {
    for (const s of Object.keys(MARKETS) as Sym[]) {
      const d = market(s);
      assert.equal(marketMode(d), 0, s);
      assert.equal(isLiveMarket(d), true, s);
      const t = decodeTerminalState(d);
      assert.equal(t?.kind, "live", s);
    }
    // SOL carries $50 insurance budget (seed): insurance_domain_budget_remaining_total @ group + 509.
    const t = decodeTerminalState(market("sol"));
    assert.equal(t?.kind === "live" && t.budget, 50_000_000n);
  });

  it("market-state: a VERSION-19 market with the mode byte set to 1 decodes Resolved (resolved_slot @ group + 675)", () => {
    const r = new Uint8Array(market("sol"));
    r[592 + 674] = 1;
    new DataView(r.buffer).setBigUint64(592 + 675, 509_460_000n, true);
    const t = decodeTerminalState(r);
    assert.equal(t?.kind, "resolved");
    assert.equal(t?.kind === "resolved" && t.resolvedSlot, 509_460_000n);
    assert.equal(isLiveMarket(r), false);
  });

  it("NEGATIVE CONTROL: market-state refuses an unknown VERSION (null, not Live)", () => {
    const d = withVersion(market("sol"), 20);
    assert.equal(marketMode(d), null);
    assert.equal(decodeTerminalState(d), null);
    assert.equal(isLiveMarket(d), false);
  });

  it("fee-legs reads the asset-0 profile at the VERSION-19 slot base (creator claimable is a real value, not garbage)", () => {
    const legs = readFeeLegs(market("jup"));
    assert.notEqual(legs.creatorClaimable, null);
    const g = selectMarketGroupOffset(market("jup"));
    assert.ok(g.ok);
    assert.equal(legs.creatorClaimable, parseAssetOracleProfileV17(market("jup"), assetSlotOffset(g, 0)).creatorFeeClaimableAtoms);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// K-1: per-lot mark
// ════════════════════════════════════════════════════════════════════════════
describe("K-1: per-lot mark scaling", () => {
  it("reads lot_exp 0 / 1 / 4 from the market account (profile byte +19), equal to the SDK's lotExpOfMarketV22", () => {
    for (const s of Object.keys(MARKETS) as Sym[]) {
      const d = market(s);
      const f = parsePushAuthMarkGenerationFields(d, 0);
      assert.ok(f, s);
      assert.equal(f.lotExp, MARKETS[s].lotExp, s);
      assert.equal(f.lotExp, lotExpOfMarketV22(d), s);
      assert.equal(f.marketId, 1n, s);
    }
  });

  it("perLotMarkE6 = price x 10^lot_exp (the stop-gap pusher's own numbers: JUP 3,411,315 -> 34,113,150; CHILLHOUSE 1,097 -> 10,970,000)", () => {
    assert.equal(perLotMarkE6(109_705_251n, 0), 109_705_251n);
    assert.equal(perLotMarkE6(3_411_315n, 1), 34_113_150n);
    assert.equal(perLotMarkE6(1_097n, 4), 10_970_000n);
  });

  it("NEGATIVE CONTROL: out-of-range inputs are refused (skip), never clamped", () => {
    assert.equal(perLotMarkE6(0n, 0), null);
    assert.equal(perLotMarkE6(-1n, 1), null);
    assert.equal(perLotMarkE6(1n, 16), null);
    assert.equal(perLotMarkE6(1n, -1), null);
    assert.equal(perLotMarkE6(MAX_ORACLE_PRICE_E6, 0), MAX_ORACLE_PRICE_E6);
    assert.equal(perLotMarkE6(MAX_ORACLE_PRICE_E6, 1), null);
  });

  it("NEGATIVE CONTROL: a lot_exp byte above 15 makes the market unpushable (null fields), and v2.1 never reads the byte", () => {
    const d = new Uint8Array(market("chillhouse"));
    d[592 + 806 + 19] = 16;
    assert.equal(parsePushAuthMarkGenerationFields(d, 0), null);
    assert.equal(readMarketLotExp(d, 18, 592 + 806), 0, "VERSION < 19: lot_exp is 0 regardless of the byte");
  });

  /** Fake devnet: serves the fixture bytes, records every simulated PushAuthMark (mark @19, seq @27 of the ix data). */
  function fakeConn(accounts: Record<string, Uint8Array>) {
    const sims: Array<{ market: string; mark: bigint; seq: bigint }[]> = [];
    const conn = {
      async getMultipleAccountsInfo(pks: PublicKey[]) {
        return pks.map((pk) => (accounts[pk.toBase58()] ? { data: Buffer.from(accounts[pk.toBase58()]) } : null));
      },
      async simulateTransaction(tx: { instructions: Array<{ programId: PublicKey; keys: Array<{ pubkey: PublicKey }>; data: Uint8Array }> }) {
        sims.push(
          nonComputeBudget(tx.instructions).map((ix) => {
            const v = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
            return { market: ix.keys[1].pubkey.toBase58(), mark: v.getBigUint64(19, true), seq: v.getBigUint64(27, true) };
          }),
        );
        return { value: { err: null } };
      },
      async sendRawTransaction() {
        return "sig";
      },
    };
    return { conn, sims };
  }

  it("pushAuthMarkBatch sends price x 10^lot_exp per market in ONE batch (SOL x1, JUP x10, CHILLHOUSE x10^4)", async () => {
    resetPushLandingState();
    const accounts = Object.fromEntries((Object.keys(MARKETS) as Sym[]).map((s) => [MARKETS[s].addr, market(s)]));
    const { conn, sims } = fakeConn(accounts);
    const pushes = [
      { marketAddress: MARKETS.sol.addr, assetIndex: 0, priceE6: 109_705_251n },
      { marketAddress: MARKETS.jup.addr, assetIndex: 0, priceE6: 3_411_315n },
      { marketAddress: MARKETS.chillhouse.addr, assetIndex: 0, priceE6: 1_097n },
    ];
    const res = await pushAuthMarkBatch(conn as never, Keypair.generate(), pushes, 509_453_100n, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }, false);
    assert.equal(res.pushedMarkets.length, 3);
    const sent = new Map(sims[0].map((p) => [p.market, p.mark]));
    assert.equal(sent.get(MARKETS.sol.addr), 109_705_251n);
    assert.equal(sent.get(MARKETS.jup.addr), 34_113_150n);
    assert.equal(sent.get(MARKETS.chillhouse.addr), 10_970_000n);
  });

  it("NEGATIVE CONTROL: the pre-K-1 behaviour (raw token price) would put CHILLHOUSE's mark 10^4 below the seeded per-lot mark", () => {
    // The seed priced CHILLHOUSE at a per-lot mark of 10,980,000 (ledger section 4); the raw token price is ~1,097.
    const seeded = 10_980_000n;
    assert.ok(1_097n * 1000n < seeded, "raw price is orders of magnitude off");
    const scaled = perLotMarkE6(1_097n, 4)!;
    assert.ok(scaled > (seeded * 9n) / 10n && scaled < (seeded * 11n) / 10n, "scaled mark is within 10% of the seed");
  });

  it("NEGATIVE CONTROL: a market whose per-lot mark would exceed MAX_ORACLE_PRICE is skipped, the others still push", async () => {
    resetPushLandingState();
    const accounts = { [MARKETS.sol.addr]: market("sol"), [MARKETS.chillhouse.addr]: market("chillhouse") };
    const { conn, sims } = fakeConn(accounts);
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [
        { marketAddress: MARKETS.sol.addr, assetIndex: 0, priceE6: 100_000_000n },
        { marketAddress: MARKETS.chillhouse.addr, assetIndex: 0, priceE6: MAX_ORACLE_PRICE_E6 }, // x10^4 > MAX
      ],
      1n,
      { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 },
      false,
    );
    assert.deepEqual(res.pushedMarkets, [MARKETS.sol.addr]);
    assert.ok(res.skippedMarkets.includes(MARKETS.chillhouse.addr));
    assert.deepEqual(sims[0].map((p) => p.market), [MARKETS.sol.addr]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// K-3: vault-LP portfolio without a registry lpPortfolio
// ════════════════════════════════════════════════════════════════════════════
describe("K-3: lpPortfolio derived on chain for registry entries that carry none", () => {
  const sol = new PublicKey(MARKETS.sol.addr);
  const lp = new PublicKey(MARKETS.sol.lp);
  const lpData = fx("v22-sol-lp-portfolio-v19");

  function conn(o: { vls?: boolean; lpAccount?: boolean; scan?: boolean }) {
    const gpaLens: number[] = [];
    const vls = deriveVaultLpState(WRAPPER_PROGRAM_ID, sol);
    return {
      gpaLens,
      c: {
        async getAccountInfo(pk: PublicKey) {
          if (o.vls && pk.equals(vls)) return { owner: WRAPPER_PROGRAM_ID, data: Buffer.from(fx("v22-sol-vault-lp-state")) };
          if (o.lpAccount && pk.equals(lp)) return { owner: WRAPPER_PROGRAM_ID, data: Buffer.from(lpData) };
          return null;
        },
        async getProgramAccounts(_p: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) {
          const size = cfg.filters.find((f) => f.dataSize !== undefined)!.dataSize!;
          gpaLens.push(size);
          return o.scan && size === lpData.length ? [{ pubkey: lp, account: { data: Buffer.from(lpData) } }] : [];
        },
      },
    };
  }

  it("resolves SOL's vault-LP portfolio from the vault_lp PDA with no scan at all", async () => {
    const { c, gpaLens } = conn({ vls: true, lpAccount: true });
    assert.equal((await findLpPortfolio(c as never, sol))?.toBase58(), MARKETS.sol.lp);
    assert.deepEqual(gpaLens, []);
  });

  it("falls back to a scan that includes the VERSION-19 portfolio length (10,603 B)", async () => {
    const { c, gpaLens } = conn({ scan: true });
    assert.equal((await findLpPortfolio(c as never, sol))?.toBase58(), MARKETS.sol.lp);
    assert.ok(gpaLens.includes(10_603), `scanned lengths ${gpaLens.join(",")}`);
  });

  it("NEGATIVE CONTROL: the pre-K-3 scan (v2.1 length 9,563 only) finds nothing for a v2.2 market", async () => {
    const { c } = conn({ scan: true });
    const res = await (c as { getProgramAccounts: (p: PublicKey, cfg: unknown) => Promise<unknown[]> }).getProgramAccounts(WRAPPER_PROGRAM_ID, { filters: [{ dataSize: 9563 }] });
    assert.deepEqual(res, []);
  });

  it("NEGATIVE CONTROL: a vault_lp state naming a portfolio that does not exist is not trusted (scan decides; nothing found = null)", async () => {
    const { c } = conn({ vls: true, lpAccount: false, scan: false });
    assert.equal(await findLpPortfolio(c as never, sol), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// K-4: stake v5 pools
// ════════════════════════════════════════════════════════════════════════════
describe("K-4: StakePool v5 decode for terminal-insurance / stake-fee", () => {
  it("decodes the real v5 pools (480 B): slab = the market, initialized, insurance mode", () => {
    for (const s of Object.keys(MARKETS) as Sym[]) {
      const d = fx(`v22-${s}-stake-pool-v5`);
      assert.equal(d.length, 480, s);
      assert.equal(isStakePoolV5(d), true, s);
      const p = decodeStakePoolAnyVersion(d);
      assert.equal(p.version, 5, s);
      assert.equal(p.slab.toBase58(), MARKETS[s].addr, s);
      assert.equal(p.isInitialized, true, s);
      assert.equal(p.poolMode, 0, s);
      assert.ok(p.totalLpSupply >= 1000n, s);
    }
  });

  it("NEGATIVE CONTROL: the legacy SDK decoder (what the job used) refuses the same bytes with the logged error", () => {
    assert.throws(() => decodeStakePool(fx("v22-sol-stake-pool-v5")), /StakePool unsupported version: 5 !== 4/);
  });

  it("NEGATIVE CONTROL: an unknown pool version (6) still throws (never a guess)", () => {
    const d = new Uint8Array(fx("v22-sol-stake-pool-v5"));
    d[328] = 6;
    assert.equal(isStakePoolV5(d), false);
    assert.throws(() => decodeStakePoolAnyVersion(d));
  });
});
