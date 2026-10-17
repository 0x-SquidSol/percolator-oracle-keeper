/**
 * Tests for the recovery-cranker's PermissionlessCrank wire format.
 *
 * v16-migration wire sync (VERSION 17 -> 18, dcccrypto/percolator-prog
 * `sync/integration-v16` @ `a9318945`, dcccrypto/percolator-sdk
 * `sync/v16-migration-version18`): the wrapper's PermissionlessCrank
 * instruction (tag 5) no longer takes a caller-chosen `action` /
 * `assetIndex` / `recoveryReason`. The v18 decoder
 * (`v16_program.rs` `Instruction::decode`, arm `5 =>`) reads:
 *
 *   now_slot: u64
 *   n: u8                                    (<= CRANK_OBSERVATION_DECODE_MAX = 16)
 *   n x { asset_index: u16, oracle_accounts: u8 }   ("observations")
 *
 * i.e. tag(1) + now_slot(8) + n(1) + n*(2+1) = 10 + 3n bytes.
 *
 * This loop sends exactly one observation hint, `{ assetIndex: 0,
 * oracleAccounts: 0 }` — these are single-asset (index 0) AUTH_MARK-mode
 * markets, so the wrapper's crank-price primitive
 * (`hybrid_effective_price_for_crank_view`) reads the committed
 * `mark_ewma_e6` directly and needs zero external oracle accounts (see the
 * module doc comment on recovery-cranker.ts for the full reasoning). That
 * makes the wire 13 bytes: tag(1) + now_slot(8) + n=1(1) + assetIndex(2) +
 * oracleAccounts(1).
 *
 * This pins the EXACT bytes buildCrankIx() sends every cycle so a
 * regression back to the pre-migration 29-byte layout, or ANY drift from
 * the v18 `Instruction::PermissionlessCrank` decode arm, fails loudly
 * instead of silently breaking every crank against a v18 wrapper.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/recovery-cranker.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buildCrankIx } from "./recovery-cranker.ts";
import { IX_TAG, PROGRAM_IDS_DEVNET_V1, PROGRAM_IDS_V17, CRANK_OBSERVATION_DECODE_MAX } from "@percolatorct/sdk";

const OWNER = PublicKey.unique();
const MARKET = PublicKey.unique();
const PORTFOLIO = PublicKey.unique();

// Fresh devnet triple — deployed + upgraded 2026-07-17, hash-verified on-chain.
const FRESH_WRAPPER = process.env.WRAPPER_PROGRAM_ID?.trim() || "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";

// Superseded 2026-06-26 wrapper — still live on devnet with ~152 existing
// markets, but no longer the SDK default. buildCrankIx must NOT target it.
const OLD_WRAPPER = "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9";

/**
 * Mirrors the v18 wrapper's own decode arm (`v16_program.rs`, `5 => { ... }`)
 * byte-for-byte, independent of the SDK's own encoder/decoder, so a bug that
 * happened to be symmetric in the SDK (encode+decode both wrong the same way)
 * would still be caught here.
 */
function decodePermissionlessCrankLikeWrapper(data: Uint8Array): {
  tag: number;
  nowSlot: bigint;
  observations: { assetIndex: number; oracleAccounts: number }[];
} {
  let off = 0;
  const tag = data[off];
  off += 1;
  const nowSlot = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(off, true);
  off += 8;
  const n = data[off];
  off += 1;
  assert.ok(n <= CRANK_OBSERVATION_DECODE_MAX, `n=${n} exceeds CRANK_OBSERVATION_DECODE_MAX`);
  const observations: { assetIndex: number; oracleAccounts: number }[] = [];
  for (let i = 0; i < n; i++) {
    const assetIndex = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(off, true);
    off += 2;
    const oracleAccounts = data[off];
    off += 1;
    observations.push({ assetIndex, oracleAccounts });
  }
  assert.equal(off, data.length, "decoder did not consume the whole buffer (extra/missing bytes)");
  return { tag, nowSlot, observations };
}

describe("buildCrankIx — PermissionlessCrank v18 (v16-migration) wire format", () => {
  it("produces exactly 13 bytes (10 + 3*n, n=1; pre-migration was 29)", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.data.length, 13);
  });

  it("pins the full 13-byte payload byte for byte", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    // tag(5) + nowSlot(u64=0, 8 bytes) + n(u8=1) + observations[0]:
    // assetIndex(u16=0) + oracleAccounts(u8=0). All-zero apart from the tag
    // byte and the n=1 byte at offset 9 — this loop always cranks with
    // nowSlot=0 and exactly one hint naming asset 0 with 0 oracle accounts.
    const expected = new Uint8Array(13); // zero-filled
    expected[0] = IX_TAG.PermissionlessCrank; // tag
    expected[9] = 1; // n = observations.length
    assert.deepEqual([...ix.data], [...expected]);
  });

  it("tag byte is IX_TAG.PermissionlessCrank (5)", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.data[0], IX_TAG.PermissionlessCrank);
    assert.equal(ix.data[0], 5);
  });

  it("does NOT emit the pre-migration 29-byte layout (regression guard)", () => {
    // The pre-migration wire (action/assetIndex/nowSlot/fundingRateE9/
    // recoveryReason) was 29 bytes. If buildCrankIx ever regressed to that
    // shape (or any other non-v18 shape), this length check catches it even
    // before the byte-exact pin above would.
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.notEqual(ix.data.length, 29);
  });

  it("decodes (via an independent, wrapper-decode-arm-shaped parser) to nowSlot=0n, one observation {assetIndex:0, oracleAccounts:0}", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    const decoded = decodePermissionlessCrankLikeWrapper(ix.data);
    assert.equal(decoded.tag, 5);
    assert.equal(decoded.nowSlot, 0n);
    assert.equal(decoded.observations.length, 1);
    assert.deepEqual(decoded.observations[0], { assetIndex: 0, oracleAccounts: 0 });
  });

  it("NEGATIVE CONTROL: a malformed/old-shape payload is NOT accepted by the wrapper-shaped decoder", () => {
    // Simulates what the OLD 29-byte wire (tag + action + assetIndex(u16) +
    // nowSlot(u64) + fundingRateE9(i128) + recoveryReason) would look like if
    // sent against the v18 decoder: tag(5) is followed by 3 non-zero bytes
    // (action=0, assetIndex=0 LE, but then nowSlot's LOW byte lands where the
    // v18 decoder expects nowSlot's low byte too — the shapes only coincide
    // when every field is zero). Use a nonzero action/assetIndex byte
    // pattern so the misparse is detectable: old wire's byte[1] (action)
    // would be misread by the v18 decoder as the low byte of `now_slot`.
    const oldShapeBadPayload = new Uint8Array(29);
    oldShapeBadPayload[0] = 5; // tag
    oldShapeBadPayload[1] = 1; // old "action" byte = Liquidate (nonzero, on purpose)
    // Old-wire n/observation-count byte is absent; the v18 decoder will read
    // whatever byte lands at offset 9 as `n`. Construct that byte to exceed
    // CRANK_OBSERVATION_DECODE_MAX so a real wrapper would hard-reject it
    // with InvalidInstructionData rather than silently misparsing further.
    oldShapeBadPayload[9] = 255;
    assert.throws(
      () => decodePermissionlessCrankLikeWrapper(oldShapeBadPayload),
      /exceeds CRANK_OBSERVATION_DECODE_MAX/,
      "an old-shape (or otherwise malformed) payload must be rejected, not silently accepted",
    );
    // And buildCrankIx's REAL output must never match this malformed shape.
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.notDeepEqual([...ix.data], [...oldShapeBadPayload]);
  });

  it("targets the v1 (ETDLAdi) wrapper the keeper resolves at runtime, not the SDK's moved v2.1 default", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.programId.toBase58(), PROGRAM_IDS_DEVNET_V1.percolator);
    assert.notEqual(ix.programId.toBase58(), PROGRAM_IDS_V17.percolator);
  });

  // 2026-07-17 fresh devnet triple cutover: the assertion above re-imports
  // PROGRAM_IDS_V17 from the same SDK module buildCrankIx reads from, so it
  // is a vacuous self-check — it would pass no matter which program the SDK
  // currently points at. These two pin the LITERAL addresses instead, so a
  // silent SDK regression back to (or drift away from) the fresh wrapper is
  // caught here independent of PROGRAM_IDS_V17's current contents.
  it("targets the fresh devnet wrapper (literal pin, 2026-07-17 cutover)", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.programId.toBase58(), FRESH_WRAPPER);
  });

  it("does NOT target the superseded 2026-06-26 wrapper", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.notEqual(ix.programId.toBase58(), OLD_WRAPPER);
  });

  it("account order is [owner(signer,writable), market(writable), portfolio(writable)] — unchanged by the v18 wire (no oracle tail needed for oracleAccounts=0)", () => {
    const ix = buildCrankIx(OWNER, MARKET, PORTFOLIO);
    assert.equal(ix.keys.length, 3);
    assert.equal(ix.keys[0].pubkey.toBase58(), OWNER.toBase58());
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[1].pubkey.toBase58(), MARKET.toBase58());
    assert.equal(ix.keys[1].isWritable, true);
    assert.equal(ix.keys[2].pubkey.toBase58(), PORTFOLIO.toBase58());
    assert.equal(ix.keys[2].isWritable, true);
  });
});

// ── 2026-09-28: LP-portfolio discovery must recognise the v18 layout ──
// Fixtures are verbatim devnet account bytes (wrapper GnwdeQr, SOL market
// AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr):
//   sol-lp-portfolio-v18      3oDTvjEP… — the real matcher-enabled LP portfolio (9563 B)
//   sol-trader-portfolio-v18  HyKpWvnu… — an ordinary trader portfolio (9563 B)
//   sol-kind3-240b-v18        QA6VQNU9… — a 240 B kind-3 account sharing the portfolio
//                             magic + market prefix; the old check selected it, and every
//                             crank against it reverted InsufficientFundsForRent.
import { readFileSync } from "node:fs";
import { isLpVaultPortfolio } from "./recovery-cranker.ts";

const fixture = (name: string): Buffer =>
  Buffer.from(readFileSync(new URL(`./__fixtures__/${name}.b64`, import.meta.url), "utf8"), "base64");

describe("isLpVaultPortfolio (v18 layout)", () => {
  it("accepts the live v18 LP (matcher-enabled) portfolio", () => {
    assert.equal(isLpVaultPortfolio(fixture("sol-lp-portfolio-v18")), true);
  });
  it("rejects an ordinary v18 trader portfolio", () => {
    assert.equal(isLpVaultPortfolio(fixture("sol-trader-portfolio-v18")), false);
  });
  it("rejects the 240-byte kind-3 account that the v17-offset check selected", () => {
    assert.equal(isLpVaultPortfolio(fixture("sol-kind3-240b-v18")), false);
  });
});
