/**
 * B12 cleanup on the P3 FINAL wrapper b2b2559e: permissionless CloseResolved
 * + ClosePortfolio(owner at [3]) for every materialized portfolio on a
 * Resolved market, before stake tag 29. Gated so it is a no-op on 6377376a
 * (Custom(8) Unauthorized). PDA owners (NFT escrow, LP-vault registry) are
 * skipped so their rent is not stranded (security B12 review).
 *
 * Real bytes: SOL market (resolved by patching the mode byte) and a real SOL
 * trader portfolio (id 4, sequence 5, epoch 0, owner HbCNkGon…).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveLpBackingLedger, deriveLpVaultRegistry, deriveMarketVaultAccounts, deriveStakePool, parsePortfolioV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  buildClosePortfolioIx,
  buildCloseResolvedIx,
  classifyCleanupProbe,
  buildClaimResolvedPayoutTopupIx,
  cleanupResolvedPortfolios,
  CleanupState,
  receiptOpen,
  RESOLVED_RECEIPT_OFF,
  encodeClosePortfolio,
  encodeCloseResolved,
  decodePositionNft,
  deriveNftRegistry,
  deriveVaultLpState,
  nftEscrowAuthority,
  ownerAta,
  pdaGraceLeft,
  pdaOwnerKind,
} from "./resolved-portfolio-cleanup.ts";
import type { CleanupConfig, CleanupConnection } from "./resolved-portfolio-cleanup.ts";
import { TerminalInsuranceState, windDownOnce } from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";
import { nonComputeBudgetCompiled } from "./test-ix.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const NFT = new PublicKey("CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const SOL = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const KEEPER = Keypair.generate();
const MINT = parseWrapperConfigV17(new Uint8Array(fx("sol-market-v18-fees"))).collateralMint;
const TRADER = parsePortfolioV17(new Uint8Array(fx("sol-trader-portfolio-v18")));
/** A wallet (on-curve) owner for the ordinary closable case. The raw SOL trader fixture is NFT-escrowed. */
const WALLET = Keypair.generate().publicKey;
const GRACE = 216_000n;
const RESOLVED_AT = 500_000_000n;
const IN_GRACE = { nowSlot: RESOLVED_AT + GRACE - 1n, resolvedSlot: RESOLVED_AT };
const AFTER_GRACE = { nowSlot: RESOLVED_AT + GRACE, resolvedSlot: RESOLVED_AT };
const CUCFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: GRACE, probeTtlMs: 3_600_000, confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0 };

/**
 * An EMPTY portfolio derived from real bytes: the real CATE flat portfolio (no
 * legs, pnl 0) with its capital zeroed where the SDK decoder reads it; owner set.
 */
function emptyPortfolio(owner: PublicKey): Buffer {
  const b = Buffer.from(fx("cate-flat-portfolio-v18"));
  // capital u128 @ 148 = the SDK decoder's PF_CAPITAL_OFF (header 16 + provenance 100 + 32).
  assert.ok(parsePortfolioV17(new Uint8Array(b)).capital > 0n);
  b.fill(0, 148, 164);
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  const p = parsePortfolioV17(new Uint8Array(b));
  assert.equal(p.capital, 0n); assert.equal(p.pnl, 0n); assert.equal(p.activeBitmap, 0n); assert.ok(p.owner.equals(owner));
  return b;
}
const ESCROWED_CLAIM_PF = new PublicKey("2TRPacVc3N4fbJfqP1WFzLyNFwhkDuxP6CusEh12nj8N"); // real devnet, 2026-09-30
/** Literal values read from live devnet 2026-09-30 for record 4rHXEHHD… (independent of the decoder under test). */
const ESCROW_NFT_MINT = "2Zf7YvBLvy5qCVpKJtXjRdhpy1CmTuLdDBfCQCuCpGiM";
const ESCROW_NFT_HOLDER = "G6RtYRnVc1XjwY7ncQoFuTcZCbYPCgm3yh1ZrW5fh1sE";
/** The trader portfolio with its owner (both copies, @80 and @116) replaced. */
function withOwner(owner: PublicKey): Buffer {
  const b = Buffer.from(fx("sol-trader-portfolio-v18"));
  owner.toBuffer().copy(b, 80);
  owner.toBuffer().copy(b, 116);
  return b;
}

type Sim = { err: unknown; logs?: string[] };
/**
 * `chunks`: how many chunk calls (a lone CloseResolved, or VaultLpSettleResolved(0)) make
 * progress before the close is fully advanced. A chunk simulation returns the watched
 * portfolio's post-state: a new value per landed chunk, then unchanged (= no progress).
 */
function cconn(portfolios: Array<{ pubkey: PublicKey; data: Buffer }>, reply: (tags: number[]) => Sim, opts: { ataExists?: boolean; vaultLp?: { state: Buffer; registry: Buffer }; nftRecords?: Array<{ pubkey: PublicKey; data: Buffer }>; chunks?: number } = {}) {
  const calls = { sims: [] as number[][], sent: [] as number[][], simKeys: [] as string[][], sentTag8: [] as Buffer[], chunkSends: 0 };
  const totalChunks = opts.chunks ?? 1;
  const isChunk = (t: number[]) => (t.includes(30) && !t.includes(8)) || t.includes(101);
  const tagsOf = (tx: VersionedTransaction): number[] =>
    nonComputeBudgetCompiled(tx.message.compiledInstructions, tx.message.staticAccountKeys).map((ix) => {
      const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
      if (pid === WRAPPER.toBase58()) return ix.data[0] === 101 ? (ix.data[1] === 1 ? 1011 : 101) : ix.data[0];
      return pid.startsWith("ATok") ? -1 : -2;
      // 101 = VaultLpSettleResolved; -1 = ATA create
    });
  const conn = {
    async getProgramAccounts(program: PublicKey) {
      if (program.equals(NFT)) return (opts.nftRecords ?? []).map((r) => ({ pubkey: r.pubkey, account: { data: r.data, owner: NFT, lamports: 1, executable: false } }));
      return portfolios.map((p) => ({ pubkey: p.pubkey, account: { data: p.data, owner: WRAPPER, lamports: 67_000_000, executable: false } }));
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        const pf = portfolios.find((p) => p.pubkey.equals(k));
        if (pf) return { data: pf.data, owner: WRAPPER, lamports: 67_000_000, executable: false };
        if (k.equals(deriveVaultLpState(WRAPPER, SOL))) return opts.vaultLp ? { data: opts.vaultLp.state, owner: WRAPPER, lamports: 1, executable: false } : null;
        return opts.ataExists === false ? null : { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false };
      });
    },
    async getAccountInfo() { return opts.vaultLp ? { data: opts.vaultLp.registry, owner: WRAPPER, lamports: 1, executable: false } : null; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
    async simulateTransaction(tx: VersionedTransaction, o?: { accounts?: { addresses: string[] } }) {
      const t = tagsOf(tx); calls.sims.push(t);
      calls.simKeys.push(tx.message.staticAccountKeys.map((k) => k.toBase58()));
      const r = reply(t);
      const accounts = o?.accounts
        ? o.accounts.addresses.map(() => ({ data: [Buffer.alloc(64, Math.min(calls.chunkSends + 1, totalChunks)).toString("base64"), "base64"] }))
        : undefined;
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [], accounts } };
    },
    async sendRawTransaction(raw: Buffer) {
      const tx = VersionedTransaction.deserialize(raw);
      calls.sent.push(tagsOf(tx));
      if (isChunk(tagsOf(tx))) calls.chunkSends++;
      for (const ix of tx.message.compiledInstructions) if (ix.data[0] === 8 && ix.data.length === 25) calls.sentTag8.push(Buffer.from(ix.data));
      return "5ig1111111111111111111111111111111111111111111111111111111111111"; },
    async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
    async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
  };
  return { conn: conn as unknown as CleanupConnection, calls };
}
const PF = (k?: PublicKey) => k ?? Keypair.generate().publicKey;
/** Probe = a lone tag 8 (first sim). P3 answers it with an engine error on a non-empty portfolio. */
const p3 = (rest: (tags: number[]) => Sim) => {
  let n = 0;
  return (t: number[]): Sim => (n++ === 0 ? { err: { InstructionError: [1, { Custom: 61 }] } } : rest(t));
};

describe("wire and accounts, checked against b2b2559e", () => {
  it("ClosePortfolio = [8][portfolio_id][expected_sequence][position_epoch] (25 B, u64 LE)", () => {
    const b = encodeClosePortfolio(4n, 5n, 7n);
    assert.equal(b.length, 25);
    assert.equal(b[0], 8);
    assert.deepEqual([b.readBigUInt64LE(1), b.readBigUInt64LE(9), b.readBigUInt64LE(17)], [4n, 5n, 7n]);
  });
  it("CloseResolved = [30][fee_rate_per_slot u128 = 0] (17 B)", () => {
    const b = encodeCloseResolved();
    assert.equal(b.length, 17);
    assert.equal(b[0], 30);
    assert.ok(b.subarray(1).every((x) => x === 0));
  });
  it("ClosePortfolio accounts: [closer s,w] [market w] [portfolio w] [owner w] (rent -> owner)", () => {
    const pf = PF();
    const ix = buildClosePortfolioIx({ wrapperProgramId: WRAPPER, closer: KEEPER.publicKey, market: SOL, portfolio: pf, owner: TRADER.owner, portfolioId: 4n, expectedSequence: 5n, positionEpoch: 0n });
    assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
      [KEEPER.publicKey.toBase58(), true, true], [SOL.toBase58(), false, true], [pf.toBase58(), false, true], [TRADER.owner.toBase58(), false, true],
    ]);
  });
  it("CloseResolved accounts: [owner unsigned] [market w] [portfolio w] [owner ATA w] [wrapper vault w] [vault auth] [token] [nft_registry PDA] (GH#496)", () => {
    const pf = PF();
    const ix = buildCloseResolvedIx({ wrapperProgramId: WRAPPER, owner: TRADER.owner, market: SOL, portfolio: pf, collateralMint: MINT });
    const v = deriveMarketVaultAccounts(WRAPPER, SOL, MINT);
    assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
      [TRADER.owner.toBase58(), false, false], [SOL.toBase58(), false, true], [pf.toBase58(), false, true],
      [ownerAta(TRADER.owner, MINT).toBase58(), false, true], [v.vaultToken.toBase58(), false, true],
      [v.vaultAuthority.toBase58(), false, false], [v.tokenProgram.toBase58(), false, false],
      [deriveNftRegistry(WRAPPER, SOL).toBase58(), false, false],
    ]);
    assert.ok(deriveNftRegistry(WRAPPER, SOL).equals(PublicKey.findProgramAddressSync([Buffer.from("nft_registry"), SOL.toBuffer()], WRAPPER)[0]));
  });
});

describe("gate: a no-op on 6377376a", () => {
  it("classifyCleanupProbe: Custom(8) at ClosePortfolio = unsupported; anything past auth = supported", () => {
    assert.equal(classifyCleanupProbe({ InstructionError: [1, { Custom: 8 }] }, false), "unsupported");
    assert.equal(classifyCleanupProbe({ InstructionError: [1, { Custom: 61 }] }, false), "supported");
    assert.equal(classifyCleanupProbe(null, true), "supported");
    assert.equal(classifyCleanupProbe("BlockhashNotFound", false), "unknown");
  });
  it("6377376a (probe -> Custom(8)): nothing is sent, every portfolio reported as needing P3", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], () => ({ err: { InstructionError: [1, { Custom: 8 }] } }));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.support, "unsupported");
    assert.equal(c.calls.sent.length, 0);
    assert.equal(c.calls.sims.length, 1, "only the probe");
    assert.match(r.remaining[0].reason, /needs P3 b2b2559e/);
  });
});

describe("cleanup on P3", () => {
  it("sends [CloseResolved, ClosePortfolio] bound to the portfolio's LIVE id/sequence/epoch", async () => {
    const pf = PF();
    const c = cconn([{ pubkey: pf, data: withOwner(WALLET) }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[30, 8]]);
    const d = c.calls.sentTag8[0];
    assert.deepEqual([d.readBigUInt64LE(1), d.readBigUInt64LE(9), d.readBigUInt64LE(17)], [TRADER.portfolioId, TRADER.matcherSequence, TRADER.matcherPositionEpoch]);
    assert.deepEqual([TRADER.portfolioId, TRADER.matcherSequence, TRADER.matcherPositionEpoch], [4n, 5n, 0n], "the real fixture's live binding");
  });
  it("creates the owner's token account first when it is missing (payout destination)", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: null })), { ataExists: false });
    await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.deepEqual(c.calls.sent, [[-1, 30, 8]]);
  });
  it("already resolved-closed: falls back to ClosePortfolio alone", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3((t) => (t.includes(30) ? { err: { InstructionError: [1, { Custom: 61 }] } } : { err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[8]]);
  });
  it("progress-only CloseResolved is sent, and the portfolio is reported as not yet closable", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3((t) => (t.includes(8) ? { err: { InstructionError: [t.indexOf(8) + 1, { Custom: 61 }] } } : { err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 0);
    assert.equal(r.progressed, 1);
    assert.deepEqual(c.calls.sent, [[30]]);
  });
  it("an owner-signature requirement (NFT escrow / force-close delay) is reported, not retried blindly", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: { InstructionError: [1, "MissingRequiredSignature"] } })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /needs the owner's signature/);
  });
  it("bounded per cycle", async () => {
    const many = Array.from({ length: 10 }, () => ({ pubkey: PF(), data: withOwner(WALLET) }));
    const c = cconn(many, p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, { ...CUCFG, maxPerCycle: 3 }, new CleanupState());
    assert.equal(r.closed, 3);
    assert.equal(r.remaining.filter((x) => /per-cycle bound/.test(x.reason)).length, 7);
  });
  it("dry-run simulates only", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: null })));
    await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, true, CUCFG, new CleanupState());
    assert.equal(c.calls.sent.length, 0);
  });
});

/** A VaultLpStateV18 account (kind 9, version 1) naming `lp` and `junior`. */
function vaultLpStateBuf(registry: PublicKey, lp: PublicKey, junior: PublicKey): Buffer {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
  SOL.toBuffer().copy(b, 16); registry.toBuffer().copy(b, 16 + 32); lp.toBuffer().copy(b, 16 + 64); junior.toBuffer().copy(b, 16 + 96);
  b[16 + 214] = 1;
  return b;
}
/** An LpVaultRegistry the SDK parses (v18 header, kind 5), domain 0. */
function registryBuf(): Buffer {
  const b = Buffer.alloc(176);
  b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 5;
  return b;
}

describe("PDA-owned portfolios: grace period after resolve, then closed (coordinator correction + security B12 review)", () => {
  const escrow = nftEscrowAuthority(NFT);
  const registry = deriveLpVaultRegistry(WRAPPER, SOL)[0];
  it("the NFT escrow PDA is find_program_address([\"mint_authority\"], nft) (wrapper derive_nft_mint_authority)", () => {
    assert.ok(escrow.equals(PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], NFT)[0]));
    assert.ok(!PublicKey.isOnCurve(escrow.toBytes()));
  });
  it("pdaOwnerKind / pdaGraceLeft", () => {
    assert.equal(pdaOwnerKind(escrow, SOL, CUCFG), "nft-escrow");
    assert.equal(pdaOwnerKind(registry, SOL, CUCFG), "lp-registry");
    assert.equal(pdaOwnerKind(WALLET, SOL, CUCFG), null);
    assert.equal(pdaGraceLeft(IN_GRACE.nowSlot, RESOLVED_AT, GRACE), 1n);
    assert.equal(pdaGraceLeft(AFTER_GRACE.nowSlot, RESOLVED_AT, GRACE), 0n);
    assert.equal(pdaGraceLeft(1n, null, GRACE), GRACE, "unknown resolve slot = full grace (fail safe for the holder)");
  });

  it("EMPTY NFT-escrowed, WITHIN grace: skipped — no close tx ever names it", async () => {
    const pf = PF();
    const c = cconn([{ pubkey: pf, data: emptyPortfolio(escrow) }, { pubkey: PF(), data: withOwner(WALLET) }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), IN_GRACE);
    assert.equal(r.closed, 1, "only the wallet-owned portfolio");
    assert.ok(!c.calls.simKeys.slice(1).some((ks) => ks.includes(pf.toBase58())));
    assert.match(r.remaining.find((x) => x.portfolio === pf.toBase58())!.reason, /grace period, 1 slots left/);
    assert.deepEqual(r.pdaClosed, []);
  });
  it("EMPTY NFT-escrowed, AFTER grace: tag 8 ALONE with [3] = escrow PDA (no CloseResolved), reported", async () => {
    const pf = PF();
    const c = cconn([{ pubkey: pf, data: emptyPortfolio(escrow) }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), AFTER_GRACE);
    assert.equal(r.closed, 1);
    assert.deepEqual(c.calls.sent, [[8]]);
    assert.ok(c.calls.simKeys[c.calls.simKeys.length - 1].includes(escrow.toBase58()), "escrow PDA passed as [3]");
    assert.deepEqual(r.pdaClosed, [{ portfolio: pf.toBase58(), owner: escrow.toBase58(), kind: "nft-escrow", rentLamports: 67_000_000 }]);
  });
  for (const [when, clock] of [["within", IN_GRACE], ["after", AFTER_GRACE]] as const) {
    it(`REAL escrowed portfolio WITH a claim (${when} grace): never attempted; reported as waiting on the NFT holder with mint + claim`, async () => {
      const rec = fx("escrowed-position-nft-record");
      const d = decodePositionNft(new Uint8Array(rec))!;
      assert.ok(d.portfolio.equals(ESCROWED_CLAIM_PF), "real record points at the real portfolio (offset 10)");
      const c = cconn([{ pubkey: ESCROWED_CLAIM_PF, data: fx("escrowed-claim-portfolio-v18") }], p3(() => ({ err: null })), {
        nftRecords: [{ pubkey: new PublicKey("4rHXEHHDGqrZrYdibKVkVmvo2gdwQqgfmsKTfdBQNqiR"), data: rec }],
      });
      const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), clock);
      assert.equal(c.calls.sent.length, 0, "no tx: GH#496, holder-only");
      assert.equal(c.calls.sims.length, 1, "only the capability probe");
      assert.deepEqual(r.waitingOnHolder, [{
        portfolio: ESCROWED_CLAIM_PF.toBase58(), nftMint: ESCROW_NFT_MINT, holder: ESCROW_NFT_HOLDER,
        capital: 498_677_477n, pnl: 0n, reservedPnl: 0n, activeLegs: 1,
      }]);
      assert.match(r.remaining[0].reason, /waiting on NFT holder/);
    });
  }

  const lpPf = PF();
  const vaultLp = { state: vaultLpStateBuf(registry, lpPf, WALLET), registry: registryBuf() };
  it("vault LP (registry PDA): 101 topup=0 -> 101 topup=1 -> tag 8 with [3] = registry, immediately (no grace)", async () => {
    const c = cconn([{ pubkey: lpPf, data: withOwner(registry) }], p3(() => ({ err: null })), { vaultLp });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), IN_GRACE);
    assert.deepEqual(c.calls.sent, [[-1, 101], [1011], [8]]);
    assert.equal(r.closed, 1);
    assert.deepEqual(r.vaultLpClosed, [lpPf.toBase58()]);
    assert.deepEqual(r.pdaClosed, [], "rent to the registry is expected: logged, not alerted");
    const closeKeys = c.calls.simKeys[c.calls.simKeys.length - 1];
    assert.ok(closeKeys.includes(registry.toBase58()), "registry PDA as [3]");
  });
  it("vault LP: a 21 on 101 topup=1 (nothing pending) is harmless — tag 8 still runs", async () => {
    const c = cconn([{ pubkey: lpPf, data: withOwner(registry) }], p3((t) => (t.includes(1011) ? { err: { InstructionError: [1, { Custom: 21 }] } } : { err: null })), { vaultLp });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), AFTER_GRACE);
    assert.deepEqual(c.calls.sent, [[-1, 101], [8]]);
    assert.equal(r.closed, 1);
  });
  it("tag 101 wire: [101][topup], the 12 accounts in the b2b2559e order, BOTH pot ledgers writable (d119eebd books a pending senior draw)", async () => {
    const { buildVaultLpSettleResolvedIx } = await import("./resolved-portfolio-cleanup.ts");
    const st = { registry, lpPortfolio: lpPf, juniorOwner: WALLET, seniorDrawnAtoms: 0n, seniorDrawOutstandingAtoms: 0n };
    const ix = buildVaultLpSettleResolvedIx({ wrapperProgramId: WRAPPER, caller: KEEPER.publicKey, market: SOL, vaultLpState: deriveVaultLpState(WRAPPER, SOL), state: st, registryDomain: 0, collateralMint: MINT, topup: 1 });
    assert.deepEqual([...ix.data], [101, 1]);
    assert.equal(ix.keys.length, 12);
    assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [
      [true, true], [false, true], [false, false], [false, true], [false, true], [false, true], [false, true], [false, true], [false, true], [false, false], [false, false], [false, false],
    ]);
    assert.ok(ix.keys[5].pubkey.equals(deriveLpBackingLedger(WRAPPER, SOL, 0)[0]) && ix.keys[6].pubkey.equals(deriveLpBackingLedger(WRAPPER, SOL, 1)[0]));
    assert.ok(ix.keys[2].pubkey.equals(registry) && ix.keys[4].pubkey.equals(lpPf) && ix.keys[7].pubkey.equals(ownerAta(WALLET, MINT)));
  });
  // ── Option B (5544302a): tag-46 top-up sweep right after the vault LP's final 101 ──
  /** A wallet-owned trader portfolio carrying a PARTIAL resolved receipt (present, not finalised). */
  const withOpenReceipt = (owner: PublicKey, finalized = 0): Buffer => {
    const b = withOwner(owner);
    b[RESOLVED_RECEIPT_OFF + 64] = 1; b[RESOLVED_RECEIPT_OFF + 65] = finalized;
    return b;
  };
  it("receipt decoder (offset 9369: present @+64, finalized @+65) and the tag-46 wire (CloseResolved accounts, data [46])", () => {
    assert.equal(receiptOpen(withOpenReceipt(WALLET)), true);
    assert.equal(receiptOpen(withOpenReceipt(WALLET, 1)), false);
    assert.equal(receiptOpen(withOwner(WALLET)), false);
    const pf = PF();
    const ix = buildClaimResolvedPayoutTopupIx({ wrapperProgramId: WRAPPER, owner: WALLET, market: SOL, portfolio: pf, collateralMint: MINT });
    const cr = buildCloseResolvedIx({ wrapperProgramId: WRAPPER, owner: WALLET, market: SOL, portfolio: pf, collateralMint: MINT });
    assert.deepEqual([...ix.data], [46]);
    assert.deepEqual(ix.keys, cr.keys, "same 8 accounts as the permissionless CloseResolved (owner unsigned, [7] nft_registry)");
    assert.equal(ix.keys[0].isSigner, false);
  });
  it("partial receipt: trader stuck before 101 → vault LP 101 settles → tag-46 sweep → tag 8; every receipt finalised", async () => {
    const trader = PF();
    let swept = false;
    const c = cconn([{ pubkey: trader, data: withOpenReceipt(WALLET) }, { pubkey: lpPf, data: withOwner(registry) }], p3((t) => {
      if (t.includes(46)) { swept = true; return { err: null }; }
      // the trader cannot close while its receipt is open (CloseResolved/tag 8 refused; no chunk progress)
      if (!swept && (t.includes(30) || (t.length === 1 && t[0] === 8 && c.calls.sent.every((x) => !x.includes(1011) && !x.includes(101))))) return { err: { InstructionError: [1, { Custom: 21 }] } };
      return { err: null };
    }), { vaultLp });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), IN_GRACE);
    const flat = c.calls.sent.map((x) => x.join(","));
    const i101 = flat.findIndex((x) => x.includes("101"));
    const i46 = flat.findIndex((x) => x === "46");
    assert.ok(i101 >= 0 && i46 > i101, `46 sent right AFTER the vault LP's 101 (sent: ${flat.join(" | ")})`);
    assert.equal(flat[i46 + 1], "8", "the swept trader is closed right after its 46");
    assert.deepEqual(r.topupSwept, [trader.toBase58()]);
    assert.ok(r.vaultLpClosed.includes(lpPf.toBase58()));
    assert.ok(!r.remaining.some((x) => x.portfolio === trader.toBase58()), "no open receipt left");
  });
  it("NEGATIVE CONTROL: the sweep never runs while the vault LP is not yet settled (101 not final)", async () => {
    const trader = PF();
    const c = cconn([{ pubkey: trader, data: withOpenReceipt(WALLET) }, { pubkey: lpPf, data: withOwner(registry) }],
      p3((t) => (t.includes(101) || t.includes(1011) || t.includes(30) || (t.length === 1 && t[0] === 8) ? { err: { InstructionError: [1, { Custom: 21 }] } } : { err: null })), { vaultLp });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), IN_GRACE);
    assert.ok(!c.calls.sent.some((x) => x.includes(46)), "no 46 before the vault LP is settled");
    assert.deepEqual(r.topupSwept, []);
  });
  it("revisit rule: 46 refused → a repeat CloseResolved is sent instead; not yet finalised → NOT closed, revisited next cycle", async () => {
    const trader = PF();
    const c = cconn([{ pubkey: trader, data: withOpenReceipt(WALLET) }], p3((t) => {
      if (t.includes(46)) return { err: { InstructionError: [1, { Custom: 21 }] } };
      if (t.length === 1 && t[0] === 30) return { err: null };
      return { err: { InstructionError: [1, { Custom: 21 }] } }; // tag 8 / CloseResolved+8 refused: receipt still open
    }));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), AFTER_GRACE);
    assert.ok(!c.calls.sent.some((x) => x.includes(46)), "no 46 sent (refused)");
    assert.ok(c.calls.sent.some((x) => x.length === 1 && x[0] === 30), "a repeat CloseResolved is sent");
    assert.ok(!c.calls.sent.some((x) => x.length === 1 && x[0] === 8), "not closed while the receipt is still open");
    assert.deepEqual(r.topupSwept, [trader.toBase58()]);
    assert.ok(r.remaining.some((x) => x.portfolio === trader.toBase58() && /revisit next cycle/.test(x.reason)));
  });
  it("no open receipt (finalised): the sweep sends no 46", async () => {
    const trader = PF();
    const c = cconn([{ pubkey: trader, data: withOpenReceipt(WALLET, 1) }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), AFTER_GRACE);
    assert.ok(!c.calls.sent.some((x) => x.includes(46)));
    assert.deepEqual(r.topupSwept, []);
  });
  it("a registry-owned portfolio with no bound vault-LP state is reported, not guessed at", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(registry) }], p3(() => ({ err: null })));
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), AFTER_GRACE);
    assert.equal(c.calls.sent.length, 0);
    assert.match(r.remaining[0].reason, /no bound vault-LP state/);
  });
});

describe("wind-down: cleanup runs before stake tag 29", () => {
  const MODE_ABS = 592 + 626;
  const COUNT_ABS = 592 + 517;
  const resolvedTextit = (count: bigint): Buffer => {
    const b = Buffer.from(fx("textit-market-v18-fees"));
    b[MODE_ABS] = 1;
    b.writeBigUInt64LE(count, COUNT_ABS);
    b.writeBigUInt64LE(RESOLVED_AT, 592 + 627); // resolved_slot
    return b;
  };
  const TEXTIT = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
  const TCFG: TerminalInsuranceConfig = { wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000, confirm: CUCFG.confirm, now: () => 0, cleanup: CUCFG };

  function wconn(afterCleanupCount: bigint, cleanupProbe: Sim, budgetCallAnswers21 = false, pfData: Buffer = withOwner(WALLET), nowSlot: bigint = AFTER_GRACE.nowSlot, pfKey: PublicKey = PF()) {
    let marketReads = 0;
    let reReads = 0;
    const order: string[] = [];
    let n = 0;
    const conn = {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        if (keys.length === 2 && keys[1].equals(deriveStakePool(TEXTIT, STAKE)[0])) {
          marketReads++;
          return [{ data: resolvedTextit(1n), owner: WRAPPER, lamports: 1, executable: false }, { data: fx("textit-stake-pool-v18"), owner: STAKE, lamports: 1, executable: false }];
        }
        if (keys.length === 1 && keys[0].equals(TEXTIT)) reReads++;
        if (keys.length === 1 && keys[0].equals(TEXTIT)) return [{ data: resolvedTextit(afterCleanupCount), owner: WRAPPER, lamports: 1, executable: false }];
        return keys.map(() => ({ data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false }));
      },
      async getProgramAccounts() { return [{ pubkey: pfKey, account: { data: pfData, owner: WRAPPER, lamports: 67_000_000, executable: false } }]; },
      async getSlot() { return Number(nowSlot); },
      async getAccountInfo() { return null; },
      async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: [] }; },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
      async simulateTransaction(tx: VersionedTransaction) {
        const ix = tx.message.compiledInstructions[1];
        const pid = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
        const kind = pid === STAKE.toBase58() ? `stake29(${Buffer.from(ix.data).readBigUInt64LE(1)})` : `wrapper${ix.data[0]}`;
        order.push(kind);
        if (budgetCallAnswers21 && pid === STAKE.toBase58() && Buffer.from(ix.data).readBigUInt64LE(1) > 0n) {
          return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 21 }] }, logs: [] } };
        }
        if (n++ === 0) return { context: { slot: 1 }, value: { err: cleanupProbe.err, logs: [] } };
        if (kind.startsWith("stake29") && order.filter((o) => o.startsWith("stake29")).length === 1) return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 30 }] }, logs: [] } }; // tag-29 probe
        return { context: { slot: 1 }, value: { err: null, logs: [] } };
      },
      async sendRawTransaction() { order.push("SEND"); return "5ig1111111111111111111111111111111111111111111111111111111111111"; },
      async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
      async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    };
    return { conn: conn as unknown as TerminalConnection, order, reads: () => marketReads, reReads: () => reReads };
  }

  it("P3: portfolios closed first, the market re-read (count 0), then tag 29 recovers the budget", async () => {
    const w = wconn(0n, { err: { InstructionError: [1, { Custom: 61 }] } });
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    const firstStakeSim = w.order.findIndex((o) => o.startsWith("stake29"));
    const firstClose = w.order.findIndex((o) => o === "wrapper30");
    assert.ok(firstClose >= 0 && firstClose < firstStakeSim, `cleanup before tag 29: ${w.order.join(" ")}`);
    assert.equal(w.reReads(), 1, "market re-read after the cleanup closed something");
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
  });

  it("EMPTY escrowed portfolio after grace: closed, count reaches 0, tag 29 recovers, and a PDA-close event is raised", async () => {
    const w = wconn(0n, { err: { InstructionError: [1, { Custom: 61 }] } }, false, emptyPortfolio(nftEscrowAuthority(NFT)), AFTER_GRACE.nowSlot);
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
    assert.equal(w.reReads(), 1);
    assert.ok(w.order.some((o) => o.startsWith("stake29(") && o !== "stake29(0)"), "tag 29 with the budget ran after the cleanup");
    const ev = r.outcome.events ?? [];
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, "terminal-pda-portfolio-closed");
    assert.match(ev[0].message, /EMPTY NFT-escrowed portfolio .* 67000000 lamports of rent went to its PDA owner/);
  });
  it("REAL escrowed portfolio WITH a claim: tag 29 blocked -> terminal-waiting-nft-holder names holder, mint, claim", async () => {
    const w = wconn(1n, { err: { InstructionError: [1, { Custom: 61 }] } }, true, fx("escrowed-claim-portfolio-v18"), AFTER_GRACE.nowSlot, ESCROWED_CLAIM_PF);
    const d = decodePositionNft(new Uint8Array(fx("escrowed-position-nft-record")))!;
    const base = w.conn.getProgramAccounts.bind(w.conn);
    (w.conn as unknown as { getProgramAccounts: (p: PublicKey) => Promise<unknown> }).getProgramAccounts = async (prog: PublicKey) =>
      prog.equals(NFT) ? [{ pubkey: PF(), account: { data: fx("escrowed-position-nft-record"), owner: NFT, lamports: 1, executable: false } }] : base(prog as never);
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "blocked");
    const o = r.outcome as { alertKind?: string; reason: string };
    assert.equal(o.alertKind, "terminal-waiting-nft-holder");
    assert.ok(o.reason.includes(ESCROW_NFT_HOLDER) && o.reason.includes(ESCROW_NFT_MINT), o.reason);
    void d;
    assert.match(o.reason, /claim capital 498677477/);
    assert.ok(!w.order.includes("SEND"));
  });
  it("EMPTY escrowed WITHIN grace: not closed, tag 29 still blocked (21) -> B12 alert says why", async () => {
    const w = wconn(1n, { err: { InstructionError: [1, { Custom: 61 }] } }, true, emptyPortfolio(nftEscrowAuthority(NFT)), IN_GRACE.nowSlot);
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "blocked");
    assert.match((r.outcome as { reason: string }).reason, /closed 0.*grace period, 1 slots left/);
    assert.deepEqual(r.outcome.events ?? [], []);
  });

  it("C-7: a chunked close that progressed but is not done -> 'in progress' (skipped), NOT the B12 blocked alert", async () => {
    const w = wconn(1n, { err: { InstructionError: [1, { Custom: 61 }] } }, true);
    const base = w.conn.simulateTransaction.bind(w.conn);
    let n = 0;
    (w.conn as unknown as { simulateTransaction: (tx: VersionedTransaction, o?: { accounts?: { addresses: string[] } }) => Promise<unknown> }).simulateTransaction = async (tx, o) => {
      const tags = tx.message.compiledInstructions.map((ix) => (tx.message.staticAccountKeys[ix.programIdIndex].equals(WRAPPER) ? ix.data[0] : -1));
      if (tags.includes(8)) return { context: { slot: 1 }, value: { err: { InstructionError: [tags.indexOf(8), { Custom: 21 }] }, logs: [] } };
      if (o?.accounts) return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: [Buffer.alloc(64, ++n).toString("base64"), "base64"] }] } };
      return base(tx as never, o as never);
    };
    const cfg = { ...TCFG, cleanup: { ...TCFG.cleanup!, maxChunkCallsPerCycle: 3 } };
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, cfg, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "skipped", JSON.stringify(r.outcome));
    assert.match((r.outcome as { reason: string }).reason, /cleanup in progress \(3 chunk call\(s\) this cycle/);
  });

  it("6377376a: cleanup is a no-op and the B12 alert names the count and the reason", async () => {
    // tag 29(budget) on a market that still has a portfolio answers 21
    const w = wconn(1n, { err: { InstructionError: [1, { Custom: 8 }] } }, true);
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, TCFG, new TerminalInsuranceState());
    assert.equal(r.outcome.kind, "blocked");
    const reason = (r.outcome as { reason: string }).reason;
    assert.match(reason, /1 materialized portfolio\(s\) remain/);
    assert.match(reason, /Cleanup: support=unsupported, closed 0/);
    assert.ok(!w.order.includes("SEND"), "nothing sent on 6377376a");
  });
});

describe("C-7: chunked resolved closes (CloseResolved / tag 101 advance one chunk per call)", () => {
  const onlyCloseRefused = (t: number[]): Sim => (t.includes(8) && t.includes(30) ? { err: { InstructionError: [2, { Custom: 21 }] } } : { err: null });

  it("CloseResolved over 5 chunks, then tag 8: closed in ONE cycle, each chunk a distinct transaction", async () => {
    const pf = PF();
    let chunkDone = 0;
    const c = cconn([{ pubkey: pf, data: withOwner(WALLET) }], p3((t) => {
      if (t.length === 1 && t[0] === 8) return chunkDone >= 5 ? { err: null } : { err: { InstructionError: [1, { Custom: 21 }] } }; // tag 8 only once flat
      return onlyCloseRefused(t);
    }), { chunks: 5 });
    const origSend = c.conn.sendRawTransaction.bind(c.conn);
    const sigs = new Set<string>();
    (c.conn as unknown as { sendRawTransaction: (raw: Buffer) => Promise<string> }).sendRawTransaction = async (raw: Buffer) => {
      sigs.add(Buffer.from(VersionedTransaction.deserialize(raw).signatures[0]).toString("hex"));
      const r = await origSend(raw as never);
      if (c.calls.sent[c.calls.sent.length - 1].join() === "30") chunkDone++;
      return r;
    };
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(r.closed, 1);
    assert.equal(r.progressed, 5);
    assert.deepEqual(c.calls.sent, [[30], [30], [30], [30], [30], [8]]);
    assert.equal(sigs.size, 6, "no duplicate signatures across chunk calls");
  });

  it("per-cycle cap: a close that needs more chunks stops at the cap and reports 'progress, not done' (not a failure)", async () => {
    const c = cconn([{ pubkey: PF(), data: withOwner(WALLET) }], p3((t) => (t.includes(8) ? { err: { InstructionError: [1, { Custom: 21 }] } } : { err: null })), { chunks: 100 });
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, { ...CUCFG, maxChunkCallsPerCycle: 4 }, new CleanupState());
    assert.equal(r.progressed, 4);
    assert.equal(c.calls.sent.filter((t) => t.join() === "30").length, 4);
    assert.equal(r.closed, 0);
    assert.match(r.remaining[0].reason, /made progress \(4 chunk call\(s\)\), not done — continues next cycle \(per-cycle cap/);
  });

  it("no progress: a chunk that would change nothing is never sent (never spins)", async () => {
    const real = withOwner(WALLET);
    const c = cconn([{ pubkey: PF(), data: real }], p3((t) => (t.includes(8) ? { err: { InstructionError: [1, { Custom: 21 }] } } : { err: null })));
    // the chunk simulation reports the portfolio unchanged
    const base = c.conn.simulateTransaction.bind(c.conn);
    (c.conn as unknown as { simulateTransaction: (tx: VersionedTransaction, o?: { accounts?: { addresses: string[] } }) => Promise<unknown> }).simulateTransaction = async (tx, o) => {
      const res = (await base(tx as never, o as never)) as { value: { accounts?: unknown[] } };
      if (o?.accounts) res.value.accounts = [{ data: [real.toString("base64"), "base64"] }];
      return res;
    };
    const out = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState());
    assert.equal(c.calls.sent.length, 0, "nothing sent");
    assert.equal(out.progressed, 0);
    assert.match(out.remaining[0].reason, /would make no progress/);
  });

  it("vault LP: 101(0) over 3 chunks (junior ATA ensured on the first), then 101(1), then tag 8", async () => {
    const reg = deriveLpVaultRegistry(WRAPPER, SOL)[0];
    const lp = PF();
    const state = vaultLpStateBuf(reg, lp, WALLET);
    let settled = 0;
    const c = cconn([{ pubkey: lp, data: withOwner(reg) }], p3((t) => {
      if (t.length === 1 && t[0] === 8) return settled >= 3 ? { err: null } : { err: { InstructionError: [1, { Custom: 21 }] } };
      if (t.includes(1011)) return settled >= 3 ? { err: null } : { err: { InstructionError: [1, { Custom: 21 }] } };
      return { err: null };
    }), { vaultLp: { state, registry: registryBuf() }, chunks: 3 });
    const origSend = c.conn.sendRawTransaction.bind(c.conn);
    (c.conn as unknown as { sendRawTransaction: (raw: Buffer) => Promise<string> }).sendRawTransaction = async (raw: Buffer) => {
      const r = await origSend(raw as never);
      if (c.calls.sent[c.calls.sent.length - 1].includes(101)) settled++;
      return r;
    };
    const r = await cleanupResolvedPortfolios(c.conn, KEEPER, SOL, MINT, false, CUCFG, new CleanupState(), AFTER_GRACE);
    assert.deepEqual(c.calls.sent, [[-1, 101], [101], [101], [1011], [8]]);
    assert.equal(r.closed, 1);
  });
});
