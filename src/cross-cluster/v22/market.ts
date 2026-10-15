/**
 * cross-cluster/v22/market.ts
 *
 * Reads one v2.2 market into a typed context for the v2.2 crankers: layout (VERSION-keyed, variant B only),
 * header / asset state, the LP-vault registry flags (bound / ext / BOND), the bound vault LP, the asset's oracle
 * profile, and the band / rent state.
 *
 * Offsets that are NOT in the SDK table and are derived here (source: engine release/v22-engine
 * src/v16.rs struct order, every field a byte-aligned Pod, `V16ConfigAccount` 7786-7829 and
 * `AssetStateV16Account` ~8120-8165). They are NOT verified against live v2.2 bytes (none exist yet):
 *   config band / rent words   header-relative 281..329:  band_bps 281, band_max_epoch_slots 289,
 *                              band_max_pin_slots 297, rent_max_e9_per_slot 305, band_max_positions_per_side 313,
 *                              band_min_leg_notional 321   (the config ends where asset_slot_capacity @329 begins)
 *   asset band / rent words    engine-slot-relative (asset state = first field, 627 B):
 *                              band_anchor_price 515, band_anchor_slot 523, band_epoch 531,
 *                              band_uncertified_long 539 / short 547, band_liq_pending_long 555 / short 563,
 *                              band_pin_since_slot 571, rent_index_long 579 (u128), rent_index_short 595, rent_unrouted 611
 *   registry bond flag         `_reserved[2]` = struct byte 146 -> absolute 16 + 146 (bound 144, ext 145; Wave C review)
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { ACCOUNT_KIND, UnknownLayoutError, deriveLpVaultRegistry, parseAssetOracleProfileV17, parseLpVaultRegistry, resolveLayout } from "@percolatorct/sdk";
import { noteLayoutGuardRefusal } from "../layout-guard-metrics.ts";
import type { MarketV22 } from "@percolatorct/sdk";
import { assetSlotsOff, detectLayout, engineSlotBase, describeUnknownLayout } from "../market-layout.ts";
import type { MarketLayout } from "../market-layout.ts";
import { refreshStateForMarket } from "../multi-asset.ts";
import type { MarketRefreshState } from "../positioned-refresh.ts";
import { decodeVaultLpState, deriveVaultLpState } from "../resolved-portfolio-cleanup.ts";
import { lpVaultRegistryBound, lpVaultRegistryExtFlag } from "../registry-flags.ts";

export const REGISTRY_BOND_FLAG_OFF = 16 + 146;
export function lpVaultRegistryBondFlag(data: Uint8Array): boolean {
  return data.length > REGISTRY_BOND_FLAG_OFF && data[REGISTRY_BOND_FLAG_OFF] === 1;
}

export const V22_CONFIG_OFF = { bandBps: 281, bandMaxEpochSlots: 289, bandMaxPinSlots: 297, rentMaxE9PerSlot: 305, bandMaxPositionsPerSide: 313, bandMinLegNotional: 321 } as const;
export const V22_ASSET_BAND_OFF = { anchorPrice: 515, anchorSlot: 523, epoch: 531, uncertifiedLong: 539, uncertifiedShort: 547, liqPendingLong: 555, liqPendingShort: 563, pinSinceSlot: 571, rentIndexLong: 579, rentIndexShort: 595, rentUnrouted: 611 } as const;

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);

export interface BandState {
  /** band_bps (0 = not a band market). */
  bandBps: bigint;
  maxEpochSlots: bigint;
  maxPinSlots: bigint;
  /** rent_max_e9_per_slot (0 = not a rent market). */
  rentMaxE9PerSlot: bigint;
  maxPositionsPerSide: bigint;
  /** 0 = not pinned; else the slot the duration/edge pin began. */
  pinSinceSlot: bigint;
  epoch: bigint;
  uncertifiedLong: bigint;
  uncertifiedShort: bigint;
  liqPendingLong: bigint;
  liqPendingShort: bigint;
}

export interface V22MarketCtx {
  marketAddress: string;
  label: string;
  market: PublicKey;
  programId: PublicKey;
  data: Uint8Array;
  /** The slot of the read (RPC context slot). */
  readSlot: number;
  layout: MarketLayout;
  slots: number;
  refresh: MarketRefreshState;
  band: BandState;
  isBand: boolean;
  isRent: boolean;
  /** `currentSlot - pinSinceSlot` while pinned, else 0 (slots; read-slot based). */
  pinDurationSlots: bigint;
  registryData: Uint8Array | null;
  registryDomain: number;
  bound: boolean;
  ext: boolean;
  bond: boolean;
  lpPortfolio: PublicKey | null;
  vaultLpState: PublicKey;
  /** `senior_draw_outstanding_atoms` of the vault_lp_state (0 when unreadable): > 0 means a senior draw is pending. */
  seniorDrawOutstandingAtoms: bigint;
  oracleMode: number;
  oracleLegCount: number;
  oracleLegFeeds: PublicKey[];
  /** The SDK's MarketV22 view for the builders (lpPortfolio set when known). */
  sdk: MarketV22;
}

export type V22MarketLoad =
  | { ok: true; ctx: V22MarketCtx }
  | { ok: false; reason: "not-v22" | "layout-unknown" | "layout-unsupported" | "unreadable"; detail: string };

export function readBand(data: Uint8Array, layout: MarketLayout, assetIndex = 0, currentSlot = 0n): BandState {
  const g = layout.groupOff;
  const e = engineSlotBase(layout, assetIndex);
  const pin = u64(data, e + V22_ASSET_BAND_OFF.pinSinceSlot);
  void currentSlot;
  return {
    bandBps: u64(data, g + V22_CONFIG_OFF.bandBps),
    maxEpochSlots: u64(data, g + V22_CONFIG_OFF.bandMaxEpochSlots),
    maxPinSlots: u64(data, g + V22_CONFIG_OFF.bandMaxPinSlots),
    rentMaxE9PerSlot: u64(data, g + V22_CONFIG_OFF.rentMaxE9PerSlot),
    maxPositionsPerSide: u64(data, g + V22_CONFIG_OFF.bandMaxPositionsPerSide),
    pinSinceSlot: pin,
    epoch: u64(data, e + V22_ASSET_BAND_OFF.epoch),
    uncertifiedLong: u64(data, e + V22_ASSET_BAND_OFF.uncertifiedLong),
    uncertifiedShort: u64(data, e + V22_ASSET_BAND_OFF.uncertifiedShort),
    liqPendingLong: u64(data, e + V22_ASSET_BAND_OFF.liqPendingLong),
    liqPendingShort: u64(data, e + V22_ASSET_BAND_OFF.liqPendingShort),
  };
}

/** Build a context from account bytes already read (pure; tests use it). */
export function buildV22MarketCtx(p: {
  marketAddress: string;
  label: string;
  programId: PublicKey;
  data: Uint8Array;
  readSlot: number;
  registryData: Uint8Array | null;
  vaultLpStateData: Uint8Array | null;
  lpHint?: PublicKey | null;
}): V22MarketLoad {
  // The SDK's full guard (magic, kind = Market, VERSION): every v2.2 account is decoded through it.
  try {
    resolveLayout(p.data, { parser: "keeper.v22.market", kind: ACCOUNT_KIND.Market });
  } catch (e) {
    if (e instanceof UnknownLayoutError && (e.code === "BAD_MAGIC" || e.code === "WRONG_KIND")) {
      noteLayoutGuardRefusal(e.code, e.version ?? null);
      return { ok: false, reason: "layout-unknown", detail: e.message };
    }
    // UNKNOWN_VERSION / TOO_SHORT fall through to detectLayout, which reports (and counts) them with its own reason.
  }
  const det = detectLayout(p.data);
  if (!det.known) return { ok: false, reason: "layout-unknown", detail: describeUnknownLayout(det) };
  const layout = det.layout;
  if (layout.id !== "v2.2-b") {
    return {
      ok: false,
      reason: layout.id === "v2.2-drift" ? "layout-unsupported" : "not-v22",
      detail: layout.id === "v2.2-drift" ? "stage-A v2.2 layout (10,091 B portfolios): the SDK parser reads variant B only" : `layout ${layout.id}`,
    };
  }
  let refresh: MarketRefreshState;
  try {
    // K-6: over every observed asset of a multi-asset registry market (exactly asset 0 otherwise).
    refresh = refreshStateForMarket(p.data, p.marketAddress);
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  const market = new PublicKey(p.marketAddress);
  const band = readBand(p.data, layout);
  const currentSlot = refresh.currentSlot;
  let registryDomain = 0;
  let bound = false;
  let ext = false;
  let bond = false;
  if (p.registryData) {
    try {
      registryDomain = Number(parseLpVaultRegistry(p.registryData).domain);
    } catch {
      // domain stays 0; the flags below are read from their own bytes
    }
    try {
      bound = lpVaultRegistryBound(p.registryData);
    } catch {
      bound = false; // an invalid bound byte reads as unbound: the jobs that need the vault skip
    }
    ext = lpVaultRegistryExtFlag(p.registryData);
    bond = lpVaultRegistryBondFlag(p.registryData);
  }
  const vaultLpState = deriveVaultLpState(p.programId, market);
  const st = p.vaultLpStateData ? decodeVaultLpState(p.vaultLpStateData) : null;
  const lpPortfolio = st ? st.lpPortfolio : p.lpHint ?? null;
  const slotOff = assetSlotsOff(layout);
  const profile = parseAssetOracleProfileV17(p.data, slotOff);
  const pinned = band.pinSinceSlot !== 0n && currentSlot > band.pinSinceSlot;
  const ctx: V22MarketCtx = {
    marketAddress: p.marketAddress,
    label: p.label,
    market,
    programId: p.programId,
    data: p.data,
    readSlot: p.readSlot,
    layout,
    slots: det.slots,
    refresh,
    band,
    isBand: band.bandBps !== 0n,
    isRent: band.rentMaxE9PerSlot !== 0n,
    pinDurationSlots: pinned ? currentSlot - band.pinSinceSlot : 0n,
    registryData: p.registryData,
    registryDomain,
    bound,
    ext,
    bond,
    lpPortfolio,
    vaultLpState,
    seniorDrawOutstandingAtoms: st ? st.seniorDrawOutstandingAtoms : 0n,
    oracleMode: profile.oracleMode,
    oracleLegCount: profile.oracleLegCount,
    oracleLegFeeds: profile.oracleLegFeeds.slice(0, profile.oracleLegCount),
    sdk: { programId: p.programId, market, registryDomain, ...(lpPortfolio ? { lpPortfolio } : {}) },
  };
  return { ok: true, ctx };
}

/** The oracle leg accounts an observation crank must carry on this market ([] for AUTH_MARK; the legs for Hybrid). */
export function crankOracleAccounts(ctx: Pick<V22MarketCtx, "oracleMode" | "oracleLegFeeds">): PublicKey[] {
  return ctx.oracleMode === 1 ? [...ctx.oracleLegFeeds] : [];
}

/** One read of market + registry + vault_lp_state, then {@link buildV22MarketCtx}. Never throws. */
export async function loadV22Market(
  conn: Pick<Connection, "getMultipleAccountsInfoAndContext">,
  entry: { marketAddress: string; label: string; lpPortfolio?: string },
  programId: PublicKey,
): Promise<V22MarketLoad> {
  try {
    const market = new PublicKey(entry.marketAddress);
    const [registry] = deriveLpVaultRegistry(programId, market);
    const res = await conn.getMultipleAccountsInfoAndContext([market, registry, deriveVaultLpState(programId, market)], "processed");
    const [m, r, s] = res.value;
    if (!m) return { ok: false, reason: "unreadable", detail: "market account not found" };
    let lpHint: PublicKey | null = null;
    try {
      lpHint = entry.lpPortfolio ? new PublicKey(entry.lpPortfolio) : null;
    } catch {
      lpHint = null;
    }
    return buildV22MarketCtx({
      marketAddress: entry.marketAddress,
      label: entry.label,
      programId,
      data: new Uint8Array(m.data),
      readSlot: res.context.slot,
      registryData: r ? new Uint8Array(r.data) : null,
      vaultLpStateData: s ? new Uint8Array(s.data) : null,
      lpHint,
    });
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
}
