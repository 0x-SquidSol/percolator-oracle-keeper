/**
 * S3 audit 2026-10-17 (slice B: keeper staleness, races, keys). One regression test per confirmed defect.
 *
 *   S3-B1  the SOL/USD reference rate for every WSOL-quoted market was chosen by display symbol/label only
 *          (isSolUsdEntry), never by the pool's mints: a row labelled "SOL/USDC" (a DB row's label is
 *          `${symbol}/USDC — …`, so any market whose symbol is "SOL") pointing at another token's USDC pool became
 *          the SOL price for every pumpswap / WSOL-Meteora market, and also suppressed SOL_USD_REFERENCE_POOL.
 *   S3-B2  the #100 mint binding accepted the market's mainnet_ca on the QUOTE side. For a publishable pool the
 *          quote is WSOL / USDC / USDT, so that branch only ever passes when the market is FOR WSOL (or a stable)
 *          and the pool prices a DIFFERENT token: a "SOL" market bound to a MEME/WSOL pool published MEME's price.
 *   S3-B4  a cycle abandoned by the watchdog keeps running; when it finally sends, its OLDER price gets a HIGHER
 *          nonce (max(chain, lastSent) + 1) than the newer cycle's push and lands on top of it.
 *   S3-B5  the poisoned-watermark log line printed `conn.rpcEndpoint`, i.e. the Helius URL with `?api-key=`.
 *   S3-B6  (todo, design) R3.24 deadline bypass publishes a single unfiltered pool read at cycle 0 after a restart,
 *          and the circuit breaker is unseeded then (first price always accepted), so the "bounded by the breaker"
 *          claim does not hold at exactly the moment the bypass fires.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/audit-1017-keeper-b.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { WSOL_MINT } from "@percolatorct/sdk";
import { checkMintBinding, readAllPoolPricesE6, readAtWatermark, resetSlotWatermarksForTests } from "./price-reader.ts";
import { pruneAuthMarkPusherState, pushAuthMarkBatch, resetPushLandingState } from "./auth-mark-pusher.ts";
import { createMarkSmoother } from "./mark-smoother.ts";
import { deadlineBypass } from "./keeper-loop.ts";
import { checkCircuitBreaker } from "../circuit-breaker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Uint8Array => new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));

const PUMPSWAP_OWNER = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_CLMM_OWNER = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** Raydium CLMM pool mint0 (9 dp) / mint1 = USDC (6 dp) priced at `priceE6` USDC per mint0. */
function raydiumPool(mint0: PublicKey, priceE6: bigint): Buffer {
  const b = Buffer.alloc(300);
  mint0.toBuffer().copy(b, 73);
  USDC.toBuffer().copy(b, 105);
  b[233] = 9;
  b[234] = 6;
  const target = (priceE6 << 128n) / 1_000_000_000n;
  let x = target;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + target / x) / 2n;
  }
  b.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  b.writeBigUInt64LE(x >> 64n, 261);
  return b;
}
function pumpPool(base: PublicKey, quote: PublicKey, baseVault: PublicKey, quoteVault: PublicKey): Buffer {
  const b = Buffer.alloc(301);
  base.toBuffer().copy(b, 43);
  quote.toBuffer().copy(b, 75);
  baseVault.toBuffer().copy(b, 139);
  quoteVault.toBuffer().copy(b, 171);
  return b;
}
function vault(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}
/** Mainnet connection mock answering by address (order-independent). */
function addrConn(endpoint: string, accounts: Map<string, { owner?: PublicKey; data: Buffer }>): Connection {
  const get = (k: PublicKey) => {
    const a = accounts.get(k.toBase58());
    return a ? { owner: a.owner ?? PublicKey.default, data: a.data, lamports: 1, executable: false } : null;
  };
  return {
    rpcEndpoint: endpoint,
    getMultipleAccountsInfoAndContext: (keys: PublicKey[]) => Promise.resolve({ context: { slot: 1 }, value: keys.map(get) }),
    getAccountInfoAndContext: (k: PublicKey) => Promise.resolve({ context: { slot: 1 }, value: get(k) }),
  } as unknown as Connection;
}

beforeEach(() => resetSlotWatermarksForTests());

// ── S3-B1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("S3-B1 SOL/USD reference is chosen by the pool's mints, not by its label", () => {
  const SOL_E6 = 117_000_000n; // real SOL/USD
  const FAKE_E6 = 2_000_000n; // another token's USDC price, $2
  const BASE_AMT = 1_000_000_000_000n; // 1,000,000 tokens (6 dp)
  const QUOTE_AMT = 1_000_000_000n; // 1 SOL (9 dp) -> 1e-6 SOL per token

  function setup() {
    const realSol = Keypair.generate().publicKey;
    const fakeSol = Keypair.generate().publicKey;
    const cat = Keypair.generate().publicKey;
    const catMint = Keypair.generate().publicKey;
    const bv = Keypair.generate().publicKey;
    const qv = Keypair.generate().publicKey;
    const notSol = Keypair.generate().publicKey; // the fake row's real base token
    const accounts = new Map<string, { owner?: PublicKey; data: Buffer }>([
      [realSol.toBase58(), { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(WSOL_MINT, SOL_E6) }],
      [fakeSol.toBase58(), { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(notSol, FAKE_E6) }],
      [cat.toBase58(), { owner: PUMPSWAP_OWNER, data: pumpPool(catMint, WSOL_MINT, bv, qv) }],
      [bv.toBase58(), { data: vault(BASE_AMT) }],
      [qv.toBase58(), { data: vault(QUOTE_AMT) }],
    ]);
    return { realSol, fakeSol, cat, accounts };
  }

  it("a DB-shaped row (symbol \"SOL\" -> label \"SOL/USDC — raydium-clmm\") on a non-SOL pool does not price every WSOL market", async () => {
    const { realSol, fakeSol, cat, accounts } = setup();
    const out = await readAllPoolPricesE6(
      addrConn("https://ep-b1-db", accounts),
      [
        // exactly what db-markets.ts builds for a creator row with symbol "SOL" (label `${symbol}/USDC — ${dexType}`)
        { poolAddress: fakeSol.toBase58(), dexType: "raydium-clmm", label: "SOL/USDC — raydium-clmm", symbol: "SOL" },
        { poolAddress: cat.toBase58(), dexType: "pumpswap", label: "CAT/USDC — pumpswap", symbol: "CAT" },
      ],
      new Map([[cat.toBase58(), { base: 6, quote: 9 }]]),
      realSol.toBase58(), // the operator's SOL_USD_REFERENCE_POOL
    );
    // 1e-6 SOL per token at the REAL SOL price = 117 (e6). With the fake row as the "SOL" price it reads 2.
    const got = out.get(cat.toBase58());
    assert.ok(got !== undefined && got >= 110n && got <= 120n, `CAT priced at ${got} e6 (expected ~117 at the real SOL price; 1-2 = the fake row's $2 "SOL")`);
  });

  it("a registry row labelled SOL/USDC whose pool's base is not WSOL is never the SOL price (no reference pool configured)", async () => {
    const { fakeSol, cat, accounts } = setup();
    const out = await readAllPoolPricesE6(
      addrConn("https://ep-b1-file", accounts),
      [
        { poolAddress: fakeSol.toBase58(), dexType: "raydium-clmm", label: "SOL/USDC (Raydium CLMM)", symbol: "SOL/USDC" },
        { poolAddress: cat.toBase58(), dexType: "pumpswap", label: "CAT", symbol: "CAT" },
      ],
      new Map([[cat.toBase58(), { base: 6, quote: 9 }]]),
    );
    // No genuine SOL/USD source this cycle: the WSOL-quoted market must be SKIPPED, not priced at $2/SOL.
    assert.equal(out.has(cat.toBase58()), false, `CAT must be skipped, got ${out.get(cat.toBase58())}`);
  });

  it("control: a genuine WSOL/USDC row still prices WSOL markets (unchanged)", async () => {
    const { realSol, cat, accounts } = setup();
    const out = await readAllPoolPricesE6(
      addrConn("https://ep-b1-ok", accounts),
      [
        { poolAddress: realSol.toBase58(), dexType: "raydium-clmm", label: "SOL/USDC", symbol: "SOL/USDC" },
        { poolAddress: cat.toBase58(), dexType: "pumpswap", label: "CAT", symbol: "CAT" },
      ],
      new Map([[cat.toBase58(), { base: 6, quote: 9 }]]),
    );
    const got = out.get(cat.toBase58());
    assert.ok(got !== undefined && got >= 110n && got <= 120n, `got ${got}`);
  });
});

// ── S3-B2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("S3-B2 mint binding: the market's token must be the PRICED (base) side", () => {
  it("checkMintBinding refuses mainnet_ca = WSOL against a MEME/WSOL pool (it prices MEME, not SOL)", () => {
    const MEME = Keypair.generate().publicKey;
    assert.equal(checkMintBinding(WSOL_MINT.toBase58(), MEME, WSOL_MINT).ok, false);
    assert.equal(checkMintBinding(USDC.toBase58(), MEME, USDC).ok, false);
  });

  it("live batch path: a market FOR SOL bound to a MEME/WSOL pumpswap pool is not priced at MEME's price", async () => {
    const realSol = Keypair.generate().publicKey;
    const meme = Keypair.generate().publicKey;
    const memeMint = Keypair.generate().publicKey;
    const bv = Keypair.generate().publicKey;
    const qv = Keypair.generate().publicKey;
    const accounts = new Map<string, { owner?: PublicKey; data: Buffer }>([
      [realSol.toBase58(), { owner: RAYDIUM_CLMM_OWNER, data: raydiumPool(WSOL_MINT, 117_000_000n) }],
      [meme.toBase58(), { owner: PUMPSWAP_OWNER, data: pumpPool(memeMint, WSOL_MINT, bv, qv) }],
      [bv.toBase58(), { data: vault(1_000_000_000_000n) }],
      [qv.toBase58(), { data: vault(1_000_000_000n) }],
    ]);
    const out = await readAllPoolPricesE6(
      addrConn("https://ep-b2", accounts),
      [
        { poolAddress: realSol.toBase58(), dexType: "raydium-clmm", label: "SOL/USDC", symbol: "SOL/USDC" },
        { poolAddress: meme.toBase58(), dexType: "pumpswap", label: "SOL/USDC — pumpswap", symbol: "SOL", mainnetCa: WSOL_MINT.toBase58() },
      ],
      new Map([[meme.toBase58(), { base: 6, quote: 9 }]]),
    );
    assert.equal(out.has(meme.toBase58()), false, `wrong-asset price published: ${out.get(meme.toBase58())}`);
  });

  it("control: the token as base still binds", () => {
    const TOKEN = Keypair.generate().publicKey;
    assert.deepEqual(checkMintBinding(TOKEN.toBase58(), TOKEN, WSOL_MINT), { ok: true });
  });
});

// ── shared fake devnet connection for the push path (real 2xhs v2.2 bytes) ───────────────────────────────────────
const PUSH_TAG = 63;
const SLOT = 511_456_771n;
const BLOCKHASH = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
function devnetConn(accounts: Map<string, Uint8Array>, simErr?: (tx: Transaction) => unknown) {
  const sent: Transaction[] = [];
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        const d = accounts.get(k.toBase58());
        return d ? { data: Buffer.from(d), owner: PublicKey.default, lamports: 1, executable: false } : null;
      });
    },
    async simulateTransaction(tx: Transaction) {
      return { context: { slot: 1 }, value: { err: simErr ? simErr(tx) : null, logs: [] } };
    },
    async sendRawTransaction(raw: Buffer | Uint8Array) {
      sent.push(Transaction.from(Buffer.from(raw)));
      return `sig${sent.length}`;
    },
    async getSignatureStatuses() {
      return { value: [] };
    },
  };
  return { conn: conn as never, sent };
}
const pushesOf = (sent: Transaction[]) =>
  sent.flatMap((t) => t.instructions.filter((ix) => ix.data[0] === PUSH_TAG).map((ix) => {
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    return { market: ix.keys[1].pubkey.toBase58(), asset: dv.getUint16(1, true), mark: dv.getBigUint64(19, true), seq: dv.getBigUint64(27, true) };
  }));

// ── S3-B4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("S3-B4 a superseded (timed-out) cycle never sends its older price after a newer cycle", () => {
  beforeEach(() => {
    resetPushLandingState();
    pruneAuthMarkPusherState(new Set());
  });

  it("cycle 2 pushes 200; the abandoned cycle 1 (price 100) finishing later sends nothing for that market", async () => {
    const market = Keypair.generate().publicKey.toBase58();
    const data = fx("k6-2xhs-market-v22");
    const { conn, sent } = devnetConn(new Map([[market, data]]));
    const keeper = Keypair.generate();
    const newer = await pushAuthMarkBatch(conn, keeper, [{ marketAddress: market, assetIndex: 0, priceE6: 200_000_000n, depth: null }], SLOT, BLOCKHASH, false, { cycle: 2 });
    assert.deepEqual(newer.pushedMarkets, [market]);
    // The watchdog abandoned cycle 1 (runCycle is never cancelled); its getSlot/blockhash/balance call resolves now.
    await pushAuthMarkBatch(conn, keeper, [{ marketAddress: market, assetIndex: 0, priceE6: 100_000_000n, depth: null }], SLOT, BLOCKHASH, false, { cycle: 1 });
    const p = pushesOf(sent);
    // Before the fix: [200 @ n, 100 @ n+1] -> the stale 100 lands LAST, with a valid (higher) nonce.
    assert.deepEqual(p.map((x) => x.mark), [200_000_000n], `sent ${JSON.stringify(p.map((x) => `${x.mark}@${x.seq}`))}`);
  });

  it("control: without a cycle tag the old behaviour is unchanged (each call pushes)", async () => {
    const market = Keypair.generate().publicKey.toBase58();
    const { conn, sent } = devnetConn(new Map([[market, fx("k6-2xhs-market-v22")]]));
    const keeper = Keypair.generate();
    await pushAuthMarkBatch(conn, keeper, [{ marketAddress: market, assetIndex: 0, priceE6: 1n, depth: null }], SLOT, BLOCKHASH, false);
    await pushAuthMarkBatch(conn, keeper, [{ marketAddress: market, assetIndex: 0, priceE6: 2n, depth: null }], SLOT, BLOCKHASH, false);
    const p = pushesOf(sent);
    assert.equal(p.length, 2);
    assert.ok(p[1].seq > p[0].seq);
  });
});

// ── S3-B5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("S3-B5 RPC api-key never reaches the log", () => {
  it("the poisoned-watermark line does not print the endpoint's ?api-key=", async () => {
    const SECRET = "deadbeef-0000-4000-8000-c0ffee000001";
    const conn = { rpcEndpoint: `https://mainnet.helius-rpc.com/?api-key=${SECRET}` } as unknown as Connection;
    const lines: string[] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      // establish a watermark, then 3 reads that stay below it (each retried internally) -> the reset log line
      await readAtWatermark(conn, async () => ({ context: { slot: 100 }, value: 1 }));
      for (let i = 0; i < 3; i++) {
        await readAtWatermark(conn, async () => ({ context: { slot: 50 }, value: 1 })).catch(() => undefined);
      }
    } finally {
      console.error = origErr;
      console.warn = origWarn;
    }
    assert.ok(lines.some((l) => /DROPPING it/.test(l)), "fixture sanity: the reset line was logged");
    for (const l of lines) assert.equal(l.includes(SECRET), false, `api key logged: ${l}`);
  });
});

// ── S3-B6 (fixed 2026-10-18): the deadline bypass needs the normal multi-read confirmation ──────────────────────────
describe("S3-B6 deadline bypass at cycle 0 never publishes a single read", () => {
  const urgent = { terminal: null, readSlot: 0n, stale: null, pin: null, urgent: true, urgentReason: "test" };

  it("after a restart, an urgent deadline with ONE manipulated pool read publishes nothing", () => {
    const s = createMarkSmoother({ windowMs: 17_000 });
    assert.equal(s.smooth("P", 50_000_000n, 0), null); // ONE manipulated read (on-chain mark was ~100)
    assert.equal(s.peek("P"), null);
    assert.equal(deadlineBypass(urgent, s.peek("P")), null);
  });

  it("two reads are still not enough; the third (minSamples) read is", () => {
    const s = createMarkSmoother({ windowMs: 17_000 });
    s.smooth("P", 100_000_000n, 0);
    s.smooth("P", 100_000_000n, 7_000);
    assert.equal(deadlineBypass(urgent, s.peek("P")), null);
    assert.equal(s.smooth("P", 101_000_000n, 14_000), null); // span 14 s < the 14.1 s span gate: smooth() still withholds
    assert.ok(deadlineBypass(urgent, s.peek("P")) !== null);
  });

  it("a one-read median would have been accepted by the unseeded breaker (why the count gate is required)", () => {
    const fresh = { symbol: "X", lastPrice: 0, circuitBreakerTrips: 0, cbTripPrice: 0, cbConsecutiveTrips: 0 };
    assert.equal(checkCircuitBreaker(fresh, 50, { maxMovePct: 10, confirmTrips: 3, log: () => {} }), 50);
  });
});
