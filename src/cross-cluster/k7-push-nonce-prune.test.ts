/**
 * K-7 (fresh v2.2 devnet, 2026-10-11): 411 landed PushAuthMark batches reverted Custom(19) at "ix 1" (SOL, the first
 * market) in 30 h, each voiding the whole 8-market batch.
 *
 * Root cause, from chain: every failure is a PAIR of the keeper's own batches carrying the SAME observation_sequence
 * from two different cycles (different nowSlot) that landed in the same slot; the first wins, the second reverts.
 * The 2026-09-28 local nonce reservation (lastSentObservationSequence) should prevent that, but
 * pruneDeregisteredMarkets runs at the top of EVERY cycle and pruneAuthMarkPusherState compared the reservation keys
 * (`${market}:${assetIndex}`) with bare market addresses, so it deleted every reservation every cycle.
 *
 * Also: landed-revert fault isolation (a market that keeps reverting on chain is pushed in its own tx).
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/k7-push-nonce-prune.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
} from "@percolatorct/sdk";
import {
  SOLO_AFTER_LANDED_REVERTS,
  generationKeyMarket,
  getSoloMarkets,
  pruneAuthMarkPusherState,
  pushAuthMarkBatch,
  pushLandingStats,
  reconcilePushOutcomes,
  resetPushLandingState,
} from "./auth-mark-pusher.ts";
import { pruneDeregisteredMarkets } from "./keeper-loop.ts";
import { nonComputeBudget } from "./test-ix.ts";
import type { PublicKey } from "@solana/web3.js";

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };

function marketAccount(oracleObservation: bigint): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const v = new DataView(buf.buffer);
  v.setBigUint64(0, V17_MAGIC, true);
  v.setUint16(8, V17_EXPECTED_VERSION, true);
  v.setBigUint64(marketIdOff, 1n, true);
  v.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, oracleObservation, true);
  return buf;
}

type IxLike = { programId: PublicKey; keys: Array<{ pubkey: { toBase58(): string } }>; data: Uint8Array };
const seqOf = (ix: IxLike) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(27, true);

/** Chain whose read view does NOT see our in-flight txs (they land later): the K-7 condition. */
function chain(markets: string[], start = 100n, landedErr: (pos: number) => unknown = () => null) {
  const watermark = new Map(markets.map((m) => [m, start]));
  const sent: Array<{ markets: string[]; seqs: bigint[] }> = [];
  let sig = 0;
  return {
    sent,
    conn: {
      async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
        return pks.map((pk) => ({ data: marketAccount(watermark.get(pk.toBase58()) ?? 0n) }));
      },
      async simulateTransaction() {
        return { value: { err: null } };
      },
      async sendRawTransaction(raw: Uint8Array) {
        void raw;
        return `sig${++sig}`;
      },
      async getSignatureStatuses(sigs: string[]) {
        return { value: sigs.map(() => ({ err: landedErr(0) })) };
      },
    },
    /** Capture the pushes of the tx being sent (keeper builds then simulates, so use simulate for decoding). */
    capture(conn: { simulateTransaction: (tx: { instructions: IxLike[] }) => Promise<unknown> }) {
      conn.simulateTransaction = async (tx: { instructions: IxLike[] }) => {
        const ixs = nonComputeBudget(tx.instructions);
        sent.push({ markets: ixs.map((ix) => ix.keys[1].pubkey.toBase58()), seqs: ixs.map(seqOf) });
        return { value: { err: null } };
      };
    },
  };
}

const mkts = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
const asPushes = (ms: string[]) => ms.map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n }));
const loopState = (ms: string[]) => ({
  stats: new Map(ms.map((m) => [m, {} as never])),
  terminalMarkets: new Set<string>(),
  landedThisCycle: new Set<string>(),
});

beforeEach(() => resetPushLandingState());

describe("K-7 root cause: the per-cycle prune must not wipe the nonce reservation", () => {
  it("generationKeyMarket strips the asset index", () => {
    assert.equal(generationKeyMarket("BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5:0"), "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5");
    assert.equal(generationKeyMarket("abc"), "abc");
  });

  it("two cycles with the REAL per-cycle prune (pruneDeregisteredMarkets) in between never reuse a nonce while cycle 1 is unlanded", async () => {
    const ms = mkts(8);
    const c = chain(ms);
    c.capture(c.conn as never);
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
    pruneDeregisteredMarkets(loopState(ms) as never, { markets: ms.map((m) => ({ marketAddress: m })) } as never);
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);
    assert.equal(c.sent.length, 2);
    for (let i = 0; i < 8; i++) assert.ok(c.sent[1].seqs[i] > c.sent[0].seqs[i], `market ${i}: ${c.sent[0].seqs[i]} then ${c.sent[1].seqs[i]}`);
  });

  it("a DEREGISTERED market's reservation is still dropped (the prune keeps its purpose)", async () => {
    const ms = mkts(2);
    const c = chain(ms);
    c.capture(c.conn as never);
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
    pruneAuthMarkPusherState(new Set([ms[0]])); // ms[1] retired
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);
    assert.ok(c.sent[1].seqs[0] > c.sent[0].seqs[0], "kept market keeps its reservation");
    assert.equal(c.sent[1].seqs[1], c.sent[0].seqs[1], "retired market's reservation was forgotten (chain + 1 again)");
  });

  it("NEGATIVE CONTROL: without a reservation (what the old prune left) cycle 2 re-proposes cycle 1's nonce — the on-chain K-7 pair", async () => {
    const ms = mkts(8);
    const c = chain(ms);
    c.capture(c.conn as never);
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
    pruneAuthMarkPusherState(new Set()); // equivalent to the old keyed-mismatch prune: every reservation gone
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);
    assert.deepEqual(c.sent[1].seqs, c.sent[0].seqs);
  });
});

describe("K-7 fault isolation: a market that keeps reverting on chain is pushed in its own tx", () => {
  /** Landed revert at push position `pos` (ix pos+1), Custom(19), on the LATEST nonce (not a superseded late duplicate). */
  async function landRevert(c: ReturnType<typeof chain>, pos: number, n: number, ms: string[], keeper: Keypair) {
    (c.conn as { getSignatureStatuses: unknown }).getSignatureStatuses = async (sigs: string[]) => ({
      value: sigs.map(() => ({ err: { InstructionError: [pos + 1, { Custom: 19 }] } })),
    });
    for (let k = 0; k < n; k++) {
      await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), BigInt(200 + k), BLOCKHASH, false);
      await reconcilePushOutcomes(c.conn as never, Date.now() + 5_000);
    }
  }

  it(`after ${SOLO_AFTER_LANDED_REVERTS} landed reverts attributed to market #2, it goes solo and the other 7 still batch together`, async () => {
    const ms = mkts(8);
    const c = chain(ms);
    c.capture(c.conn as never);
    const keeper = Keypair.generate();
    // Market #2's nonce is advanced by "someone else" each time: keep the reverts NOT superseded by bumping its chain view.
    await landRevert(c, 2, SOLO_AFTER_LANDED_REVERTS, ms, keeper);
    assert.deepEqual(getSoloMarkets(), [ms[2]]);
    assert.ok(pushLandingStats.otherReverts >= SOLO_AFTER_LANDED_REVERTS);
    c.sent.length = 0;
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 300n, BLOCKHASH, false);
    const shapes = c.sent.map((t) => t.markets.length).sort();
    assert.deepEqual(shapes, [1, 7]);
    assert.deepEqual(c.sent.find((t) => t.markets.length === 1)!.markets, [ms[2]]);
  });

  it("NEGATIVE CONTROL: one landed revert (below the threshold) does not isolate anyone", async () => {
    const ms = mkts(8);
    const c = chain(ms);
    c.capture(c.conn as never);
    await landRevert(c, 2, 1, ms, Keypair.generate());
    assert.deepEqual(getSoloMarkets(), []);
  });

  it("NEGATIVE CONTROL: superseded late duplicates (a higher nonce of ours already sent) never isolate", async () => {
    const ms = mkts(3);
    const c = chain(ms);
    c.capture(c.conn as never);
    const keeper = Keypair.generate();
    // Send 3 cycles first (reservation climbs), then report every older tx as a Custom(19) revert: all superseded.
    for (let k = 0; k < 3; k++) await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), BigInt(100 + k), BLOCKHASH, false);
    await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 200n, BLOCKHASH, false);
    (c.conn as { getSignatureStatuses: unknown }).getSignatureStatuses = async (sigs: string[]) => ({
      value: sigs.map((_, i) => (i < sigs.length - 1 ? { err: { InstructionError: [1, { Custom: 19 }] } } : { err: null })),
    });
    await reconcilePushOutcomes(c.conn as never, Date.now() + 5_000);
    assert.equal(pushLandingStats.lateDuplicateReverts, 3);
    assert.deepEqual(getSoloMarkets(), []);
  });
});
