/**
 * Literal-pinned regression test for the auth-mark-pusher's wrapper program id
 * (2026-07-17 fresh devnet triple cutover — security/auth-mark-pusher-version-gate).
 *
 * auth-mark-pusher.ts sources WRAPPER_PROGRAM_ID directly from the SDK's
 * PROGRAM_IDS_V17.percolator constant (not an env var). Asserting
 * `WRAPPER_PROGRAM_ID.toBase58() === PROGRAM_IDS_V17.percolator` would be a
 * vacuous self-check — both sides read the same constant, so the assertion
 * can never fail regardless of which program the SDK actually points at.
 *
 * These tests instead pin the LITERAL fresh wrapper address so a future SDK
 * bump that silently reverts (or drifts) the devnet default is caught here,
 * independent of whatever PROGRAM_IDS_V17 currently contains. They also pin
 * the LITERAL superseded (2026-06-26) wrapper address as a must-not-equal
 * guard — the old wrapper is still live on devnet with ~152 existing markets,
 * so accidentally targeting it again would silently push marks to the wrong
 * program's markets (or fail with a signer/owner mismatch there).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/auth-mark-pusher.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

// Fresh devnet wrapper — v18 migration deploy 2026-09-22, byte-verified on-chain
// (a FRESH program id; the SDK's declare_id is a placeholder — PDAs follow the
// runtime deploy address). This is a deliberate literal pin, NOT a re-import of
// the SDK constant, so a wrapper cutover forces a conscious update here.
// The keeper resolves its wrapper from env WRAPPER_PROGRAM_ID, else the pinned v1 default (program-ids.ts). It is NOT the v18 id any more.
const FRESH_WRAPPER = process.env.WRAPPER_PROGRAM_ID?.trim() || "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";

// Superseded wrappers — still resolvable on devnet but no longer the target.
const OLD_WRAPPER = "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9"; // 2026-06-26
const OLD_WRAPPER_V17 = "DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj"; // 2026-07-17 v17, abandoned at v18

describe("auth-mark-pusher WRAPPER_PROGRAM_ID — v18 cutover (2026-09-22)", () => {
  it("targets the fresh devnet wrapper (literal pin, not a re-import of the SDK constant)", () => {
    assert.equal(WRAPPER_PROGRAM_ID.toBase58(), FRESH_WRAPPER);
  });

  it("does NOT target the superseded 2026-06-26 wrapper", () => {
    assert.notEqual(WRAPPER_PROGRAM_ID.toBase58(), OLD_WRAPPER);
  });

  it("does NOT target the abandoned v17 wrapper", () => {
    assert.notEqual(WRAPPER_PROGRAM_ID.toBase58(), OLD_WRAPPER_V17);
  });
});

// ── Batch poisoning (2026-07-27) ──────────────────────────────────────────────
//
// PushAuthMark is atomic per transaction: if ANY market in the batch is
// ineligible (engine locked -> Custom(21), slot regression -> Custom(19), junk
// slab -> Custom(8)), the WHOLE transaction reverts and every healthy market
// batched with it silently misses its price. Reproduced on devnet: `[good]`
// lands, `[good, good]` lands, `[good, junk]` reverts entirely.
//
// The old send loop made this invisible AND unrecoverable:
//   - `skipPreflight: true` with no confirmation -> a reverting chunk never errored
//   - `pushedCount += chunk.length` on SEND -> the keeper reported success
//   - no health filter -> the same bad market poisoned every subsequent cycle
//
// These tests drive pushAuthMarkBatch against a fake Connection so the
// isolate-and-quarantine behaviour is verified without touching devnet.

import { Keypair } from "@solana/web3.js";
import { pushAuthMarkBatch, getQuarantinedMarkets } from "./auth-mark-pusher.ts";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
} from "@percolatorct/sdk";

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

// ── v18 synthetic market-account buffer ─────────────────────────────────────
//
// pushAuthMarkBatch now live-reads market_id + observation_sequence via a
// batched getMultipleAccountsInfo call (see auth-mark-pusher.ts's
// `fetchPushAuthMarkGenerationFields` / `parsePushAuthMarkGenerationFields`),
// so the fake Connection must hand back bytes that actually parse as a v18
// market account: valid magic + VERSION header, market_id at
// profileOff + V17_ASSET_ORACLE_WRAPPER_LEN (AssetStateV16Account's first
// field, per that function's doc comment), and the OracleObservation
// watermark at profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF (relative offset
// 0 within AssetControlSequencesV16).
function buildV18MarketAccount(params: {
  assetIndex: number;
  marketId: bigint;
  oracleObservation: bigint;
}): Uint8Array {
  const profileOff =
    V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + params.assetIndex * V17_MARKET_ASSET_SLOT_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const oracleObservationOff = profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, params.marketId, true);
  view.setBigUint64(oracleObservationOff, params.oracleObservation, true);
  return buf;
}

/**
 * Independent, wrapper-decode-arm-shaped parser for the v18 PushAuthMark
 * wire (tag 63) — see v17-oracle-push.test.ts's `decodePushAuthMarkLikeWrapper`
 * for the same pattern with its own citation of v16_program.rs's decode arm.
 * Duplicated here (not imported) so each test file's wire assertions stand
 * on their own.
 */
function decodePushAuthMarkLikeWrapper(data: Uint8Array): {
  tag: number;
  assetIndex: number;
  marketId: bigint;
  nowSlot: bigint;
  markE6: bigint;
  observationSequence: bigint;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const readU64 = (off: number): bigint => {
    const lo = view.getUint32(off, true);
    const hi = view.getUint32(off + 4, true);
    return (BigInt(hi) << 32n) | BigInt(lo);
  };
  return {
    tag: view.getUint8(0),
    assetIndex: view.getUint16(1, true),
    marketId: readU64(3),
    nowSlot: readU64(11),
    markE6: readU64(19),
    observationSequence: readU64(27),
  };
}

/** Default generation fields for a market not explicitly registered in `fields`. */
const DEFAULT_FIELDS = { marketId: 1n, oracleObservation: 0n };

/**
 * Connection stub. `badMarkets` revert in simulation; anything else passes.
 * `unreadable` markets return a null account from getMultipleAccountsInfo
 * (simulating an RPC miss / not-yet-created account) so they must be
 * dropped from the batch, never pushed with a guessed market_id/
 * observation_sequence. `fields` overrides the default (marketId=1,
 * oracleObservation=0) generation fields per market, so tests can assert on
 * the exact bytes the batch emits.
 * Records which market sets were simulated and which were actually sent, and
 * the raw PushAuthMark ix data of every simulated transaction (for wire
 * assertions).
 */
function fakeConn(
  badMarkets: Set<string>,
  opts?: { unreadable?: Set<string>; fields?: Map<string, { marketId: bigint; oracleObservation: bigint }> },
) {
  const simulated: string[][] = [];
  const simulatedData: Uint8Array[][] = [];
  const sent: string[][] = [];
  const unreadable = opts?.unreadable ?? new Set<string>();
  const fields = opts?.fields ?? new Map<string, { marketId: bigint; oracleObservation: bigint }>();
  return {
    simulated,
    simulatedData,
    sent,
    conn: {
      async getMultipleAccountsInfo(pubkeys: Array<{ toBase58(): string }>) {
        return pubkeys.map((pk) => {
          const addr = pk.toBase58();
          if (unreadable.has(addr)) return null;
          const f = fields.get(addr) ?? DEFAULT_FIELDS;
          return { data: buildV18MarketAccount({ assetIndex: 0, ...f }) };
        });
      },
      // The tx carries one ComputeBudget ix then one PushAuthMark ix per market;
      // the market is account index 1 of each push ix (see ACCOUNTS_PUSH_AUTH_MARK).
      async simulateTransaction(tx: {
        instructions: Array<{ keys: Array<{ pubkey: { toBase58(): string } }>; data: Uint8Array }>;
      }) {
        const pushIxs = tx.instructions.slice(1);
        const marketsInTx = pushIxs.map((ix) => ix.keys[1].pubkey.toBase58());
        simulated.push(marketsInTx);
        simulatedData.push(pushIxs.map((ix) => ix.data));
        // REAL RPC shape: the index names the FIRST failing ix (ix 0 is the
        // ComputeBudget ix, so the push at position k is ix k+1).
        const firstBad = marketsInTx.findIndex((m) => badMarkets.has(m));
        const err = firstBad >= 0 ? { InstructionError: [firstBad + 1, { Custom: 8 }] } : null;
        return { value: { err } };
      },
      async sendRawTransaction() {
        sent.push(simulated[simulated.length - 1]);
        return "sig" + sent.length;
      },
    },
  };
}

/** Distinct, valid base58 pubkeys — module quarantine state is shared across tests. */
function markets(n: number): string[] {
  return Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
}

describe("pushAuthMarkBatch — one bad market must not freeze the others", () => {
  it("isolates the offender and still pushes every healthy market", async () => {
    const [a, b, bad, c] = markets(4);
    const { conn, sent } = fakeConn(new Set([bad]));
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [a, b, bad, c].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n })),
      100n,
      BLOCKHASH,
      false,
    );

    // 3 of 4 pushed — the bad one dropped, the healthy ones NOT taken down with it.
    assert.equal(res.count, 3);
    assert.equal(res.pushed, true);
    const sentMarkets = sent.flat();
    assert.deepEqual(new Set(sentMarkets), new Set([a, b, c]));
    assert.ok(!sentMarkets.includes(bad), "the reverting market must never be sent");

    // Per-market outcome — the caller (keeper-loop) stamps lastPushAt from
    // these. Reporting the whole input batch as pushed is what made a frozen
    // price look fresh on /health.
    assert.deepEqual(new Set(res.pushedMarkets), new Set([a, b, c]));
    assert.deepEqual(res.skippedMarkets, [bad]);
  });

  it("does NOT report a reverting single-market push as success (phantom-success guard)", async () => {
    const [bad] = markets(1);
    const { conn, sent } = fakeConn(new Set([bad]));
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [{ marketAddress: bad, assetIndex: 0, priceE6: 1_000_000n }],
      100n,
      BLOCKHASH,
      false,
    );
    assert.equal(res.count, 0);
    assert.equal(res.pushed, false);
    assert.equal(sent.length, 0);
    assert.deepEqual(res.pushedMarkets, []);
    assert.deepEqual(res.skippedMarkets, [bad], "a revert must be reported as skipped, not pushed");
  });

  it("quarantines a repeat offender after 3 strikes so it stops costing a cycle", async () => {
    const [good, bad] = markets(2);
    const { conn, simulated } = fakeConn(new Set([bad]));
    const keeper = Keypair.generate();
    const pushes = [good, bad].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n }));

    for (let i = 0; i < 3; i++) {
      await pushAuthMarkBatch(conn as never, keeper, pushes, 100n, BLOCKHASH, false);
    }
    assert.ok(getQuarantinedMarkets().includes(bad), "3 reverts should quarantine the market");

    // 4th cycle: the bad market is filtered out BEFORE chunking, so it is never
    // simulated again — and the good market still gets its price.
    const before = simulated.length;
    const res = await pushAuthMarkBatch(conn as never, keeper, pushes, 100n, BLOCKHASH, false);
    assert.equal(res.count, 1);
    assert.deepEqual(res.pushedMarkets, [good]);
    assert.deepEqual(res.skippedMarkets, [bad], "a quarantined market must be reported as skipped");
    for (const set of simulated.slice(before)) {
      assert.ok(!set.includes(bad), "a quarantined market must not be simulated");
    }
  });

  it("clears strikes once a market pushes cleanly again", async () => {
    const [flaky] = markets(1);
    const keeper = Keypair.generate();
    const push = [{ marketAddress: flaky, assetIndex: 0, priceE6: 1_000_000n }];

    // Two strikes (one short of quarantine)…
    const failing = fakeConn(new Set([flaky]));
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);

    // …then it recovers, which must reset the counter…
    const healthy = fakeConn(new Set());
    await pushAuthMarkBatch(healthy.conn as never, keeper, push, 100n, BLOCKHASH, false);

    // …so two further failures still do not quarantine it.
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);
    await pushAuthMarkBatch(failing.conn as never, keeper, push, 100n, BLOCKHASH, false);
    assert.ok(!getQuarantinedMarkets().includes(flaky), "a clean push must reset the strike count");
  });
});

// ── v18 PushAuthMark wire: market_id + observation_sequence live-read ─────────
//
// Added for the v18 migration (percolator-prog sync/integration-v16@a9318945).
// See auth-mark-pusher.ts's `parsePushAuthMarkGenerationFields` doc comment
// for the full derivation of both fields' semantics.

describe("pushAuthMarkBatch — v18 market_id + observation_sequence", () => {
  it("encodes the live-read market_id and (current watermark + 1) observation_sequence", async () => {
    const [a] = markets(1);
    const marketId = 77n;
    const oracleObservation = 4n;
    const { conn, simulatedData } = fakeConn(new Set(), {
      fields: new Map([[a, { marketId, oracleObservation }]]),
    });
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [{ marketAddress: a, assetIndex: 0, priceE6: 1_000_000n }],
      100n,
      BLOCKHASH,
      false,
    );
    assert.equal(res.pushed, true, "sanity: the push must have gone out");
    assert.equal(simulatedData.length, 1);
    const decoded = decodePushAuthMarkLikeWrapper(simulatedData[0][0]);
    assert.equal(decoded.tag, 63);
    assert.equal(decoded.marketId, marketId, "market_id must be the LIVE-read value, not a placeholder");
    assert.equal(
      decoded.observationSequence,
      oracleObservation + 1n,
      "observation_sequence must be the current stored watermark + 1 — " +
        "handle_push_auth_mark's require_newer_control_sequence rejects anything <= current",
    );
  });

  it("drops a market whose account cannot be read this cycle, without guessing its fields", async () => {
    const [a, unreadable] = markets(2);
    const { conn, sent } = fakeConn(new Set(), { unreadable: new Set([unreadable]) });
    const res = await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      [a, unreadable].map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n })),
      100n,
      BLOCKHASH,
      false,
    );
    assert.deepEqual(res.pushedMarkets, [a]);
    assert.deepEqual(res.skippedMarkets, [unreadable], "an unreadable account must be skipped, not pushed with guessed fields");
    assert.ok(!sent.flat().includes(unreadable));
  });

  it("issues exactly ONE getMultipleAccountsInfo call for the whole batch (RPC-budget guard)", async () => {
    const batchMarkets = markets(5);
    let calls = 0;
    const base = fakeConn(new Set());
    const conn = {
      ...base.conn,
      async getMultipleAccountsInfo(pubkeys: Array<{ toBase58(): string }>) {
        calls++;
        return base.conn.getMultipleAccountsInfo(pubkeys);
      },
    };
    await pushAuthMarkBatch(
      conn as never,
      Keypair.generate(),
      batchMarkets.map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n })),
      100n,
      BLOCKHASH,
      false,
    );
    assert.equal(calls, 1, "one batched call for N markets, not N individual getAccountInfo calls");
  });
});
