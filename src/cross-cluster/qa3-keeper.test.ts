/**
 * QA retest 3/4 keeper items (2026-10-12):
 *   - per-lot mark from the unrounded price (the "coarse steps" observation);
 *   - K-9 partial: ADL state of every asset of a multi-asset market on /health;
 *   - the /health file mirror (QA cannot reach 127.0.0.1:18797).
 *
 * Fixtures: real VERSION-19 accounts: CHILLHOUSE (lot_exp 4), SOL (lot_exp 0), and the 5-asset market 2xhsLP9N
 * (14,703 B, read 2026-10-12).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/qa3-keeper.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { perLotMarkE6, perLotMarkFromE12, pushAuthMarkBatch, resetPushLandingState, MAX_ORACLE_PRICE_E6 } from "./auth-mark-pusher.ts";
import { ADL_ONE, adlHealthOf } from "./adl-state.ts";
import { crankHealthFields } from "./keeper-loop.ts";
import { createMarkSmoother } from "./mark-smoother.ts";
import { healthFileConfigFromEnv, writeHealthSnapshot } from "./health-file.ts";
import { meteoraWsolPriceToUsdE12, meteoraWsolPriceToUsdE6 } from "./price-reader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => new Uint8Array(Buffer.from(fs.readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));
const CHILL = "ALdzXdcRjbHfKyf3XKHDAGWPvDD1Dt1qHBjsaEdN76PA";
const SOL = "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5";

describe("per-lot mark from the unrounded per-token price", () => {
  it("CHILLHOUSE-like: $0.001206437812 x 10^4 -> 12,064,378 (the e6 path gives 12,060,000)", () => {
    assert.equal(perLotMarkE6(1_206n, 4), 12_060_000n);
    assert.equal(perLotMarkFromE12(1_206n, 1_206_437_812n, 4), 12_064_378n);
  });
  it("a 0.01% price move now moves the per-lot mark (it did not on the e6 path)", () => {
    const a = perLotMarkFromE12(1_206n, 1_206_400_000n, 4)!;
    const b = perLotMarkFromE12(1_206n, 1_206_520_640n, 4)!; // +0.01%
    assert.ok(b > a && b - a === 1_206n, `${a} -> ${b}`);
    assert.equal(perLotMarkE6(1_206n, 4), perLotMarkE6(1_206n, 4));
  });
  it("rounds half up to e6 and equals the old value exactly when the price has no extra digits", () => {
    assert.equal(perLotMarkFromE12(1_206n, 1_206_000_000n, 4), 12_060_000n);
    assert.equal(perLotMarkFromE12(371_566n, 371_566_499_999n, 2), 37_156_650n);
    assert.equal(perLotMarkFromE12(371_566n, 371_566_495_000n, 2), 37_156_650n); // .6495 -> rounds to 50
  });
  it("NEGATIVE CONTROL: lot_exp 0, no e12, or an e12 that is not the same price to one e6 unit -> the exact old mark", () => {
    assert.equal(perLotMarkFromE12(109_705_251n, 109_705_251_999_999n, 0), 109_705_251n);
    assert.equal(perLotMarkFromE12(1_206n, undefined, 4), 12_060_000n);
    assert.equal(perLotMarkFromE12(1_206n, 1_266_000_000n, 4), 12_060_000n, "e12 5% away from the accepted e6 price is ignored");
    assert.equal(perLotMarkFromE12(1_206n, 1_207_000_000n, 4), 12_070_000n, "exactly one e6 unit away is still the same price");
    assert.equal(perLotMarkFromE12(1_206n, 1_207_100_000n, 4), 12_060_000n, "more than one unit away is not");
    assert.equal(perLotMarkFromE12(1_206n, 0n, 4), 12_060_000n);
  });
  it("NEGATIVE CONTROL: out of range stays a skip (null), never a clamp", () => {
    assert.equal(perLotMarkFromE12(MAX_ORACLE_PRICE_E6, MAX_ORACLE_PRICE_E6 * 1_000_000n, 1), null);
    assert.equal(perLotMarkFromE12(0n, 5n, 4), null);
  });

  it("the e12 smoother over the same samples is the e6 median with the extra digits (windows aligned)", () => {
    const e6 = createMarkSmoother({ windowMs: 10_000, minSamples: 2, minSpanMs: 0 } as never);
    const e12 = createMarkSmoother({ windowMs: 10_000, minSamples: 2, minSpanMs: 0 } as never);
    let a: bigint | null = null, b: bigint | null = null;
    [1_206_437_812n, 1_206_911_004n, 1_205_998_120n, 1_206_500_000n].forEach((p, i) => {
      a = e6.smooth("pool", p / 1_000_000n, 1_000 * (i + 1));
      b = e12.smooth("pool", p, 1_000 * (i + 1));
    });
    assert.ok(a !== null && b !== null);
    assert.ok(b! / 1_000_000n - a! <= 1n && a! - b! / 1_000_000n <= 1n, `e6 ${a} vs e12 ${b}`);
    assert.notEqual(perLotMarkFromE12(a!, b!, 4), perLotMarkE6(a!, 4));
  });

  function fakeConn(accounts: Record<string, Uint8Array>) {
    const marks = new Map<string, bigint>();
    return {
      marks,
      conn: {
        async getMultipleAccountsInfo(pks: PublicKey[]) { return pks.map((pk) => (accounts[pk.toBase58()] ? { data: Buffer.from(accounts[pk.toBase58()]) } : null)); },
        async simulateTransaction(tx: { instructions: Array<{ keys: Array<{ pubkey: PublicKey }>; data: Uint8Array }> }) {
          for (const ix of tx.instructions.slice(1)) marks.set(ix.keys[1].pubkey.toBase58(), new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(19, true));
          return { value: { err: null } };
        },
        async sendRawTransaction() { return "sig"; },
      },
    };
  }
  it("pushAuthMarkBatch on real CHILLHOUSE (lot 4) and SOL (lot 0) bytes: fine mark on the lot market, unchanged on SOL", async () => {
    resetPushLandingState();
    const { conn, marks } = fakeConn({ [CHILL]: fx("v22-chillhouse-market-v19"), [SOL]: fx("v22-sol-market-v19") });
    await pushAuthMarkBatch(conn as never, Keypair.generate(), [
      { marketAddress: SOL, assetIndex: 0, priceE6: 109_705_251n, priceE12: 109_705_251_733_000n },
      { marketAddress: CHILL, assetIndex: 0, priceE6: 1_206n, priceE12: 1_206_437_812n },
    ], 1n, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }, false);
    assert.equal(marks.get(SOL), 109_705_251n);
    assert.equal(marks.get(CHILL), 12_064_378n);
  });
  it("NEGATIVE CONTROL: without priceE12 the batch sends the old coarse mark", async () => {
    resetPushLandingState();
    const { conn, marks } = fakeConn({ [CHILL]: fx("v22-chillhouse-market-v19") });
    await pushAuthMarkBatch(conn as never, Keypair.generate(), [{ marketAddress: CHILL, assetIndex: 0, priceE6: 1_206n }], 1n, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }, false);
    assert.equal(marks.get(CHILL), 12_060_000n);
  });
});

describe("reader: the e12 price is the e6 price with more digits (meteora WSOL-quoted)", () => {
  // Same synthetic pool builder as meteora-wsol.test.ts (active_id i32 @76, bin_step u16 @80).
  function makePool(activeId: number, binStep: number): Uint8Array {
    const buf = new Uint8Array(904);
    const dv = new DataView(buf.buffer);
    buf.set([33, 11, 49, 98, 181, 101, 177, 13], 0);
    dv.setInt32(76, activeId, true);
    dv.setUint16(80, binStep, true);
    return buf;
  }
  it("usdE12 / 1e6 == usdE6 (truncation only), and e12 carries digits e6 lost", () => {
    const DEC = { base: 6, quote: 9 };
    let checked = 0;
    for (const id of [-2000, -1500, -900]) {
      try {
        const pool = makePool(id, 100);
        const e6 = meteoraWsolPriceToUsdE6(pool, DEC, 111_940_000n);
        const e12 = meteoraWsolPriceToUsdE12(pool, DEC, 111_940_000n);
        if (e6 <= 0n) continue;
        assert.equal(e12 / 1_000_000n, e6);
        checked++;
      } catch { /* a synthetic id the SDK refuses */ }
    }
    assert.ok(checked > 0, "at least one synthetic pool priced");
  });
});

describe("K-9 partial: every asset of a multi-asset market on /health", () => {
  const CAP4B = fx("v22-cap4b-market-v19-5assets");
  const E = (k: number) => 592 + 806 + k * 2661 + 1024;
  it("real 5-asset market 2xhsLP9N: adlAssets lists assets 0..4, all A = 1.000000, none reduce-only", () => {
    assert.equal(CAP4B.length, 14_703);
    const h = adlHealthOf(CAP4B);
    assert.deepEqual(h.adlAssets?.map((a) => a.asset), [0, 1, 2, 3, 4]);
    assert.ok(h.adlAssets!.every((a) => a.aLong === "1.000000" && a.aShort === "1.000000" && !a.reduceOnly));
  });
  it("a reduce-only asset OTHER than asset 0 is visible (it was hidden when only asset 0 was reported)", () => {
    const d = new Uint8Array(CAP4B);
    const v = new DataView(d.buffer);
    const x = (ADL_ONE * 9n) / 10n;
    v.setBigUint64(E(3) + 65, x & 0xffff_ffff_ffff_ffffn, true);
    v.setBigUint64(E(3) + 73, x >> 64n, true);
    const h = adlHealthOf(d);
    assert.equal(h.adl?.reduceOnly, false, "asset 0 alone still looks healthy");
    assert.deepEqual(h.adlAssets!.filter((a) => a.reduceOnly).map((a) => a.asset), [3]);
    const f = crankHealthFields({ staleLong: 0, staleShort: 0, postStaleLong: null, postStaleShort: null, positioned: 0, overflow: 0, overflowRefreshed: 0, overflowError: null, lossStaleCycles: 0, status: "ok", updatedAt: Date.now(), ...h });
    assert.equal(f.adlReduceOnlyAssets, "3");
    assert.equal((f.adlAssets as unknown[]).length, 5);
  });
  it("NEGATIVE CONTROL: a single-asset market has no adlAssets (shape unchanged), a Disabled slot is not listed", () => {
    assert.equal(adlHealthOf(fx("v22-sol-market-v19")).adlAssets, undefined);
    const d = new Uint8Array(CAP4B);
    d[E(4) + 16] = 0; // lifecycle Disabled
    assert.deepEqual(adlHealthOf(d).adlAssets?.map((a) => a.asset), [0, 1, 2, 3]);
  });
});

describe("/health file mirror", () => {
  it("is off unless KEEPER_HEALTH_FILE is set; rejects a relative path / bad interval; floors the interval at 5 s", () => {
    assert.equal(healthFileConfigFromEnv({}), null);
    assert.throws(() => healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: "health.json" }), /absolute/);
    assert.throws(() => healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: "/tmp/h.json", KEEPER_HEALTH_FILE_MS: "abc" }), /positive integer/);
    assert.deepEqual(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: "/tmp/h.json", KEEPER_HEALTH_FILE_MS: "1000" }), { file: "/tmp/h.json", intervalMs: 5_000 });
    assert.deepEqual(healthFileConfigFromEnv({ KEEPER_HEALTH_FILE: "/tmp/h.json" }), { file: "/tmp/h.json", intervalMs: 30_000 });
  });
  it("writes { writtenAt, source, health } atomically; a failed read keeps the previous file", async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "khf-"));
    const file = join(dir, "sub", "health.json");
    assert.equal(await writeHealthSnapshot(async () => JSON.stringify({ status: "ok", markets: { a: 1 } }), file, "test", () => new Date("2026-10-12T00:00:00Z")), true);
    const first = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(first, { writtenAt: "2026-10-12T00:00:00.000Z", source: "test", health: { status: "ok", markets: { a: 1 } } });
    // NEGATIVE CONTROL: unreadable / non-JSON health -> false, the old snapshot stays, no temp file is left behind.
    assert.equal(await writeHealthSnapshot(async () => { throw new Error("down"); }, file, "test"), false);
    assert.equal(await writeHealthSnapshot(async () => "<html>", file, "test"), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), first);
    assert.deepEqual(fs.readdirSync(join(dir, "sub")), ["health.json"]);
    fs.rmSync(dir, { recursive: true });
  });
});
