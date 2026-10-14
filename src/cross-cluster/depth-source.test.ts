/**
 * Round 2: on-chain DEX depth (PushAuthMark mode 2): pin cache, wire, same-cluster rule, 129 fallback, batch isolation.
 * Run with: node --import tsx/esm --test src/cross-cluster/depth-source.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  V17_MAGIC,
  V17_EXPECTED_VERSION,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_CONTROL_SEQUENCES_OFF,
  encodePushAuthMark,
  buildPushAuthMarkDexIxV22,
} from "@percolatorct/sdk";
import {
  DepthSourceCache,
  decodeActiveDepthSource,
  deriveDepthSource,
  pushDepthOnchainEnabled,
  DEPTH_SOURCE_ACCOUNT_LEN,
} from "./depth-source.ts";
import type { DexDepthPin } from "./depth-source.ts";
import { encodePushAuthMarkDexMode, encodePushAuthMarkMaybeDepth, resolvePushDepth } from "./push-depth.ts";
import { buildPushAuthMarkIx, pushAuthMarkBatch, WRAPPER_PROGRAM_ID } from "./auth-mark-pusher.ts";

const k = () => Keypair.generate().publicKey;
const PUMP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAGIC = 0x5045_5243_5631_3600n;

function pinAccount(o: { active?: boolean; pool: PublicKey; bv: PublicKey; qv: PublicKey; marketId?: bigint; assetIndex?: number; kind?: number }): Buffer {
  const b = Buffer.alloc(DEPTH_SOURCE_ACCOUNT_LEN);
  b.writeBigUInt64LE(MAGIC, 0);
  b.writeUInt16LE(19, 8);
  b[10] = o.kind ?? 16;
  const body = b.subarray(16);
  k().toBuffer().copy(body, 0); // market (non-zero)
  if (o.active !== false) {
    PUMP.toBuffer().copy(body, 32);
    o.pool.toBuffer().copy(body, 64);
    o.bv.toBuffer().copy(body, 96);
    o.qv.toBuffer().copy(body, 128);
    k().toBuffer().copy(body, 160);
    k().toBuffer().copy(body, 192);
    body.writeBigUInt64LE(o.marketId ?? 1n, 224);
    body.writeUInt16LE(o.assetIndex ?? 0, 240);
    body[242] = 6;
    body[243] = 9;
    body[244] = 1;
    body[247] = 1;
  }
  body[245] = 1;
  return b;
}
const acct = (data: Buffer, owner: PublicKey) => ({ data, owner, lamports: 1, executable: false });

/** A fake cluster: address -> account. getMultipleAccountsInfo returns null for anything it does not hold. */
function cluster(accts: Map<string, ReturnType<typeof acct>>, fail = false) {
  let reads = 0;
  return {
    reads: () => reads,
    conn: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        reads++;
        if (fail) throw new Error("rpc down");
        return keys.map((x) => accts.get(x.toBase58()) ?? null);
      },
    },
  };
}

describe("flag", () => {
  it("KEEPER_PUSH_DEPTH_ONCHAIN needs KEEPER_PUSH_DEPTH too; default off", () => {
    assert.equal(pushDepthOnchainEnabled({}), false);
    assert.equal(pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH_ONCHAIN: "on" }), false);
    assert.equal(pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH: "on" }), false);
    assert.equal(pushDepthOnchainEnabled({ KEEPER_PUSH_DEPTH: "on", KEEPER_PUSH_DEPTH_ONCHAIN: "1" }), true);
  });
});

describe("wire", () => {
  const args = { assetIndex: 2, marketId: 5n, nowSlot: 99n, markE6: 1_000_000n, observationSequence: 7n };
  it("mode 2 data = the 35 B + [2][0 u64] (44 B); never produced by the mode-1 encoder", () => {
    const d = encodePushAuthMarkDexMode(args);
    assert.equal(d.length, 44);
    assert.deepEqual(d.slice(0, 35), encodePushAuthMark(args));
    assert.equal(d[35], 2);
    assert.deepEqual([...d.slice(36)], [0, 0, 0, 0, 0, 0, 0, 0]);
    // an attested (mode 1) push with depth 0 can never be built: the encoder throws, and resolvePushDepth never yields 0
    assert.throws(() => encodePushAuthMarkMaybeDepth(args, { depthE6: 0n, source: "x" }), RangeError);
    assert.equal(resolvePushDepth(true, 40n), null);
  });
  it("ix: [authority signer][market w][depth_src][pool][base_vault][quote_vault] read-only; no dex = byte-identical 35 B", () => {
    const auth = k(), market = k();
    const pin: DexDepthPin = { depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, market), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 2, marketId: 5n };
    const ix = buildPushAuthMarkIx(auth, market, 2, 5n, 99n, 1_000_000n, 7n, null, pin);
    assert.equal(ix.keys.length, 6);
    assert.deepEqual(ix.keys.map((x) => x.pubkey.toBase58()), [auth, market, pin.depthSource, pin.pool, pin.baseVault, pin.quoteVault].map((x) => x.toBase58()));
    assert.deepEqual(ix.keys.map((x) => [x.isSigner, x.isWritable]), [[true, false], [false, true], [false, false], [false, false], [false, false], [false, false]]);
    assert.deepEqual(new Uint8Array(ix.data), encodePushAuthMarkDexMode(args));
    const off = buildPushAuthMarkIx(auth, market, 2, 5n, 99n, 1_000_000n, 7n);
    assert.equal(off.keys.length, 2);
    assert.deepEqual(new Uint8Array(off.data), encodePushAuthMark(args));
  });
});

describe("parity with the SDK builder", () => {
  it("mode-2 ix == SDK buildPushAuthMarkDexIxV22 (keys, flags, data)", () => {
    const auth = k(), market = k();
    const pin: DexDepthPin = { depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, market), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 2, marketId: 5n };
    const mine = buildPushAuthMarkIx(auth, market, 2, 5n, 99n, 1_000_000n, 7n, null, pin);
    const sdk = buildPushAuthMarkDexIxV22({ programId: WRAPPER_PROGRAM_ID, oracleAuthority: auth, market, push: { assetIndex: 2, marketId: 5n, nowSlot: 99n, markE6: 1_000_000n, observationSequence: 7n }, pool: pin.pool, baseVault: pin.baseVault, quoteVault: pin.quoteVault });
    assert.deepEqual(mine.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]), sdk.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]));
    assert.deepEqual(new Uint8Array(mine.data), new Uint8Array(sdk.data));
  });
});

describe("DepthSourceCache", () => {
  const market = k();
  const pool = k(), bv = k(), qv = k();
  const pda = deriveDepthSource(WRAPPER_PROGRAM_ID, market).toBase58();
  const onCluster = () => new Map([
    [pda, acct(pinAccount({ pool, bv, qv }), WRAPPER_PROGRAM_ID)],
    [pool.toBase58(), acct(Buffer.alloc(301), PUMP)],
    [bv.toBase58(), acct(Buffer.alloc(165), TOKEN)],
    [qv.toBase58(), acct(Buffer.alloc(165), TOKEN)],
  ]);

  it("PDA present + active + pool/vaults on this cluster -> pin", async () => {
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(onCluster()).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    const pin = c.get(market.toBase58());
    assert.ok(pin && pin.pool.equals(pool) && pin.baseVault.equals(bv) && pin.quoteVault.equals(qv));
  });
  it("PDA absent -> null", async () => {
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(new Map()).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(c.get(market.toBase58()), null);
    assert.equal(c.why(market.toBase58()), "no depth source");
  });
  it("PDA inactive (cleared) / wrong kind / short -> null", async () => {
    for (const data of [pinAccount({ active: false, pool, bv, qv }), pinAccount({ pool, bv, qv, kind: 3 }), Buffer.alloc(100)]) {
      const m = onCluster();
      m.set(pda, acct(data, WRAPPER_PROGRAM_ID));
      const c = new DepthSourceCache(60_000, () => 0);
      await c.refresh(cluster(m).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
      assert.equal(c.get(market.toBase58()), null);
    }
    assert.equal(decodeActiveDepthSource(pinAccount({ active: false, pool, bv, qv }), new PublicKey(pda)), null);
  });
  it("CROSS-CLUSTER: pin names a (mainnet) pool that does not exist on the push cluster -> never mode 2", async () => {
    for (const drop of [pool, bv, qv]) {
      const m = onCluster();
      m.delete(drop.toBase58());
      const c = new DepthSourceCache(60_000, () => 0);
      await c.refresh(cluster(m).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
      assert.equal(c.get(market.toBase58()), null);
      assert.equal(c.why(market.toBase58()), "pinned pool/vaults not on the push cluster");
    }
    // pool present but owned by a foreign program (not the pinned AMM)
    const m = onCluster();
    m.set(pool.toBase58(), acct(Buffer.alloc(301), k()));
    const c = new DepthSourceCache(60_000, () => 0);
    await c.refresh(cluster(m).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(c.get(market.toBase58()), null);
  });
  it("RPC failure -> no pin (attested path); cached for the TTL, re-read after it or on invalidate", async () => {
    let now = 0;
    const c = new DepthSourceCache(60_000, () => now);
    const cl = cluster(onCluster());
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    const reads = cl.reads();
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(cl.reads(), reads, "within TTL: no RPC");
    c.invalidate(market.toBase58());
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.ok(cl.reads() > reads, "invalidate forces a re-read");
    now = 61_000;
    const r2 = cl.reads();
    await c.refresh(cl.conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.ok(cl.reads() > r2, "after TTL: re-read");
    const bad = new DepthSourceCache(60_000, () => 0);
    await bad.refresh(cluster(onCluster(), true).conn, WRAPPER_PROGRAM_ID, [market.toBase58()]);
    assert.equal(bad.get(market.toBase58()), null);
  });
});

// ── pusher: mode 2 selection, 129 fallback, isolation ────────────────────────
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
function marketAccount(): Uint8Array {
  const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const marketIdOff = profileOff + V17_ASSET_ORACLE_WRAPPER_LEN;
  const buf = new Uint8Array(marketIdOff + 8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, V17_MAGIC, true);
  view.setUint16(8, V17_EXPECTED_VERSION, true);
  view.setBigUint64(marketIdOff, 1n, true);
  view.setBigUint64(profileOff + V17_ASSET_CONTROL_SEQUENCES_OFF, 100n, true);
  return buf;
}
type Ix = { keys: Array<{ pubkey: PublicKey }>; data: Uint8Array };
function chain(refuse129: Set<string>) {
  const simulated: Ix[][] = [];
  const sent: Ix[][] = [];
  return {
    simulated, sent,
    conn: {
      async getMultipleAccountsInfo(pks: PublicKey[]) { return pks.map(() => ({ data: marketAccount() })); },
      async simulateTransaction(tx: { instructions: Ix[] }) {
        const ixs = tx.instructions.slice(1);
        simulated.push(ixs);
        for (let i = 0; i < ixs.length; i++) {
          if (ixs[i].data.length === 44 && ixs[i].data[35] === 2 && refuse129.has(ixs[i].keys[1].pubkey.toBase58())) {
            return { value: { err: { InstructionError: [i + 1, { Custom: 129 }] } } };
          }
        }
        return { value: { err: null } };
      },
      async sendRawTransaction() { sent.push(simulated[simulated.length - 1]); return `sig${sent.length}`; },
    },
  };
}
const pinFor = (market: string, marketId = 1n): DexDepthPin => ({
  depthSource: deriveDepthSource(WRAPPER_PROGRAM_ID, new PublicKey(market)), pool: k(), baseVault: k(), quoteVault: k(), ammProgram: PUMP, assetIndex: 0, marketId,
});
const push = (m: string, extra: object = {}) => ({ marketAddress: m, assetIndex: 0, priceE6: 1_000_000n, ...extra });
const DEPTH = { depthE6: 9_852_457_023n, source: "pumpswap-cpmm" };

describe("pusher: mode 2", () => {
  it("flag off / no pin: every ix is the legacy 35 B with 2 accounts (byte identity)", async () => {
    const [a, b] = [k().toBase58(), k().toBase58()];
    const c = chain(new Set());
    const r = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a), push(b)], 100n, BLOCKHASH, false);
    assert.equal(r.count, 2);
    for (const ix of c.sent.flat()) { assert.equal(ix.data.length, 35); assert.equal(ix.keys.length, 2); }
    assert.deepEqual(r.dexPushedMarkets, []);
  });

  it("an active, same-generation pin -> mode 2 (44 B, depth 0, 6 accounts), in its own tx apart from attested markets", async () => {
    const [a, b] = [k().toBase58(), k().toBase58()];
    const c = chain(new Set());
    const r = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH }), push(b, { depth: DEPTH })], 100n, BLOCKHASH, false);
    assert.equal(r.count, 2);
    assert.deepEqual(r.dexPushedMarkets, [a]);
    assert.equal(c.sent.length, 2, "mode-2 and attested markets are never in the same tx");
    const dexTx = c.sent.find((t) => t[0].keys.length === 6)!;
    assert.equal(dexTx[0].data[35], 2);
    assert.deepEqual([...dexTx[0].data.slice(36)], [0, 0, 0, 0, 0, 0, 0, 0]);
    const attTx = c.sent.find((t) => t[0].keys.length === 2)!;
    assert.equal(attTx[0].data.length, 44);
    assert.equal(attTx[0].data[35], 1);
  });

  it("a pin for another generation / asset slot is ignored (attested path)", async () => {
    const a = k().toBase58();
    const c = chain(new Set());
    await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a, 2n), depth: DEPTH })], 100n, BLOCKHASH, false);
    assert.equal(c.sent[0][0].keys.length, 2);
    assert.equal(c.sent[0][0].data[35], 1);
  });

  it("129 on mode 2: that market falls back to mode 1 THIS cycle, no strike/quarantine, logged once, others untouched", async () => {
    const [a, b, d] = [k().toBase58(), k().toBase58(), k().toBase58()];
    const c = chain(new Set([a]));
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      const r = await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH }), push(b, { dex: pinFor(b), depth: DEPTH }), push(d, { depth: DEPTH })], 100n, BLOCKHASH, false);
      assert.equal(r.count, 3, "no market lost");
      assert.deepEqual(r.dexRefusedMarkets, [a]);
      assert.deepEqual(r.dexPushedMarkets, [b]);
      const landed = c.sent.flat();
      const ixA = landed.find((ix) => ix.keys[1].pubkey.toBase58() === a)!;
      assert.equal(ixA.keys.length, 2);
      assert.equal(ixA.data[35], 1, "fell back to attested mode 1");
      assert.equal(new DataView(ixA.data.buffer, ixA.data.byteOffset).getBigUint64(36, true), DEPTH.depthE6);
      const ixB = landed.find((ix) => ix.keys[1].pubkey.toBase58() === b)!;
      assert.equal(ixB.data[35], 2, "the other mode-2 market is unaffected");
      // second cycle, still refused: still pushes, but no second log line
      await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: DEPTH })], 101n, BLOCKHASH, false);
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.filter((w) => w.includes("mode-2 depth refused")).length, 1);
    assert.ok(!warns.some((w) => w.includes("QUARANTINE")));
  });

  it("129 with no attested depth available: falls back to the 35 B form, never a 44 B depth-0 attested push", async () => {
    const a = k().toBase58();
    const c = chain(new Set([a]));
    await pushAuthMarkBatch(c.conn as never, Keypair.generate(), [push(a, { dex: pinFor(a), depth: null })], 100n, BLOCKHASH, false);
    const ix = c.sent.flat().find((x) => x.keys[1].pubkey.toBase58() === a)!;
    assert.equal(ix.data.length, 35);
  });
});
