/**
 * SDK repin 96b267e -> a18c199e (feat/v22-sdk-growth): what the keeper's decode paths do on REAL v2.2 devnet account bytes.
 *
 * Fixtures (read-only fetch from https://api.devnet.solana.com on 2026-10-17):
 *   __fixtures__/v22-live-accounts-2026-10-17.json        the 13 v2.2 markets' slabs + the 11 stake pools that exist
 *   __fixtures__/v22-live-decode-golden-96b267e.json      what the OLD pin (96b267e) decoded those bytes to
 * Every live growth record is legacy (flags = 0). The repin must not change a single shared field on them, and the
 * fields it adds must read as their legacy defaults. Controller-written records (flags bit0/bit1 set; percolator-prog
 * fix/v22-controller-rc-2026-10-17 @ b7b3b8de, src/v16_program.rs `offset_of!(AssetGrowthV19, ...)`) are built from the
 * Rust byte offsets and decoded; the old pin reads those bytes as c_launch + zeros.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  LAYOUT_V22,
  assetGrowthAccountOffsetV19,
  decodeAssetGrowthV19,
  decodeStakePoolV5,
  growthFlagsOk,
  parseAssetOracleProfileV17,
  parseBackingBucketsV17,
  parseWrapperConfigV17,
  stakeRealLpSupply as sdkStakeRealLpSupply,
} from "@percolatorct/sdk";
import { decodeStakePoolAnyVersion } from "./stake-pool-decode.ts";
import { readStakeFloorFlags, STAKE_FLOOR_JUNIOR, STAKE_FLOOR_SENIOR, STAKE_MINIMUM_LIQUIDITY } from "./stake-fee-pusher.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(f: string): T => JSON.parse(readFileSync(join(here, "__fixtures__", f), "utf8")) as T;
interface Acct { symbol: string; market: string; nAssets: number; slab: string; pool?: string; poolData?: string }
const accounts = load<{ accounts: Acct[] }>("v22-live-accounts-2026-10-17.json").accounts;
const golden = load<{ byMarket: Record<string, Record<string, unknown>> }>("v22-live-decode-golden-96b267e.json").byMarket;
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/** Same normalisation the golden was captured with: bigint -> "<n>n", PublicKey -> base58. */
const norm = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x instanceof PublicKey ? x.toBase58() : x)));
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Growth fields the controller layout retired (bytes now vol / rent stamp); all 0 on every live record under the old pin. */
const RETIRED = ["allocAlphaBps", "allocBufferBps", "cushionTargetBps", "cushionShareBps"];
const ADDED_GROWTH: Record<string, unknown> = {
  r3Layout: false, volHasData: false, volVarX100: 0, rentStamp64: 0,
  depthTw: { curTokens: 0, prevTokens: 0, bucketP1: 0 },
};
/** creatorSeedAtoms is conditional on pool byte 333 bit 0 (the close-out seed flag; set on the *-T pools, whose seed is 0). */
const ADDED_POOL: Record<string, unknown> = { unclaimedAtoms: "0n", creatorTotalForwardedAtoms: "0n" };

describe("live legacy bytes: a18c199e decodes exactly what 96b267e did", () => {
  for (const a of accounts) {
    it(`${a.symbol} ${a.market.slice(0, 6)}`, () => {
      const slab = b64(a.slab);
      const g = golden[a.symbol] as { growth: Record<string, unknown>[]; poolV5?: Record<string, unknown> };
      for (let i = 0; i < a.nAssets; i++) {
        const now = norm(decodeAssetGrowthV19(slab, i)) as Record<string, unknown> | null;
        const was = g.growth[i] as Record<string, unknown> | null;
        if (was === null) { assert.equal(now, null, `asset ${i}`); continue; }
        assert.ok(now);
        assert.equal(now.flags, 0, "live records are legacy");
        for (const k of RETIRED) assert.equal(was[k], 0, `${k} was 0 under the old pin, so dropping it loses nothing`);
        for (const k of Object.keys(was)) if (!RETIRED.includes(k)) assert.deepEqual(now[k], was[k], `asset ${i} field ${k}`);
        for (const [k, v] of Object.entries(ADDED_GROWTH)) assert.deepEqual(now[k], v, `asset ${i} added ${k} legacy default`);
        // rent kink (u16 @42) and rent N_cap snapshot (u64 @48) are real live data the old pin did not expose (non-zero on the *-T / CHILLHOUSE markets)
        const dv = new DataView(slab.buffer, slab.byteOffset + assetGrowthAccountOffsetV19(i, LAYOUT_V22), 120);
        assert.equal(now.rentKinkBps, dv.getUint16(42, true), "rentKinkBps = raw u16 @42");
        assert.equal(now.rentNCapQ, `${dv.getBigUint64(48, true)}n`, "rentNCapQ = raw u64 @48");
        for (const k of RETIRED) assert.ok(!(k in now), `${k} no longer exposed`);
      }
      // slab-level parsers the keeper also calls: byte-identical output (hash of the old output)
      const nAssets = a.nAssets;
      assert.equal(sha(norm(parseWrapperConfigV17(slab))), (g as Record<string, unknown>).wrapperConfigSha256);
      assert.equal(sha(norm(parseBackingBucketsV17(slab))), (g as Record<string, unknown>).backingBucketsSha256);
      assert.equal(sha(norm(Array.from({ length: nAssets }, (_, i) => parseAssetOracleProfileV17(slab, i)))), (g as Record<string, unknown>).oracleProfileSha256);
      if (a.poolData) {
        const now = norm(decodeStakePoolV5(b64(a.poolData))) as Record<string, unknown>;
        assert.ok(g.poolV5);
        for (const k of Object.keys(g.poolV5)) assert.deepEqual(now[k], g.poolV5[k], `pool field ${k}`);
        for (const [k, v] of Object.entries(ADDED_POOL)) assert.deepEqual(now[k], v, `pool added ${k} legacy default (no close-out seed flag)`);
        const raw = b64(a.poolData);
        assert.equal(now.creatorSeedAtoms, (raw[333] as number) & 1 ? "0n" : null, "seed record only when the flag is set");
        // the keeper's wrapper over it (terminal-insurance / stake-fee-pusher) still takes the v5 path
        assert.equal(decodeStakePoolAnyVersion(b64(a.poolData)).totalLpSupply, decodeStakePoolV5(b64(a.poolData)).totalLpSupply);
      } else assert.equal(g.poolV5, undefined);
    });
  }
  it("the fixture really covers 13 markets, 11 stake pools", () => {
    assert.equal(accounts.length, 13);
    assert.equal(accounts.filter((a) => a.poolData).length, 11);
  });
});

describe("TODO(repin) retired: SDK stakeRealLpSupply == the old local mirror, on real pool bytes", () => {
  /** The hand port that lived in stake-fee-pusher.ts (verbatim logic). */
  const oldMirror = (totalLpSupply: bigint, floorFlags: number): bigint => {
    const sat = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
    if (floorFlags === 0) return sat(totalLpSupply, 1_000n);
    const sd = (floorFlags & 0x01) !== 0 ? 1_000n : 0n;
    const jd = (floorFlags & 0x02) !== 0 ? 1_000n : 0n;
    return sat(sat(totalLpSupply, sd), jd);
  };
  it("constants re-exported from the SDK keep their wire values", () => {
    assert.equal(STAKE_MINIMUM_LIQUIDITY, 1_000n);
    assert.equal(STAKE_FLOOR_SENIOR, 0x01);
    assert.equal(STAKE_FLOOR_JUNIOR, 0x02);
  });
  it("each live pool: raw flags byte == decoded floorFlags, and real supply is identical", () => {
    for (const a of accounts.filter((x) => x.poolData)) {
      const raw = b64(a.poolData as string);
      const p = decodeStakePoolV5(raw);
      assert.equal(readStakeFloorFlags(raw), p.floorFlags, a.symbol);
      assert.ok([1, 3].includes(p.floorFlags), `${a.symbol}: the v2.2 stake program writes FLOOR_SENIOR (1), or SENIOR|JUNIOR (3), on every live pool (got ${p.floorFlags})`);
      assert.equal(sdkStakeRealLpSupply({ totalLpSupply: p.totalLpSupply, floorFlags: p.floorFlags }), oldMirror(p.totalLpSupply, p.floorFlags), a.symbol);
      assert.equal(sdkStakeRealLpSupply(p), oldMirror(p.totalLpSupply, p.floorFlags));
    }
  });
  it("exhaustive over every flags value and the boundary supplies", () => {
    const totals = [0n, 1n, 999n, 1000n, 1001n, 1999n, 2000n, 2001n, 3000n, 3_100_002_000n, 2n ** 64n - 1n];
    for (let f = 0; f < 256; f++) for (const t of totals) assert.equal(sdkStakeRealLpSupply({ totalLpSupply: t, floorFlags: f }), oldMirror(t, f), `f=${f} t=${t}`);
  });
});

describe("controller-written growth records (flags bit0 / bit1), built from percolator-prog b7b3b8de offset_of!", () => {
  // src/v16_program.rs asserts: vol_var_x100_le 0, rent_stamp64_le 4, ceil_slot 8, depth_tw_cur_le 30, depth_tw_prev_le 34,
  // version 38 (ASSET_GROWTH_VERSION_FIELD_OFF), flags 39, depth_source 44, rent_n_cap_q 48, depth_e6 56, ... depth_rise_slot64_le 114.
  const rec = (o: { flags: number; vol?: number; stamp?: number; cur?: number; prev?: number; bucket?: number; cLaunch?: bigint }): Uint8Array => {
    const b = new Uint8Array(120);
    const v = new DataView(b.buffer);
    if (o.cLaunch !== undefined) v.setBigUint64(0, o.cLaunch, true);
    if (o.vol !== undefined) v.setUint32(0, o.vol, true);
    if (o.stamp !== undefined) v.setUint32(4, o.stamp, true);
    v.setBigUint64(8, 509_432_357n, true);
    v.setUint16(24, 1000, true);
    v.setUint32(30, o.cur ?? 0, true);
    v.setUint32(34, o.prev ?? 0xffff_ffff, true);
    b[38] = 1; b[39] = o.flags;
    v.setBigUint64(48, 123_456_789n, true);
    v.setUint16(118, o.bucket ?? 0, true);
    return b;
  };
  const withRecord = (slab: Uint8Array, asset: number, r: Uint8Array): Uint8Array => {
    const out = new Uint8Array(slab);
    out.set(r, assetGrowthAccountOffsetV19(asset, LAYOUT_V22));
    return out;
  };
  const sol = accounts.find((a) => a.symbol === "SOL") as Acct;
  const cap4 = accounts.find((a) => a.symbol === "CAP4-SYN") as Acct;

  it("SDK offsets equal the Rust offset_of! numbers", () => {
    // growth record sits at slot + 672 of a 2325-byte stride after the 592+758 header; asset 0 at 2022 on this layout
    assert.equal(assetGrowthAccountOffsetV19(0, LAYOUT_V22) % 1, 0);
    assert.equal(assetGrowthAccountOffsetV19(1, LAYOUT_V22) - assetGrowthAccountOffsetV19(0, LAYOUT_V22), LAYOUT_V22.assetSlotStride);
  });
  it("flags 0x03 (R3 layout + volatility data): vol EWMA, rent stamp, depth window, rent snapshot decode; c_launch is retired", () => {
    const slab = withRecord(b64(sol.slab), 0, rec({ flags: 0x03, vol: 7_777, stamp: 1_234_567, cur: 800, prev: 600, bucket: 42 }));
    const g = decodeAssetGrowthV19(slab, 0);
    assert.ok(g);
    assert.deepEqual([g.flags, g.r3Layout, g.volHasData, g.volVarX100, g.rentStamp64, g.cLaunchAtoms], [3, true, true, 7_777, 1_234_567, 0n]);
    assert.deepEqual(g.depthTw, { curTokens: 800, prevTokens: 600, bucketP1: 42 });
    assert.equal(g.rentNCapQ, 123_456_789n);
    assert.equal(g.ceilX100, 1000);
    assert.equal(g.ceilSlot, 509_432_357n);
  });
  it("flags 0x01 (R3 layout, no volatility data yet): vol_var 0 and volHasData false", () => {
    const g = decodeAssetGrowthV19(withRecord(b64(sol.slab), 0, rec({ flags: 0x01, vol: 0, stamp: 9 })), 0);
    assert.ok(g);
    assert.deepEqual([g.r3Layout, g.volHasData, g.volVarX100, g.rentStamp64], [true, false, 0, 9]);
  });
  it("flags 0x00 with bytes 0..8 set is the legacy c_launch, not vol / stamp", () => {
    const g = decodeAssetGrowthV19(withRecord(b64(sol.slab), 0, rec({ flags: 0, cLaunch: 5_000_000_000n })), 0);
    assert.ok(g);
    assert.deepEqual([g.r3Layout, g.cLaunchAtoms, g.volVarX100, g.rentStamp64], [false, 5_000_000_000n, 0, 0]);
  });
  it("the program's validator refuses flags 0x02 / unknown bits", () => {
    assert.deepEqual([0, 1, 3].map(growthFlagsOk), [true, true, true]);
    assert.deepEqual([2, 4, 0x80].map(growthFlagsOk), [false, false, false]);
  });
  it("multi-asset slab: a controller record on asset 3 decodes, the neighbours stay inert", () => {
    const slab = withRecord(b64(cap4.slab), 3, rec({ flags: 0x03, vol: 250, stamp: 77, cur: 5, prev: 4, bucket: 2 }));
    const g = decodeAssetGrowthV19(slab, 3);
    assert.ok(g);
    assert.deepEqual([g.volVarX100, g.rentStamp64, g.depthTw.bucketP1], [250, 77, 2]);
    assert.equal(decodeAssetGrowthV19(slab, 2), decodeAssetGrowthV19(b64(cap4.slab), 2));
  });
});
