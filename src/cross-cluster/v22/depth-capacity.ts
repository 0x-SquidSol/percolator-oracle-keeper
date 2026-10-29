/**
 * cross-cluster/v22/depth-capacity.ts
 *
 * #174: a clamp-enforced growth asset whose depth reading stopped is closed to every OPEN once its sticky cap decays to zero
 * (`growth_v19::cap_depth_e6`: no fresh reading but DEPTH_EVER -> `last_good >> k`, k = floor((now - last_good_slot) / 9,000), 0 once
 * the shift clears the value, NEVER uncapped). The decay is documented fail-closed behaviour and is NOT changed here. What was missing
 * was anyone noticing: four funded Live markets were closed for ~5.5 days with nothing in /health or the alerts.
 *
 * This is the keeper's read-only watch. It reads only the market bytes the v2.2 loop already read (no RPC, nothing sent), decodes each
 * asset's growth record, derives the cap depth the program uses (`growthCeilingView(...).capDepthE6`) and reports:
 *   - "closed"    cap depth is 0: opens are clipped to nothing whatever the LP's capital (critical);
 *   - "decaying"  no fresh depth reading and the sticky cap is `staleWarnEpochs`+ halvings old, or within `criticalEpochs` of zero
 *                 (warn, critical once within `criticalEpochs`): the alarm lands hours BEFORE the market closes;
 *   - "ok" / "fresh" / "uncapped" (never had a depth reading: no depth cap) / "no-clamp" (not a clamp-enforced asset): no alert.
 * One halving epoch is 9,000 slots (~1 h), and the cap reaches 0 after bitlength(last_good) epochs (31 for a $1.8k reading: ~31 h,
 * not 64), which is why the time to zero is derived from the value rather than assumed.
 */
import { DEPTH_MAX_AGE_SLOTS, DEPTH_STICKY_EPOCH_SLOTS, STRESS_NONE, growthCeilingView } from "@percolatorct/sdk";
import type { AssetGrowthV19 } from "@percolatorct/sdk";
import type { Alert } from "../alerting.ts";

export type DepthCapacityStatus = "no-clamp" | "uncapped" | "fresh" | "stale" | "decaying" | "closed";

export interface DepthCapacity {
  assetIndex: number;
  status: DepthCapacityStatus;
  /** The cap depth the program uses (USD e6); null = no depth cap. */
  capDepthE6: bigint | null;
  /** Sticky halvings since the last good reading (0 while a fresh reading is in hand). */
  stickyEpochs: number;
  /** Halvings left before the sticky cap is 0 (null when not decaying). */
  epochsToZero: number | null;
  /** Slots since the last depth push (null = never pushed). */
  depthAgeSlots: bigint | null;
  /** byte 44 bits 0-1: 0 none, 1 keeper-attested, 2 on-chain DEX. */
  depthSource: number;
  depthDexPinned: boolean;
}

export interface DepthCapacityThresholds {
  /** Warn once the sticky cap has halved this many times with no fresh reading (default 2: a depth reading 2 h old). */
  staleWarnEpochs: number;
  /** Critical once the cap is within this many halvings of zero (default 6). */
  criticalEpochs: number;
}

export const DEFAULT_DEPTH_CAPACITY_THRESHOLDS: DepthCapacityThresholds = { staleWarnEpochs: 2, criticalEpochs: 6 };

type Env = Readonly<Record<string, string | undefined>>;

/** ALERT_DEPTH_STALE_WARN_EPOCHS (2), ALERT_DEPTH_ZERO_CRITICAL_EPOCHS (6). Throws on garbage so a bad value fails boot loudly. */
export function depthCapacityThresholdsFromEnv(env: Env): DepthCapacityThresholds {
  const get = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`${name}="${raw}" must be an integer in [1, 64]`);
    return n;
  };
  return {
    staleWarnEpochs: get("ALERT_DEPTH_STALE_WARN_EPOCHS", DEFAULT_DEPTH_CAPACITY_THRESHOLDS.staleWarnEpochs),
    criticalEpochs: get("ALERT_DEPTH_ZERO_CRITICAL_EPOCHS", DEFAULT_DEPTH_CAPACITY_THRESHOLDS.criticalEpochs),
  };
}

function bitLength(n: bigint): number {
  return n <= 0n ? 0 : n.toString(2).length;
}

/** The depth-capacity state of one growth asset at `nowSlot`. Pure; the SDK's own derivation of the cap depth. */
export function assessDepthCapacity(
  g: AssetGrowthV19,
  assetIndex: number,
  bandBps: number,
  nowSlot: bigint,
  t: DepthCapacityThresholds = DEFAULT_DEPTH_CAPACITY_THRESHOLDS,
): DepthCapacity {
  const view = growthCeilingView(g, bandBps, nowSlot, null, STRESS_NONE);
  const base = { assetIndex, depthSource: g.depthSource, depthDexPinned: g.depthDexPinned };
  const depthAge = g.depthSlot > 0n && nowSlot >= g.depthSlot ? nowSlot - g.depthSlot : null;
  const off = { ...base, capDepthE6: view.capDepthE6, stickyEpochs: 0, epochsToZero: null, depthAgeSlots: depthAge };
  if (!view.clampEnforced) return { ...off, status: "no-clamp", capDepthE6: null };
  if (view.capDepthE6 === null) return { ...off, status: "uncapped" };
  if (view.capDepthE6 === 0n) {
    const k = g.depthLastGoodSlot > 0n && nowSlot > g.depthLastGoodSlot ? Number((nowSlot - g.depthLastGoodSlot) / DEPTH_STICKY_EPOCH_SLOTS) : 0;
    return { ...off, status: "closed", stickyEpochs: k, epochsToZero: 0 };
  }
  const fresh = depthAge !== null && depthAge <= DEPTH_MAX_AGE_SLOTS;
  if (fresh) return { ...off, status: "fresh" };
  // No fresh reading: the cap is the sticky one and is halving every epoch.
  const k = nowSlot > g.depthLastGoodSlot ? Number((nowSlot - g.depthLastGoodSlot) / DEPTH_STICKY_EPOCH_SLOTS) : 0;
  const zeroAt = Math.min(64, bitLength(g.depthLastGoodE6));
  const epochsToZero = Math.max(0, zeroAt - k);
  const decaying = k >= t.staleWarnEpochs || epochsToZero <= t.criticalEpochs;
  return { ...off, status: decaying ? "decaying" : "stale", stickyEpochs: k, epochsToZero };
}

/** The alert for one asset, or null. `venue` (the registry DEX type) is named so the operator sees whether the keeper can attest it at all. */
export function depthCapacityAlert(
  label: string,
  market: string,
  d: DepthCapacity,
  t: DepthCapacityThresholds,
  ctx: { venue?: string | null; keeperAttestsVenue: boolean },
): Alert | null {
  if (d.status !== "closed" && d.status !== "decaying") return null;
  const closed = d.status === "closed";
  const critical = closed || (d.epochsToZero !== null && d.epochsToZero <= t.criticalEpochs);
  const venue = ctx.venue ? ` (venue ${ctx.venue})` : "";
  const why = ctx.keeperAttestsVenue
    ? "the keeper attests depth for this venue, so check its depth push (unreadable reserve / no SOL-USD rate / pool drained?)"
    : "the keeper does NOT attest depth for this venue (only constant-product pools): a depth push needs the asset's oracle authority by hand";
  const pin = d.depthDexPinned ? " The asset is DEX-pinned: only an on-chain-DEX (mode 2) reading refreshes it; a keeper-attested one is refused." : "";
  return {
    kind: "depth-cap-zero",
    severity: critical ? "critical" : "warn",
    subject: `${label}#${d.assetIndex}`,
    message: closed
      ? `OPENS ARE CLOSED: the depth cap decayed to 0 (no fresh depth reading for ${d.stickyEpochs} h; last depth push ${d.depthAgeSlots === null ? "never" : `${d.depthAgeSlots} slots ago`}), so N_cap is 0 whatever the LP's capital and every new position is clipped to nothing. Closes still work. Restoring needs a fresh depth reading: ${why}${venue}.${pin}`
      : `the depth cap is decaying: ${d.stickyEpochs} halving(s) since the last good reading, ${d.epochsToZero} left before it reaches 0 and the market closes to opens. ${why}${venue}.${pin}`,
    data: { market, assetIndex: d.assetIndex, status: d.status, stickyEpochs: d.stickyEpochs, epochsToZero: d.epochsToZero, capDepthE6: d.capDepthE6 === null ? null : d.capDepthE6.toString(), depthSource: d.depthSource, depthDexPinned: d.depthDexPinned, venue: ctx.venue ?? null },
  };
}
