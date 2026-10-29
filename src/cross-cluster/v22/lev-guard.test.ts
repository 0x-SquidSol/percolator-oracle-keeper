/**
 * Leverage guard (wrapper tag 124) keeper jobs: lev-guard-math.ts (CPMM dump, holder_terms port, holder filter, report clamp) and lev-guard.ts
 * (POKE, the hourly holder job, W1). Fakes only: no RPC, no transaction is ever sent anywhere.
 *
 * The instruction-level tests compare what the keeper SENDS with the SDK builders' bytes and account metas and with hand-computed bytes (the SDK
 * test vectors), so a drifting SDK fails here rather than on a send.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { WRAPPER_ACCOUNT_MAGIC, LAYOUT_V22, deriveDepthSourceV22 } from "@percolatorct/sdk";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import {
  buildLevGuardLpStopIxV22,
  buildLevGuardPokeIxV22,
  buildLevGuardReportIxV22,
  buildLevGuardTightenIxV22,
  deriveLevGuardV22,
  deriveVaultLpExtV22,
  deriveVaultLpStateV22,
  levLpStopTriggeredV22,
  levW1RoundLiveV22,
  decodeLevGuardV22,
  levKeyTagV22,
} from "@percolatorct/sdk";
import {
  BPS_MAX,
  INCINERATOR,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  buildReport,
  clampBps,
  cpmmDumpBps,
  filterHolders,
  holderAttemptOrder,
  holderTerms,
  knownExcludedOwners,
  largestHolder,
  totalsByOwner,
} from "./lev-guard-math.ts";
import type { OwnerView, TokenAccountView } from "./lev-guard-math.ts";
import { LEV_GUARD_DEFAULTS, LevGuardKeeper, keyTagOf, netPosOnAsset, W1_MAX_VICTIMS_PER_TX, levGuardConfigFromEnv, levGuardEnabled, loadRiskKey, w1Victims } from "./lev-guard.ts";
import type { LevGuardConfig } from "./lev-guard.ts";
import { fakeExecConn, key, portfolioBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";
import { levGuardHealthFields, setLevGuardHealthProvider } from "./health.ts";
import { resetJobCounters, allJobCounters } from "./exec.ts";
import { V22FlagError, v22FlagsFromEnv } from "./flags.ts";
import { VaultLpAllocator } from "../p2b-allocate.ts";
import { DEFAULT_ALLOCATE_CONFIG } from "../p2b-allocate.ts";
import { KEEPER as P2B_KEEPER, PROGRAM as P2B_PROGRAM, fakeConn as p2bFakeConn, patchedMarket, registryBytes as p2bRegistryBytes, snapshot, vaultLpStateBytes as p2bVaultLpState } from "../p2b-test-helpers.ts";

const PROGRAM = WRAPPER_PROGRAM_ID;
const hex = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("hex");

// ── byte builders ────────────────────────────────────────────────────────────────────────────────

interface GuardOpts {
  market: PublicKey;
  riskKey?: PublicKey;
  assetIndex?: number;
  t0?: bigint;
  roundActive?: boolean;
  roundLpLong?: boolean;
  roundOpenSlot?: bigint;
  roundId?: bigint;
  navps?: bigint;
  navPeakCur?: bigint;
  navRef?: bigint;
  touched?: PublicKey[];
}

/** A 4,456 B guard account (header kind 17) with the fields the keeper reads. */
function guardBytes(o: GuardOpts): Uint8Array {
  const data = new Uint8Array(4456);
  const v = new DataView(data.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  data[10] = 17;
  const r = 16;
  data.set(o.market.toBytes(), r);
  data.set((o.riskKey ?? new PublicKey(new Uint8Array(32))).toBytes(), r + 32);
  v.setBigUint64(r + 64, o.t0 ?? 0n, true);
  v.setUint16(r + 72, o.assetIndex ?? 0, true);
  data[r + 74] = 1;
  data[r + 77] = o.roundActive ? 1 : 0;
  data[r + 78] = o.roundLpLong ? 1 : 0;
  const u128 = (off: number, x: bigint): void => {
    v.setBigUint64(r + off, x & ((1n << 64n) - 1n), true);
    v.setBigUint64(r + off + 8, x >> 64n, true);
  };
  const ONE = 1_000_000_000_000n;
  u128(184, o.navps ?? ONE);
  u128(248, o.navPeakCur ?? ONE);
  u128(264, o.navPeakCur ?? ONE);
  u128(280, o.navRef ?? ONE);
  v.setBigUint64(r + 312, o.roundId ?? 0n, true);
  v.setBigUint64(r + 336, o.roundOpenSlot ?? 0n, true);
  const touched = o.touched ?? [];
  v.setUint16(r + 100, touched.length, true);
  touched.forEach((k, i) => v.setBigUint64(r + 344 + 8 * i, keyTagOf(k), true));
  return data;
}

/** A 272 B active depth-source pin (header kind 16). */
function pinBytes(p: { market: PublicKey; pool: PublicKey; amm: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; baseMint: PublicKey; quoteMint: PublicKey }): Uint8Array {
  const data = new Uint8Array(272);
  const v = new DataView(data.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  data[10] = 16;
  const b = 16;
  data.set(p.market.toBytes(), b);
  data.set(p.amm.toBytes(), b + 32);
  data.set(p.pool.toBytes(), b + 64);
  data.set(p.baseVault.toBytes(), b + 96);
  data.set(p.quoteVault.toBytes(), b + 128);
  data.set(p.baseMint.toBytes(), b + 160);
  data.set(p.quoteMint.toBytes(), b + 192);
  v.setBigUint64(b + 224, 1n, true);
  v.setUint16(b + 240, 0, true);
  data[b + 242] = 6;
  data[b + 243] = 6;
  data[b + 244] = 1; // active
  data[b + 245] = 1; // version
  data[b + 247] = 1; // amm kind
  return data;
}

/** A 165 B initialized token account. */
function tokenAcct(mint: PublicKey, owner: PublicKey, amount: bigint, state = 1): Uint8Array {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = state;
  return d;
}

// ── a fake connection with account state ─────────────────────────────────────────────────────────

interface Acct {
  owner: PublicKey;
  data: Uint8Array;
}

function levConn(o: { accounts: Map<string, Acct>; slot?: () => number; largest?: Array<{ address: PublicKey; amount: string }>; supply?: bigint; simErr?: (keys: string[][]) => unknown; onSend?: (data: Uint8Array, keys: string[]) => void }) {
  const base = fakeExecConn({
    slot: o.slot,
    simErr: o.simErr ? (d) => o.simErr!(d.keys) : undefined,
  });
  const reads = { getAccountInfo: 0, getMultipleAccountsInfo: 0, getTokenLargestAccounts: 0, getTokenSupply: 0, getSlot: 0 };
  const raws: Buffer[] = [];
  const info = (k: PublicKey) => {
    const a = o.accounts.get(k.toBase58());
    return a ? { data: Buffer.from(a.data), owner: a.owner, lamports: 1, executable: false } : null;
  };
  const origSend = base.conn.sendRawTransaction.bind(base.conn);
  const conn = Object.assign(base.conn, {
    async getAccountInfo(k: PublicKey) {
      reads.getAccountInfo++;
      return info(k);
    },
    async getMultipleAccountsInfo(ks: PublicKey[]) {
      reads.getMultipleAccountsInfo++;
      return ks.map(info);
    },
    async getTokenLargestAccounts() {
      reads.getTokenLargestAccounts++;
      return { context: { slot: 1 }, value: (o.largest ?? []).map((x) => ({ address: x.address, amount: x.amount, decimals: 6, uiAmount: 0, uiAmountString: "0" })) };
    },
    async getTokenSupply() {
      reads.getTokenSupply++;
      return { context: { slot: 1 }, value: { amount: String(o.supply ?? 0n), decimals: 6, uiAmount: 0, uiAmountString: "0" } };
    },
    async getSlot() {
      reads.getSlot++;
      return (o.slot ?? (() => 1000))();
    },
    async sendRawTransaction(raw: Uint8Array) {
      raws.push(Buffer.from(raw));
      const sig = await origSend(raw);
      const last = base.sentData[base.sentData.length - 1];
      o.onSend?.(last[last.length - 1], base.sent[base.sent.length - 1].keys[base.sent[base.sent.length - 1].keys.length - 1]);
      return sig;
    },
  });
  return { conn, base, reads, raws };
}

const cfg = (c: Partial<LevGuardConfig> = {}): LevGuardConfig => ({ ...LEV_GUARD_DEFAULTS, ...c });
const SLOT = 1_000_000;

/** A guarded market: market, guard, vault LP state + LP portfolio key, all as program-owned accounts. */
function world(g: Partial<GuardOpts> = {}, opts: { vaultLp?: boolean; guard?: boolean } = {}) {
  const market = key(500);
  const lp = key(501);
  const accounts = new Map<string, Acct>();
  if (opts.guard !== false) accounts.set(deriveLevGuardV22(PROGRAM, market)[0].toBase58(), { owner: PROGRAM, data: guardBytes({ market, ...g }) });
  if (opts.vaultLp !== false) accounts.set(deriveVaultLpStateV22(PROGRAM, market)[0].toBase58(), { owner: PROGRAM, data: vaultLpStateBytes(lp) });
  accounts.set(market.toBase58(), { owner: PROGRAM, data: v22MarketBytes() });
  return { market, lp, accounts, guardKey: deriveLevGuardV22(PROGRAM, market)[0] };
}

function keeperOf(conn: ReturnType<typeof levConn>["conn"], c: LevGuardConfig, extra: { dryRun?: boolean; riskKey?: Keypair | null; loadPortfolios?: (m: PublicKey, len: number) => Promise<Array<{ pubkey: PublicKey; data: Uint8Array }>>; now?: () => number } = {}) {
  const logs: string[] = [];
  const kp = Keypair.generate();
  const k = new LevGuardKeeper({ conn: conn as never, keeper: kp, programId: PROGRAM, dryRun: extra.dryRun ?? false, config: c, riskKey: extra.riskKey ?? null, loadPortfolios: extra.loadPortfolios, now: extra.now, log: (s) => logs.push(s) });
  return { k, logs, kp };
}

const keysOf = (ix: { keys: Array<{ pubkey: PublicKey }> }): string[] => ix.keys.map((x) => x.pubkey.toBase58());

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("holder maths", () => {
  it("cpmmDumpBps mirrors lev_guard_v22::cpmm_dump_bps (floor ratio, round up)", () => {
    assert.equal(cpmmDumpBps(1000n, 0n), 0);
    assert.equal(cpmmDumpBps(0n, 5n), BPS_MAX);
    assert.equal(cpmmDumpBps(1000n, 1000n), 7500); // 1 - 0.25
    assert.equal(cpmmDumpBps(1_000_000_000n, 500_000_000n), 5556); // ratio 666666666 -> kept 4444 -> 5556
    assert.equal(cpmmDumpBps(1n, 1n << 63n), 10_000);
    // u64 extremes do not overflow (BigInt) and stay <= 10_000
    assert.ok(cpmmDumpBps((1n << 64n) - 1n, (1n << 64n) - 1n) <= BPS_MAX);
  });

  it("holderTerms equals the sim model (levmodel.py holder_terms) on three reference books", () => {
    // reference values printed by `python3 -c "import levmodel as m; m.holder_terms(...)"`
    const a = holderTerms([{ kind: "whale", frac: 0.05 }, { kind: "whale", frac: 0.01 }, { kind: "dev", frac: 0.1 }], 0.2, 10);
    assert.ok(Math.abs(a.J - 0.05555555555555556) < 1e-12);
    assert.ok(Math.abs(a.mInd - 0.5555555555555556) < 1e-12);
    assert.ok(Math.abs(a.H - 0.0012401421846196781) < 1e-12);
    const b = holderTerms([{ kind: "whale", frac: 0.05 }, { kind: "whale", frac: 0.01 }], 0.2, 10);
    assert.ok(Math.abs(b.J - 0.005246913580246912) < 1e-12);
    assert.ok(Math.abs(b.mInd - 0.36) < 1e-12);
    assert.ok(Math.abs(b.H - 0.00012903107350856706) < 1e-12);
    const c = holderTerms([{ kind: "whale", frac: 0.05 }], 0.0125, 100);
    assert.ok(Math.abs(c.J - 0.022222222222222223) < 1e-12);
    assert.ok(Math.abs(c.mInd - 0.96) < 1e-12);
  });

  it("H9: m_ind uses the holder's FULL balance (s = 1), J keeps the partial-sale share; top10 / early / non-individual never feed m_ind", () => {
    const x = 0.1;
    const frac = 0.05;
    const r = holderTerms([{ kind: "whale", frac }], x, 50);
    const full = 1 - (x / (x + frac)) ** 2;
    const half = 1 - (x / (x + 0.5 * frac)) ** 2;
    assert.ok(Math.abs(r.mInd - full) < 1e-12);
    assert.ok(full > half);
    assert.ok(Math.abs(r.J - 0.025 * half) < 1e-12, "J = min(1, pi / P_TGT) * m with s = 0.5");
    assert.equal(holderTerms([{ kind: "top10", frac }], x, 50).mInd, 0);
    assert.equal(holderTerms([{ kind: "early", frac }], x, 50).mInd, 0);
    assert.equal(holderTerms([{ kind: "whale", frac, individual: false }], x, 50).mInd, 0);
  });
});

describe("holder filtering", () => {
  const mint = key(10).toBase58();
  const vault = key(11).toBase58();
  const quote = key(12).toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();
  const wallet2 = Keypair.generate().publicKey.toBase58();
  const pdaOwner = PublicKey.findProgramAddressSync([Buffer.from("auth")], key(99))[0].toBase58();
  const dataOwner = Keypair.generate().publicKey.toBase58();
  const poolAuth = Keypair.generate().publicKey.toBase58();
  const ta = (address: string, owner: string, amount: bigint, o: Partial<TokenAccountView> = {}): TokenAccountView => ({ address, programOwner: TOKEN_PROGRAM, mint, owner, amount, state: 1, ...o });
  const owners = new Map<string, OwnerView>([
    [wallet, { onCurve: true, accountOwner: SYSTEM_PROGRAM }],
    [wallet2, { onCurve: true, accountOwner: null }],
    [pdaOwner, { onCurve: false, accountOwner: null }],
    [dataOwner, { onCurve: true, accountOwner: key(77).toBase58() }],
    [poolAuth, { onCurve: false, accountOwner: null }],
  ]);
  const input = { baseMint: mint, poolVaults: new Set([vault, quote]), excludedOwners: knownExcludedOwners([poolAuth]), owners };

  it("keeps wallets; drops the pool vaults, known owners, PDA / program-owned owners, frozen, empty, wrong mint, foreign program", () => {
    const accts = [
      ta(vault, poolAuth, 900n),
      ta("A1", poolAuth, 800n), // owner = the pool authority: excluded by identity
      ta("A2", INCINERATOR, 700n),
      ta("A3", pdaOwner, 600n), // off-curve owner
      ta("A4", dataOwner, 500n), // owner address is program-owned data
      ta("A5", wallet, 400n),
      ta("A6", wallet2, 300n),
      ta("A7", wallet, 200n, { state: 2 }), // frozen
      ta("A8", wallet, 0n), // empty
      ta("A9", wallet, 100n, { mint: key(13).toBase58() }),
      ta("A10", wallet, 100n, { programOwner: key(14).toBase58() }),
      ta("A11", key(15).toBase58(), 50n), // owner address never looked up
    ];
    const r = filterHolders(accts, input);
    assert.deepEqual(r.kept.map((c) => c.address), ["A5", "A6"]);
    const why = Object.fromEntries(r.dropped.map((d) => [d.address, d.reason]));
    assert.deepEqual(why, { [vault]: "pool-vault", A1: "excluded-owner", A2: "excluded-owner", A3: "owner-off-curve", A4: "owner-program-owned", A7: "not-initialized", A8: "empty", A9: "wrong-mint", A10: "not-a-token-account", A11: "owner-unknown" });
  });

  it("largest holder and attempt order are by balance (ties: lower address); totals sum one owner's accounts (H9)", () => {
    const kept = [
      { address: "b", owner: wallet, amount: 5n },
      { address: "a", owner: wallet2, amount: 5n },
      { address: "c", owner: wallet, amount: 3n },
    ];
    assert.equal(largestHolder(kept)?.address, "a");
    assert.deepEqual(holderAttemptOrder(kept).map((c) => c.address), ["a", "b", "c"]);
    assert.equal(largestHolder([]), null);
    const t = new Map(totalsByOwner(kept).map((x) => [x.owner, x.total]));
    assert.equal(t.get(wallet), 8n);
    assert.equal(t.get(wallet2), 5n);
  });
});

describe("report fields", () => {
  it("clampBps: integer in [0, 10000], rounds up, non-finite -> null", () => {
    assert.equal(clampBps(12_000), 10_000);
    assert.equal(clampBps(-5), 0);
    assert.equal(clampBps(0.0001), 1);
    assert.equal(clampBps(90.00000000000001), 90);
    assert.equal(clampBps(0), 0);
    assert.equal(clampBps(Number.NaN), null);
    assert.equal(clampBps(Number.POSITIVE_INFINITY), null);
  });

  it("buildReport: m_ind from the FULL balance by the integer CPMM, j_dump from the whale-treated model, no cap, n_mult 10000", () => {
    const r = buildReport({ reserve: 1_000_000_000n, supply: 10_000_000_000n, ownerTotals: [{ owner: "w1", total: 500_000_000n }, { owner: "w2", total: 100_000_000n }], ageDays: 20 });
    assert.deepEqual(r, { jDumpBps: 90, mIndBps: 5556, lCapX100: 0, nMultBps: 10_000 });
  });

  it("buildReport clamps to [0, 10000] and refuses garbage: an owner above the whole supply, zero supply, zero reserve with zero balance", () => {
    const big = buildReport({ reserve: 1n, supply: 1_000n, ownerTotals: [{ owner: "w", total: 10n ** 12n }], ageDays: 20 });
    assert.ok(big);
    for (const f of [big.jDumpBps, big.mIndBps, big.nMultBps]) assert.ok(Number.isInteger(f) && f >= 0 && f <= BPS_MAX);
    assert.equal(big.mIndBps, BPS_MAX);
    assert.equal(buildReport({ reserve: 5n, supply: 0n, ownerTotals: [], ageDays: 1 }), null);
    assert.equal(buildReport({ reserve: 0n, supply: 100n, ownerTotals: [{ owner: "w", total: 0n }], ageDays: 1 }), null, "0/0 is NaN: no report");
    const none = buildReport({ reserve: 100n, supply: 1000n, ownerTotals: [], ageDays: 1 });
    assert.deepEqual(none, { jDumpBps: 0, mIndBps: 0, lCapX100: 0, nMultBps: 10_000 });
  });
});

describe("touched tag", () => {
  it("keyTagOf is the first 8 bytes of the key, LE, for pooled and unpooled buffers and equals the SDK's fixed levKeyTagV22", () => {
    for (let i = 0; i < 20; i++) {
      const k = Keypair.generate().publicKey;
      assert.equal(keyTagOf(k), Buffer.from(k.toBase58() ? k.toBuffer() : []).readBigUInt64LE(0));
      assert.equal(keyTagOf(k), levKeyTagV22(k));
      assert.equal(keyTagOf(k), new DataView(Uint8Array.from(k.toBuffer()).buffer).getBigUint64(0, true));
    }
    assert.notEqual(keyTagOf(key(2001)), keyTagOf(key(2002)));
  });
});

describe("flags", () => {
  it("every job is OFF by default and nothing is enabled with an empty env", () => {
    const c = levGuardConfigFromEnv({});
    assert.deepEqual(c, LEV_GUARD_DEFAULTS);
    assert.equal(c.poke, false);
    assert.equal(c.holderJob, false);
    assert.equal(c.w1, false);
    assert.equal(c.riskKeyPath, null);
    assert.equal(levGuardEnabled(c), false);
  });
  it("GH#226: KEEPER_LEV_DRY_RUN is this subsystem's own switch, because KEEPER_V22_DRY_RUN does not reach it", () => {
    // The gap being closed: these jobs run outside KEEPER_V22, and with KEEPER_V22 off the v2.2
    // dry-run flag is deliberately not read (N-6) -- so it cannot be what guards op 5.
    assert.equal(v22FlagsFromEnv({ KEEPER_V22_DRY_RUN: "on" }).dryRun, false, "N-6: not read with the master switch off");
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_DRY_RUN: "on" }).dryRun, true, "read when the layer is on");
    // the subsystem's own switch, independent of KEEPER_V22
    assert.equal(levGuardConfigFromEnv({}).dryRun, false);
    assert.equal(levGuardConfigFromEnv({ KEEPER_LEV_DRY_RUN: "1" }).dryRun, true);
    assert.equal(levGuardConfigFromEnv({ KEEPER_LEV_W1: "1", KEEPER_LEV_DRY_RUN: "on" }).dryRun, true);
    // strict like every other KEEPER_LEV_* flag, and it never enables the subsystem by itself
    assert.throws(() => levGuardConfigFromEnv({ KEEPER_LEV_DRY_RUN: "dry" }), V22FlagError);
    assert.equal(levGuardEnabled(levGuardConfigFromEnv({ KEEPER_LEV_DRY_RUN: "1" })), false, "a dry-run flag alone starts no job");
  });
  it("each flag turns on only its own job; 1 / on / true parse; a typo is a startup error (never a silent default)", () => {
    assert.deepEqual([levGuardConfigFromEnv({ KEEPER_LEV_POKE: "1" }).poke, levGuardConfigFromEnv({ KEEPER_LEV_POKE: "1" }).holderJob, levGuardConfigFromEnv({ KEEPER_LEV_POKE: "1" }).w1], [true, false, false]);
    assert.equal(levGuardConfigFromEnv({ KEEPER_LEV_HOLDER_JOB: "on" }).holderJob, true);
    assert.equal(levGuardConfigFromEnv({ KEEPER_LEV_W1: "true" }).w1, true);
    assert.equal(levGuardEnabled(levGuardConfigFromEnv({ KEEPER_LEV_W1: "1" })), true);
    assert.throws(() => levGuardConfigFromEnv({ KEEPER_LEV_POKE: "yes please" }), V22FlagError);
    assert.throws(() => levGuardConfigFromEnv({ KEEPER_LEV_W1_BATCH: "0" }), V22FlagError);
    assert.throws(() => levGuardConfigFromEnv({ KEEPER_LEV_W1_BATCH: String(W1_MAX_VICTIMS_PER_TX + 1) }), V22FlagError);
    assert.throws(() => levGuardConfigFromEnv({ KEEPER_LEV_RISK_KEY_PATH: "relative/key.json" }), V22FlagError);
    assert.equal(levGuardConfigFromEnv({ KEEPER_LEV_RISK_KEY_PATH: "/etc/k.json" }).riskKeyPath, "/etc/k.json");
  });
  it("loadRiskKey never logs key bytes and returns null on a bad file", () => {
    const logs: string[] = [];
    assert.equal(loadRiskKey("/definitely/not/here.json", (s) => logs.push(s)), null);
    assert.ok(logs.every((l) => !/\[\s*\d+\s*,/.test(l)));
  });
  it("L-4: a group- or world-readable risk-key file is refused at startup; 0600 loads", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "levkey-"));
    const f = join(dir, "k.json");
    const kp = Keypair.generate();
    fs.writeFileSync(f, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    fs.chmodSync(f, 0o600);
    assert.ok(loadRiskKey(f, () => {})?.publicKey.equals(kp.publicKey));
    for (const m of [0o640, 0o604, 0o644, 0o660]) {
      fs.chmodSync(f, m);
      assert.throws(() => loadRiskKey(f, () => {}), /group- or world-readable.*chmod 600/);
    }
    fs.rmSync(dir, { recursive: true });
  });
  it("/health gains no levGuard key unless a provider is installed", () => {
    setLevGuardHealthProvider(null);
    assert.deepEqual(levGuardHealthFields(), {});
    setLevGuardHealthProvider(() => ({ poke: true }));
    assert.deepEqual(levGuardHealthFields(), { levGuard: { poke: true } });
    setLevGuardHealthProvider(null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("flags off: no instruction is built and no RPC is made", () => {
  it("every entry point is inert with all three flags off", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    const { k } = keeperOf(c.conn, cfg());
    await k.onPushLanded(w.market.toBase58(), "T");
    await k.beforeAllocate(w.market.toBase58(), "T");
    await k.holderTick([{ marketAddress: w.market.toBase58(), label: "T" }]);
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "disabled");
    assert.equal(await k.w1Once(w.market.toBase58(), "T"), "disabled");
    assert.equal(c.base.sims.length, 0);
    assert.equal(c.base.sent.length, 0);
    assert.deepEqual(c.reads, { getAccountInfo: 0, getMultipleAccountsInfo: 0, getTokenLargestAccounts: 0, getTokenSupply: 0, getSlot: 0 });
  });

  it("each flag alone leaves the other two jobs inert", async () => {
    const w = world({ navps: 1n, navPeakCur: 1_000_000_000_000n }); // stop holds
    for (const only of ["poke", "holderJob", "w1"] as const) {
      const c = levConn({ accounts: w.accounts });
      const { k } = keeperOf(c.conn, cfg({ [only]: true }));
      await k.onPushLanded(w.market.toBase58(), "T");
      const tags = c.base.sims.map((s) => s.keys[0].length);
      if (only === "holderJob") assert.equal(c.base.sims.length, 0, "the holder job runs on its own timer, not on a push");
      if (only === "poke") assert.deepEqual(tags, [6], "poke only: one 6-account op 4");
    }
  });
});

const TRIG_LEN = { navps: 400_000_000_000n, navPeakCur: 1_000_000_000_000n, navRef: 1_000_000_000_000n };
describe("guard account length (K-2)", () => {
  const withLen = (len: number, kind = 17, owner: PublicKey = PROGRAM) => {
    const w = world();
    const d = new Uint8Array(len);
    d.set(guardBytes({ market: w.market }).subarray(0, Math.min(len, 4456)));
    d[10] = kind;
    w.accounts.set(w.guardKey.toBase58(), { owner, data: d });
    return w;
  };
  it("4456 B and the burst-memory 4472 B are both a guard: poke is built for both", async () => {
    for (const len of [4456, 4472]) {
      const w = withLen(len);
      const c = levConn({ accounts: w.accounts });
      const { k } = keeperOf(c.conn, cfg({ poke: true }));
      assert.equal(await k.hasGuard(w.market.toBase58()), true, `len ${len}`);
      assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "sent");
    }
  });
  it("any other length at a program-owned kind-17 guard PDA is alerted and counted, and treated as no guard", async () => {
    const w = withLen(4460);
    const c = levConn({ accounts: w.accounts });
    const { k, logs } = keeperOf(c.conn, cfg({ poke: true }));
    assert.equal(await k.hasGuard(w.market.toBase58()), false);
    assert.equal(k.stats.guardBadLength, 1);
    assert.ok(logs.some((l) => l.includes("[ALERT]") && l.includes("4460")));
    assert.equal(c.base.sims.length, 0);
  });
  it("a foreign-owned or other-kind account is silently no guard (no alert)", async () => {
    for (const w of [withLen(4456, 17, key(5)), withLen(4456, 16)]) {
      const c = levConn({ accounts: w.accounts });
      const { k, logs } = keeperOf(c.conn, cfg({ poke: true }));
      assert.equal(await k.hasGuard(w.market.toBase58()), false);
      assert.equal(logs.length, 0);
    }
  });
  it("a real 4472 B guard (record 360 B) decodes through the SDK and W1 reads it", async () => {
    const w = world(TRIG_LEN);
    const d = new Uint8Array(4472);
    d.set(guardBytes({ market: w.market, ...TRIG_LEN }).subarray(0, 16 + 344));
    d[10] = 17;
    w.accounts.set(w.guardKey.toBase58(), { owner: PROGRAM, data: d });
    const c = levConn({ accounts: w.accounts });
    const { k } = keeperOf(c.conn, cfg({ w1: true }), { loadPortfolios: async () => [] });
    assert.notEqual(await k.w1Once(w.market.toBase58(), "T"), "guard unreadable");
  });
});

describe("POKE (KEEPER_LEV_POKE)", () => {
  it("builds exactly the SDK's op 4 with NAV sampling: bytes 7c04, six metas, vault_lp_state at [4], ext at [5]", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    const { k, kp } = keeperOf(c.conn, cfg({ poke: true }));
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "sent");
    assert.equal(c.base.sent.length, 1);
    const want = buildLevGuardPokeIxV22({ programId: PROGRAM, market: w.market }, kp.publicKey, { vaultLpPortfolio: w.lp, sampleNav: true });
    assert.equal(hex(c.base.sentData[0][0]), "7c04");
    assert.equal(hex(c.base.sentData[0][0]), hex(want.data));
    assert.deepEqual(c.base.sent[0].keys[0], keysOf(want));
    assert.equal(want.keys.length, 6);
    assert.equal(c.base.sent[0].keys[0][4], deriveVaultLpStateV22(PROGRAM, w.market)[0].toBase58());
    assert.equal(c.base.sent[0].keys[0][5], deriveVaultLpExtV22(PROGRAM, w.market)[0].toBase58());
    assert.equal(c.base.sent[0].keys[0][3], w.lp.toBase58());
  });

  it("a market with no guard PDA, or no vault LP: nothing is built (cached no-op)", async () => {
    const noGuard = world({}, { guard: false });
    let c = levConn({ accounts: noGuard.accounts });
    let h = keeperOf(c.conn, cfg({ poke: true }));
    assert.equal(await h.k.pokeOnce(noGuard.market.toBase58(), "T", "push"), "no-guard");
    assert.equal(c.base.sims.length, 0);
    const reads = c.reads.getAccountInfo;
    await h.k.pokeOnce(noGuard.market.toBase58(), "T", "pre-allocate");
    assert.equal(c.reads.getAccountInfo, reads, "the negative answer is cached");
    const noLp = world({}, { vaultLp: false });
    c = levConn({ accounts: noLp.accounts });
    h = keeperOf(c.conn, cfg({ poke: true }));
    assert.equal(await h.k.pokeOnce(noLp.market.toBase58(), "T", "push"), "no-vault-lp");
    assert.equal(c.base.sims.length, 0);
  });

  it("a push-triggered poke honours the minimum gap; the pre-allocation poke does not", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    let now = 10_000;
    const { k } = keeperOf(c.conn, cfg({ poke: true, pokeMinGapMs: 5_000 }), { now: () => now });
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "sent");
    now += 1_000;
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "gap");
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "pre-allocate"), "sent");
    now += 5_000;
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "sent");
    assert.equal(c.base.sent.length, 3);
  });

  it("dry-run: the poke is SIMULATED and logged, never sent or signed", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    const { k, logs } = keeperOf(c.conn, cfg({ poke: true }), { dryRun: true });
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "dry-run");
    assert.equal(c.base.sims.length, 1);
    assert.equal(c.base.sent.length, 0);
    assert.equal(c.raws.length, 0);
    assert.ok(logs.some((l) => l.includes("[DRY-RUN]") && l.includes("tag 124")));
    assert.ok(logs.some((l) => l.includes("[lev-guard][poke]")));
  });

  it("a refused poke is counted and logged with the program error name, not retried in a loop", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts, simErr: () => ({ InstructionError: [2, { Custom: 134 }] }) });
    const { k, logs } = keeperOf(c.conn, cfg({ poke: true }));
    assert.equal(await k.pokeOnce(w.market.toBase58(), "T", "push"), "refused");
    assert.equal(c.base.sent.length, 0);
    assert.equal(k.stats.pokes.refused, 1);
    assert.ok(logs.some((l) => l.includes("refused") && l.includes("(134)")));
  });

  it("job counters carry the lev-poke job (the existing /health jobs convention)", async () => {
    resetJobCounters();
    const w = world();
    const c = levConn({ accounts: w.accounts });
    const { k } = keeperOf(c.conn, cfg({ poke: true }));
    await k.pokeOnce(w.market.toBase58(), "T", "push");
    assert.equal(allJobCounters()["lev-poke"].sent, 1);
  });

  it("an RPC failure on the reads never throws out of the hook", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    c.conn.getAccountInfo = async () => {
      throw new Error("fetch failed https://x.helius-rpc.com/?api-key=SECRET123");
    };
    const { k, logs } = keeperOf(c.conn, cfg({ poke: true, w1: true }));
    await k.onPushLanded(w.market.toBase58(), "T");
    assert.equal(c.base.sent.length, 0);
    assert.ok(logs.every((l) => !l.includes("SECRET123")));
  });
});

describe("POKE before the Earn -> LP allocation (night fix F1)", () => {
  function rigAlloc(hook?: (m: PublicKey, l: string) => Promise<void>, dryRun = false) {
    const c = p2bFakeConn();
    const calls: string[] = [];
    const a = new VaultLpAllocator({ ...DEFAULT_ALLOCATE_CONFIG, dryRun }, {
      programId: P2B_PROGRAM,
      conn: c.conn as never,
      keeper: P2B_KEEPER,
      confirm: { statusRetries: 0, statusRetryDelayMs: 1 },
      log: () => {},
      now: () => 1_000_000,
      rand: () => 0,
      beforeSend: hook ? async (m, l) => { calls.push(`hook:${c.count("sendRawTransaction")}`); await hook(m, l); } : undefined,
    });
    const snap = snapshot({ label: "SOL", registryData: p2bRegistryBytes({ bound: true }), marketData: patchedMarket(), vaultLpData: p2bVaultLpState({ lp: Keypair.generate().publicKey }) });
    return { a, c, calls, snap };
  }

  it("the hook runs after a clean simulation and BEFORE the allocation send; the tx is re-signed on a fresh blockhash", async () => {
    const r = rigAlloc(async () => {});
    await r.a.runMarket(r.snap); // staggered
    assert.equal(await r.a.runMarket(r.snap), "sent");
    assert.deepEqual(r.calls, ["hook:0"], "the hook ran before any send");
    assert.equal(r.c.count("sendRawTransaction"), 1);
    assert.equal(r.c.count("getLatestBlockhash"), 2, "one for the simulation, one fresh one for the re-sign");
  });

  it("no hook (flag off): today's behaviour exactly, one blockhash read", async () => {
    const r = rigAlloc();
    await r.a.runMarket(r.snap);
    assert.equal(await r.a.runMarket(r.snap), "sent");
    assert.equal(r.c.count("getLatestBlockhash"), 1);
  });

  it("a refused simulation (no room) never reaches the hook; a throwing hook never blocks the allocation; dry-run still sends nothing", async () => {
    const noRoom = p2bFakeConn({ sims: [{ err: { InstructionError: [1, { Custom: 100 }] } }] });
    let hooked = 0;
    const a = new VaultLpAllocator({ ...DEFAULT_ALLOCATE_CONFIG }, { programId: P2B_PROGRAM, conn: noRoom.conn as never, keeper: P2B_KEEPER, log: () => {}, now: () => 1, rand: () => 0, beforeSend: async () => { hooked++; } });
    const snap = snapshot({ label: "SOL", registryData: p2bRegistryBytes({ bound: true }), marketData: patchedMarket(), vaultLpData: p2bVaultLpState({ lp: Keypair.generate().publicKey }) });
    await a.runMarket(snap);
    assert.equal(await a.runMarket(snap), "no-room");
    assert.equal(hooked, 0);
    const thrower = rigAlloc(async () => { throw new Error("boom"); });
    await thrower.a.runMarket(thrower.snap);
    assert.equal(await thrower.a.runMarket(thrower.snap), "sent");
    const dry = rigAlloc(async () => {}, true);
    await dry.a.runMarket(dry.snap);
    assert.equal(await dry.a.runMarket(dry.snap), "dry-run");
    assert.equal(dry.c.count("sendRawTransaction"), 0);
    assert.equal(dry.calls.length, 1, "the poke hook still runs in dry-run (it only simulates and logs there)");
  });

  it("beforeAllocate pokes (bypassing the gap) and only when KEEPER_LEV_POKE is on", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    const on = keeperOf(c.conn, cfg({ poke: true, pokeMinGapMs: 3_600_000 }));
    await on.k.pokeOnce(w.market.toBase58(), "T", "push");
    await on.k.beforeAllocate(w.market.toBase58(), "T");
    assert.equal(c.base.sent.length, 2);
    const c2 = levConn({ accounts: w.accounts });
    const off = keeperOf(c2.conn, cfg());
    await off.k.beforeAllocate(w.market.toBase58(), "T");
    assert.equal(c2.base.sims.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("HOLDER JOB (KEEPER_LEV_HOLDER_JOB)", () => {
  const baseMint = key(600);
  const quoteMint = key(601);
  const poolVault = key(602);
  const quoteVault = key(603);
  const pool = key(604);
  const amm = key(605);
  const poolAuth = PublicKey.findProgramAddressSync([Buffer.from("pool-auth")], amm)[0];
  const W1 = Keypair.generate().publicKey;
  const W2 = Keypair.generate().publicKey;
  const FROZEN = Keypair.generate().publicKey;
  const progOwned = Keypair.generate().publicKey;
  const riskKey = Keypair.generate();
  const R = 1_000_000_000n;
  const SUPPLY = 10_000_000_000n;
  const TOKEN = new PublicKey(TOKEN_PROGRAM);

  function holderWorld(g: Partial<GuardOpts> = {}) {
    const w = world({ riskKey: riskKey.publicKey, t0: 1n, ...g });
    const a = w.accounts;
    a.set(deriveDepthSourceV22(PROGRAM, w.market)[0].toBase58(), { owner: PROGRAM, data: pinBytes({ market: w.market, pool, amm, baseVault: poolVault, quoteVault, baseMint, quoteMint }) });
    a.set(poolVault.toBase58(), { owner: TOKEN, data: tokenAcct(baseMint, poolAuth, R) });
    a.set(quoteVault.toBase58(), { owner: TOKEN, data: tokenAcct(quoteMint, poolAuth, 5n) });
    const holder = (addr: PublicKey, owner: PublicKey, amount: bigint, state = 1): { address: PublicKey; amount: string } => {
      a.set(addr.toBase58(), { owner: TOKEN, data: tokenAcct(baseMint, owner, amount, state) });
      return { address: addr, amount: String(amount) };
    };
    const largest = [
      { address: poolVault, amount: String(R) },
      holder(key(610), poolAuth, 800_000_000n), // the pool authority's other account
      holder(key(611), FROZEN, 700_000_000n, 2), // frozen: op 3 would refuse it
      holder(key(612), W1, 500_000_000n),
      holder(key(613), PublicKey.findProgramAddressSync([Buffer.from("p")], amm)[0], 400_000_000n), // PDA-owned
      holder(key(614), progOwned, 300_000_000n), // owner address is a program-owned data account
      holder(key(615), W2, 100_000_000n),
    ];
    a.set(progOwned.toBase58(), { owner: key(777), data: new Uint8Array(40) });
    a.set(W1.toBase58(), { owner: new PublicKey(SYSTEM_PROGRAM), data: new Uint8Array(0) });
    return { ...w, largest };
  }

  it("runs (a) op 3 without a holder, (b) op 3 with the single largest holder, (c) op 2 signed by the risk key; each equals the SDK builder", async () => {
    const w = holderWorld();
    const c = levConn({ accounts: w.accounts, largest: w.largest, supply: SUPPLY, slot: () => 1 + 216_000 * 20 });
    const { k, kp, logs } = keeperOf(c.conn, cfg({ holderJob: true, riskKeyPath: "/k.json" }), { riskKey });
    const out = await k.holderOnce(w.market.toBase58(), "T");
    assert.equal(c.base.sent.length, 3, out);
    const ctx = { programId: PROGRAM, market: w.market };
    const plain = buildLevGuardTightenIxV22(ctx, kp.publicKey, { baseMint, poolBaseVault: poolVault });
    const withHolder = buildLevGuardTightenIxV22(ctx, kp.publicKey, { baseMint, poolBaseVault: poolVault, holderTokenAccount: key(612) });
    assert.equal(plain.keys.length, 6);
    assert.equal(withHolder.keys.length, 7);
    assert.equal(hex(c.base.sentData[0][0]), "7c03");
    assert.deepEqual(c.base.sent[0].keys[0], keysOf(plain));
    assert.equal(hex(c.base.sentData[1][0]), hex(withHolder.data));
    assert.deepEqual(c.base.sent[1].keys[0], keysOf(withHolder), "the largest KEPT holder: not the pool vault, not the pool authority's account, not frozen, not PDA- or program-owned");
    // (c) j / m from the maths: m_ind = CPMM of the 500M balance; j = whale-treated model
    const rep = buildReport({ reserve: R, supply: SUPPLY, ownerTotals: [{ owner: W1.toBase58(), total: 500_000_000n }, { owner: W2.toBase58(), total: 100_000_000n }], ageDays: 20 });
    assert.ok(rep);
    assert.deepEqual(rep, { jDumpBps: 90, mIndBps: 5556, lCapX100: 0, nMultBps: 10_000 });
    const wantReport = buildLevGuardReportIxV22(ctx, riskKey.publicKey, rep);
    assert.equal(hex(c.base.sentData[2][0]), "7c02" + "5a00" + "b415" + "0000" + "1027");
    assert.equal(hex(c.base.sentData[2][0]), hex(wantReport.data));
    assert.deepEqual(c.base.sent[2].keys[0], keysOf(wantReport));
    // the report tx is signed by the risk key AND the keeper (fee payer)
    const rawReport = Transaction.from(c.raws[2]);
    assert.ok(rawReport.verifySignatures());
    assert.ok(rawReport.signatures.some((s) => s.publicKey.equals(riskKey.publicKey) && s.signature !== null));
    assert.ok(logs.some((l) => l.includes("[lev-guard][holder]")));
    assert.ok(logs.every((l) => !l.includes(Buffer.from(riskKey.secretKey).toString("hex"))), "the key is never logged");
  });

  it("without KEEPER_LEV_RISK_KEY_PATH: tighten only, no REPORT", async () => {
    const w = holderWorld();
    const c = levConn({ accounts: w.accounts, largest: w.largest, supply: SUPPLY });
    const { k } = keeperOf(c.conn, cfg({ holderJob: true }));
    await k.holderOnce(w.market.toBase58(), "T");
    assert.deepEqual(c.base.sentData.map((d) => hex(d[0]).slice(0, 4)), ["7c03", "7c03"]);
  });

  it("a guard whose risk key is another key: no REPORT is sent", async () => {
    const w = holderWorld({ riskKey: Keypair.generate().publicKey });
    const c = levConn({ accounts: w.accounts, largest: w.largest, supply: SUPPLY });
    const { k } = keeperOf(c.conn, cfg({ holderJob: true, riskKeyPath: "/k.json" }), { riskKey });
    await k.holderOnce(w.market.toBase58(), "T");
    assert.equal(c.base.sentData.filter((d) => hex(d[0]).startsWith("7c02")).length, 0);
    assert.equal(k.stats.reports.skipped, 1);
  });

  it("dry-run: all three are simulated and logged, nothing is sent", async () => {
    const w = holderWorld();
    const c = levConn({ accounts: w.accounts, largest: w.largest, supply: SUPPLY });
    const { k, logs } = keeperOf(c.conn, cfg({ holderJob: true, riskKeyPath: "/k.json" }), { dryRun: true, riskKey });
    await k.holderOnce(w.market.toBase58(), "T");
    assert.equal(c.base.sims.length, 3);
    assert.equal(c.base.sent.length, 0);
    assert.equal(c.raws.length, 0);
    assert.equal(logs.filter((l) => l.includes("[DRY-RUN]")).length, 3);
  });

  it("a holder account the program refuses (134) falls to the next largest, at most three tries; the plain tighten is not repeated", async () => {
    const w = holderWorld();
    const first = key(612).toBase58();
    const c = levConn({
      accounts: w.accounts,
      largest: w.largest,
      supply: SUPPLY,
      simErr: (keys) => (keys[0].length === 7 && keys[0][6] === first ? { InstructionError: [2, { Custom: 134 }] } : null),
    });
    const { k } = keeperOf(c.conn, cfg({ holderJob: true }));
    await k.holderOnce(w.market.toBase58(), "T");
    const holderTx = c.base.sent.filter((s) => s.keys[0].length === 7);
    assert.equal(holderTx.length, 1);
    assert.equal(holderTx[0].keys[0][6], key(615).toBase58(), "next largest kept holder (W2)");
  });

  it("no pin / no guard: nothing is built; the hourly cadence and per-market stagger are honoured", async () => {
    const w = world();
    const c = levConn({ accounts: w.accounts });
    let now = 1_000;
    const { k } = keeperOf(c.conn, cfg({ holderJob: true, holderIntervalMs: 3_600_000 }), { now: () => now });
    assert.equal(await k.holderOnce(w.market.toBase58(), "T"), "no depth-source pin");
    assert.equal(c.base.sims.length, 0);
    const g = holderWorld();
    const c2 = levConn({ accounts: g.accounts, largest: g.largest, supply: SUPPLY });
    const h = keeperOf(c2.conn, cfg({ holderJob: true, holderIntervalMs: 3_600_000 }), { now: () => now });
    const mk = [{ marketAddress: g.market.toBase58(), label: "T" }];
    await h.k.holderTick(mk); // first sight: staggered, may not be due
    now += 600_001;
    await h.k.holderTick(mk);
    const runs = h.k.stats.holderRuns;
    assert.equal(runs, 1);
    now += 3_599_000; // < one interval later
    await h.k.holderTick(mk);
    assert.equal(h.k.stats.holderRuns, 1, "not due again within the hour");
    now += 2_000;
    await h.k.holderTick(mk);
    assert.equal(h.k.stats.holderRuns, 2);
  });

  it("no individual holder after filtering: the plain tighten still runs, no holder tx, no report figures beyond a zero m_ind", async () => {
    const w = holderWorld();
    const c = levConn({ accounts: w.accounts, largest: [{ address: poolVault, amount: String(R) }], supply: SUPPLY });
    const { k } = keeperOf(c.conn, cfg({ holderJob: true }));
    const out = await k.holderOnce(w.market.toBase58(), "T");
    assert.ok(out.includes("no individual holder after filtering"));
    assert.equal(c.base.sent.length, 1);
    assert.equal(k.stats.holderDropped["pool-vault"], 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("W1 (KEEPER_LEV_W1)", () => {
  const user = (n: number) => key(2000 + n);
  const acc = (n: number, side: 0 | 1, assetIndex = 0) => ({ pubkey: user(n), data: portfolioBytes({ owner: key(3000 + n), legs: [{ side, basis: side === 0 ? 100n : -100n, assetIndex }] }) });

  /** Triggered stop (navps <= half of the peak), asset 0. */
  const TRIG = { navps: 400_000_000_000n, navPeakCur: 1_000_000_000_000n, navRef: 1_000_000_000_000n };

  it("the SDK read helpers agree with the fixtures (the stop holds; a fresh round is live)", () => {
    const g = decodeLevGuardV22(guardBytes({ market: key(1), ...TRIG }));
    assert.equal(levLpStopTriggeredV22(g), true);
    assert.equal(levLpStopTriggeredV22(decodeLevGuardV22(guardBytes({ market: key(1) }))), false);
    assert.equal(levW1RoundLiveV22(decodeLevGuardV22(guardBytes({ market: key(1), roundActive: true, roundOpenSlot: 100n })), 9_100n), true);
    assert.equal(levW1RoundLiveV22(decodeLevGuardV22(guardBytes({ market: key(1), roundActive: true, roundOpenSlot: 100n })), 9_101n), false, "a round older than 9000 slots is stale");
  });

  it("w1Victims: only users whose EFFECTIVE net position is opposite the LP's, never the LP, skips touched and already-listed, on the guard's asset only", () => {
    const lp = key(501);
    const lpAcc = { pubkey: lp, data: portfolioBytes({ owner: key(1), legs: [{ side: 0, basis: 1000n }] }) };
    // u6: one long and one bigger short leg on the asset: net short (effective side), not "has a short leg"
    const mixed = { pubkey: user(6), data: portfolioBytes({ owner: key(3006), legs: [{ side: 0, basis: 10n }, { side: 1, basis: -50n }] }) };
    // u7: net long although it also holds a small short leg: on the LP's side
    const mixedLong = { pubkey: user(7), data: portfolioBytes({ owner: key(3007), legs: [{ side: 0, basis: 80n }, { side: 1, basis: -5n }] }) };
    const accounts = [lpAcc, acc(1, 1), acc(2, 1), acc(3, 0), acc(4, 1, 5), acc(5, 1), mixed, mixedLong, { pubkey: key(9999), data: new Uint8Array(10) }];
    const base = { assetIndex: 0, roundId: 7n, lp };
    const out = w1Victims(accounts, { ...base, lpLong: true, touchedTags: [keyTagOf(user(2))], listed: new Set([`7:${user(5).toBase58()}`]) });
    assert.deepEqual(out.map((k) => k.toBase58()).sort(), [user(1), user(6)].map((k) => k.toBase58()).sort(), "u1 and the net-short u6 only");
    const longSide = w1Victims(accounts, { ...base, lpLong: false, touchedTags: [], listed: new Set() });
    assert.deepEqual(longSide.map((k) => k.toBase58()).sort(), [user(3), user(7)].map((k) => k.toBase58()).sort(), "LP short: users net long");
    assert.ok(!out.some((k) => k.equals(lp)) && !longSide.some((k) => k.equals(lp)));
    assert.equal(netPosOnAsset(lpAcc.data, 0), 1000n);
    assert.equal(netPosOnAsset(new Uint8Array(10), 0), null);
  });

  /**
   * A fake that MODELS `lev_guard_lp_stop`: no live round + stop holds -> the call opens a round, cuts the listed victims that are opposite the LP
   * and untouched, and if NOTHING was cut it answers 135, which REVERTS the open (no state change). A live round with no victim listed also
   * answers 135. The round closes after `closeAfter` cutting batches.
   */
  function w1Rig(o: { opposing: number; batch: number; closeAfter?: number; simErr?: (keys: string[][]) => unknown; dryRun?: boolean; maxTxs?: number; slot?: number; guard?: Partial<GuardOpts>; lpShort?: boolean }) {
    const w = world({ ...TRIG, ...o.guard });
    const guardKey = w.guardKey.toBase58();
    const slotNow = o.slot ?? 1000;
    let touched: PublicKey[] = [];
    let batches = 0;
    const lpSide = o.lpShort ? 1 : 0;
    const lpAcc = { pubkey: w.lp, data: portfolioBytes({ owner: key(1), legs: [{ side: lpSide, basis: o.lpShort ? -100_000n : 100_000n }] }) };
    // users opposite the LP: shorts when the LP is long (and vice versa), plus two on the LP's side
    const opp = Array.from({ length: o.opposing }, (_, i) => acc(i + 1, o.lpShort ? 0 : 1));
    const portfolios = [lpAcc, ...opp, acc(900, o.lpShort ? 1 : 0), acc(901, o.lpShort ? 1 : 0)];
    const oppSet = new Set(opp.map((x) => x.pubkey.toBase58()));
    const cur = () => decodeLevGuardV22(w.accounts.get(guardKey)!.data);
    const rewrite = (p: Partial<GuardOpts>): void => {
      const g = cur();
      w.accounts.set(guardKey, { owner: PROGRAM, data: guardBytes({ market: w.market, navps: g.navps, navPeakCur: g.navPeakCur, navRef: g.navRef, roundId: g.roundId, touched, ...p }) });
    };
    const err = (code: number) => ({ InstructionError: [2, { Custom: code }] });
    const model = (keys: string[][]): unknown => {
      const victims = keys[0].slice(6);
      const g = cur();
      const live = levW1RoundLiveV22(g, BigInt(slotNow));
      const touchedSet = new Set(live ? touched.map((t) => t.toBase58()) : []);
      const cut = victims.filter((v) => oppSet.has(v) && !touchedSet.has(v));
      if (!live) {
        if (!levLpStopTriggeredV22(g)) return err(135);
        if (cut.length === 0) return err(135); // the round open is reverted with the error
      } else if (victims.length === 0) return err(135);
      return null;
    };
    const c = levConn({
      accounts: w.accounts,
      slot: () => slotNow,
      simErr: (keys) => o.simErr?.(keys) ?? model(keys),
      onSend: (data, keys) => {
        if (hex(data) !== "7c05") return;
        const g = cur();
        const live = levW1RoundLiveV22(g, BigInt(slotNow));
        if (!live) touched = [];
        const victims = keys.slice(6).filter((v) => oppSet.has(v) && !touched.some((t) => t.toBase58() === v));
        batches++;
        touched = [...touched, ...victims.map((v) => new PublicKey(v))];
        if (batches >= (o.closeAfter ?? 99)) rewrite({ roundActive: false, roundId: 1n, touched });
        else rewrite({ roundActive: true, roundLpLong: !o.lpShort, roundId: 1n, roundOpenSlot: BigInt(slotNow) - 100n, touched });
      },
    });
    const h = keeperOf(c.conn, cfg({ w1: true, w1BatchSize: o.batch, ...(o.maxTxs ? { w1MaxTxs: o.maxTxs } : {}) }), { dryRun: o.dryRun, loadPortfolios: async () => portfolios });
    return { ...w, c, ...h, lpAcc };
  }

  it("K-1: the round-opening op 5 carries the first batch of victims (the program reverts an opening call that cuts nothing); a no-victim call is never sent", async () => {
    const r = w1Rig({ opposing: 5, batch: 2, closeAfter: 3 });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.match(out, /round closed after 3 tx/);
    assert.deepEqual(r.c.base.sent.map((t) => t.keys[0].length - 6), [2, 2, 1], "the FIRST call already lists victims");
    assert.ok(r.c.base.sims.every((x) => x.keys[0].length > 6), "no simulated call without a victim");
    // negative control: the model really does revert an empty opening call
    const empty = w1Rig({ opposing: 0, batch: 2 });
    assert.match(await empty.k.w1Once(empty.market.toBase58(), "T"), /no opposing portfolio to cut \(no call sent\)/);
    assert.equal(empty.c.base.sims.length, 0, "nothing opposing: no call at all (and never 'nothing to do' concluded from a no-victim call)");
  });

  it("K-1: the LP side comes from the vault LP's net position: an LP that is SHORT is cut against the long users", async () => {
    const r = w1Rig({ opposing: 3, batch: 5, closeAfter: 1, lpShort: true });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.match(out, /round (closed|opened and closed)/);
    assert.equal(r.c.base.sent.length, 1);
    const listed = r.c.base.sent[0].keys[0].slice(6);
    assert.deepEqual(listed.sort(), [1, 2, 3].map((n) => user(n).toBase58()).sort());
  });

  it("opens the round with the first batch, then cuts the opposing portfolios in batches of the configured size until round_active is 0; the LP is never listed, nobody twice", async () => {
    const r = w1Rig({ opposing: 7, batch: 3, closeAfter: 3 });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.match(out, /round closed after 3 tx/);
    const tx = r.c.base.sent;
    assert.equal(tx.length, 3, "the opening call is the first batch: 3 + 3 + 1");
    const sizes = tx.map((t) => t.keys[0].length - 6);
    assert.deepEqual(sizes, [3, 3, 1]);
    const seen = new Set<string>();
    for (const t of tx) for (const v of t.keys[0].slice(6)) {
      assert.ok(!seen.has(v), "no portfolio listed twice");
      seen.add(v);
      assert.notEqual(v, r.lp.toBase58(), "the LP is never listed");
      assert.ok(v !== user(900).toBase58() && v !== user(901).toBase58(), "users on the LP's side are not listed");
    }
    assert.equal(seen.size, 7);
    // every tx is the SDK's op 5 for those accounts
    const want = buildLevGuardLpStopIxV22({ programId: PROGRAM, market: r.market }, r.kp.publicKey, r.lp, tx[1].keys[0].slice(6).map((x) => new PublicKey(x)));
    assert.equal(hex(r.c.base.sentData[1][0]), "7c05");
    assert.deepEqual(tx[1].keys[0], keysOf(want));
    assert.equal(r.k.stats.w1.closed, 1);
  });

  it("stops at once on error 135 (nothing to do), with no further op 5 and no failure counted", async () => {
    const r = w1Rig({ opposing: 4, batch: 2, simErr: () => ({ InstructionError: [2, { Custom: 135 }] }) });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.equal(out, "nothing to do (135)");
    assert.equal(r.c.base.sims.length, 1);
    assert.equal(r.c.base.sent.length, 0);
    assert.equal(r.k.stats.w1.nothingToDo, 1);
    assert.equal(r.k.stats.w1.failed, 0);
    assert.equal(r.k.stats.w1.refused, 0);
  });

  it("135 in the middle of a round (the round closed under us) ends the run", async () => {
    let calls = 0;
    const r = w1Rig({ opposing: 6, batch: 2, simErr: () => (++calls >= 2 ? { InstructionError: [2, { Custom: 135 }] } : null) });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.equal(out, "nothing to do (135)");
    assert.equal(r.c.base.sent.length, 1, "only the first (round-opening) batch was sent");
  });

  it("neither stop nor live round: no instruction at all", async () => {
    const r = w1Rig({ opposing: 4, batch: 2, guard: { navps: 1_000_000_000_000n, navPeakCur: 1_000_000_000_000n } });
    assert.equal(await r.k.w1Once(r.market.toBase58(), "T"), "idle");
    assert.equal(r.c.base.sims.length, 0);
    assert.equal(r.k.stats.w1.checks, 1);
  });

  it("a round already live is continued with the guard\'s own LP side (no re-open)", async () => {
    const r = w1Rig({ opposing: 3, batch: 5, closeAfter: 1, guard: { roundActive: true, roundLpLong: true, roundOpenSlot: 900n, roundId: 1n, navps: 1_000_000_000_000n } });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.match(out, /round closed/);
    assert.equal(r.c.base.sent.length, 1);
    assert.equal(r.c.base.sent[0].keys[0].length - 6, 3);
  });

  it("a stale round (older than 9000 slots) with the stop no longer holding is not continued", async () => {
    const r = w1Rig({ opposing: 3, batch: 5, slot: 20_000, guard: { roundActive: true, roundLpLong: true, roundOpenSlot: 1n, roundId: 1n, navps: 1_000_000_000_000n, navPeakCur: 1_000_000_000_000n } });
    assert.equal(await r.k.w1Once(r.market.toBase58(), "T"), "idle");
    assert.equal(r.c.base.sims.length, 0);
  });

  it("the per-run limit bounds the transactions; a round with nobody left to list ends the run", async () => {
    const limited = w1Rig({ opposing: 20, batch: 2, maxTxs: 3 });
    const out = await limited.k.w1Once(limited.market.toBase58(), "T");
    assert.match(out, /still open after 3 tx\(s\) \(limit\)/);
    assert.equal(limited.c.base.sent.length, 3);
    const few = w1Rig({ opposing: 2, batch: 5 }); // never closes on its own
    const out2 = await few.k.w1Once(few.market.toBase58(), "T");
    assert.match(out2, /no opposing portfolio left to list/);
    assert.equal(few.c.base.sent.length, 1, "one batch of 2 (the opening call), then nobody left");
  });

  it("dry-run: the round-opening op 5 (with victims) is simulated and logged, nothing is sent", async () => {
    const r = w1Rig({ opposing: 4, batch: 2, dryRun: true });
    const out = await r.k.w1Once(r.market.toBase58(), "T");
    assert.equal(out, "dry-run (would send)");
    assert.equal(r.c.base.sims.length, 1);
    assert.equal(r.c.base.sent.length, 0);
    assert.equal(r.c.raws.length, 0);
    assert.ok(r.logs.some((l) => l.includes("[DRY-RUN]")));
  });

  it("w1 packet size: the largest allowed batch fits one 1,232 B transaction (with the compute prelude)", async () => {
    const r = w1Rig({ opposing: 40, batch: W1_MAX_VICTIMS_PER_TX, closeAfter: 99, maxTxs: 2 });
    await r.k.w1Once(r.market.toBase58(), "T");
    const big = r.c.base.sent.find((s) => s.keys[0].length - 6 === W1_MAX_VICTIMS_PER_TX);
    assert.ok(big, "a full-size batch was sent");
    const rawBig = r.c.base.rawSizes[r.c.base.sent.indexOf(big)];
    assert.ok(rawBig <= 1232, `serialized ${rawBig} B must fit 1232`);
    // the ceiling is tight: one more victim no longer fits (same prelude: heap frame + CU limit)
    const kp = Keypair.generate();
    const tooMany = new Transaction();
    tooMany.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tooMany.add(buildLevGuardLpStopIxV22({ programId: PROGRAM, market: r.market }, kp.publicKey, r.lp, Array.from({ length: W1_MAX_VICTIMS_PER_TX + 1 }, (_, i) => key(4000 + i))));
    tooMany.recentBlockhash = "11111111111111111111111111111111";
    tooMany.feePayer = kp.publicKey;
    tooMany.sign(kp);
    assert.ok(tooMany.serialize().length > 1232 - 64, `${W1_MAX_VICTIMS_PER_TX + 1} victims serialize to ${tooMany.serialize().length} B (near / over the limit)`);
  });

  it("W1 off while a stop holds: no instruction (flag-off)", async () => {
    const w = world(TRIG);
    const c = levConn({ accounts: w.accounts });
    const { k } = keeperOf(c.conn, cfg({ poke: true }));
    await k.onPushLanded(w.market.toBase58(), "T");
    assert.equal(c.base.sims.filter((s) => s.keys[0].length > 6 || s.keys[0].length === 6).length, 1, "only the poke (6 accounts) was built");
    assert.equal(c.base.sentData.some((d) => hex(d[0]) === "7c05"), false);
  });
});
