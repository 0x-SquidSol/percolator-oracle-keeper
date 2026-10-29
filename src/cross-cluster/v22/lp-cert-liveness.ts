/**
 * cross-cluster/v22/lp-cert-liveness.ts
 *
 * Vault-LP crank liveness for v2.2 BAND markets (sim 2026-10-19 §P2.10, `sdlag` / `nosdlag`): a keeper that stops
 * cranking a band market's vault LP for more than ~E + Pmax slots (~9,600 at E = 600, Pmax = 9,000, about 1 h)
 * resolves the market even in calm conditions and with no loss. This module pages well before that.
 *
 * WHY IT RESOLVES (engine 1c96c22f, the engine path-dep of wrapper 6kpg2wi7 `feat/v22-rc-2026-10-20` 75fca911 and
 * `fix/v22-combined-ports-2026-10-15`; read-only):
 *   - A leg is CERTIFIED in band epoch e when a fresh health statement finds it healthy: `band_epoch_snap := e`
 *     (`kernel_band_certify_leg`, src/v16.rs:1580-1610). It is uncertified in epoch e iff `band_epoch_snap < e`
 *     (`PortfolioLegV16::band_epoch_snap` doc, src/v16.rs:6391-6393).
 *   - The anchor may advance only when EVERY positioned leg is certified this epoch (`kernel_band_reanchor_ready`,
 *     src/v16.rs:1627-1638). The advance stamps `band_anchor_slot` = the accrual's window start and makes every leg
 *     uncertified again (`kernel_band_reanchor`, src/v16.rs:1645-1666).
 *   - An accrual whose target differs from P_last and whose segment ends more than `band_max_epoch_slots` (E) after the
 *     anchor is a DURATION PIN (`band_duration_pinned`, src/band_rent.rs:174-176); `band_finish_accrual` stamps
 *     `band_pin_since_slot` (src/v16.rs:17005-17037). An edge pin stamps it earlier.
 *   - At crank entry, by ANYONE's crank, a pin older than `band_max_pin_slots` (Pmax) makes the Live market recovery
 *     eligible (`band_pin_expired_at`, src/v16.rs:17691-17710, called at src/v16.rs:17840): BandPinExpired resolves it.
 *
 * So while the vault LP's leg is uncertified in the current epoch, the anchor is stuck at `band_anchor_slot` and the
 * market resolves at about `band_anchor_slot + E + Pmax` (sooner if an edge pin started earlier) unless the LP is
 * certified first. That is read ON-CHAIN (the LP leg's `band_epoch_snap` vs the asset's `band_epoch`, plus
 * `band_anchor_slot`), so the alert also catches ANOTHER keeper's failure, a keeper restart, or our own crank being
 * refused, not only "our process stopped cranking".
 *
 * Horizon: `E + Pmax` from the market's config words (`band_max_epoch_slots` / `band_max_pin_slots`, set from the init
 * params at wrapper src/v16_program.rs:16625-16627 on 75fca911). Fallback only when a word reads 0 on a band market
 * (cannot happen on a valid config, the engine rejects it): the engine's validation FLOORS (`BAND_MIN_EPOCH_SLOTS` 150,
 * `BAND_MIN_PIN_EPOCHS` 8, src/band_rent.rs:83/86, enforced at src/v16.rs:5315-5318), i.e. the shortest horizon any band
 * market can have, so the fallback pages early rather than late.
 *
 * Thresholds (fractions of the horizon; boot-safe: garbage logs one error and keeps the default, never crashes):
 *   ALERT_VAULT_LP_CRANK_WARN_PCT      WARN at this % of the horizon (default 25 -> ~2,400 of 9,600 slots)
 *   ALERT_VAULT_LP_CRANK_CRITICAL_PCT  CRITICAL at this % (default 50 -> ~4,800 slots; Telegram pages criticals)
 *
 * Pure decode + pure evaluation; the V22Loop feeds it once per tick and reconciles the alert set through the shared
 * AlertSink (fires, cools down, and emits one ALERT-RESOLVED when the LP is certified again).
 */
import { parsePortfolioV17 } from "@percolatorct/sdk";
import type { Alert, AlertSeverity } from "../alerting.ts";
import { engineSlotBase } from "../market-layout.ts";
import type { MarketLayout } from "../market-layout.ts";
import { V22_ASSET_BAND_OFF, V22_CONFIG_OFF } from "./market.ts";

/** Engine `BAND_MIN_EPOCH_SLOTS` (1c96c22f src/band_rent.rs:83). Fallback E only. */
export const FALLBACK_BAND_MAX_EPOCH_SLOTS = 150n;
/** Engine `BAND_MIN_PIN_EPOCHS` (1c96c22f src/band_rent.rs:86): Pmax >= 8 E. Fallback Pmax = 8 E only. */
export const FALLBACK_BAND_MIN_PIN_EPOCHS = 8n;

const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;

export interface LpCertThresholds {
  /** WARN once this percentage of the resolve horizon has elapsed with the LP uncertified. */
  warnPct: number;
  /** CRITICAL once this percentage has elapsed. */
  criticalPct: number;
}

export const DEFAULT_LP_CERT_THRESHOLDS: LpCertThresholds = { warnPct: 25, criticalPct: 50 };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Thresholds from env. Boot-safe: an invalid value (not an integer in 1..99, or warn > critical) logs ONE error and the
 * default is used, so a typo can neither crash the live keeper nor silently disable the alert.
 */
export function lpCertThresholdsFromEnv(env: Env, logError: (l: string) => void = (l) => console.error(l)): LpCertThresholds {
  const pct = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      logError(`[v22][lp-cert] ${name}="${raw}" must be an integer percentage in 1..99; using the default ${fallback}`);
      return fallback;
    }
    return n;
  };
  const t = {
    warnPct: pct("ALERT_VAULT_LP_CRANK_WARN_PCT", DEFAULT_LP_CERT_THRESHOLDS.warnPct),
    criticalPct: pct("ALERT_VAULT_LP_CRANK_CRITICAL_PCT", DEFAULT_LP_CERT_THRESHOLDS.criticalPct),
  };
  if (t.warnPct > t.criticalPct) {
    logError(`[v22][lp-cert] ALERT_VAULT_LP_CRANK_WARN_PCT (${t.warnPct}) > ALERT_VAULT_LP_CRANK_CRITICAL_PCT (${t.criticalPct}); using the defaults`);
    return { ...DEFAULT_LP_CERT_THRESHOLDS };
  }
  return t;
}

/** The on-chain words for one band asset + the vault LP's leg on it. */
export interface LpCertAsset {
  assetIndex: number;
  lifecycle: number;
  /** `band_epoch` (0 = the band is not running on this asset). */
  epoch: bigint;
  /** `band_anchor_slot`: the slot the current epoch's window opened. */
  anchorSlot: bigint;
  /** `band_pin_since_slot` (0 = not pinned). */
  pinSinceSlot: bigint;
  /** config `band_max_epoch_slots` (E). */
  maxEpochSlots: bigint;
  /** config `band_max_pin_slots` (Pmax). */
  maxPinSlots: bigint;
  /** Smallest `band_epoch_snap` of the LP's active legs on this asset; null = the LP holds no leg here (not counted). */
  lpLegEpochSnap: bigint | null;
}

export interface LpCertStaleness {
  assetIndex: number;
  /** The LP's leg is certified in the current epoch. */
  certified: boolean;
  /** Slots the LP has been uncertified in the current epoch (now - band_anchor_slot); 0 when certified. */
  staleSlots: bigint;
  /** Slots from band_anchor_slot to the BandPinExpired deadline (E + Pmax, less if an edge pin started earlier). */
  horizonSlots: bigint;
  /** Slot at which the market becomes recovery-eligible if the LP stays uncertified (and the target moves). */
  deadlineSlot: bigint;
  remainingSlots: bigint;
  horizonSource: "on-chain" | "fallback-engine-floor";
}

/** Pure: how long the LP has been uncertified on one asset, against its resolve horizon. null = not applicable. */
export function lpCertStalenessOf(a: LpCertAsset, nowSlot: bigint): LpCertStaleness | null {
  if (a.lifecycle !== LIFECYCLE_ACTIVE && a.lifecycle !== LIFECYCLE_DRAIN_ONLY) return null;
  if (a.epoch === 0n || a.lpLegEpochSnap === null) return null;
  const onChain = a.maxEpochSlots > 0n && a.maxPinSlots > 0n;
  const e = a.maxEpochSlots > 0n ? a.maxEpochSlots : FALLBACK_BAND_MAX_EPOCH_SLOTS;
  const pmax = a.maxPinSlots > 0n ? a.maxPinSlots : e * FALLBACK_BAND_MIN_PIN_EPOCHS;
  const durationPinAt = a.anchorSlot + e;
  const pinStart = a.pinSinceSlot !== 0n && a.pinSinceSlot < durationPinAt ? a.pinSinceSlot : durationPinAt;
  const deadlineSlot = pinStart + pmax;
  const horizonSlots = deadlineSlot > a.anchorSlot ? deadlineSlot - a.anchorSlot : 1n;
  const certified = a.lpLegEpochSnap >= a.epoch;
  const staleSlots = certified ? 0n : nowSlot > a.anchorSlot ? nowSlot - a.anchorSlot : 0n;
  return {
    assetIndex: a.assetIndex,
    certified,
    staleSlots,
    horizonSlots,
    deadlineSlot,
    remainingSlots: deadlineSlot > nowSlot ? deadlineSlot - nowSlot : 0n,
    horizonSource: onChain ? "on-chain" : "fallback-engine-floor",
  };
}

const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

/**
 * Decode the band words of `assetIndices` from a variant-B market and the LP leg epochs from the LP portfolio bytes.
 * Assets outside the account are skipped. Throws only when the LP portfolio does not decode (the caller keeps the last
 * known state rather than clearing a live alert on a bad read).
 */
export function readLpCertAssets(
  marketData: Uint8Array,
  layout: MarketLayout,
  assetIndices: ReadonlyArray<number>,
  lpPortfolioData: Uint8Array,
): LpCertAsset[] {
  const pf = parsePortfolioV17(lpPortfolioData);
  const g = layout.groupOff;
  const maxEpochSlots = u64(marketData, g + V22_CONFIG_OFF.bandMaxEpochSlots);
  const maxPinSlots = u64(marketData, g + V22_CONFIG_OFF.bandMaxPinSlots);
  const out: LpCertAsset[] = [];
  for (const assetIndex of assetIndices) {
    const e = engineSlotBase(layout, assetIndex);
    if (e + V22_ASSET_BAND_OFF.pinSinceSlot + 8 > marketData.length) continue;
    let snap: bigint | null = null;
    for (const leg of pf.legs) {
      if (!leg.active || leg.assetIndex !== assetIndex) continue;
      if (leg.bandEpochSnap === undefined) throw new Error("vault LP portfolio legs carry no band_epoch_snap (not a v2.2 layout)");
      snap = snap === null || leg.bandEpochSnap < snap ? leg.bandEpochSnap : snap;
    }
    out.push({
      assetIndex,
      lifecycle: marketData[e + layout.asset.lifecycle],
      epoch: u64(marketData, e + V22_ASSET_BAND_OFF.epoch),
      anchorSlot: u64(marketData, e + V22_ASSET_BAND_OFF.anchorSlot),
      pinSinceSlot: u64(marketData, e + V22_ASSET_BAND_OFF.pinSinceSlot),
      maxEpochSlots,
      maxPinSlots,
      lpLegEpochSnap: snap,
    });
  }
  return out;
}

/** One market's sample for the evaluator. */
export interface VaultLpCertSample {
  label: string;
  market: string;
  /** Not Live (resolved / closed / recovery): never alerted. */
  terminal: boolean;
  /** Read slot the staleness is relative to. */
  nowSlot: bigint;
  assets: ReadonlyArray<LpCertStaleness>;
}

export type LpCertLevel = "ok" | "warn" | "critical";

/** Level of one asset's staleness. Integer math: stale * 100 >= horizon * pct. */
export function lpCertLevelOf(s: LpCertStaleness, t: LpCertThresholds): LpCertLevel {
  if (s.certified || s.staleSlots === 0n) return "ok";
  const used = s.staleSlots * 100n;
  if (used >= s.horizonSlots * BigInt(t.criticalPct)) return "critical";
  if (used >= s.horizonSlots * BigInt(t.warnPct)) return "warn";
  return "ok";
}

/**
 * The vault-LP crank liveness alert for one band market: at most ONE alert (the asset closest to its deadline), WARN at
 * `warnPct` of the horizon, CRITICAL at `criticalPct`. Empty when every LP leg is certified (or nothing applies). Pure.
 */
export function evaluateVaultLpCrankStaleness(s: VaultLpCertSample, t: LpCertThresholds): Alert[] {
  if (s.terminal) return [];
  let worst: { a: LpCertStaleness; level: Exclude<LpCertLevel, "ok"> } | null = null;
  for (const a of s.assets) {
    const level = lpCertLevelOf(a, t);
    if (level === "ok") continue;
    // closest to its deadline first (fewest remaining slots); critical beats warn
    if (
      worst === null ||
      (level === "critical" && worst.level === "warn") ||
      (level === worst.level && a.remainingSlots < worst.a.remainingSlots)
    ) {
      worst = { a, level };
    }
  }
  if (worst === null) return [];
  const a = worst.a;
  const severity: AlertSeverity = worst.level;
  const pctUsed = Number((a.staleSlots * 100n) / a.horizonSlots);
  return [
    {
      kind: "vault-lp-crank-stale",
      severity,
      subject: s.label,
      message:
        `vault LP not certified on asset ${a.assetIndex} for ${a.staleSlots} slots (${pctUsed}% of the ${a.horizonSlots}-slot ` +
        `resolve horizon E + Pmax${a.horizonSource === "on-chain" ? "" : ", engine-floor fallback"}): the band anchor cannot advance, ` +
        `and the market becomes BandPinExpired-resolvable at ~slot ${a.deadlineSlot} (${a.remainingSlots} slots left) once the target moves. ` +
        "Crank the vault LP (a paired settle round) so its leg is certified this epoch.",
      data: {
        market: s.market,
        assetIndex: a.assetIndex,
        staleSlots: a.staleSlots.toString(),
        horizonSlots: a.horizonSlots.toString(),
        deadlineSlot: a.deadlineSlot.toString(),
        remainingSlots: a.remainingSlots.toString(),
        nowSlot: s.nowSlot.toString(),
        horizonSource: a.horizonSource,
      },
    },
  ];
}

/** Scope the V22Loop reconciles this alert under (one active set per tick across every band market). */
export const LP_CERT_ALERT_SCOPE = "v22-vault-lp-cert";
