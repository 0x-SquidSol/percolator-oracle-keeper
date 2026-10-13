/**
 * K-7 (found on the fresh v2.2 devnet, 2026-10-11; same code on relaunch-live): landed PushAuthMark batches reverted
 * Custom(19) at "ix 1" (the first market), each voiding the whole batch.
 *
 * Root cause, from chain: every failure is a PAIR of the keeper's own batches carrying the SAME observation_sequence
 * from two different cycles (different nowSlot) that landed in the same slot; the first wins, the second reverts.
 * The 2026-09-28 local nonce reservation (lastSentObservationSequence) should prevent that, but
 * pruneDeregisteredMarkets runs at the top of EVERY cycle and pruneAuthMarkPusherState compared the reservation keys
 * (`${market}:${assetIndex}`) with bare market addresses, so it deleted every reservation every cycle.
 *
 * Hand port of the prune fix from feat/v22-keeper 4391e5d (the landed-revert solo isolation in that commit is NOT ported).
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
  generationKeyMarket,
  pruneAuthMarkPusherState,
  pushAuthMarkBatch,
  resetPushLandingState,
} from "./auth-mark-pusher.ts";
import { pruneDeregisteredMarkets } from "./keeper-loop.ts";

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

type IxLike = { keys: Array<{ pubkey: { toBase58(): string } }>; data: Uint8Array };
const seqOf = (ix: IxLike) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(27, true);

/** Chain whose read view does NOT see our in-flight txs (they land later): the K-7 condition. */
function chain(markets: string[], start = 100n) {
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
        return { value: sigs.map(() => ({ err: null })) };
      },
    },
    /** Capture the pushes of the tx being sent (keeper builds then simulates, so use simulate for decoding). */
    capture(conn: { simulateTransaction: (tx: { instructions: IxLike[] }) => Promise<unknown> }) {
      conn.simulateTransaction = async (tx: { instructions: IxLike[] }) => {
        const ixs = tx.instructions.slice(1);
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
