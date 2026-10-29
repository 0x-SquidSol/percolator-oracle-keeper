/**
 * v2.2 growth round 2 (R2.1 item 4): the wrapper's ON-CHAIN DEX depth source and PushAuthMark depth mode 2.
 *
 * PDA derivation comes from the SDK (`deriveDepthSourceV22`, pin ec2b63e). The active-pin decoder stays local on purpose: the
 * SDK's `decodeDepthSourceV22` THROWS on a bad/cleared record and returns every field, this one returns null and only the
 * mode-2 fields. The mode-2 ix is built in auth-mark-pusher.ts; a test pins it byte-for-byte to the SDK's
 * `buildPushAuthMarkDexIxV22`. (Wrapper `feat/v22-growth-dex-depth` @ e2c93138 `src/depth_src_v22.rs`.)
 *
 * The upgrade authority pins ONE pool per market (PDA `["depth_src", market]`, header kind 16). A mode-2 push is the 44 B
 * PushAuthMark with `depth_mode = 2`, `depth_e6 = 0`, plus `[2] depth_src [3] pool [4] base_vault [5] quote_vault`
 * (read-only) after `[0] authority [1] market`; the program reads the reserves itself and answers 129 `DepthSourceInvalid`
 * on any mismatch with the pin.
 *
 * Flag `KEEPER_PUSH_DEPTH_ONCHAIN` (default OFF, and only effective with `KEEPER_PUSH_DEPTH` on). Off = nothing here runs.
 */
import { PublicKey } from "@solana/web3.js";
import { deriveDepthSourceV22 } from "@percolatorct/sdk";
import type { AccountInfo, Connection } from "@solana/web3.js";
import { pushDepthEnabled } from "./push-depth.ts";
import { parseFlag } from "./v22/flags.ts";
import { getMultipleAccountsInfoChunked } from "./rpc-chunk.ts";

/** Wrapper `DepthSourceInvalid`. */
export const WRAPPER_ERR_DEPTH_SOURCE_INVALID = 129;
/** PushAuthMark depth_mode 2 = on-chain DEX pool. */
export const DEPTH_MODE_ONCHAIN_DEX = 2;
export const DEPTH_SOURCE_ONCHAIN_DEX = "onchain-dex";
export const DEPTH_SOURCE_SEED = "depth_src";
export const DEPTH_SOURCE_ACCOUNT_LEN = 16 + 256;
const KIND_DEPTH_SOURCE = 16;
const WRAPPER_ACCOUNT_MAGIC = 0x5045_5243_5631_3600n;
const FLAG_ACTIVE = 1;
const FLAGS_KNOWN = 3;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** `KEEPER_PUSH_DEPTH_ONCHAIN` on AND `KEEPER_PUSH_DEPTH` on. Both are parsed (an unrecognised value throws) even when the other is off. */
export function pushDepthOnchainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const onchain = parseFlag(env, "KEEPER_PUSH_DEPTH_ONCHAIN", false);
  return pushDepthEnabled(env) && onchain;
}

export function deriveDepthSource(programId: PublicKey, market: PublicKey): PublicKey {
  return deriveDepthSourceV22(programId, market)[0];
}

/** What a mode-2 push needs. */
export interface DexDepthPin {
  depthSource: PublicKey;
  pool: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  ammProgram: PublicKey;
  assetIndex: number;
  /** The asset generation the pin was made for. */
  marketId: bigint;
}

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

/**
 * Decode an ACTIVE `DepthSourceV22`; null for anything else (cleared, wrong header/length/kind/version, unknown flags,
 * non-zero reserved, zero or duplicate keys). Same structural checks as the wrapper's `validate_depth_source`.
 */
export function decodeActiveDepthSource(data: Uint8Array, depthSource: PublicKey): DexDepthPin | null {
  if (data.length !== DEPTH_SOURCE_ACCOUNT_LEN) return null;
  const hv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (hv.getBigUint64(0, true) !== WRAPPER_ACCOUNT_MAGIC || data[10] !== KIND_DEPTH_SOURCE) return null;
  const b = data.subarray(16);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const key = (off: number): Uint8Array => b.subarray(off, off + 32);
  const flags = b[244];
  if (b[245] !== 1 || isZero(key(0)) || !isZero(b.subarray(248, 256)) || (flags & ~FLAGS_KNOWN & 0xff) !== 0) return null;
  if ((flags & FLAG_ACTIVE) === 0) return null; // cleared: mode 2 is refused on chain
  const pool = key(64), baseVault = key(96), quoteVault = key(128), baseMint = key(160), quoteMint = key(192);
  if ([pool, baseVault, quoteVault, baseMint, quoteMint].some(isZero)) return null;
  if (Buffer.compare(Buffer.from(baseVault), Buffer.from(quoteVault)) === 0 || Buffer.compare(Buffer.from(baseMint), Buffer.from(quoteMint)) === 0) return null;
  if (b[242] > 18 || b[243] > 18 || (b[247] !== 1 && b[247] !== 2)) return null;
  return {
    depthSource,
    pool: new PublicKey(pool),
    baseVault: new PublicKey(baseVault),
    quoteVault: new PublicKey(quoteVault),
    ammProgram: new PublicKey(key(32)),
    assetIndex: v.getUint16(240, true),
    marketId: v.getBigUint64(224, true),
  };
}

type Entry = { pin: DexDepthPin | null; why: string; at: number };

/**
 * Per-market cache of the depth-source pin. Refreshed every `refreshMs` (default 5 min) or when invalidated (a 129).
 *
 * SAME-CLUSTER rule: the pin only names keys; the wrapper reads those accounts on the cluster it runs on. So a pin is
 * usable only if its pool, base vault and quote vault EXIST ON THE PUSH CLUSTER (the connection passed to `refresh`),
 * the pool is owned by the pinned AMM program and both vaults are token accounts. A pin of a pool that lives on another
 * cluster (e.g. a mainnet pool) fails this and the market stays on the attested mode-1 path. Any RPC failure = no pin
 * (fail to mode 1), never a guess.
 */
export class DepthSourceCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly refreshMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  get(market: string): DexDepthPin | null {
    return this.entries.get(market)?.pin ?? null;
  }
  why(market: string): string | undefined {
    return this.entries.get(market)?.why;
  }
  /** Force a re-read next `refresh` (after a 129). */
  invalidate(market: string): void {
    const e = this.entries.get(market);
    if (e) e.at = Number.NEGATIVE_INFINITY;
  }

  async refresh(conn: Pick<Connection, "getMultipleAccountsInfo">, programId: PublicKey, markets: readonly string[]): Promise<void> {
    const now = this.now();
    const due = markets.filter((m) => {
      const e = this.entries.get(m);
      return !e || now - e.at >= this.refreshMs;
    });
    if (due.length === 0) return;
    const pdas = due.map((m) => deriveDepthSource(programId, new PublicKey(m)));
    const got = await getMultipleAccountsInfoChunked(conn, pdas, "confirmed");
    const pending: Array<{ market: string; pin: DexDepthPin }> = [];
    due.forEach((m, i) => {
      const info = got.infos[i];
      if (info === undefined) return this.entries.set(m, { pin: null, why: "depth-source read failed", at: now }), undefined;
      if (info === null || !info.owner.equals(programId)) return this.entries.set(m, { pin: null, why: "no depth source", at: now }), undefined;
      const pin = decodeActiveDepthSource(new Uint8Array(info.data), pdas[i]);
      if (!pin) return this.entries.set(m, { pin: null, why: "depth source inactive or invalid", at: now }), undefined;
      pending.push({ market: m, pin });
      return undefined;
    });
    if (pending.length === 0) return;
    const keys = pending.flatMap((p) => [p.pin.pool, p.pin.baseVault, p.pin.quoteVault]);
    const acc = await getMultipleAccountsInfoChunked(conn, keys, "confirmed");
    const isToken = (a: AccountInfo<Buffer> | null | undefined): boolean => !!a && (a.owner.equals(TOKEN_PROGRAM) || a.owner.equals(TOKEN_2022_PROGRAM));
    pending.forEach((p, i) => {
      const pool = acc.infos[i * 3], bv = acc.infos[i * 3 + 1], qv = acc.infos[i * 3 + 2];
      if (pool === undefined || bv === undefined || qv === undefined) {
        this.entries.set(p.market, { pin: null, why: "pool read failed", at: now });
      } else if (!pool || !pool.owner.equals(p.pin.ammProgram) || !isToken(bv) || !isToken(qv)) {
        this.entries.set(p.market, { pin: null, why: "pinned pool/vaults not on the push cluster", at: now });
      } else {
        this.entries.set(p.market, { pin: p.pin, why: "ok", at: now });
      }
    });
  }
}
