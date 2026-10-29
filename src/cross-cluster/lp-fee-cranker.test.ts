/**
 * Regression tests for the LP-fee distribution loop.
 *
 * Verified on devnet 2026-07-28 before this loop existed: a fresh market with a
 * 500-notional round trip accrued exactly 1_440_000 atoms of LP fee on the slab
 * (48% of $3.00, the correct split) and NOTHING ever moved it, so every LP
 * depositor saw 0% APY forever. After one LpVaultCrankFees:
 *
 *     lpFeeWithdrawnAtoms  0        -> 1440000
 *     vault feeDistribution 0       -> 1440000
 *
 * The loop's whole job is to make that call happen. These tests pin the two
 * conditions under which it must NOT call (they are normal, not faults) and the
 * error it must treat as success.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_EXPECTED_VERSION } from "@percolatorct/sdk";
import { crankLpFeesOnce, crankAllLpFeesOnce } from "./lp-fee-cranker.ts";

const KEEPER = Keypair.generate();

/** Connection stub: control which of [registry, ledger] exist, and how send behaves. */
/**
 * A registry the SDK will actually parse. The old fake handed back a zeroed
 * buffer, which threw inside parseLpVaultRegistry and silently exercised only
 * the fallback path — so no test ever covered the real domain or share count.
 */
function registryBuf(opts: { shares?: bigint; domain?: number } = {}): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); // V17_MAGIC
  // The SDK's CURRENT header version (18 on v18 slabs). This fixture used to
  // hardcode 17, which parseLpVaultRegistry rejects since the v18 cutover, so
  // every test here silently ran the parse-failure fallback instead (and the
  // "no depositor" test failed outright).
  b.writeUInt16LE(V17_EXPECTED_VERSION, 8);
  b.writeUInt8(5, 10);                           // kind = LpVaultRegistry
  const H = 16;                                  // V17_ACCOUNT_HEADER_LEN
  const shares = opts.shares ?? 1_000_000n;
  b.writeBigUInt64LE(shares & 0xffff_ffff_ffff_ffffn, H + 64);
  b.writeBigUInt64LE(shares >> 64n, H + 72);     // u128 LE
  b.writeUInt16LE(opts.domain ?? 2, H + 132);    // domain
  return b;
}

function fakeConn(opts: {
  registry?: boolean;
  shares?: bigint;
  domain?: number;
  sendError?: unknown;
  /** No confirmed status before the blockhash expired (block height exceeded). */
  confirmThrows?: boolean;
  /** The status carries this err (landed but failed on chain). */
  confirmErr?: unknown;
  /** What getSignatureStatuses reports for the sent signature (overrides the two above). */
  status?: { err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" };
}) {
  let sends = 0;
  return {
    get sends() { return sends; },
    conn: {
      async getMultipleAccountsInfo() {
        return [
          opts.registry === false
            ? null
            : { data: registryBuf({ shares: opts.shares, domain: opts.domain }) },
        ];
      },
      async getLatestBlockhash() {
        return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
      },
      async sendRawTransaction() {
        sends++;
        if (opts.sendError) throw opts.sendError;
        return "sig";
      },
      async getBlockHeight() {
        return 2; // past lastValidBlockHeight 1
      },
      async getSignatureStatuses() {
        const s = opts.status ?? (opts.confirmThrows ? null : { err: opts.confirmErr ?? null, confirmationStatus: "confirmed" });
        return { value: [s ? { slot: 1, confirmations: 1, ...s } : null] };
      },
    },
  };
}

/** Fast status re-checks for tests. */
const FAST = { statusRetries: 1, statusRetryDelayMs: 0 };

const MARKET = () => Keypair.generate().publicKey.toBase58();

describe("crankLpFeesOnce — only spend a transaction when there is something to move", () => {
  it("distributes when a vault and a depositor ledger both exist", async () => {
    const f = fakeConn({});
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "cranked");
    assert.equal(f.sends, 1);
  });

  it("skips a market whose creator never made an LP vault", async () => {
    const f = fakeConn({ registry: false });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.sends, 0, "no vault must cost no transaction");
  });

  it("skips a market with no LP depositor yet, instead of failing every cycle", async () => {
    // v17 dual-domain: ledger absence is NO LONGER the signal. The program now
    // creates the target ledger on first use, so a missing ledger just means
    // "this pot has not been funded", not "there are no LPs". The registry's
    // share count is the direct signal — and it is what the program itself
    // checks before crediting atoms no share could ever claim.
    const f = fakeConn({ shares: 0n });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "skipped");
    assert.equal(f.sends, 0, "no depositors must cost no transaction");
  });

  it("cranks a vault bound to a non-zero domain", async () => {
    // The old code hardcoded domain 0. A market that appends an asset binds its
    // vault to that asset's domain, so the ledger PDAs were derived for the
    // wrong pot entirely.
    const f = fakeConn({ domain: 3, shares: 5_000n });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "cranked");
    assert.equal(f.sends, 1);
  });

  it("treats Custom(38) NoFeesToCrank as healthy, not as a failure", async () => {
    // The expected answer on any quiet market. Reporting it as an error would
    // page someone every cycle for a market that is working fine.
    const f = fakeConn({ sendError: new Error('failed: {"InstructionError":[1,{"Custom":38}]}') });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "no-fees");
  });

  it("also decodes the hex form of the same error", async () => {
    const f = fakeConn({ sendError: new Error("custom program error: 0x26") });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false), "no-fees");
  });

  it("reports a genuine failure rather than swallowing it", async () => {
    const f = fakeConn({ sendError: new Error("blockhash not found") });
    const r = await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false);
    assert.ok(typeof r === "object" && "error" in r);
  });

  it("never sends in dry-run", async () => {
    const f = fakeConn({});
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), true), "skipped");
    assert.equal(f.sends, 0);
  });

  it("F6: a tx whose signature status shows it LANDED is 'cranked', not a failure", async () => {
    // SOLCAT 5xq4yAXH… / ANSEM 4RJv6kJt… (2026-09-29): logged as "block height
    // exceeded" failures, but lp_fee_withdrawn == accrued on chain.
    const f = fakeConn({ confirmThrows: true, status: { err: null, confirmationStatus: "confirmed" } });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false, FAST), "cranked");
  });

  it("F6: a tx with NO signature status is 'not landed', reported for retry", async () => {
    const f = fakeConn({ confirmThrows: true });
    const r = await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false, FAST);
    assert.ok(typeof r === "object" && /not landed/.test(r.error), JSON.stringify(r));
  });

  it("F6: a confirmation carrying value.err is a failure, never 'cranked'", async () => {
    const f = fakeConn({ confirmErr: { InstructionError: [1, { Custom: 41 }] } });
    const r = await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false, FAST);
    assert.ok(typeof r === "object" && /landed but failed/.test(r.error), JSON.stringify(r));
  });

  it("F6: a landed-but-failed Custom(38) found via signature status is still 'no-fees'", async () => {
    const f = fakeConn({ confirmThrows: true, status: { err: { InstructionError: [1, { Custom: 38 }] }, confirmationStatus: "confirmed" } });
    assert.equal(await crankLpFeesOnce(f.conn as never, KEEPER, MARKET(), false, FAST), "no-fees");
  });

  it("returns an error for an unparseable market instead of throwing", async () => {
    const f = fakeConn({});
    const r = await crankLpFeesOnce(f.conn as never, KEEPER, "not-a-pubkey", false);
    assert.ok(typeof r === "object" && "error" in r);
  });
});

describe("crankAllLpFeesOnce — one bad market must not stop the sweep", () => {
  it("buckets every market and never throws", async () => {
    const markets = [MARKET(), MARKET(), MARKET()];
    const conn = {
      async getMultipleAccountsInfo() { return [{ data: Buffer.alloc(176) }, { data: Buffer.alloc(240) }]; },
      async getLatestBlockhash() { return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 }; },
      async sendRawTransaction() { throw new Error("boom"); },
    };
    const r = await crankAllLpFeesOnce(
      conn as never,
      KEEPER,
      { markets: markets.map((m) => ({ marketAddress: m })) } as never,
      false,
    );
    assert.equal(r.failed.length, 3, "each market reported independently");
    assert.equal(r.cranked.length, 0);
  });

  it("keeps going when markets are in different states", async () => {
    let call = 0;
    const conn = {
      async getMultipleAccountsInfo() {
        call++;
        // 1st: full, 2nd: no vault, 3rd: no ledger
        if (call === 2) return [null, null];
        if (call === 3) return [{ data: Buffer.alloc(176) }, null];
        return [{ data: Buffer.alloc(176) }, { data: Buffer.alloc(240) }];
      },
      async getLatestBlockhash() { return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 }; },
      async sendRawTransaction() { return "sig"; },
      async getSignatureStatuses() { return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    };
    const r = await crankAllLpFeesOnce(
      conn as never,
      KEEPER,
      { markets: [{ marketAddress: MARKET() }, { marketAddress: MARKET() }, { marketAddress: MARKET() }] } as never,
      false,
    );
    assert.equal(r.cranked.length + r.skipped.length, 3);
    assert.equal(r.failed.length, 0);
  });
});
