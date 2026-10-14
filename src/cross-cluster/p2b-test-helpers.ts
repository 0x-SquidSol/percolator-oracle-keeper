/**
 * Test helpers for the v2.1 (P2b) keeper layer: byte-level builders on top of the repo's real v18
 * fixtures and a recording fake Connection. No network, no sends: every "send" lands in an array.
 * (Not a test file itself, so `node --test "src/**\/*.test.ts"` does not run it.)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  ASSET_GROWTH_FIELD_OFF,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  adlEpisodeKey,
  assetGrowthAccountOffsetV19,
  assetRiskLimitsAccountOffsetP1,
  deriveLpVaultRegistry,
  parseLpVaultRegistry,
} from "@percolatorct/sdk";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import type { VaultMarketSnapshot } from "./p2b-markets.ts";
import { decodeVaultLpState } from "./resolved-portfolio-cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
export const fxJson = <T>(n: string): T => JSON.parse(readFileSync(join(here, "__fixtures__", n), "utf8")) as T;

export const ADL_ONE = 1_000_000_000_000_000n;
export const PROGRAM = WRAPPER_PROGRAM_ID;

export function w64(b: Buffer, off: number, v: bigint): void {
  b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
}
export function w128(b: Buffer, off: number, v: bigint): void {
  b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
  b.writeBigUInt64LE(v >> 64n, off + 8);
}

/** Absolute offset of the engine asset record (AssetStateV16Account) of asset `i`. */
export const engineBase = (i = 0): number => V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + i * V17_MARKET_ASSET_SLOT_LEN + 1024;
/** Absolute offset of asset `i`'s wrapper slot (oracle profile at +0). */
export const wrapperBase = (i = 0): number => V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + i * V17_MARKET_ASSET_SLOT_LEN;

export interface MarketPatch {
  aLong?: bigint;
  aShort?: bigint;
  oiEffLong?: bigint;
  oiEffShort?: bigint;
  effectivePriceE6?: bigint;
  marketId?: bigint;
  epochLong?: bigint;
  epochShort?: bigint;
  /** Arm the ADL episode: `since` slot recorded under the key of (marketId, epochLong, epochShort). */
  episodeSince?: bigint;
  /** Stored override (0 = default 9000). */
  episodeMaxSlots?: number;
  /** Profile `last_good_oracle_slot` and `mark_ewma_last_slot`. */
  markSlot?: bigint;
  /** Growth block (asset 0): lambda bps; presence turns growth ON (version 1). */
  growthLambdaBps?: number;
  growthKinkBps?: number;
  /** Engine market mode byte (0 Live, 1 Resolved, 2 Recovery). */
  mode?: number;
}

/** A real v18 SOL market with fields patched in place (never the original buffer). */
export function patchedMarket(p: MarketPatch = {}, base = "sol-market-v18"): Uint8Array {
  const b = Buffer.from(fx(base));
  const e = engineBase(0);
  if (p.aLong !== undefined) w128(b, e + 49, p.aLong);
  if (p.aShort !== undefined) w128(b, e + 65, p.aShort);
  if (p.oiEffLong !== undefined) w128(b, e + 289, p.oiEffLong);
  if (p.oiEffShort !== undefined) w128(b, e + 305, p.oiEffShort);
  if (p.effectivePriceE6 !== undefined) w64(b, e + 25, p.effectivePriceE6);
  if (p.marketId !== undefined) w64(b, e + 0, p.marketId);
  if (p.epochLong !== undefined) w64(b, e + 497, p.epochLong);
  if (p.epochShort !== undefined) w64(b, e + 505, p.epochShort);
  const marketId = b.readBigUInt64LE(e + 0);
  const epochL = b.readBigUInt64LE(e + 497);
  const epochS = b.readBigUInt64LE(e + 505);
  const rl = assetRiskLimitsAccountOffsetP1(0);
  if (p.episodeMaxSlots !== undefined) b.writeUInt32LE(p.episodeMaxSlots, rl + 44);
  if (p.episodeSince !== undefined) {
    const [kl, ks] = adlEpisodeKey(marketId, epochL, epochS);
    w64(b, rl + 48, p.episodeSince);
    b.writeUInt32LE(kl, rl + 56);
    b.writeUInt32LE(ks, rl + 60);
  }
  if (p.markSlot !== undefined) {
    // AssetOracleProfileV17 (SDK parseAssetOracleProfileV17): mark_ewma_last_slot @176, last_good_oracle_slot @216
    w64(b, wrapperBase(0) + 176, p.markSlot);
    w64(b, wrapperBase(0) + 216, p.markSlot);
  }
  if (p.mode !== undefined) b[V17_MARKET_GROUP_OFF + 626] = p.mode;
  if (p.growthLambdaBps !== undefined) {
    const g = assetGrowthAccountOffsetV19(0);
    const F = ASSET_GROWTH_FIELD_OFF;
    b.writeUInt32LE(p.growthLambdaBps, g + F.lambdaBps);
    b.writeUInt16LE(1000, g + F.lLaunchX100 - 0); // l_launch 10x
    b.writeUInt16LE(1000, g + F.lTierX100);
    b.writeUInt16LE(1000, g + F.ceilX100);
    b.writeUInt16LE(p.growthKinkBps ?? 5000, g + F.kinkBps);
    b[g + F.version] = 1;
  }
  return new Uint8Array(b);
}

/** A real SOLCAT LP-vault registry (176 B, domain 0) with the bound / ext flag bytes set. */
export function registryBytes(o: { bound?: boolean; ext?: boolean; domain?: number; feeShareBps?: number; boundByte?: number; bond?: boolean } = {}): Uint8Array {
  const b = Buffer.from(fx("solcat-lp-vault-registry-v18"));
  b[160] = o.boundByte ?? (o.bound ? 1 : 0);
  b[161] = o.ext ? 1 : 0;
  b[162] = o.bond ? 1 : 0;
  if (o.domain !== undefined) b.writeUInt16LE(o.domain, 16 + 132);
  if (o.feeShareBps !== undefined) b.writeUInt16LE(o.feeShareBps, 16 + 128);
  return new Uint8Array(b);
}

/** A 272-byte vault_lp_state (kind 9, version 1) naming `lp` as the vault LP portfolio. */
export function vaultLpStateBytes(o: { registry?: PublicKey; lp: PublicKey; outstanding?: bigint }): Uint8Array {
  const b = Buffer.alloc(16 + 256 + 16);
  b[10] = 9;
  b[16 + 214] = 1;
  (o.registry ?? Keypair.generate().publicKey).toBuffer().copy(b, 16 + 32);
  o.lp.toBuffer().copy(b, 16 + 64);
  Keypair.generate().publicKey.toBuffer().copy(b, 16 + 96);
  w128(b, 16 + 240, o.outstanding ?? 0n);
  return new Uint8Array(b);
}

export function snapshot(o: {
  label?: string;
  market?: PublicKey;
  slot?: number;
  marketData?: Uint8Array | null;
  registryData?: Uint8Array | null;
  vaultLpData?: Uint8Array | null;
  parse?: boolean;
}): VaultMarketSnapshot {
  const market = o.market ?? Keypair.generate().publicKey;
  const registryData = o.registryData === undefined ? registryBytes({ bound: true }) : o.registryData;
  const vaultLp = o.vaultLpData ? decodeVaultLpState(o.vaultLpData) : null;
  let registry = null;
  let bound = false;
  let extFlag = false;
  if (registryData) {
    registry = parseRegistryLoose(registryData);
    bound = registryData[160] === 1;
    extFlag = registryData[161] === 1;
  }
  return {
    ref: { marketAddress: market.toBase58(), label: o.label ?? "TST", assetIndex: 0 },
    market,
    slot: o.slot ?? 505_231_200,
    marketData: o.marketData === undefined ? patchedMarket() : o.marketData,
    registryData,
    registry,
    bound,
    extFlag,
    vaultLp,
  };
}

function parseRegistryLoose(d: Uint8Array): ReturnType<typeof parseLpVaultRegistry> | null {
  try {
    return parseLpVaultRegistry(d);
  } catch {
    return null;
  }
}

export { deriveLpVaultRegistry, deriveVaultLpState };

// ── Recording fake connection ────────────────────────────────────────────────

export interface SimScript {
  err: unknown;
  logs?: string[];
  unitsConsumed?: number;
}

export interface FakeConnOpts {
  /** Account bytes by base58 key. */
  accounts?: Map<string, Uint8Array>;
  slot?: number;
  /** One result per simulateTransaction call, in order; the last repeats. */
  sims?: SimScript[];
  /** getMultipleAccountsInfo[AndContext] throws this when set. */
  readError?: Error;
  balanceLamports?: number;
  /** confirmTransaction result err (null = landed). */
  confirmErr?: unknown;
}

export interface Call {
  fn: string;
  args: unknown[];
}

export function fakeConn(o: FakeConnOpts = {}) {
  const accounts = o.accounts ?? new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const sent: Transaction[] = [];
  const simulated: Transaction[] = [];
  let simIdx = 0;
  const info = (k: PublicKey) => {
    const d = accounts.get(k.toBase58());
    return d ? { data: Buffer.from(d), executable: false, lamports: 1, owner: PROGRAM } : null;
  };
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.push({ fn: "getMultipleAccountsInfo", args: [keys.length] });
      if (o.readError) throw o.readError;
      return keys.map(info);
    },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      calls.push({ fn: "getMultipleAccountsInfoAndContext", args: [keys.length] });
      if (o.readError) throw o.readError;
      return { context: { slot: o.slot ?? 505_231_200 }, value: keys.map(info) };
    },
    async getAccountInfo(k: PublicKey) {
      calls.push({ fn: "getAccountInfo", args: [k.toBase58()] });
      return info(k);
    },
    async getBalance() {
      calls.push({ fn: "getBalance", args: [] });
      return o.balanceLamports ?? 5_000_000_000;
    },
    async getLatestBlockhash() {
      calls.push({ fn: "getLatestBlockhash", args: [] });
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
    },
    async simulateTransaction(vtx: { message: { compiledInstructions: unknown[] } }, cfg: unknown) {
      calls.push({ fn: "simulateTransaction", args: [cfg] });
      simulated.push(Transaction.from(Buffer.from(vtxToLegacy(vtx))));
      const scripts = o.sims ?? [{ err: null, logs: [] }];
      const s = scripts[Math.min(simIdx++, scripts.length - 1)];
      return { context: { slot: o.slot ?? 505_231_200 }, value: { err: s.err, logs: s.logs ?? [], accounts: null, unitsConsumed: s.unitsConsumed ?? 100_000, returnData: null } };
    },
    async sendRawTransaction(raw: Buffer) {
      calls.push({ fn: "sendRawTransaction", args: [] });
      sent.push(Transaction.from(raw));
      return "sig1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
    },
    async confirmTransaction() {
      calls.push({ fn: "confirmTransaction", args: [] });
      return { context: { slot: 1 }, value: { err: o.confirmErr ?? null } };
    },
    async getSignatureStatuses() {
      calls.push({ fn: "getSignatureStatuses", args: [] });
      return { context: { slot: 1 }, value: [null] };
    },
  };
  return { conn, calls, sent, simulated, accounts, count: (fn: string) => calls.filter((c) => c.fn === fn).length };
}

/** The recorded VersionedTransaction carries the compiled message; rebuild a legacy Transaction for inspection. */
function vtxToLegacy(vtx: { message: unknown }): Uint8Array {
  const m = vtx.message as {
    staticAccountKeys: PublicKey[];
    compiledInstructions: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>;
    header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
    recentBlockhash: string;
  };
  const tx = new Transaction();
  tx.recentBlockhash = m.recentBlockhash;
  tx.feePayer = m.staticAccountKeys[0];
  const h = m.header;
  const nKeys = m.staticAccountKeys.length;
  const isSigner = (i: number) => i < h.numRequiredSignatures;
  const isWritable = (i: number) =>
    i < h.numRequiredSignatures - h.numReadonlySignedAccounts || (i >= h.numRequiredSignatures && i < nKeys - h.numReadonlyUnsignedAccounts);
  for (const ci of m.compiledInstructions) {
    tx.add({
      programId: m.staticAccountKeys[ci.programIdIndex],
      keys: ci.accountKeyIndexes.map((i) => ({ pubkey: m.staticAccountKeys[i], isSigner: isSigner(i), isWritable: isWritable(i) })),
      data: Buffer.from(ci.data),
    });
  }
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

export const KEEPER = Keypair.generate();
