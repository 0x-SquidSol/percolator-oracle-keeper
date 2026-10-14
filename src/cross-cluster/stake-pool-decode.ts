/**
 * cross-cluster/stake-pool-decode.ts
 *
 * K-4: one StakePool decode for every keeper job that reads a pool (terminal-insurance, stake-fee).
 *
 * The SDK has two decoders: `decodeStakePool` (legacy v1..v4, picks the version from the account LENGTH and refuses
 * anything else: "StakePool unsupported version: 5 !== 4" on every v2.2 pool), and `decodeStakePoolV5` (the v2.2 pool:
 * 480 B, version byte 5 at `_reserved` + 8 = 328, percolator-stake release/v22-stake-rem). This picks by the version
 * byte, then hands the jobs only the fields they consume. Both layouts share the fixed prefix (is_initialized @0,
 * slab @8, collateral_mint @72, vault @136, total_lp_supply @176, percolator_program @224, pool_mode @280, `_reserved` @320 with the R-1
 * floor flags at `_reserved[61]`), so the jobs' logic is unchanged. Unknown versions still throw (never a guess).
 */
import type { PublicKey } from "@solana/web3.js";
import { decodeStakePool, decodeStakePoolV5 } from "@percolatorct/sdk";

/** StakePool `_reserved` offset; the version byte is `_reserved[8]` (v2+ layouts). */
export const STAKE_POOL_RESERVED_OFF = 320;
export const STAKE_POOL_VERSION_OFF = STAKE_POOL_RESERVED_OFF + 8;
/** v2.2 pool (stake v5): 480 B, version 5. */
export const STAKE_POOL_SIZE_V5 = 480;
export const STAKE_POOL_VERSION_V5 = 5;

export interface StakePoolView {
  /** Pool layout version (1..5). */
  version: number;
  isInitialized: boolean;
  slab: PublicKey;
  collateralMint: PublicKey;
  vault: PublicKey;
  percolatorProgram: PublicKey;
  /** 0 = insurance pool (the only mode the fee / wind-down jobs act on). */
  poolMode: number;
  totalLpSupply: bigint;
  /** Pool admin (the creator whose seed is returned at terminal, stake S1). */
  admin: PublicKey;
  /** v5 only: 1 = FIRST_LOSS, 2 = FEE_ONLY. undefined on legacy pools. */
  riskMode?: number;
}

/** True when the bytes are a v5 (v2.2) StakePool by length + version byte. */
export function isStakePoolV5(data: Uint8Array): boolean {
  return data.length >= STAKE_POOL_SIZE_V5 && data[STAKE_POOL_VERSION_OFF] === STAKE_POOL_VERSION_V5;
}

/** Decode a StakePool of any supported version (v1..v4 via the legacy decoder, v5 via the v2.2 decoder). Throws otherwise. */
export function decodeStakePoolAnyVersion(data: Uint8Array): StakePoolView {
  if (isStakePoolV5(data)) {
    const p = decodeStakePoolV5(data);
    return {
      version: STAKE_POOL_VERSION_V5,
      isInitialized: data[0] === 1,
      slab: p.slab,
      collateralMint: p.collateralMint,
      vault: p.vault,
      percolatorProgram: p.percolatorProgram,
      poolMode: p.poolMode,
      totalLpSupply: p.totalLpSupply,
      admin: p.admin,
      riskMode: p.riskMode,
    };
  }
  const p = decodeStakePool(data);
  return {
    version: p.version,
    isInitialized: p.isInitialized,
    slab: p.slab,
    collateralMint: p.collateralMint,
    vault: p.vault,
    percolatorProgram: p.percolatorProgram,
    poolMode: p.poolMode,
    totalLpSupply: p.totalLpSupply,
    admin: p.admin,
  };
}
