/**
 * PushAuthMark Custom(19) / EngineStale self-race (2026-09-28).
 *
 * The live keeper (df2b5e5) logged, every few cycles:
 *   [push] chunk of 3 reverted in preflight — retrying individually to isolate the bad market
 *   [push] 3 push(es) failed — 7UrCpWSA…: {"InstructionError":[1,{"Custom":19}]} | CjdnH8fT…: … | HGBsy58V…: …
 * and on-chain ~5% of LANDED push txs reverted with the same error, e.g. (SOL slab):
 *   slot 505273955 ok   nowSlot=505273951 seq=253915
 *   slot 505273956 ERR  nowSlot=505273944 seq=253915   {"InstructionError":[1,{"Custom":19}]}
 * i.e. two consecutive cycles proposed the SAME observation_sequence, because
 * the second cycle read the watermark before the first cycle's fire-and-forget
 * tx was visible. handle_push_auth_mark -> advance_control_sequence_view ->
 * require_newer_control_sequence: `if proposed <= current { EngineStale }`.
 *
 * The fake below models the wrapper's nonce rule and the RPC's REAL error
 * shape (`{"InstructionError":[i,{"Custom":n}]}`, ix 0 = ComputeBudget), with
 * a read view that can lag the bank the preflight/execution runs on.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/push-nonce-race.test.ts
 */
import { describe, it } from "node:test";
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
import { pushAuthMarkBatch, getQuarantinedMarkets } from "./auth-mark-pusher.ts";
import { nonComputeBudget } from "./test-ix.ts";
import type { PublicKey } from "@solana/web3.js";

const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
const PRICE = 1_000_000n;
const ENGINE_STALE = 19;
const ENGINE_LOCK_ACTIVE = 21;
/** auth-mark-pusher quarantines after 3 strikes — run at least that many cycles. */
const QUARANTINE_CYCLES = 3;

function marketAccount(oracleObservation: bigint): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN; // asset 0
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, oracleObservation, true);
  return buf;
}

type Push = { market: string; seq: bigint };
type IxLike = { programId: PublicKey; keys: Array<{ pubkey: { toBase58(): string } }>; data: Uint8Array };

function decodePushes(ixs: IxLike[]): Push[] {
  return nonComputeBudget(ixs).map((ix) => ({
    market: ix.keys[1].pubkey.toBase58(),
    seq: new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(27, true),
  }));
}

/**
 * Wrapper-rule chain model.
 * - `ledger`: the executed state (what the preflight bank and the leader see).
 * - `readView`: what getMultipleAccountsInfo returns — may LAG the ledger, as
 *   a load-balanced RPC's read node / an unlanded fire-and-forget tx does.
 * - `sentTxs`: submitted txs, NOT executed until `land()` (fire-and-forget).
 * - `locked`: markets that revert with EngineLockActive regardless of nonce.
 */
function chain(marketsList: string[], start = 100n) {
  const ledger = new Map(marketsList.map((m) => [m, start]));
  const readView = new Map(ledger);
  const locked = new Set<string>();
  const sentTxs: Push[][] = [];
  const simulated: Push[][] = [];
  let reads = 0;
  let onRead: ((n: number) => void) | null = null;

  /** Execute `pushes` atomically against `state`; real RPC error shape on failure. */
  const execute = (state: Map<string, bigint>, pushes: Push[], commit: boolean) => {
    const next = new Map(state);
    for (let i = 0; i < pushes.length; i++) {
      const { market, seq } = pushes[i];
      if (locked.has(market)) return { InstructionError: [i + 1, { Custom: ENGINE_LOCK_ACTIVE }] };
      if (seq <= (next.get(market) ?? 0n)) return { InstructionError: [i + 1, { Custom: ENGINE_STALE }] };
      next.set(market, seq);
    }
    if (commit) for (const [k, v] of next) state.set(k, v);
    return null;
  };

  const conn = {
    async getMultipleAccountsInfo(pks: Array<{ toBase58(): string }>) {
      reads++;
      onRead?.(reads);
      return pks.map((pk) => ({ data: marketAccount(readView.get(pk.toBase58()) ?? 0n) }));
    },
    async simulateTransaction(tx: { instructions: IxLike[] }) {
      const pushes = decodePushes(tx.instructions);
      simulated.push(pushes);
      return { value: { err: execute(ledger, pushes, false) } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      void raw;
      sentTxs.push(simulated[simulated.length - 1]);
      return `sig${sentTxs.length}`;
    },
  };

  return {
    conn,
    ledger,
    readView,
    locked,
    sentTxs,
    simulated,
    setOnRead(fn: (n: number) => void) {
      onRead = fn;
    },
    /** Execute sent tx #i against the ledger (it "lands"); returns its on-chain error. */
    land(i: number) {
      return execute(ledger, sentTxs[i], true);
    },
    /** Make the read node catch up with the ledger. */
    syncRead() {
      for (const [k, v] of ledger) readView.set(k, v);
    },
  };
}

function markets(n: number): string[] {
  return Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
}

const asPushes = (ms: string[]) => ms.map((m) => ({ marketAddress: m, assetIndex: 0, priceE6: PRICE }));

describe("PushAuthMark observation_sequence self-race (Custom(19))", () => {
  it("cycle N+1 still pushes every market when cycle N's tx has landed but the read node has not seen it", async () => {
    const ms = markets(4);
    const c = chain(ms);
    const keeper = Keypair.generate();

    // Cycle N: clean.
    const r1 = await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
    assert.equal(r1.count, 4);
    assert.equal(c.land(0), null);
    // The read node lags: it still reports the pre-cycle-N watermark while the
    // preflight bank already executed cycle N (exactly the live preflight case).
    const r2 = await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);

    assert.equal(r2.count, 4, "all 4 markets must still be priced this cycle");
    assert.deepEqual(r2.skippedMarkets, []);
    assert.equal(c.land(1), null, "cycle N+1's tx must execute cleanly on-chain");
    for (const m of ms) assert.ok(!getQuarantinedMarkets().includes(m));
  });

  it("the NEWEST cycle's tx executes on-chain whichever order two in-flight cycles land in", async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const ms = markets(3);
      const c = chain(ms);
      const keeper = Keypair.generate();
      // Two cycles, neither tx landed yet (fire-and-forget), read view static.
      await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
      await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 104n, BLOCKHASH, false);
      assert.equal(c.sentTxs.length, 2);
      const errs = order.map((i) => ({ i, err: c.land(i) }));
      const newest = errs.find((e) => e.i === 1)!;
      assert.equal(
        newest.err,
        null,
        `landing order ${order.join("→")}: the newest price must not revert (got ${JSON.stringify(newest.err)})`,
      );
    }
  });

  it("an externally-advanced nonce (restart / second pusher) is re-read and retried in the SAME cycle, with no strike", async () => {
    const ms = markets(3);
    const c = chain(ms);
    const keeper = Keypair.generate();
    // Each cycle someone else advances the ledger by 5 (a restarted keeper, a
    // second pusher). The FIRST read of a cycle still sees the old value; a
    // re-read sees the ledger.
    let readsThisCycle = 0;
    c.setOnRead(() => {
      readsThisCycle++;
      if (readsThisCycle >= 2) c.syncRead();
    });
    for (let cycle = 0; cycle < QUARANTINE_CYCLES; cycle++) {
      for (const m of ms) c.ledger.set(m, (c.ledger.get(m) ?? 0n) + 1000n);
      readsThisCycle = 0;
      const res = await pushAuthMarkBatch(c.conn as never, keeper, asPushes(ms), 100n, BLOCKHASH, false);
      assert.equal(res.count, 3, `cycle ${cycle}: every market must be priced`);
      assert.equal(c.land(c.sentTxs.length - 1), null);
    }
    for (const m of ms) {
      assert.ok(!getQuarantinedMarkets().includes(m), "a stale nonce is not a bad market — never quarantine for it");
    }
  });
});

describe("one failing market cannot black out the others (real InstructionError index)", () => {
  it("excludes exactly the market the error names and re-sends the rest as ONE tx", async () => {
    const ms = markets(6);
    const c = chain(ms);
    c.locked.add(ms[4]);
    const res = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), asPushes(ms), 100n, BLOCKHASH, false);

    assert.equal(res.count, 5);
    assert.deepEqual(res.skippedMarkets, [ms[4]]);
    assert.equal(c.sentTxs.length, 1, "the healthy 5 go out together, not one tx each");
    assert.deepEqual(
      c.sentTxs[0].map((p) => p.market),
      ms.filter((_, i) => i !== 4),
    );
    assert.equal(c.simulated.length, 2, "full chunk, then the chunk minus the named offender — no per-market sims");
    assert.equal(c.land(0), null);
  });

  it("peels several offenders by index, still in the same cycle", async () => {
    const ms = markets(6);
    const c = chain(ms);
    c.locked.add(ms[0]);
    c.locked.add(ms[5]);
    const res = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), asPushes(ms), 100n, BLOCKHASH, false);
    assert.equal(res.count, 4);
    assert.deepEqual(new Set(res.skippedMarkets), new Set([ms[0], ms[5]]));
    assert.equal(c.sentTxs.length, 1);
  });
});
