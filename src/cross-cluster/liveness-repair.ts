/**
 * cross-cluster/liveness-repair.ts
 *
 * Two permissionless, market-only wrapper instructions that un-brick a Live
 * market the accrual/refresh crank cannot fix on its own. Neither moves
 * tokens, neither takes a caller-chosen slot or amount, and the engine refuses
 * both unless the market is actually in the state being repaired, so sending
 * one early is a clean revert, never a state change.
 *
 * 1. ExpireBackingBucket (tag 89, `handle_expire_backing_bucket`).
 *    A realized loss opens the domain's backing bucket as `Fresh` with a
 *    FIXED expiry (`current_slot + max(max_accrual_dt, h_max,
 *    max_bankrupt_close_lifetime)`), never extended while it stays Fresh.
 *    Once that expiry passes the bucket is a dead end until someone advances
 *    it to Expired/Impaired (wrapper doc on `Instruction::ExpireBackingBucket`):
 *      - settling a gain against it -> EngineStale Custom(19)
 *        (`validate_source_domain_ledger_current`) — this is every crank and
 *        refresh that touches a portfolio holding a claim on that domain, so
 *        the market's accrual clock stops and every trade reverts;
 *      - reserving a further loss against it -> EngineLockActive Custom(21)
 *        (`prepare_counterparty_backing_add_delta`, expiry-mismatch arm);
 *      - TopUpBackingBucket / DepositToLpVault into it -> Custom(21), same arm.
 *    Observed live 2026-09-29: PAID and CATE (domain 1 lapsed) — every keeper
 *    crank reverted Custom(19) ("RECOVERED after 12 reverts" treadmill, engine
 *    clock hundreds of slots behind, UI "engine behind"); Murphy (both domains
 *    lapsed) — the Earn deposit reverted Custom(21).
 *    The engine gate (`prepare_counterparty_backing_expiry_delta`) is
 *    `status == Fresh && now_slot >= expiry_slot`, with `now_slot` the runtime
 *    Clock. We only send it for a Fresh bucket whose expiry is strictly below
 *    the slot the market was read at.
 *
 * 2. FinalizeResetSide (tag 45, `handle_finalize_reset_side` ->
 *    `finalize_side_reset_not_atomic`).
 *    A full drain reset leaves a side in `ResetPending`. Nothing but this
 *    instruction moves it back to `Normal`, and `asset_risk_increase_gate`
 *    rejects EVERY risk-increasing trade with Custom(21) while either side is
 *    not Normal. Observed live 2026-09-29: COLLECT and Murphy short side
 *    ResetPending with 0 stored positions — every open reverted "market
 *    locked". The engine gate is `stored_pos_count == 0 && stale_account_count
 *    == 0 && pending_obligation_count == 0 && pending_domain_loss_barrier ==
 *    0`; we mirror it exactly so the instruction is only sent when it lands.
 *
 * Both are prepended to the per-market crank transaction (see planCrankTx):
 * the repaired state is then what the accrual crank and the refreshes see.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_EXPIRE_BACKING_BUCKET,
  LAYOUTS_BY_VERSION,
  buildAccountMetas,
  encodeExpireBackingBucket,
} from "@percolatorct/sdk";
import { describeUnknownLayout, detectLayout, engineSlotBase } from "./market-layout.ts";
import type { MarketLayout } from "./market-layout.ts";

import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

/** Wrapper instruction tag for FinalizeResetSide (v16_program.rs `45 => Self::FinalizeResetSide`). */
export const FINALIZE_RESET_SIDE_TAG = 45;

// Engine slot layout (percolator src/v16.rs, `EngineAssetSlotV16Account` /
// `AssetStateV16Account` / `BackingBucketV16Account`, all packed POD). The
// engine slot starts right after the asset's 1024-byte wrapper oracle block.
const ASSET_SLOT_LEN = 2325;
const ASSET_WRAPPER_LEN = 1024;
const AS_STORED_POS_LONG = 321;
const AS_STORED_POS_SHORT = 329;
const AS_STALE_LONG = 337;
const AS_STALE_SHORT = 345;
const AS_PENDING_OBL_LONG = 353;
const AS_PENDING_OBL_SHORT = 361;
const AS_MODE_LONG = 513;
const AS_MODE_SHORT = 514;
/** size_of::<AssetStateV16Account>() */
const ASSET_STATE_LEN = 515;
// EngineAssetSlotV16Account after `asset`: 4 x u128 insurance budget/spent,
// then pending_domain_loss_barrier_long/short (u64), 2 x SourceCreditState
// (184 B each), then backing_long / backing_short (97 B each).
const SLOT_BARRIER_LONG = ASSET_STATE_LEN + 64;
const SLOT_BARRIER_SHORT = ASSET_STATE_LEN + 72;
const SLOT_BACKING_LONG = ASSET_STATE_LEN + 80 + 2 * 184;
// market_id u64 + 5 x u128 + expiry_slot u64 + status u8 (packed).
const BACKING_LEN = 97;
const BK_EXPIRY = 88;
const BK_STATUS = 96;

/** `BackingBucketStatusV16` wire bytes. */
export const BUCKET_FRESH = 1;
/** `SideModeV16` wire bytes. */
export const SIDE_MODE_RESET_PENDING = 2;

export interface BucketState {
  domain: number;
  status: number;
  expirySlot: bigint;
}

export interface SideResetState {
  /** 0 = long, 1 = short (wrapper `decode_side`). */
  side: 0 | 1;
  mode: number;
  storedPos: bigint;
  stale: bigint;
  pendingObligations: bigint;
  pendingDomainLossBarrier: bigint;
}

export interface LivenessState {
  assetIndex: number;
  buckets: [BucketState, BucketState];
  sides: [SideResetState, SideResetState];
}

function u64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}

/**
 * The engine-slot offsets the repairs read, for one market layout (K-8, 2026-10-12).
 *
 * The constants above are the v2.1 numbers (asset state 515 B, slot stride 2,325, group 758). On a v2.2 (VERSION 19)
 * market the group header is 806 B (+48), the asset state 627 B (+112 band / rent words appended AFTER mode_short, so
 * the asset-state prefix is unchanged) and the stride 2,661, so the old fixed offsets read 48 B early: the keeper never
 * saw a ResetPending side or a lapsed bucket on v2.2 (JUP GtUe5hYy… stayed close-only, 120, until a manual tag 45).
 * Every number now comes from the market's detected layout row (market-layout.ts, per VERSION and length) and the
 * SDK's per-VERSION engine-slot table: v2.1 backing 963 / barrier 579, v2.2 backing 1,075 / barrier 691. The bucket
 * struct (97 B, expiry @88, status @96) and the engine-slot field order are unchanged (engine 3ce4cbd1 v16.rs:8253-8260,
 * :8518-8528).
 */
export interface LivenessOffsets {
  /** Absolute offset of the asset's engine slot. */
  engineBase: number;
  storedPosLong: number; storedPosShort: number;
  staleLong: number; staleShort: number;
  pendingOblLong: number; pendingOblShort: number;
  modeLong: number; modeShort: number;
  barrierLong: number; barrierShort: number;
  backingLong: number; backingShort: number;
}

/** v2.1 offsets (the constants above); kept for callers / tests that pin them. */
export function livenessOffsetsV21(assetIndex = 0): LivenessOffsets {
  return {
    engineBase: 592 + 758 + assetIndex * ASSET_SLOT_LEN + ASSET_WRAPPER_LEN,
    storedPosLong: AS_STORED_POS_LONG, storedPosShort: AS_STORED_POS_SHORT,
    staleLong: AS_STALE_LONG, staleShort: AS_STALE_SHORT,
    pendingOblLong: AS_PENDING_OBL_LONG, pendingOblShort: AS_PENDING_OBL_SHORT,
    modeLong: AS_MODE_LONG, modeShort: AS_MODE_SHORT,
    barrierLong: SLOT_BARRIER_LONG, barrierShort: SLOT_BARRIER_SHORT,
    backingLong: SLOT_BACKING_LONG, backingShort: SLOT_BACKING_LONG + BACKING_LEN,
  };
}

/** Offsets for a detected layout row; null when the pinned SDK has no engine-slot table for its VERSION. */
export function livenessOffsetsFor(layout: MarketLayout, assetIndex = 0): LivenessOffsets | null {
  const t = LAYOUTS_BY_VERSION.get(layout.wrapperVersion);
  if (!t) return null;
  return {
    engineBase: engineSlotBase(layout, assetIndex),
    storedPosLong: layout.asset.storedPosLong, storedPosShort: layout.asset.storedPosShort,
    staleLong: layout.asset.staleLong, staleShort: layout.asset.staleShort,
    pendingOblLong: layout.asset.pendingOblLong, pendingOblShort: layout.asset.pendingOblShort,
    modeLong: layout.asset.modeLong, modeShort: layout.asset.modeShort,
    barrierLong: layout.slot.barrierLong, barrierShort: layout.slot.barrierShort,
    backingLong: t.engineSlot.backingLong, backingShort: t.engineSlot.backingShort,
  };
}

/**
 * Decode the repair-relevant state of asset `assetIndex`. The layout is detected from the account (VERSION + length)
 * unless `offsets` is given; an unknown layout throws (never decoded with a guessed offset).
 */
export function decodeLivenessState(data: Uint8Array, assetIndex = 0, offsets?: LivenessOffsets): LivenessState {
  let o = offsets;
  if (!o) {
    const det = detectLayout(data);
    if (!det.known) throw new Error(`decodeLivenessState: ${describeUnknownLayout(det)}`);
    const got = livenessOffsetsFor(det.layout, assetIndex);
    if (!got) throw new Error(`decodeLivenessState: no SDK engine-slot table for VERSION ${det.layout.wrapperVersion}`);
    o = got;
  }
  const a = o.engineBase;
  if (data.length < a + o.backingShort + BACKING_LEN) {
    throw new Error(`decodeLivenessState: market account too short (${data.length} bytes)`);
  }
  const bucket = (i: 0 | 1): BucketState => {
    const b = a + (i === 0 ? o.backingLong : o.backingShort);
    return { domain: assetIndex * 2 + i, status: data[b + BK_STATUS], expirySlot: u64(data, b + BK_EXPIRY) };
  };
  const side = (s: 0 | 1): SideResetState => ({
    side: s,
    mode: data[a + (s === 0 ? o.modeLong : o.modeShort)],
    storedPos: u64(data, a + (s === 0 ? o.storedPosLong : o.storedPosShort)),
    stale: u64(data, a + (s === 0 ? o.staleLong : o.staleShort)),
    pendingObligations: u64(data, a + (s === 0 ? o.pendingOblLong : o.pendingOblShort)),
    pendingDomainLossBarrier: u64(data, a + (s === 0 ? o.barrierLong : o.barrierShort)),
  });
  return { assetIndex, buckets: [bucket(0), bucket(1)], sides: [side(0), side(1)] };
}

export type LivenessRepair =
  | { kind: "expire"; domain: number }
  | { kind: "finalize"; assetIndex: number; side: 0 | 1 };

/**
 * The repairs this market needs right now. `nowSlot` is the slot the market
 * account was read at; a bucket is expired only once its expiry is strictly
 * below it, so the runtime Clock at landing is guaranteed past it too.
 */
export function planLivenessRepairs(s: LivenessState, nowSlot: bigint): LivenessRepair[] {
  const out: LivenessRepair[] = [];
  for (const b of s.buckets) {
    if (b.status === BUCKET_FRESH && b.expirySlot < nowSlot) out.push({ kind: "expire", domain: b.domain });
  }
  for (const side of s.sides) {
    if (
      side.mode === SIDE_MODE_RESET_PENDING &&
      side.storedPos === 0n &&
      side.stale === 0n &&
      side.pendingObligations === 0n &&
      side.pendingDomainLossBarrier === 0n
    ) {
      out.push({ kind: "finalize", assetIndex: s.assetIndex, side: side.side });
    }
  }
  return out;
}

export function buildExpireBackingBucketIx(market: PublicKey, domain: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_EXPIRE_BACKING_BUCKET, [market]),
    data: Buffer.from(encodeExpireBackingBucket({ domain })),
  });
}

/** FinalizeResetSide wire: [45, asset_index u16 LE, side u8]; accounts: [market (w)]. */
export function buildFinalizeResetSideIx(market: PublicKey, assetIndex: number, side: 0 | 1): TransactionInstruction {
  const data = Buffer.alloc(4);
  data[0] = FINALIZE_RESET_SIDE_TAG;
  data.writeUInt16LE(assetIndex, 1);
  data[3] = side;
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: [{ pubkey: market, isSigner: false, isWritable: true }],
    data,
  });
}

export function buildLivenessRepairIx(market: PublicKey, r: LivenessRepair): TransactionInstruction {
  return r.kind === "expire"
    ? buildExpireBackingBucketIx(market, r.domain)
    : buildFinalizeResetSideIx(market, r.assetIndex, r.side);
}

export function describeRepair(r: LivenessRepair): string {
  return r.kind === "expire" ? `ExpireBackingBucket(d${r.domain})` : `FinalizeResetSide(${r.side === 0 ? "long" : "short"})`;
}
