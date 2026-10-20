/**
 * cross-cluster/market-layout.ts
 *
 * THE table of market-account layouts the cranker / sweep can read. Every byte
 * offset used by positioned-refresh.ts and positioned-sweep.ts is derived from
 * a row here; when a layout moves, this file is the single place to update.
 *
 * A market account is
 *   [wrapper header + config: groupOff][engine group header: headerLen]
 *   [asset slot x max_market_slots], slot = [wrapper oracle block: wrapperLen][engine slot: engineSlotLen]
 * so its length is `groupOff + headerLen + n * (wrapperLen + engineSlotLen)`.
 * The layout is detected from that length, `max_market_slots` (same absolute
 * offset in every known layout) AND the wrapper header VERSION (u16 at byte 8).
 * The version is required because lengths collide: Wave B without the drift
 * tail is 1398 + 2437 = 3835 bytes for one slot, exactly the v2.1-drift length
 * (1350 + 2485). A length-only match would decode such an account with v2.1
 * offsets, 48 bytes off.
 *
 * Rows and where their numbers come from:
 *   v2.1-legacy  deployed devnet program (wrapper 7c906e45 / engine 35ddd692). The offsets the
 *                keeper has used since 2026-09-28, cross-checked against live account bytes.
 *   v2.1-drift   fix/v21-funding-scale (engine 3b02ff24..89403177, wrapper eae0cce7): two 80-byte
 *                KfDriftSideV16Account blocks appended to every engine slot.
 *   v2.2-drift   Wave B (band + holding rent) + the drift tail. Probed with core::mem::offset_of!
 *                against a copy of engine `release/v22-engine` @ ee05b125 (which contains BOTH
 *                #279 Wave B and #277 funding-scale): header 806, engine slot 1573, leg 185.
 *                The wrapper-side lengths (592 / 1024) are unchanged on feat/v22-wave-b. Marked
 *                provisional: the wrapper release branch had not merged Wave B at probe time
 *                and the engine header has already grown twice (790 -> 798 -> 806).
 *
 *   v2.2-b       VARIANT B, the v2.2 LAUNCH CANDIDATE (wrapper release/v22-wrapper-rem 8fac24e8 on engine
 *                release/v22-engine-rem ccc3fda4: per-leg K/F remainders + the second 32 B slot tail + #287's third, the
 *                provider-principal mirror: slot 2,661, engine slot 1,637).
 *                Every geometry number is READ FROM the SDK's VERSION-keyed LAYOUT_V22 (percolator-sdk#406),
 *                not typed here; only the in-slot drift-tail offsets (which the SDK table does not carry) are
 *                keeper-side, and `rowAgreesWithSdk` fails the row closed if the two ever disagree.
 *   v2.2-drift   (stage A) the earlier v2.2 numbers, kept so a stage-A account is still READ loudly rather than
 *                mis-decoded; its portfolios are 10,091 B which the SDK parser (VERSION 19 = variant B) refuses,
 *                so the cranker reports it "unsupported" (see layoutHealthFor).
 *
 * Detection never guesses: a length that matches no row is "unknown", and the
 * caller must report the market unhealthy (see recovery-cranker.ts), not fall
 * back to another layout's behaviour. Before any row is tried the header VERSION must be one the pinned SDK has a
 * table for (LAYOUTS_BY_VERSION); a refusal is counted in layout-guard-metrics.ts and surfaces
 * in /health as `layoutGuard`, never as a silent fallback.
 */
import { LAYOUTS_BY_VERSION, LAYOUT_V22 } from "@percolatorct/sdk";
import type { LayoutTable } from "@percolatorct/sdk";
import { noteLayoutGuardRefusal } from "./layout-guard-metrics.ts";

/** KfDriftSideV16Account field offsets (identical wherever the tail exists). */
export const KF_DRIFT_FIELDS = {
  len: 80,
  genEpoch: 0,
  laggardCount: 8,
  driftGen: 16,
  driftPrior: 32,
  staleWeight: 48,
  laggardWeight: 64,
} as const;

export type MarketLayoutId = "v2.1-legacy" | "v2.1-drift" | "v2.2-drift" | "v2.2-b";

export interface MarketLayout {
  id: MarketLayoutId;
  /** True while the numbers may still move (not yet a merged, deployed program). */
  provisional: boolean;
  /** Where the numbers were taken from. */
  source: string;
  /** Wrapper `constants::VERSION` stored in the account header (u16 LE at byte 8). */
  wrapperVersion: number;
  /** HEADER_LEN + WRAPPER_CONFIG_LEN: start of the engine group header. */
  groupOff: number;
  /** size_of::<MarketGroupV16HeaderAccount>(). */
  headerLen: number;
  /** ASSET_ORACLE_WRAPPER_LEN: wrapper oracle block in front of each engine slot. */
  wrapperLen: number;
  /** size_of::<EngineAssetSlotV16Account>(). */
  engineSlotLen: number;
  /** wrapperLen + engineSlotLen. */
  slotStride: number;
  /** Portfolio account length this program creates, and its leg size. */
  portfolioAccountLen: number;
  portfolioLegLen: number;
  /**
   * True when the group header and AssetStateV16 prefix match v2.1, i.e. the
   * keeper's other v2.1 decoders (liveness-repair.ts, adl-state.ts, ...) read
   * the right bytes. They are skipped on a layout where this is false.
   */
  v21Decoders: boolean;
  /** Offsets relative to `groupOff`. */
  header: {
    maxMarketSlots: number;
    maxAccrualDtSlots: number;
    insurance: number;
    sourceInsuranceReservedTotal: number;
    currentSlot: number;
    lossStaleActive: number;
  };
  /** Offsets relative to the engine slot base (AssetStateV16Account is its first field). */
  asset: {
    lifecycle: number;
    /**
     * GH#172: `raw_oracle_target_price` — the last AuthMark PUSHED for this asset, as opposed to
     * `effectivePrice`, which is the engine's walked mark and lags it by the per-slot step cap. This
     * is the trusted-but-possibly-stale value the cross-cluster circuit breaker seeds its baseline
     * from on a cold start, so a restart cannot accept an unbounded first price.
     */
    rawOracleTargetPrice: number;
    effectivePrice: number;
    slotLast: number;
    kfEpochLong: number;
    kfEpochShort: number;
    oiEffLong: number;
    oiEffShort: number;
    storedPosLong: number;
    storedPosShort: number;
    staleLong: number;
    staleShort: number;
    pendingOblLong: number;
    pendingOblShort: number;
    lossWeightSumLong: number;
    lossWeightSumShort: number;
    modeLong: number;
    modeShort: number;
  };
  /** Engine-slot fields after the asset state, relative to the engine slot base. */
  slot: {
    insBudgetLong: number;
    insBudgetShort: number;
    insSpentLong: number;
    insSpentShort: number;
    barrierLong: number;
    barrierShort: number;
    /** InsuranceCreditReservationV16Account; insurance_credit_reserved_num u128 is its first field. */
    insReservationLong: number;
    insReservationShort: number;
    /** kf_drift_long / kf_drift_short; null = this layout has no drift tail (no sweep, no coverage). */
    driftLong: number | null;
    driftShort: number | null;
  };
}

/** AssetStateV16Account prefix: unchanged from v2.1 through v2.2 (Wave B appends after mode_short). */
const ASSET_V21 = {
  lifecycle: 16,
  // AssetStateV16Account: market_id 0..8, retired_slot 8..16, lifecycle 16, then the two prices.
  rawOracleTargetPrice: 17,
  effectivePrice: 25,
  slotLast: 41,
  kfEpochLong: 145,
  kfEpochShort: 153,
  oiEffLong: 289,
  oiEffShort: 305,
  storedPosLong: 321,
  storedPosShort: 329,
  staleLong: 337,
  staleShort: 345,
  pendingOblLong: 353,
  pendingOblShort: 361,
  lossWeightSumLong: 369,
  lossWeightSumShort: 385,
  modeLong: 513,
  modeShort: 514,
} as const;

const HEADER_V21 = {
  maxMarketSlots: 34,
  maxAccrualDtSlots: 150,
  insurance: 301,
  sourceInsuranceReservedTotal: 445,
  currentSlot: 613,
  lossStaleActive: 623,
} as const;

/** v2.1 engine slot after the 515-byte asset state. */
const SLOT_V21 = {
  insBudgetLong: 515,
  insBudgetShort: 531,
  insSpentLong: 547,
  insSpentShort: 563,
  barrierLong: 579,
  barrierShort: 587,
  insReservationLong: 1157,
  insReservationShort: 1229,
} as const;

export const MARKET_LAYOUTS: ReadonlyArray<MarketLayout> = [
  {
    id: "v2.1-legacy",
    provisional: false,
    source: "deployed devnet wrapper 7c906e45 / engine 35ddd692 (live account bytes)",
    wrapperVersion: 18,
    groupOff: 592,
    headerLen: 758,
    wrapperLen: 1024,
    engineSlotLen: 1301,
    slotStride: 2325,
    portfolioAccountLen: 9563,
    portfolioLegLen: 152,
    v21Decoders: true,
    header: HEADER_V21,
    asset: ASSET_V21,
    slot: { ...SLOT_V21, driftLong: null, driftShort: null },
  },
  {
    id: "v2.1-drift",
    provisional: false,
    source: "engine 3b02ff24..89403177 (#277) / wrapper eae0cce7 (#528)",
    wrapperVersion: 18,
    groupOff: 592,
    headerLen: 758,
    wrapperLen: 1024,
    engineSlotLen: 1461,
    slotStride: 2485,
    portfolioAccountLen: 9563,
    portfolioLegLen: 152,
    v21Decoders: true,
    header: HEADER_V21,
    asset: ASSET_V21,
    slot: { ...SLOT_V21, driftLong: 1301, driftShort: 1381 },
  },
  {
    id: "v2.2-drift",
    provisional: true,
    source: "offset_of! probe of engine release/v22-engine @ ee05b125 (Wave B #279 + funding-scale #277); wrapper lens from feat/v22-wave-b",
    // Wave B bumps VERSION 18 -> 19 (feat/v22-wave-b). The ledger notes another wave may take 20:
    // a v2.2 market with a different VERSION is "unknown" (loud) until this row is updated.
    wrapperVersion: 19,
    groupOff: 592,
    headerLen: 806,
    wrapperLen: 1024,
    engineSlotLen: 1573,
    slotStride: 2597,
    portfolioAccountLen: 10091,
    portfolioLegLen: 185,
    v21Decoders: false,
    // V16ConfigAccount +48 B (band_bps .. band_min_leg_notional): everything after the config moves.
    header: {
      maxMarketSlots: 34,
      maxAccrualDtSlots: 150,
      insurance: 349,
      sourceInsuranceReservedTotal: 493,
      currentSlot: 661,
      lossStaleActive: 671,
    },
    // AssetStateV16 +112 B (8 band u64 + 3 rent u128) appended after mode_short: prefix unchanged.
    asset: ASSET_V21,
    slot: {
      insBudgetLong: 627,
      insBudgetShort: 643,
      insSpentLong: 659,
      insSpentShort: 675,
      barrierLong: 691,
      barrierShort: 699,
      insReservationLong: 1269,
      insReservationShort: 1341,
      driftLong: 1413,
      driftShort: 1493,
    },
  },
  v22VariantBRow(LAYOUT_V22),
];


/**
 * The variant-B row, derived from the SDK's LAYOUT_V22 table so the geometry has ONE source. Only the drift-tail
 * offsets (the #277 funding tail sits at the END of the engine slot, before #282 (32 B) and #287 (32 B) tails, so they equal
 * stage A's) and the header words the SDK table does not carry (`max_accrual_dt_slots`, `loss_stale_active`)
 * are keeper-side; they are unchanged from stage A (a header +48 B config growth moves neither relative to
 * the group base, because the config sits BEFORE them and the SDK `group.insurance` already includes it).
 */
export function v22VariantBRow(t: LayoutTable): MarketLayout {
  return {
    id: "v2.2-b",
    provisional: t.status === "PROVISIONAL",
    source: `SDK LAYOUT_V22 "${t.name}": ${t.source}`,
    wrapperVersion: t.version,
    groupOff: t.marketGroupOff,
    headerLen: t.marketGroupLen,
    wrapperLen: t.wrapperSlotLen,
    engineSlotLen: t.engineSlotLen,
    slotStride: t.assetSlotStride,
    portfolioAccountLen: t.portfolio.accountLen,
    portfolioLegLen: t.portfolio.legStride,
    v21Decoders: false,
    header: {
      maxMarketSlots: 34,
      maxAccrualDtSlots: 150,
      insurance: t.group.insurance,
      sourceInsuranceReservedTotal: t.group.sourceInsuranceCreditReservedTotalAtoms,
      currentSlot: t.group.currentSlot,
      lossStaleActive: 671,
    },
    asset: ASSET_V21,
    slot: {
      insBudgetLong: t.engineSlot.insuranceDomainBudgetLong,
      insBudgetShort: t.engineSlot.insuranceDomainBudgetShort,
      insSpentLong: t.engineSlot.insuranceDomainSpentLong,
      insSpentShort: t.engineSlot.insuranceDomainSpentShort,
      barrierLong: 691,
      barrierShort: 699,
      insReservationLong: t.engineSlot.insuranceReservationLong,
      insReservationShort: t.engineSlot.insuranceReservationShort,
      driftLong: 1413,
      driftShort: 1493,
    },
  };
}

/**
 * True when the keeper row and the SDK table of the row's VERSION agree on the geometry both carry
 * (group offset, header length, wrapper-slot length; the whole stride / portfolio / leg for the variant-B row).
 * A disagreement means the SDK pin moved under the keeper: the row is refused, loudly.
 */
export function rowAgreesWithSdk(l: MarketLayout, sdk: ReadonlyMap<number, LayoutTable> = LAYOUTS_BY_VERSION): string | null {
  const t = sdk.get(l.wrapperVersion);
  if (!t) return `SDK has no layout for VERSION ${l.wrapperVersion}`;
  const diffs: string[] = [];
  const cmp = (name: string, a: number, b: number) => {
    if (a !== b) diffs.push(`${name} keeper ${a} != SDK ${b}`);
  };
  cmp("groupOff", l.groupOff, t.marketGroupOff);
  cmp("headerLen", l.headerLen, t.marketGroupLen);
  cmp("wrapperLen", l.wrapperLen, t.wrapperSlotLen);
  if (l.id === "v2.2-b") {
    cmp("slotStride", l.slotStride, t.assetSlotStride);
    cmp("portfolioAccountLen", l.portfolioAccountLen, t.portfolio.accountLen);
    cmp("portfolioLegLen", l.portfolioLegLen, t.portfolio.legStride);
  }
  return diffs.length === 0 ? null : diffs.join("; ");
}

/**
 * Portfolio account lengths the pinned SDK parser decodes (VERSION 18 = 9,563 B, VERSION 19 = 10,603 B).
 * A portfolio of any other length is not read: the keeper never hand-rolls leg offsets.
 */
export const SDK_PORTFOLIO_LENS: ReadonlySet<number> = new Set([...LAYOUTS_BY_VERSION.values()].map((t) => t.portfolio.accountLen));

export function layoutById(id: MarketLayoutId): MarketLayout {
  const l = MARKET_LAYOUTS.find((x) => x.id === id);
  if (!l) throw new Error(`no market layout "${id}"`);
  return l;
}

/** Absolute offset of the first asset slot. */
export function assetSlotsOff(l: MarketLayout): number {
  return l.groupOff + l.headerLen;
}

/** Absolute offset of the engine slot of `assetIndex`. */
export function engineSlotBase(l: MarketLayout, assetIndex = 0): number {
  return assetSlotsOff(l) + assetIndex * l.slotStride + l.wrapperLen;
}

/** Account length of a market with `slots` asset slots. */
export function marketAccountLen(l: MarketLayout, slots: number): number {
  return assetSlotsOff(l) + slots * l.slotStride;
}

/** Wrapper account header: VERSION u16 LE at byte 8 (after the 8-byte magic). */
export const ABS_WRAPPER_VERSION = 8;

/** `max_market_slots` sits at the same absolute offset in every known layout (asserted by a test). */
export const ABS_MAX_MARKET_SLOTS = MARKET_LAYOUTS[0].groupOff + MARKET_LAYOUTS[0].header.maxMarketSlots;

export type LayoutDetection =
  | { known: true; layout: MarketLayout; slots: number }
  | { known: false; accountLen: number; slots: number | null; version: number | null; reason: string };

/** The strides the keeper knows, for the error message of an unknown layout. */
export function knownStrides(): string {
  return MARKET_LAYOUTS.map((l) => `${l.id}=v${l.wrapperVersion}:${assetSlotsOff(l)}+n*${l.slotStride}`).join(", ");
}

/**
 * Detect the layout of a market account. Exactly one row must match BOTH the
 * header VERSION and `len == groupOff + headerLen + max_market_slots * slotStride`;
 * otherwise the result is `known: false` with the reason. Never a guess.
 */
export function detectLayout(data: Uint8Array, sdkRegistry: ReadonlyMap<number, LayoutTable> = LAYOUTS_BY_VERSION): LayoutDetection {
  if (data.length < ABS_MAX_MARKET_SLOTS + 4) {
    return { known: false, accountLen: data.length, slots: null, version: null, reason: `length ${data.length}: account too short for a market group header` };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint16(ABS_WRAPPER_VERSION, true);
  const n = view.getUint32(ABS_MAX_MARKET_SLOTS, true);
  if (n === 0) {
    return { known: false, accountLen: data.length, slots: 0, version, reason: `length ${data.length}: max_market_slots is 0` };
  }
  // The SDK's VERSION registry (LAYOUTS_BY_VERSION) decides BEFORE any row is tried: a VERSION the pinned SDK has no
  // table for is refused (UNKNOWN_VERSION). The magic / kind check is NOT applied here (this function has always
  // read synthetic and real accounts by header VERSION alone); the v2.2 loader (v22/market.ts) runs the SDK's full
  // guard, `resolveLayout` with kind = Market, on every account it decodes.
  const guardCode: string | null = sdkRegistry.has(version) ? null : "UNKNOWN_VERSION";
  const matches = MARKET_LAYOUTS.filter((l) => l.wrapperVersion === version && data.length === marketAccountLen(l, n));
  if (guardCode === null && matches.length === 1) {
    const disagree = rowAgreesWithSdk(matches[0], sdkRegistry);
    if (disagree === null) return { known: true, layout: matches[0], slots: n };
    noteLayoutGuardRefusal("ROW_DISAGREES_WITH_SDK", version);
    return {
      known: false,
      accountLen: data.length,
      slots: n,
      version,
      reason: `layout row ${matches[0].id} disagrees with the pinned SDK table for VERSION ${version} (${disagree}); refusing to decode`,
    };
  }
  if (guardCode !== null) noteLayoutGuardRefusal(guardCode, version);
  else noteLayoutGuardRefusal(matches.length === 0 ? "NO_ROW_FOR_LENGTH" : "AMBIGUOUS_ROW", version);
  return {
    known: false,
    accountLen: data.length,
    slots: n,
    version,
    reason:
      matches.length === 0
        ? `length ${data.length} with VERSION ${version}, max_market_slots=${n} matches no known layout (${knownStrides()})${guardCode ? ` [sdk-guard: ${guardCode}]` : ""}`
        : `length ${data.length} with VERSION ${version} is ambiguous between ${matches.map((m) => m.id).join(" / ")}`,
  };
}

/** One-line description of an unknown layout for logs / alerts. */
export function describeUnknownLayout(d: Extract<LayoutDetection, { known: false }>): string {
  return `unknown market layout: ${d.reason}`;
}
