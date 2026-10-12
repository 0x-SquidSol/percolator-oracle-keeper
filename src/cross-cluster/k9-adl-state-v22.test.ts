/**
 * K-9 (2026-10-12): the ADL reduce-only observation (/health `adl`) decodes v2.2 (VERSION 19) markets at their own
 * offsets. It used to refuse every non-VERSION-18 header and the cranker skipped it on v2.2, so /health carried no ADL
 * state for any v2.2 market (and the post-ADL JUP freeze, section 7b, was invisible there).
 *
 * Fixtures: real VERSION-19 accounts read from the fresh v2.2 devnet: JUP GtUe5hYy (2026-10-12) and SOL BYFuWyuo (2026-10-12, positioned)
 * A reduce-only state is recreated by writing a_short < ADL_ONE at the v2.2 offset.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/k9-adl-state-v22.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADL_ONE, decodeAdlState } from "./adl-state.ts";
import { observeMarket } from "./recovery-cranker.ts";
import { readWindDownView } from "./p2b-wind-down.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));
const JUP = fx("v22-jup2-market-v19");
const SOL = fx("v22-sol2-market-v19"); // 2026-10-12, positioned
const ENGINE0_V22 = 592 + 806 + 1024; // 2,422
const ENGINE0_V21 = 592 + 758 + 1024; // 2,374
const u128 = (d: Uint8Array, o: number) => { const v = new DataView(d.buffer, d.byteOffset); return v.getBigUint64(o, true) | (v.getBigUint64(o + 8, true) << 64n); };
const w128 = (d: Uint8Array, o: number, x: bigint) => { const v = new DataView(d.buffer, d.byteOffset); v.setBigUint64(o, x & 0xffff_ffff_ffff_ffffn, true); v.setBigUint64(o + 8, x >> 64n, true); };

describe("K-9: ADL state on VERSION-19 markets", () => {
  it("real v2.2 JUP and SOL: a_long = a_short = ADL_ONE exactly (positive control for the v2.2 base 2,422 + 49/65), not reduce-only", () => {
    for (const d of [JUP, SOL]) {
      const s = decodeAdlState(d)!;
      assert.deepEqual([s.aLong, s.aShort, s.reduceOnly], [ADL_ONE, ADL_ONE, false]);
    }
  });

  it("real v2.2 SOL carries non-zero matching OI on both sides (the +289/+305 read at the v2.2 base)", () => {
    const s = decodeAdlState(SOL)!;
    assert.ok(s.oiEffLong > 0n && s.oiEffLong === s.oiEffShort, `${s.oiEffLong} / ${s.oiEffShort}`);
  });

  it("a post-ADL v2.2 state (a_short = 0.8617 ADL_ONE) is reduce-only, and observeMarket (the /health source) carries it", () => {
    const d = new Uint8Array(JUP);
    w128(d, ENGINE0_V22 + 65, (ADL_ONE * 8617n) / 10_000n);
    const s = decodeAdlState(d)!;
    assert.equal(s.reduceOnly, true);
    assert.equal(observeMarket(d, 1n, null, []).adl?.reduceOnly, true);
    assert.equal(observeMarket(JUP, 1n, null, []).adl?.reduceOnly, false);
  });

  it("NEGATIVE CONTROL: the old v2.1 base (2,374) reads garbage for A on the same v2.2 bytes", () => {
    assert.notEqual(u128(JUP, ENGINE0_V21 + 49), ADL_ONE);
    assert.notEqual(u128(JUP, ENGINE0_V21 + 65), ADL_ONE);
  });

  it("NEGATIVE CONTROL: an unknown VERSION throws (observeMarket reports no ADL rather than a guess)", () => {
    const d = new Uint8Array(JUP);
    new DataView(d.buffer).setUint16(8, 20, true);
    assert.throws(() => decodeAdlState(d), /unknown market layout/);
    assert.equal(observeMarket(d, 1n, null, []).adl, null);
  });

  it("the P2b wind-down view stays v2.1-only (it reads the rest of the asset at v2.1 offsets): null on v2.2", () => {
    assert.equal(readWindDownView(JUP, 0, 1n), null);
  });
});

describe("K-9 sweep: terminal-insurance's asset-0 insurance authority on v2.2", () => {
  it("real v2.2 SOL: insurance_authority = the stake pool's vault authority PDA (stake-bound), read at 592 + 806", async () => {
    const { PublicKey } = await import("@solana/web3.js");
    const { deriveStakePool, deriveStakeVaultAuth } = await import("@percolatorct/sdk");
    const { asset0InsuranceAuthority } = await import("./terminal-insurance.ts");
    const { parseAssetOracleProfileV17 } = await import("@percolatorct/sdk");
    const stake = new PublicKey("7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V");
    const [pool] = deriveStakePool(new PublicKey("BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5"), stake);
    const [vaultAuth] = deriveStakeVaultAuth(pool, stake);
    assert.equal(asset0InsuranceAuthority(SOL)?.toBase58(), vaultAuth.toBase58());
    // NEGATIVE CONTROL: the old v2.1 group length (758) reads a different key.
    assert.notEqual(parseAssetOracleProfileV17(SOL, 592 + 758).insuranceAuthority.toBase58(), vaultAuth.toBase58());
  });
});
