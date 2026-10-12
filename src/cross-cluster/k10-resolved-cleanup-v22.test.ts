/**
 * K-10 (2026-10-12): the resolved-market cleanup scanned 9,563-byte (v2.1) portfolios only, so a Resolved v2.2 market
 * (VERSION 19, 10,603 B portfolios) was never wound down. CODEC DJM81s8h… is the live case: Resolved since slot
 * 509,455,455 with 3 materialized portfolios (vault LP 1,000.43 USDC, two users 100.00 and 498.97 USDC).
 *
 * Fixtures: the real CODEC market and its 3 portfolios, read from devnet 2026-10-12. The fake RPC applies the
 * dataSize / memcmp filters honestly, so a wrong-size scan returns nothing, as the real node does.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/k10-resolved-cleanup-v22.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { decodeResolvedPayoutReceiptP3, parsePortfolioV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import { CleanupState, cleanupResolvedPortfolios, isFinalizedReceiptOnly, portfolioLenForMarketData, receiptOpen } from "./resolved-portfolio-cleanup.ts";
import type { CleanupConfig } from "./resolved-portfolio-cleanup.ts";
import { decodeTerminalState } from "./market-state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const NFT = new PublicKey("27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1");
const CODEC = new PublicKey("DJM81s8hi5KnozZrgL5MzdJ8sN1mnxBzAY17VBTVkxwU");
const MARKET = fx("v22-codec-market-v19-resolved");
const PFS = [
  { pubkey: new PublicKey("5sx1tsw1uBRh743GtFr1UeeAfAxHUR3mECGGe9dWronA"), data: fx("v22-codec-pf-5sx1tsw1") }, // vault LP
  { pubkey: new PublicKey("5vYAD3RKNjMm8GsV6rLQowDaJZnjt1z5z4tLYLtYowSV"), data: fx("v22-codec-pf-5vYAD3RK") },
  { pubkey: new PublicKey("6UW2ecEZiVR9iVNx8f2gMXrT9QcNP5WhVYto39pFZiaK"), data: fx("v22-codec-pf-6UW2ecEZ") },
];
const CFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: 216_000n, probeTtlMs: 3_600_000 };

type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string; encoding?: string } };
function honestConn(marketBytes: Buffer) {
  const scans: number[] = [];
  const sims: number[][] = [];
  const conn = {
    async getAccountInfo(k: PublicKey) {
      if (k.equals(CODEC)) return { data: marketBytes, owner: WRAPPER, lamports: 1, executable: false };
      const pf = PFS.find((p) => p.pubkey.equals(k));
      return pf ? { data: pf.data, owner: WRAPPER, lamports: 74_687_760, executable: false } : null;
    },
    async getProgramAccounts(program: PublicKey, o: { filters: Filter[] }) {
      if (!program.equals(WRAPPER)) return [];
      const size = o.filters.find((f) => f.dataSize !== undefined)?.dataSize;
      if (size !== undefined) scans.push(size);
      const mkt = o.filters.find((f) => f.memcmp?.offset === 16)?.memcmp?.bytes;
      return PFS.filter((p) => (size === undefined || p.data.length === size) && (!mkt || new PublicKey(p.data.subarray(16, 48)).toBase58() === mkt)).map((p) => ({
        pubkey: p.pubkey,
        account: { data: p.data, owner: WRAPPER, lamports: 74_687_760, executable: false },
      }));
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        const pf = PFS.find((p) => p.pubkey.equals(k));
        return pf ? { data: pf.data, owner: WRAPPER, lamports: 74_687_760, executable: false } : null;
      });
    },
    async getLatestBlockhash() { return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      sims.push(tx.message.compiledInstructions.filter((ix) => tx.message.staticAccountKeys[ix.programIdIndex].equals(WRAPPER)).map((ix) => ix.data[0]));
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: null } };
    },
    async sendRawTransaction() { throw new Error("dry-run must not send"); },
    async confirmTransaction() { return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [] }; },
  };
  return { conn, scans, sims };
}
const run = async (marketBytes: Buffer) => {
  const c = honestConn(marketBytes);
  const out = await cleanupResolvedPortfolios(c.conn as never, Keypair.generate(), CODEC, parseWrapperConfigV17(new Uint8Array(MARKET)).collateralMint, true, CFG, new CleanupState(), { nowSlot: 510_114_691n, resolvedSlot: 509_455_455n });
  return { ...c, out };
};

describe("K-10: resolved-market cleanup on a v2.2 market (real CODEC bytes)", () => {
  it("the fixtures: CODEC is Resolved with 3 materialized portfolios; the 3 portfolios are 10,603 B, flat, no receipt", () => {
    const t = decodeTerminalState(new Uint8Array(MARKET));
    assert.deepEqual([t?.kind, t?.kind === "resolved" && t.materializedPortfolios, t?.kind === "resolved" && t.resolvedSlot], ["resolved", 3n, 509_455_455n]);
    const caps = PFS.map((p) => {
      assert.equal(p.data.length, 10_603);
      const d = new Uint8Array(p.data);
      const pf = parsePortfolioV17(d);
      assert.equal(pf.legs.filter((l) => l.active).length, 0);
      const r = decodeResolvedPayoutReceiptP3(d); // SDK reads it at 10,409 on v2.2
      assert.deepEqual([r.present, r.finalized, receiptOpen(d), isFinalizedReceiptOnly(d)], [false, false, false, false]);
      return pf.capital;
    });
    assert.deepEqual(caps, [1_000_430_000n, 100_000_000n, 498_969_766n]);
  });

  it("portfolio scan length follows the market VERSION: v2.2 -> 10,603; v2.1 -> 9,563; unreadable -> 9,563", () => {
    assert.equal(portfolioLenForMarketData(new Uint8Array(MARKET)), 10_603);
    assert.equal(portfolioLenForMarketData(new Uint8Array(fx("sol-market-v18-fees"))), 9_563);
    assert.equal(portfolioLenForMarketData(null), 9_563);
  });

  it("NEGATIVE CONTROL: an unknown market VERSION throws (nothing is scanned at a guessed size)", () => {
    const d = new Uint8Array(MARKET);
    new DataView(d.buffer).setUint16(8, 20, true);
    assert.throws(() => portfolioLenForMarketData(d), /VERSION 20 has no portfolio layout/);
  });

  it("dry-run cleanup on CODEC scans 10,603 B, finds the 3 portfolios and simulates their closes", async () => {
    const r = await run(MARKET);
    assert.deepEqual([...new Set(r.scans)], [10_603]);
    assert.ok(r.sims.length > 0, "the cleanup simulated at least one wrapper instruction");
    const tags = new Set(r.sims.flat());
    assert.ok(tags.has(30) || tags.has(8) || tags.has(101), `wrapper tags simulated: ${[...tags].join(",")}`);
  });

  it("NEGATIVE CONTROL: with the old v2.1 scan size (market header forced to VERSION 18) the same 3 portfolios are not found and nothing is simulated", async () => {
    const m = Buffer.from(MARKET);
    m.writeUInt16LE(18, 8);
    const r = await run(m);
    assert.deepEqual([...new Set(r.scans)], [9_563]);
    assert.equal(r.sims.length, 0);
    assert.equal(r.out.closed + r.out.progressed + r.out.remaining.length + r.out.waitingOnHolder.length, 0);
  });
});
