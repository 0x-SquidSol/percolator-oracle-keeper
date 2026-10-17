/**
 * Test helpers for the v2.2 layer: a recording fake Connection (simulate / send / confirm), a synthetic variant-B
 * market account, and hand-built positioned portfolios. Not a test file (the glob only runs *.test.ts).
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@percolatorct/sdk";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { ExecConnection, ExecContext } from "./exec.ts";
import { COMPUTE_IX_COUNT } from "./exec.ts";
import { V22_ASSET_BAND_OFF, V22_CONFIG_OFF, buildV22MarketCtx } from "./market.ts";
import type { V22MarketCtx } from "./market.ts";
import { layoutById, engineSlotBase } from "../market-layout.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";

export const key = (n: number): PublicKey => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n & 0xff : i === 1 ? (n >> 8) & 0xff : 7)));

export function pf(n: number, legs = 1, o: { lp?: boolean; weight?: bigint } = {}): PositionedPortfolio {
  return { pubkey: key(n), longLegs: legs, shortLegs: 0, isLp: o.lp === true, lossWeight: o.weight ?? BigInt(n) };
}

export interface SentTx {
  /** instruction tags after the compute-budget prelude, in order. */
  tags: number[];
  /** the keys of each instruction (base58) */
  keys: string[][];
}

export interface FakeConnOptions {
  /** Return an `err` for a simulation given the decoded instructions (tags/keys), or null for success. */
  simErr?: (ixs: SentTx, callIndex: number) => unknown;
  /**
   * F1: the post-simulation account data a simulation returns when the caller asked for accounts (index-aligned with the requested
   * addresses; null = account missing). Absent: the simulation returns no accounts.
   */
  simAccounts?: (ixs: SentTx, callIndex: number, addresses: string[]) => Array<Uint8Array | null> | undefined;
  /** Program logs a simulation returns (by decoded tx and call index). */
  simLogs?: (ixs: SentTx, callIndex: number) => string[];
  /** Compute units a simulation reports (default 123,456). */
  simUnitsConsumed?: (ixs: SentTx, callIndex: number) => number;
  slot?: () => number;
  landedSlot?: () => number;
  confirmStatus?: "ok" | "err";
  /** Program error code a LANDED tx fails with (by send index), or null for success. */
  confirmFail?: (sendIndex: number, tx: SentTx) => number | null;
}

export function fakeExecConn(o: FakeConnOptions = {}) {
  const sims: SentTx[] = [];
  /** compute-unit limit of each simulated tx (parallel to `sims`). */
  const simUnits: number[] = [];
  const sent: Array<SentTx & { order: number }> = [];
  /** serialized byte length of each tx sent (parallel to `sent`). */
  const rawSizes: number[] = [];
  /** instruction data of each tx sent (parallel to `sent`), compute-budget prelude excluded. */
  const sentData: Uint8Array[][] = [];
  let order = 0;
  let sim = 0;
  let slot = 1000;
  const decode = (msg: { compiledInstructions: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>; staticAccountKeys: PublicKey[] }): SentTx => {
    const ixs = msg.compiledInstructions.slice(COMPUTE_IX_COUNT);
    return { tags: ixs.map((i) => i.data[0]), keys: ixs.map((i) => i.accountKeyIndexes.map((k) => msg.staticAccountKeys[k].toBase58())) };
  };
  const conn = {
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000_000 };
    },
    async simulateTransaction(tx: { message: Parameters<typeof decode>[0] }, cfg?: { accounts?: { addresses: string[] } }) {
      const d = decode(tx.message);
      sims.push(d);
      const lim = tx.message.compiledInstructions.find((i) => i.data[0] === 2 && i.data.length === 5);
      simUnits.push(lim ? Buffer.from(lim.data).readUInt32LE(1) : -1);
      const callIndex = sim++;
      const err = o.simErr ? o.simErr(d, callIndex) : null;
      const want = cfg?.accounts?.addresses;
      const post = want && o.simAccounts ? o.simAccounts(d, callIndex, want) : undefined;
      const accounts = post ? post.map((a) => (a ? { data: [Buffer.from(a).toString("base64"), "base64"], executable: false, lamports: 1, owner: "", rentEpoch: 0 } : null)) : undefined;
      return { context: { slot: 1 }, value: { err: err ?? null, logs: o.simLogs ? o.simLogs(d, callIndex) : [], unitsConsumed: o.simUnitsConsumed ? o.simUnitsConsumed(d, callIndex) : 123_456, ...(accounts ? { accounts } : {}) } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      // decode the transaction actually being sent (phase-1 txs are simulated and sent concurrently)
      rawSizes.push(raw.length);
      const t = Transaction.from(Buffer.from(raw));
      const ixs = t.instructions.slice(COMPUTE_IX_COUNT);
      const d: SentTx = { tags: ixs.map((i) => i.data[0]), keys: ixs.map((i) => i.keys.map((k) => k.pubkey.toBase58())) };
      sentData.push(ixs.map((i) => new Uint8Array(i.data)));
      sent.push({ ...d, order: order++ });
      return `sig${sent.length}`;
    },
    async confirmTransaction(arg: { signature: string }) {
      const idx = Number(arg.signature.slice(3)) - 1; // sendRawTransaction returned `sig<N>`
      const code = o.confirmFail ? o.confirmFail(idx, sent[idx]) : o.confirmStatus === "err" ? 1 : null;
      return { context: { slot: 1 }, value: { err: code !== null ? { InstructionError: [2, { Custom: code }] } : null } };
    },
    async getSignatureStatuses() {
      return { context: { slot: 1 }, value: [{ slot: (o.landedSlot ?? (() => (slot += 1)))(), confirmations: 1, err: null, confirmationStatus: "confirmed" as const }] };
    },
    async getSlot() {
      return (o.slot ?? (() => slot))();
    },
    async getMinimumBalanceForRentExemption(len: number) {
      return len * 7_000;
    },
  };
  return { conn: conn as unknown as ExecConnection & { getSlot(): Promise<number> }, sims, simUnits, sent, rawSizes, sentData };
}

export function execCtx(conn: ExecConnection, dryRun = false): ExecContext {
  return { conn, keeper: Keypair.generate(), dryRun, log: () => {}, confirm: { statusRetries: 0, statusRetryDelayMs: 0 } };
}

/** A Custom(code) error at instruction index `i` of the tx as the test sees it (compute-budget ixs are added back). */
export const customAt = (i: number, code: number) => ({ InstructionError: [i + COMPUTE_IX_COUNT, { Custom: code }] });

/** A runtime error WITH an instruction index but NO program Custom code (what a compute-budget overrun looks like). */
export const computeAt = (i: number) => ({ InstructionError: [i + COMPUTE_IX_COUNT, "ComputationalBudgetExceeded"] });

const L = layoutById("v2.2-b");

/** A synthetic variant-B market (1 slot) with the wrapper header stamped, optional band / rent / pin words. */
export function v22MarketBytes(o: { slots?: number; version?: number; band?: boolean; rent?: boolean; pinSince?: bigint; currentSlot?: bigint; slotLast?: bigint; maxPin?: bigint; oracleMode?: number; legs?: number; lifecycle?: number; staleLong?: bigint; legFeeds?: PublicKey[] } = {}): Uint8Array {
  const slots = o.slots ?? 1;
  const len = L.groupOff + L.headerLen + slots * L.slotStride;
  const b = Buffer.alloc(len);
  b.writeBigUInt64LE(WRAPPER_ACCOUNT_MAGIC, 0);
  b.writeUInt16LE(o.version ?? 19, 8);
  b[10] = 1;
  b.writeUInt32LE(slots, L.groupOff + L.header.maxMarketSlots);
  b.writeBigUInt64LE(150n, L.groupOff + L.header.maxAccrualDtSlots);
  b.writeBigUInt64LE(o.currentSlot ?? 5000n, L.groupOff + L.header.currentSlot);
  const e = engineSlotBase(L, 0);
  b[e + L.asset.lifecycle] = o.lifecycle ?? 2;
  b.writeBigUInt64LE(o.slotLast ?? o.currentSlot ?? 5000n, e + L.asset.slotLast);
  if (o.staleLong !== undefined) b.writeBigUInt64LE(o.staleLong, e + L.asset.staleLong);
  if (o.band) {
    b.writeBigUInt64LE(130n, L.groupOff + V22_CONFIG_OFF.bandBps);
    b.writeBigUInt64LE(600n, L.groupOff + V22_CONFIG_OFF.bandMaxEpochSlots);
    b.writeBigUInt64LE(o.maxPin ?? 9000n, L.groupOff + V22_CONFIG_OFF.bandMaxPinSlots);
    b.writeBigUInt64LE(256n, L.groupOff + V22_CONFIG_OFF.bandMaxPositionsPerSide);
  }
  if (o.rent) b.writeBigUInt64LE(5000n, L.groupOff + V22_CONFIG_OFF.rentMaxE9PerSlot);
  if (o.pinSince !== undefined) b.writeBigUInt64LE(o.pinSince, e + V22_ASSET_BAND_OFF.pinSinceSlot);
  // wrapper slot: oracle profile at +0 (oracle_mode @0, oracle_leg_count @1)
  const w = L.groupOff + L.headerLen;
  b[w] = o.oracleMode ?? 1;
  b[w + 1] = o.legs ?? 1;
  (o.legFeeds ?? []).forEach((f, i) => Buffer.from(f.toBytes()).copy(b, w + 224 + i * 32));
  return new Uint8Array(b);
}

export function registryBytes(o: { bound?: boolean; ext?: boolean; bond?: boolean } = {}): Uint8Array {
  const b = Buffer.alloc(176);
  b[160] = o.bound ? 1 : 0;
  b[161] = o.ext ? 1 : 0;
  b[162] = o.bond ? 1 : 0;
  return new Uint8Array(b);
}

/** A ready V22MarketCtx (bound + ext + bond by default). */
export function v22Ctx(o: Parameters<typeof v22MarketBytes>[0] & { bound?: boolean; ext?: boolean; bond?: boolean; lp?: PublicKey | null } = {}): V22MarketCtx {
  const market = key(900);
  const lp = o.lp === undefined ? key(901) : o.lp;
  const load = buildV22MarketCtx({
    marketAddress: market.toBase58(),
    label: "TEST/V22",
    programId: WRAPPER_PROGRAM_ID,
    data: v22MarketBytes(o),
    readSlot: Number(o.currentSlot ?? 5000n),
    registryData: registryBytes({ bound: o.bound ?? true, ext: o.ext ?? true, bond: o.bond ?? true }),
    vaultLpStateData: null,
    lpHint: lp,
  });
  if (!load.ok) throw new Error(`test market did not load: ${load.reason} ${load.detail}`);
  return load.ctx;
}

export { LAYOUT_V22 };

/** A refusal at the instruction (any) whose accounts include `portfolio` -- targets one counterparty's refresh. */
export function refusePortfolio(portfolio: PublicKey, code: number, firstOnly = false) {
  let done = false;
  return (d: SentTx): unknown => {
    if (firstOnly && done) return null;
    const i = d.keys.findIndex((ks, idx) => ks.includes(portfolio.toBase58()) && !(idx === 0 && false));
    if (i < 0) return null;
    done = true;
    return customAt(i, code);
  };
}

/** A parsable 10,603 B variant-B portfolio (SDK VERSION 19 guard): owner, capital, pnl, legs on asset 0. */
export function portfolioBytes(o: { owner: PublicKey; capital?: bigint; pnl?: bigint; legs?: Array<{ side: 0 | 1; basis: bigint; assetIndex?: number }>; matcher?: boolean }): Uint8Array {
  const G = LAYOUT_V22.portfolio;
  const b = Buffer.alloc(G.accountLen);
  b.writeBigUInt64LE(WRAPPER_ACCOUNT_MAGIC, 0);
  b.writeUInt16LE(19, 8);
  b[10] = 2;
  b.writeUInt16LE(1, 112);
  b.writeUInt16LE(19, 114);
  Buffer.from(o.owner.toBytes()).copy(b, 116);
  const w128 = (off: number, v: bigint) => {
    const u = BigInt.asUintN(128, v);
    b.writeBigUInt64LE(u & 0xffff_ffff_ffff_ffffn, off);
    b.writeBigUInt64LE(u >> 64n, off + 8);
  };
  w128(148, o.capital ?? 0n);
  w128(164, o.pnl ?? 0n);
  const legs = o.legs ?? [];
  let bitmap = 0n;
  legs.forEach((l, i) => {
    bitmap |= 1n << BigInt(i);
    const at = G.legsOff + i * G.legStride;
    b[at + G.leg.active] = 1;
    b.writeUInt32LE(l.assetIndex ?? 0, at + G.leg.assetIndex);
    b[at + G.leg.side] = l.side;
    w128(at + G.leg.basisPosQ, l.basis);
    w128(at + G.leg.lossWeight, 1n);
  });
  b.writeBigUInt64LE(bitmap, 348);
  if (o.matcher) b.writeBigUInt64LE(1n, G.matcherConfigOff + 96);
  return new Uint8Array(b);
}

/** A vault_lp_state account (kind 9, 272 B) with the bound LP and a senior draw outstanding. */
export function vaultLpStateBytes(lp: PublicKey, outstanding = 0n): Uint8Array {
  const b = Buffer.alloc(16 + 256);
  b.writeBigUInt64LE(WRAPPER_ACCOUNT_MAGIC, 0);
  b.writeUInt16LE(18, 8);
  b[10] = 9;
  Buffer.from(lp.toBytes()).copy(b, 16 + 64);
  b[16 + 214] = 1;
  b.writeBigUInt64LE(outstanding & 0xffff_ffff_ffff_ffffn, 16 + 240);
  return new Uint8Array(b);
}

/** A fake Connection for the V22Loop: reads, getProgramAccounts, plus the exec surface. */
export function fakeLoopConn(o: { market: Uint8Array; registry?: Uint8Array | null; vaultLpState?: Uint8Array | null; portfolios?: Array<{ pubkey: PublicKey; data: Uint8Array }>; lpAccount?: Uint8Array | null; throwOnRead?: boolean; readSlot?: number } & FakeConnOptions) {
  const base = fakeExecConn(o);
  const progCalls: Array<{ filters: unknown[] }> = [];
  const acct = (d: Uint8Array | null | undefined) => (d ? { data: Buffer.from(d), owner: key(1), lamports: 1, executable: false } : null);
  const conn = Object.assign(base.conn, {
    async getMultipleAccountsInfoAndContext() {
      if (o.throwOnRead) throw new Error("fetch failed https://x.helius-rpc.com/?api-key=SECRET123");
      return { context: { slot: o.readSlot ?? 5000 }, value: [acct(o.market), acct(o.registry ?? null), acct(o.vaultLpState ?? null)] };
    },
    async getAccountInfo() {
      return acct(o.lpAccount ?? null);
    },
    async getProgramAccounts(_p: PublicKey, cfg: { filters: unknown[] }) {
      progCalls.push(cfg);
      return (o.portfolios ?? []).map((x) => ({ pubkey: x.pubkey, account: { data: Buffer.from(x.data) } }));
    },
  });
  return { conn, sims: base.sims, sent: base.sent, progCalls };
}
