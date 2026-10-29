/**
 * cross-cluster/v22/loop.ts
 *
 * The v2.2 layer's orchestrator. Created by cross-cluster.ts ONLY when KEEPER_V22=on; with it off nothing here is
 * imported into a running path (the legacy delegation hooks stay empty).
 *
 *   - `sweepDelegate`  installed into the recovery cranker (delegation.ts) when KEEPER_V22_SWEEP=on: for a variant-B
 *     market the per-cycle accrue+refresh work is this layer's settle round (sweep.ts) instead of the #147 sweep.
 *   - `tick()`         every KEEPER_V22_TICK_MS, per v2.2 market: bond fee crank (78), holding rent (106), dust sweep
 *     (118), G9 (111), stake sync (stake 31), keeper Earn exits (77). Each job is its own flag and is skipped
 *     when its flag is off.
 *   - /health          `v22` block (health.ts): flags, per-market band / pin health, pairing stats, per-job counters.
 *   - vault-LP crank liveness (lp-cert-liveness.ts), every tick on every band market, read-only and flag-free: alert
 *     `vault-lp-crank-stale` while the vault LP's leg is uncertified this band epoch for >= 25% (WARN) / 50% (CRITICAL)
 *     of the E + Pmax resolve horizon (sim 2026-10-19 §P2.10).
 *
 * Every send goes through exec.ts (simulate first; dry-run logs "would send"). A market whose layout is not variant B
 * is ignored (the legacy cranker owns v1 / v2.1); a market whose layout is UNKNOWN is a loud, counted problem
 * (layout-guard-metrics.ts), never a silent fallback.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { deriveInsuranceUnitsV22, deriveStakePool } from "@percolatorct/sdk";
import type { MarketEntry } from "../registry.ts";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { ACCRUAL_TX_CU_HEADROOM, CATCHUP_CRANK_CU, MAX_CATCHUP_CRANKS, MAX_TX_CU, catchupCrankCount, isAssetLossStale } from "../positioned-refresh.ts";
import { CU_PER_WEIGHT } from "./settle-pairing.ts";
import { EXTRA_HINT_ACCRUE_CU, accrueCrankCuFor, catchupCrankCuFor, isMultiAssetMarket, maxCatchupCranksFor, observationAssetsFor, refreshStateForMarket } from "../multi-asset.ts";
import { setCrankRefreshHealth } from "../refresh-coordination.ts";
import { LOSS_STALE_ALERT_CYCLES } from "../recovery-cranker.ts";
import { describeV22Flags, pairingActive } from "./flags.ts";
import type { V22Flags } from "./flags.ts";
import { allJobCounters } from "./exec.ts";
import type { ExecContext } from "./exec.ts";
import { crankOracleAccounts, loadV22Market } from "./market.ts";
import type { V22MarketCtx, V22MarketLoad } from "./market.ts";
import { loadV22Positioned, parseAccrueAnchors } from "./positioned.ts";
import { simulateAndSend, simulateOnly } from "./exec.ts";
import { buildObservationCrankIx } from "../positioned-refresh.ts";
import { buildLivenessRepairIx, decodeLivenessState, describeRepair, planLivenessRepairs } from "../liveness-repair.ts";
import type { LivenessRepair } from "../liveness-repair.ts";
import { parseSeniorDrawLogs } from "../vault-lp-crank.ts";
import type { V22Positioned } from "./positioned.ts";
import { readMarginParams } from "./liquidation.ts";
import { RENT_SETTLES_PER_ROUND, DEFERRAL_ESCALATION_AFTER, DEFERRAL_ESCALATION_SLOTS, DEFAULT_SWEEP_ROUND_CONFIG, freshGapBackoff, pairingStats, runSettleRound } from "./sweep.ts";
import type { GapBackoff, RentPlanInput as RoundInputRent, RoundResult, SweepDeps, SweepRoundConfig } from "./sweep.ts";
import { redactErrorText } from "./redact.ts";
import { isKnownV22Market, loneLpCrankSuppressed, markV22Market, portfolioWeight, weightBudgetFor } from "./settle-pairing.ts";
import { crankBondFee } from "./fee-bond.ts";
import { freshRentState, markRentSettled, planRentSettles, settleRentOnce } from "./rent.ts";
import { buildSettleHoldingRentIxV22 } from "@percolatorct/sdk";
import { freshDustState, sweepDustOnce } from "./dust.ts";
import { freshG9State, g9Once } from "./g9.ts";
import { freshStakeSyncState, stakeSyncOnce } from "./stake-sync.ts";
import { freshStakeCommitTargetState, stakeCommitTargetOnce } from "./stake-commit-target.ts";
import { executeKeeperExits, fetchRedemptionRequests, freshEarnExitState } from "./earn-exit.ts";
import { bandHealthFor } from "./band.ts";
import type { BandHealth } from "./band.ts";
import { setBondFeeDelegated, setLoneLpCrankSuppressor, setProtectiveTrigger, setSweepDelegate } from "./delegation.ts";
import type { SweepDelegateArgs } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { adlHealthOf } from "../adl-state.ts";
import { getAlertSink } from "../alerting.ts";
import type { Alert, AlertSink } from "../alerting.ts";
import { terminalKindOf } from "./band.ts";
import { assessDepthCapacity, depthCapacityAlert, depthCapacityThresholdsFromEnv } from "./depth-capacity.ts";
import type { DepthCapacity, DepthCapacityThresholds } from "./depth-capacity.ts";
import { pushDepthEnabled } from "../push-depth.ts";
import { decodeAssetGrowthV19 } from "@percolatorct/sdk";
import { LP_CERT_ALERT_SCOPE, evaluateVaultLpCrankStaleness, lpCertLevelOf, lpCertStalenessOf, lpCertThresholdsFromEnv, readLpCertAssets } from "./lp-cert-liveness.ts";
import type { LpCertThresholds } from "./lp-cert-liveness.ts";
import { ADL_D1_ALERT_SCOPE, AdlEpisodeTracker, adlD1ThresholdsFromEnv, evaluateAdlD1 } from "./d1-watch.ts";
import type { AdlAssetReading, AdlD1Thresholds, AdlEpisode } from "./d1-watch.ts";
import { ADL_ONE, decodeAdlState } from "../adl-state.ts";
import { engineSlotBase } from "../market-layout.ts";
import { LifecycleEngine } from "./lifecycle.ts";
import { crankLpFeesOnce } from "../lp-fee-cranker.ts";
import { pushStakeFeesOnce, stakeFeeConfigFromEnv } from "../stake-fee-pusher.ts";

export interface V22LoopDeps {
  /** Minimum ms between two catch-up txs across ALL markets (default KEEPER_V22_CATCHUP_SPACING_MS or 1500). */
  catchupSpacingMs?: number;
  conn: Connection;
  keeper: Keypair;
  programId: PublicKey;
  /** The live registry (hot-reloaded in place). */
  markets: () => ReadonlyArray<Pick<MarketEntry, "marketAddress" | "label" | "lpPortfolio"> & Partial<Pick<MarketEntry, "dexType" | "assets">>>;
  flags: V22Flags;
  /** Global DRY_RUN / --dry-run. */
  dryRun: boolean;
  /** Mainnet-flavoured wrapper: G9 modes 0 and 2 take the allowlist + leg accounts. */
  mainnetBuild?: boolean;
  anchors?: Map<string, PublicKey>;
  feeIntervalMs?: number;
  /** Where the vault-LP crank liveness alert is reconciled (default: the process-wide sink). */
  alertSink?: Pick<AlertSink, "reconcile">;
  /** Vault-LP crank liveness thresholds (default: from ALERT_VAULT_LP_CRANK_* env, boot-safe). */
  lpCertThresholds?: LpCertThresholds;
  /** D1 close-only / wind-down thresholds (default: from ALERT_ADL_WIND_DOWN_* env, boot-safe). */
  adlD1Thresholds?: AdlD1Thresholds;
  /** #174 depth-capacity thresholds (default: from ALERT_DEPTH_* env, boot-safe). */
  depthCapacityThresholds?: DepthCapacityThresholds;
  now?: () => number;
  log?: (s: string) => void;
}

interface MarketRuntime {
  rent: ReturnType<typeof freshRentState>;
  dust: ReturnType<typeof freshDustState>;
  g9: ReturnType<typeof freshG9State>;
  stake: ReturnType<typeof freshStakeSyncState>;
  commitTarget: ReturnType<typeof freshStakeCommitTargetState>;
  quarantine: Map<string, bigint>;
  gapBackoff: GapBackoff;
  earn: ReturnType<typeof freshEarnExitState>;
  lastProtectiveAtMs: number;
  /** Consecutive protective rounds that did not settle the LP (backoff 5 s x 2^n, cap 120 s). */
  protectiveFailures: number;
  nextProtectiveAtMs: number;
  /** Last time a protective round ran on the 'senior draw outstanding' signal alone (at most every 30 s). */
  lastOutstandingRoundAtMs: number;
  quarantineHistory: Map<string, { code: number; level: number }>;
  /** Rounds left in which the operator / discovered anchor is not used (the program refused an anchor accrue). */
  anchorBadRounds: number;
  deferrals: Map<string, number>;
  /** base58 -> {at, rounds}: portfolios escalated for repeated no-code refresh failures (named in /health). */
  escalated: Map<string, { atMs: number; count: number }>;
  /** Last time a round of ours settled the vault LP (0 = not yet seen). */
  lastLpSettledAtMs: number;
  nextTimeBoundAtMs: number;
  lossStaleCycles: number;
  lastFeeAtMs: number;
  lastEarnAtMs: number;
  lastBand: BandHealth | null;
  lastRound: { paired: boolean; txs: number; lpSettled: boolean; gapSlots: number | null; abandoned: string | null; settled: number; missing: number; protective: boolean; at: number } | null;
  lastG9: string | null;
  lastFee: string | null;
  lastStake: string | null;
  lastCommitTarget: string | null;
  lastEarn: string | null;
  layoutNote: string | null;
  positionedCache: { at: number; value: V22Positioned } | null;
  sweepInflight: boolean;
  /** Liveness repairs (tag 89 / 45) are not retried before this time after one did not land (ms). */
  repairBackoffUntilMs: number;
  /** Active vault-LP crank liveness alerts from the last GOOD read (kept across a failed read, never cleared by one). */
  lpCertAlerts: Alert[];
  /** #174: active depth-capacity alerts from the last decodable read. */
  depthAlerts: Alert[];
  /** #174: /health view of every clamp-enforced growth asset's depth cap at the last decodable read. */
  lastDepth: DepthCapacity[] | null;
  /** /health: the LP certification staleness of the worst asset at the last good read. */
  lastLpCert: { assetIndex: number; certified: boolean; staleSlots: string; horizonSlots: string; remainingSlots: string; level: string; horizonSource: string } | null;
  /** D1: per-market close-only episode tracker (in memory; a restart makes ages lower bounds). */
  adlTracker: AdlEpisodeTracker;
  /** D1: active alerts from the last GOOD read (kept across a failed read). */
  adlAlerts: Alert[];
  /** D1: /health view of the close-only episodes at the last good read. */
  lastAdl: { episodes: Array<{ assetIndex: number; ageSlots: string; observedSinceSlot: string; sinceBoot: boolean; level: string; slotsToBound: string }>; endedEpisodes: number; longestEndedSlots: string; endedPastBound: number } | null;
}

/** #174: depth-capacity alerts (scopes `:warn` / `:critical`). */
export const DEPTH_CAPACITY_ALERT_SCOPE = "v22-depth-capacity";

const POSITIONED_TTL_MS = 10_000;
/** Margin on a simulated one-crank catch-up cost when sizing the catch-up tx (per-crank cost varies a few % with state). */
const CATCHUP_MEASURED_MARGIN = 1.08;

export class V22Loop {
  private readonly rt = new Map<string, MarketRuntime>();
  private readonly log: (s: string) => void;
  private readonly now: () => number;
  private readonly lpCertThresholds: LpCertThresholds;
  private readonly adlD1Thresholds: AdlD1Thresholds;
  private readonly depthThresholds: DepthCapacityThresholds;
  private ticks = 0;
  private lastTickAt: number | null = null;
  private layoutProblems = new Map<string, string>();
  /** v22price 2026-10-22: when the last catch-up tx (any market) was started; see `catchupSpacingMs`. */
  private lastCatchupAtMs = Number.NEGATIVE_INFINITY;
  /** Market lifecycle: dead-market classifier, permissionless stale resolve (default OFF), warn-band fee forcing (default OFF). */
  private readonly lifecycle: LifecycleEngine | null;

  constructor(private readonly d: V22LoopDeps) {
    this.log = d.log ?? ((s) => console.log(s));
    this.now = d.now ?? Date.now;
    this.lpCertThresholds = d.lpCertThresholds ?? lpCertThresholdsFromEnv(process.env);
    this.adlD1Thresholds = d.adlD1Thresholds ?? adlD1ThresholdsFromEnv(process.env);
    this.depthThresholds = d.depthCapacityThresholds ?? depthCapacityThresholdsFromEnv(process.env);
    const lc = d.flags.lifecycle;
    if (lc.classify) {
      const sink = d.alertSink ?? getAlertSink();
      this.lifecycle = new LifecycleEngine({
        conn: d.conn as never,
        keeper: d.keeper,
        programId: d.programId,
        cfg: lc,
        dryRun: d.dryRun || d.flags.dryRun,
        registered: (m) => this.d.markets().some((x) => x.marketAddress === m),
        sink: { reconcile: (scope, a) => sink.reconcile(scope, a), fire: async (scope, a) => ("fire" in sink && typeof sink.fire === "function" ? (sink as Pick<AlertSink, "fire">).fire(scope, a) : false) },
        forceFees: lc.warnBandFees ? (ctx) => this.forceFeesFor(ctx) : undefined,
        sourceGroup: (m) => {
          const row = this.d.markets().find((x) => x.marketAddress === m);
          if (!row) return null;
          if (row.dexType) return row.dexType;
          const dex = [...new Set((row.assets ?? []).map((a) => (a.source === "pool" ? (a.dexType ?? "pool") : "fixed")))].sort();
          return dex.length > 0 ? dex.join("+") : null;
        },
        now: d.now,
        log: this.log,
      });
    } else {
      this.lifecycle = null;
    }
  }

  /**
   * Warn-band fee round (KEEPER_V22_WARN_BAND_FEES): tag 78 (the LP leg) and tag 87 + stake 12 (the staker leg) NOW, whatever the
   * fee loop's cadence and the push thresholds say. Both are Live-only and refused once the stale window matures, and an
   * uncranked staker leg is forfeited at resolve. Reuses the normal crankers: bond markets go through the v2.2 bond fee path (with
   * the settle-pairing policy), the rest through the legacy tag-78 job, and tag 87 through the stake-fee pusher with its minimum
   * push lowered to 1 atom. The pusher's dead-share gate stays (it protects stakers from a griefing dust deposit).
   */
  private async forceFeesFor(ctx: V22MarketCtx): Promise<string> {
    const f = this.d.flags;
    const dry = this.d.dryRun || f.dryRun;
    const parts: string[] = [];
    // Never alongside a v2.2 settle round on the same market (a round may be settling the vault LP): defer to the next tick.
    const r = this.rtFor(ctx.marketAddress);
    if (r.sweepInflight) return "deferred: a v2.2 settle round is in flight on this market";
    {
      if (f.feeCrankBond && ctx.bond) {
        const positioned = await this.positionedFor(ctx, r);
        const res = await crankBondFee(this.sweepDeps(), ctx, positioned, { mode: pairingActive(f) ? f.pairing : "off", weightBudget: weightBudgetFor() });
        parts.push(`78(bond) ${res.kind === "skipped" ? `skipped: ${res.reason}` : res.kind}`);
      } else {
        const o = await crankLpFeesOnce(this.d.conn as never, this.d.keeper, ctx.marketAddress, dry);
        parts.push(`78 ${typeof o === "string" ? o : o.error}`);
      }
      const stakeCfg = { ...stakeFeeConfigFromEnv(process.env), minPushAtoms: 1n };
      const st = await pushStakeFeesOnce(this.d.conn as never, this.d.keeper, ctx.marketAddress, dry, stakeCfg);
      parts.push(`87+12 ${st.kind}${st.kind === "skipped" ? `: ${st.reason}` : st.kind === "failed" ? `: ${st.error}` : st.kind === "waiting" || st.kind === "blocked" ? `: ${st.reason}` : ""}`);
      return parts.join("; ");
    }
  }

  /**
   * Vault-LP crank liveness for one loaded market (lp-cert-liveness.ts). Updates `r.lpCertAlerts` / `r.lastLpCert` only
   * on a GOOD read: an RPC error or an undecodable LP keeps the previous state, so a flaky read can neither raise nor
   * falsely RESOLVE the alert. Never throws.
   */
  private async checkLpCert(ctx: V22MarketCtx, r: MarketRuntime): Promise<void> {
    if (!ctx.isBand || !ctx.lpPortfolio || terminalKindOf(ctx.data) !== null) {
      r.lpCertAlerts = [];
      r.lastLpCert = null;
      return;
    }
    try {
      const info = await this.d.conn.getAccountInfo(ctx.lpPortfolio, "processed");
      if (!info) return; // unreadable this tick: keep the last state
      const nowSlot = BigInt(ctx.readSlot);
      const assets = readLpCertAssets(ctx.data, ctx.layout, observationAssetsFor(ctx.marketAddress), new Uint8Array(info.data))
        .map((a) => lpCertStalenessOf(a, nowSlot))
        .filter((x): x is NonNullable<typeof x> => x !== null);
      r.lpCertAlerts = evaluateVaultLpCrankStaleness({ label: ctx.label, market: ctx.marketAddress, terminal: false, nowSlot, assets }, this.lpCertThresholds);
      const worst = [...assets].sort((x, y) => (x.remainingSlots < y.remainingSlots ? -1 : x.remainingSlots > y.remainingSlots ? 1 : 0)).find((x) => !x.certified) ?? assets[0] ?? null;
      r.lastLpCert = worst
        ? { assetIndex: worst.assetIndex, certified: worst.certified, staleSlots: worst.staleSlots.toString(), horizonSlots: worst.horizonSlots.toString(), remainingSlots: worst.remainingSlots.toString(), level: lpCertLevelOf(worst, this.lpCertThresholds), horizonSource: worst.horizonSource }
        : null;
    } catch (err) {
      this.log(`[v22][lp-cert] ${ctx.label}: LP certification read failed (alert state kept): ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /**
   * D1 (d1-watch.ts): is a band asset close-only (A != 1), and has it outlived the tag-104 wind-down bound? Read-only: it
   * uses the market bytes this tick already read. Updates `r.adlAlerts` / `r.lastAdl` only on a decodable market; a
   * decode failure keeps the previous state (never raises or resolves on a bad read). Never throws.
   */
  private checkAdlCloseOnly(ctx: V22MarketCtx, r: MarketRuntime): void {
    const nowSlot = BigInt(ctx.readSlot);
    if (!ctx.isBand || terminalKindOf(ctx.data) !== null) {
      r.adlTracker.reset(nowSlot);
      r.adlAlerts = [];
      r.lastAdl = null;
      return;
    }
    try {
      const readings: AdlAssetReading[] = [];
      for (const assetIndex of observationAssetsFor(ctx.marketAddress)) {
        const a = decodeAdlState(ctx.data, assetIndex);
        if (!a) return; // not a market account: keep the last state
        const lifecycle = ctx.data[engineSlotBase(ctx.layout, assetIndex) + ctx.layout.asset.lifecycle];
        if (lifecycle !== 2 && lifecycle !== 3) continue; // only Active / DrainOnly assets can be close-only in a way a wind-down fixes
        readings.push({ assetIndex, closeOnly: a.aLong !== ADL_ONE || a.aShort !== ADL_ONE, oiEffLong: a.oiEffLong, oiEffShort: a.oiEffShort, aLong: a.aLong, aShort: a.aShort });
      }
      const episodes: AdlEpisode[] = r.adlTracker.observe(readings, nowSlot);
      r.adlAlerts = evaluateAdlD1({ label: ctx.label, market: ctx.marketAddress, nowSlot, terminal: false, episodes, readings }, this.adlD1Thresholds);
      const sm = r.adlTracker.summary(episodes);
      r.lastAdl = {
        episodes: sm.episodes.map((e) => ({ assetIndex: e.assetIndex, ageSlots: e.ageSlots.toString(), observedSinceSlot: e.observedSinceSlot.toString(), sinceBoot: e.sinceBoot, level: e.level, slotsToBound: e.slotsToBound.toString() })),
        endedEpisodes: sm.endedEpisodes,
        longestEndedSlots: sm.longestEndedSlots,
        endedPastBound: sm.endedPastBound,
      };
    } catch (err) {
      this.log(`[v22][d1] ${ctx.label}: close-only read failed (alert state kept): ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /**
   * #174: depth capacity of every growth asset of a loaded market (depth-capacity.ts). Read-only: the market bytes this tick already
   * read, no RPC, nothing sent. A non-band / terminal market clears its state; an undecodable record keeps the previous one. Never throws.
   */
  private checkDepthCapacity(ctx: V22MarketCtx, r: MarketRuntime, venue: string | null): void {
    if (!ctx.isBand || terminalKindOf(ctx.data) !== null) {
      r.depthAlerts = [];
      r.lastDepth = null;
      return;
    }
    try {
      const nowSlot = BigInt(ctx.readSlot);
      const bandBps = ctx.band.bandBps > 0xffff_ffffn ? Number.MAX_SAFE_INTEGER : Number(ctx.band.bandBps);
      const assets: DepthCapacity[] = [];
      const alerts: Alert[] = [];
      for (const assetIndex of observationAssetsFor(ctx.marketAddress)) {
        let g: ReturnType<typeof decodeAssetGrowthV19>;
        try {
          g = decodeAssetGrowthV19(ctx.data, assetIndex);
        } catch {
          continue; // an asset the account does not carry: not evaluated, the others are
        }
        if (g === null) continue;
        const d = assessDepthCapacity(g, assetIndex, bandBps, nowSlot, this.depthThresholds);
        assets.push(d);
        const a = depthCapacityAlert(ctx.label, ctx.marketAddress, d, this.depthThresholds, { venue, keeperAttestsVenue: venue === "pumpswap" && pushDepthEnabled() });
        if (a) alerts.push(a);
      }
      r.depthAlerts = alerts;
      r.lastDepth = assets;
    } catch (err) {
      this.log(`[v22][depth] ${ctx.label}: depth-capacity read failed (alert state kept): ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /** #174: reconcile the depth-capacity alerts. Two scopes (warn-or-worse / critical-only), like the vault-LP certification, so a warn -> critical escalation pages at once. */
  private async reconcileDepthCapacity(): Promise<void> {
    const warn: Alert[] = [];
    const critical: Alert[] = [];
    for (const m of this.d.markets()) {
      for (const a of this.rt.get(m.marketAddress)?.depthAlerts ?? []) {
        warn.push(a.severity === "warn" ? a : { ...a, severity: "warn" });
        if (a.severity === "critical") critical.push(a);
      }
    }
    try {
      const sink = this.d.alertSink ?? getAlertSink();
      await sink.reconcile(`${DEPTH_CAPACITY_ALERT_SCOPE}:warn`, warn);
      await sink.reconcile(`${DEPTH_CAPACITY_ALERT_SCOPE}:critical`, critical);
    } catch (err) {
      this.log(`[v22][depth] alert delivery failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /** Reconcile the D1 close-only / wind-down-overdue alerts of every registered market (kinds carry their own cooldown keys). */
  private async reconcileAdlD1(): Promise<void> {
    const active: Alert[] = [];
    for (const m of this.d.markets()) active.push(...(this.rt.get(m.marketAddress)?.adlAlerts ?? []));
    try {
      await (this.d.alertSink ?? getAlertSink()).reconcile(ADL_D1_ALERT_SCOPE, active);
    } catch (err) {
      this.log(`[v22][d1] alert delivery failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /**
   * Reconcile the vault-LP crank liveness alerts of every registered market (fires new ones, resolves cleared ones).
   *
   * Two scopes, one per level, because the sink's cooldown key is (scope, kind, subject) without the severity: in ONE
   * scope a WARN -> CRITICAL escalation would wait out the 15-min cooldown (~2,250 slots, i.e. the page would land near
   * 73% of the horizon, not 50%). The `:warn` scope carries every market at WARN or worse (as a warn-level record), the
   * `:critical` scope only the critical ones, so an escalation pages at once and nothing is double-paged (Telegram
   * only takes criticals). Recovery resolves both.
   */
  private async reconcileLpCert(): Promise<void> {
    const warn: Alert[] = [];
    const critical: Alert[] = [];
    for (const m of this.d.markets()) {
      for (const a of this.rt.get(m.marketAddress)?.lpCertAlerts ?? []) {
        warn.push(a.severity === "warn" ? a : { ...a, severity: "warn" });
        if (a.severity === "critical") critical.push(a);
      }
    }
    try {
      const sink = this.d.alertSink ?? getAlertSink();
      await sink.reconcile(`${LP_CERT_ALERT_SCOPE}:warn`, warn);
      await sink.reconcile(`${LP_CERT_ALERT_SCOPE}:critical`, critical);
    } catch (err) {
      this.log(`[v22][lp-cert] alert delivery failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  private rtFor(addr: string): MarketRuntime {
    let r = this.rt.get(addr);
    if (!r) {
      r = {
        rent: freshRentState(),
        dust: freshDustState(),
        g9: freshG9State(),
        stake: freshStakeSyncState(),
        commitTarget: freshStakeCommitTargetState(),
        quarantine: new Map(),
        gapBackoff: freshGapBackoff(),
        earn: freshEarnExitState(),
        lastProtectiveAtMs: 0,
        protectiveFailures: 0,
        nextProtectiveAtMs: 0,
        lastOutstandingRoundAtMs: 0,
        quarantineHistory: new Map(),
        anchorBadRounds: 0,
        repairBackoffUntilMs: 0,
        deferrals: new Map(),
        escalated: new Map(),
        lastLpSettledAtMs: 0,
        nextTimeBoundAtMs: 0,
        lossStaleCycles: 0,
        lastFeeAtMs: 0,
        lastEarnAtMs: 0,
        lastBand: null,
        lastRound: null,
        lastG9: null,
        lastFee: null,
        lastStake: null,
        lastCommitTarget: null,
        lastEarn: null,
        layoutNote: null,
        positionedCache: null,
        sweepInflight: false,
        lpCertAlerts: [],
        depthAlerts: [],
        lastDepth: null,
        lastLpCert: null,
        adlTracker: new AdlEpisodeTracker(this.adlD1Thresholds),
        adlAlerts: [],
        lastAdl: null,
      };
      this.rt.set(addr, r);
    }
    return r;
  }

  private execCtx(): ExecContext {
    return { conn: this.d.conn, keeper: this.d.keeper, dryRun: this.d.dryRun || this.d.flags.dryRun, log: this.log };
  }

  private roundConfig(): SweepRoundConfig {
    return { ...DEFAULT_SWEEP_ROUND_CONFIG, pairing: this.d.flags.pairing, weightBudget: weightBudgetFor() };
  }

  /** Install the legacy-path hooks. Called once at startup. */
  install(): void {
    const f = this.d.flags;
    if (f.sweep) setSweepDelegate((a) => this.sweepDelegate(a));
    if (f.feeCrankBond) setBondFeeDelegated(true);
    setLoneLpCrankSuppressor((m) => loneLpCrankSuppressed({ loneLpCrankFlag: f.loneLpCrank, pairingActive: pairingActive(f), isV22Market: this.isV22(m) }));
    if (pairingActive(f)) setProtectiveTrigger((m) => void this.protectiveRound(m).catch(() => {}));
    setV22HealthProvider(() => this.healthFields());
  }

  /**
   * Sticky: once a good read showed variant B, a later failed read ("unreadable") must not re-enable the lone LP crank
   * or switch off the protective round. `layoutNote` still shows the latest read on /health.
   */
  private isV22(addr: string): boolean {
    return isKnownV22Market(addr);
  }

  private async positionedFor(ctx: V22MarketCtx, r: MarketRuntime): Promise<V22Positioned | null> {
    const t = this.now();
    if (r.positionedCache && t - r.positionedCache.at < POSITIONED_TTL_MS) return r.positionedCache.value;
    const v = await loadV22Positioned(this.d.conn, ctx, (this.d.anchors ?? parseAccrueAnchors(process.env.KEEPER_V22_ACCRUE_ANCHORS)).get(ctx.market.toBase58()) ?? null, this.d.keeper.publicKey);
    if (v) r.positionedCache = { at: t, value: v };
    return v;
  }

  private noteLoad(entry: { marketAddress: string }, load: V22MarketLoad): V22MarketCtx | null {
    const r = this.rtFor(entry.marketAddress);
    if (load.ok) {
      r.layoutNote = "v2.2-b";
      this.layoutProblems.delete(entry.marketAddress);
      markV22Market(entry.marketAddress);
      return load.ctx;
    }
    if (load.reason === "not-v22") return null;
    r.layoutNote = load.reason;
    this.layoutProblems.set(entry.marketAddress, `${load.reason}: ${load.detail}`.slice(0, 200));
    return null;
  }

  private sweepDeps(): SweepDeps {
    return { exec: this.execCtx(), getSlot: () => this.d.conn.getSlot("confirmed") };
  }

  /**
   * The recovery cranker's per-market hook for a variant-B market (KEEPER_V22_SWEEP). Returns true ONLY when this layer
   * actually ran (or a round is already running); on every "could not run" path it declines so the legacy cycle still
   * runs (review F-5: the engine clock must keep moving). LF: that cycle's accrual crank targets the vault LP and settles
   * it alone, so where the lone LP crank is suppressed it declines "clock-only" (repairs and catch-up, no accrual crank;
   * counted `declinedClockOnly`). The cranker calls this only for a variant-B market, so the market is v2.2 even when
   * this cycle's own read failed.
   */
  async sweepDelegate(a: SweepDelegateArgs): Promise<boolean | "clock-only"> {
    if (await this.runRoundFor(a.conn, a.entry, false)) return true;
    const f = this.d.flags;
    if (!loneLpCrankSuppressed({ loneLpCrankFlag: f.loneLpCrank, pairingActive: pairingActive(f), isV22Market: true })) return false;
    pairingStats.declinedClockOnly++;
    return "clock-only";
  }

  private async runRoundFor(conn: Connection, entry: { marketAddress: string; label: string; lpPortfolio?: string }, protective: boolean): Promise<boolean> {
    const r = this.rtFor(entry.marketAddress);
    if (r.sweepInflight) return true; // a round is running and accrues the market
    r.sweepInflight = true;
    try {
      const load = await loadV22Market(conn, entry, this.d.programId);
      const ctx = this.noteLoad(entry, load);
      if (!ctx) return false;
      r.lastBand = bandHealthFor(ctx);
      if (ctx.refresh.lifecycle !== 2 && ctx.refresh.lifecycle !== 3) return false; // not Active / DrainOnly
      // v22price 2026-10-22: liveness repairs on EVERY asset of a v2.2 market, before any crank. A lapsed `Fresh` backing
      // bucket refuses every settle of a gain against it with EngineStale (19) and only ExpireBackingBucket (tag 89) frees
      // it (wrapper v16_program.rs, ExpireBackingBucket doc). The legacy cranker plans these repairs, but a v2.2-owned
      // market returns into this delegate before it does, and it only ever decoded asset 0: cap4b 2xhs (asset 2, domain 5,
      // lapsed ~2M slots) refused every round with Custom(19) and its counterparty stayed loss-stale. A landed repair ends
      // this cycle (the round runs on the next one, on the repaired state); one that does not land backs off 60 s and the
      // round still runs.
      if (this.now() >= r.repairBackoffUntilMs) {
        const repairs = livenessRepairsFor(ctx);
        if (repairs.length > 0) {
          const ixs = repairs.map((x) => {
            const ix = buildLivenessRepairIx(ctx.market, x);
            ix.programId = this.d.programId;
            return ix;
          });
          const out = await simulateAndSend(this.execCtx(), ixs, { job: "liveness-repair", label: ctx.label, units: Math.min(MAX_TX_CU, 40_000 * ixs.length + ACCRUAL_TX_CU_HEADROOM) });
          const what = out.kind === "sent" ? `sent ${out.landed}` : out.kind === "refused" ? `refused ${out.name}` : out.kind === "failed" ? `failed ${out.error}` : out.kind;
          this.log(`[v22][repair] ${ctx.label}: ${repairs.map(describeRepair).join(", ")}: ${what}`);
          if (out.kind === "sent" && out.landed === "landed") return true;
          r.repairBackoffUntilMs = this.now() + 60_000;
        }
      }
      const positioned = await this.positionedFor(ctx, r);
      if (!positioned || !positioned.lp) {
        this.log(`[v22][sweep] ${ctx.label}: no vault LP portfolio or the positioned set is unreadable; leaving this cycle to the legacy fallback`);
        return false;
      }
      // K-6 (+ LIQ-DIAG 2026-10-17: every market, not only multi-asset): a market whose oldest observed asset is a full
      // accrual window (or more) behind. A round now would only advance each asset by one window (the program's bounded
      // catch-up return) and every refresh would be refused (22), so a bankrupt account that nobody refreshed during the
      // outage could not be liquidated until enough rounds had each eaten one window. Send bounded catch-up cranks
      // observing every asset first (at most MAX_CATCHUP_CRANKS per tx; a larger gap takes several cycles); they return
      // before settling anyone, so the LP is never settled alone. The round runs on the next cycle, inside one window.
      // In steady state the gap is below one window, so n is 0 and nothing changes.
      {
        const n = catchupCrankCount(BigInt(ctx.readSlot) - ctx.refresh.slotLast, ctx.refresh.maxAccrualDtSlots);
        if (n > 0) {
          // v22price 2026-10-22: pace catch-up across markets. After an outage every market is behind at once; one
          // catch-up tx per market per cycle (each with two simulations, a send and status polls) hit the RPC key's rate
          // limit (429) and starved the pushes. Skipped markets catch up on a later cycle; returning true keeps the
          // legacy cranker from sending its own catch-up meanwhile.
          const spacing = this.d.catchupSpacingMs ?? Number(process.env.KEEPER_V22_CATCHUP_SPACING_MS ?? 1500);
          if (this.now() - this.lastCatchupAtMs < spacing) return true;
          this.lastCatchupAtMs = this.now();
          await this.multiAssetCatchup(ctx, positioned.flatAnchor ?? positioned.lp.pubkey, n);
          return true;
        }
      }
      const f = this.d.flags;
      // Rent (tag 106) runs AFTER the LP tx of a round, sequentially, for portfolios the plain refresh already settled.
      let rent: RoundInputRent | undefined;
      if (f.holdingRent && ctx.isRent && pairingActive(f)) {
        const plan = planRentSettles(ctx, positioned, r.rent, f.rentCadenceSlots, true, RENT_SETTLES_PER_ROUND);
        if (plan.due.length > 0) {
          const oracle = crankOracleAccounts(ctx);
          rent = { due: new Set(plan.due.map((x) => x.portfolio)), max: RENT_SETTLES_PER_ROUND, build: (p) => buildSettleHoldingRentIxV22(ctx.sdk, this.d.keeper.publicKey, p.pubkey, 0, BigInt(ctx.readSlot), ctx.oracleMode === 1 ? oracle : []) };
        }
      }
      const useAnchor = r.anchorBadRounds > 0 ? null : positioned.flatAnchor;
      if (r.anchorBadRounds > 0) r.anchorBadRounds--;
      // K-6: every accrue crank of a multi-asset round carries one observation per asset; reserve that compute in the
      // per-tx weight budget (single-asset: the budget is unchanged).
      const roundCfg = this.roundConfig();
      const hints = observationAssetsFor(ctx.marketAddress).length;
      if (hints > 1) roundCfg.weightBudget = Math.max(6, roundCfg.weightBudget - Math.ceil(((hints - 1) * EXTRA_HINT_ACCRUE_CU) / CU_PER_WEIGHT));
      const res = await runSettleRound(
        this.sweepDeps(),
        { market: ctx.market, label: ctx.label },
        {
          lp: positioned.lp.pubkey,
          lpWeight: portfolioWeight(positioned.lp),
          counterparties: positioned.counterparties,
          anchor: useAnchor,
          oracleAccounts: crankOracleAccounts(ctx),
          quarantine: r.quarantine,
          quarantineHistory: r.quarantineHistory,
          deferrals: r.deferrals,
          nowSlot: ctx.readSlot,
          gapBackoff: r.gapBackoff,
          rent,
          protective,
          liq: f.liquidate ? { layout: ctx.layout, slots: ctx.slots, params: readMarginParams(ctx.data, ctx.layout, ctx.slots), padBps: f.liquidatePadBps, maxPerTx: f.liquidateMaxPerTx } : undefined,
        },
        roundCfg,
      );
      if (res.backedOff) {
        // N-4 + LF: no round this cycle, but the clock must keep moving (F-5). Declining here made the legacy fallback crank
        // the vault LP alone about one cycle after phase 1 settled the counterparties. The positioned set is in hand, so
        // accrue through the flat anchor, else the lightest unquarantined counterparty (settles only it, as phase 1 does).
        const nowSlot = BigInt(ctx.readSlot);
        const cp = positioned.counterparties.filter((c) => !((r.quarantine.get(c.pubkey.toBase58()) ?? 0n) > nowSlot)).sort((x, y) => portfolioWeight(x) - portfolioWeight(y))[0];
        const target = useAnchor ?? cp?.pubkey ?? null;
        if (!target) return false;
        const out = await simulateAndSend(this.execCtx(), [buildObservationCrankIx(this.d.keeper.publicKey, ctx.market, target, crankOracleAccounts(ctx))], { job: "backoff-accrue", label: ctx.label, units: MAX_TX_CU });
        if (useAnchor) pairingStats.anchorAccrues++;
        else pairingStats.counterpartyAccrues++;
        const what = out.kind === "sent" ? `sent ${out.landed}` : out.kind === "refused" ? `refused ${out.name}` : out.kind === "failed" ? `failed ${out.error}` : out.kind;
        this.log(`[v22][sweep] ${ctx.label}: ${res.abandoned}; accrue-only crank on ${useAnchor ? "the flat anchor" : "a counterparty"} ${target.toBase58().slice(0, 8)}…: ${what}`);
        return true;
      }
      if (res.anchorRefused) {
        r.anchorBadRounds = 5;
        this.log(`[v22][sweep] ${ctx.label}: the program refused the flat-anchor accrue; using the counterparty accrue form for 5 rounds`);
      }
      if (rent) {
        markRentSettled(r.rent, ctx, res.rentSettled);
        pairingStats.rentSettlesInRound += res.rentSettled.length;
      }
      r.positionedCache = null; // positions changed
      this.recordRound(ctx, r, res, positioned, protective);
      for (const k of res.escalated) {
        const prev = r.escalated.get(k);
        r.escalated.set(k, { atMs: this.now(), count: (prev?.count ?? 0) + 1 });
        this.log(`[v22][WARN] ${ctx.label}: portfolio ${k} failed its refresh without a program error ${DEFERRAL_ESCALATION_AFTER} rounds in a row; treated as program-refused for pairing (quarantined ${DEFERRAL_ESCALATION_SLOTS} slots). ${this.d.flags.pairing === "strict" ? "strict: the LP keeps waiting on it" : "prefer: the LP proceeds with it counted"}`);
      }
      // a portfolio that settled again is no longer escalated
      for (const k of [...r.escalated.keys()]) if (res.settled.includes(k)) r.escalated.delete(k);
      if (res.lpSettled) r.lastLpSettledAtMs = this.now();
      else if (r.lastLpSettledAtMs === 0) r.lastLpSettledAtMs = this.now();
      await this.publishHealth(ctx, r, positioned, res);
      // TIME BOUND: the keeper never settles the LP alone and the lone crank is suppressed, so if rounds keep holding the LP
      // (a persistent miss, repeated landing failures) it could stay unsettled for good. After lpMaxUnsettledMs, with the market
      // otherwise healthy (we are here: Active, readable, LP known), run ONE full paired round with the LP last regardless
      // (the protective shape). Counted; retried at most every lpMaxUnsettledMs / 5.
      if (!protective && !res.lpSettled && !res.backedOff && this.now() - r.lastLpSettledAtMs >= f.lpMaxUnsettledMs && this.now() >= r.nextTimeBoundAtMs) {
        r.nextTimeBoundAtMs = this.now() + Math.max(1, Math.floor(f.lpMaxUnsettledMs / 5));
        pairingStats.lpTimeBoundRounds++;
        this.log(`[v22][sweep] ${ctx.label}: the vault LP has not been settled by the keeper for ${Math.round((this.now() - r.lastLpSettledAtMs) / 1000)} s: running one full paired round with the LP last`);
        r.positionedCache = null;
        r.sweepInflight = false;
        await this.runRoundFor(conn, entry, true);
        return true;
      }
      // 78 at the END of a paired round (the LP was just settled with its counterparties), not on its own timer.
      if (f.feeCrankBond && ctx.bond && res.lpSettled && this.now() - r.lastFeeAtMs >= (this.d.feeIntervalMs ?? 200_000)) {
        r.lastFeeAtMs = this.now();
        const fee = await crankBondFee(this.sweepDeps(), ctx, positioned, { mode: this.d.flags.pairing, weightBudget: weightBudgetFor(), afterRound: true });
        r.lastFee = fee.kind === "skipped" ? `skipped: ${fee.reason}` : `after-round ${fee.kind}`;
      }
      return true;
    } catch (err) {
      this.log(`[v22][sweep] ${entry.label}: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
      return false;
    } finally {
      r.sweepInflight = false;
    }
  }

  /**
   * K-6: one transaction of bounded catch-up cranks for a multi-asset market, each observing every asset (simulate first,
   * dry-run = simulate only). `n` is capped to what fits the compute budget at the multi-hint cost; a further gap is
   * covered on the next cycles. Never throws.
   */
  private async multiAssetCatchup(ctx: V22MarketCtx, target: PublicKey, wanted: number): Promise<void> {
    const hints = observationAssetsFor(ctx.marketAddress).length;
    const crank = () => buildObservationCrankIx(this.d.keeper.publicKey, ctx.market, target, crankOracleAccounts(ctx));
    // v22price 2026-10-22: the per-crank cost depends on the market's config (v2.2 single-asset 36,350 CU; a band market
    // 42,538), so a fixed estimate either overflows the tx or wastes it. Measure THIS market with a one-crank simulation and
    // size the tx from it (+8%); the static estimate is the fallback when the measurement is unavailable.
    let perCrank = catchupCrankCuFor(CATCHUP_CRANK_CU, hints);
    if (wanted > 1) {
      try {
        const one = await simulateOnly(this.execCtx(), [crank()], { units: MAX_TX_CU });
        if (!one.err && one.unitsConsumed && one.unitsConsumed > 0) perCrank = Math.ceil(one.unitsConsumed * CATCHUP_MEASURED_MARGIN);
      } catch {
        // keep the static estimate
      }
    }
    const n = Math.min(wanted, maxCatchupCranksFor(MAX_CATCHUP_CRANKS, perCrank, 1, MAX_TX_CU - ACCRUAL_TX_CU_HEADROOM));
    const ixs = Array.from({ length: n }, crank);
    const units = Math.min(MAX_TX_CU, n * perCrank + ACCRUAL_TX_CU_HEADROOM);
    const out = await simulateAndSend(this.execCtx(), ixs, { job: "catchup-multi", label: ctx.label, units });
    const gap = BigInt(ctx.readSlot) - ctx.refresh.slotLast;
    const what = out.kind === "sent" ? `sent ${out.landed}` : out.kind === "refused" ? `refused ${out.name}` : out.kind === "failed" ? `failed ${out.error}` : out.kind;
    this.log(`[v22][catchup] ${ctx.label}: ${hints} assets, oldest ${gap} slots behind: ${n} catch-up crank(s) (${wanted} wanted) on ${target.toBase58().slice(0, 8)}…: ${what}`);
  }

  /**
   * Protective trigger (installed into the suppressed lone-LP-crank path). When the LP itself needs protection the v2.2
   * layer runs a full PAIRED round NOW instead of waiting for the next crank cycle. Never a lone LP crank.
   *
   * Signal (the PROGRAM's own, not a capital ratio): (a) a SIMULATION of the LP observation crank (no send) whose logs carry
   * the wrapper's `p3_senior_draw` lines = the LP is liquidatable / a senior draw is due at this mark, or (b)
   * `senior_draw_outstanding > 0` on vault_lp_state.
   *
   * CADENCE (bounded fee spend): signal (a): at most one round per market every 5 s; signal (b) alone: at most one every
   * 30 s; after a protective round that did not settle the LP, the next one waits 5 s x 2^n (10, 20, 40, 80 s, cap 120 s),
   * reset on success. Latency without it: up to one crank cycle (default 20 s) plus a round; with it: about one round (1-5 s).
   */
  private async protectiveRound(marketAddress: string): Promise<void> {
    const entry = this.d.markets().find((m) => m.marketAddress === marketAddress);
    if (!entry || !this.isV22(marketAddress)) return;
    const r = this.rtFor(marketAddress);
    const t = this.now();
    if (r.sweepInflight || t < r.nextProtectiveAtMs || t - r.lastProtectiveAtMs < 5_000) return;
    r.lastProtectiveAtMs = t;
    const load = await loadV22Market(this.d.conn, entry, this.d.programId);
    if (!load.ok) return;
    const ctx = load.ctx;
    let signal = false;
    if (ctx.lpPortfolio) {
      try {
        const sim = await simulateOnly(this.execCtx(), [buildObservationCrankIx(this.d.keeper.publicKey, ctx.market, ctx.lpPortfolio, crankOracleAccounts(ctx))], { units: Math.min(1_400_000, accrueCrankCuFor(400_000, observationAssetsFor(ctx.marketAddress).length)) });
        if (!sim.err) signal = parseSeniorDrawLogs(sim.logs).some((e) => e.kind === "draw" || e.kind === "booked");
      } catch {
        signal = false;
      }
    }
    const outstandingDue = ctx.seniorDrawOutstandingAtoms > 0n && t - r.lastOutstandingRoundAtMs >= 30_000;
    if (!signal && !outstandingDue) return;
    if (!signal) r.lastOutstandingRoundAtMs = t;
    this.log(`[v22][protect] ${ctx.label}: LP needs protection (${signal ? "the program's senior-draw signal" : "senior draw outstanding"}): running a full paired round now`);
    r.positionedCache = null;
    await this.runRoundFor(this.d.conn, entry, true);
    if (r.lastRound?.protective && r.lastRound.lpSettled && r.lastRound.at >= t) {
      r.protectiveFailures = 0;
      r.nextProtectiveAtMs = 0;
    } else {
      r.protectiveFailures++;
      r.nextProtectiveAtMs = t + Math.min(5_000 * 2 ** r.protectiveFailures, 120_000);
    }
  }

  private recordRound(ctx: V22MarketCtx, r: MarketRuntime, res: RoundResult, positioned: V22Positioned, protective: boolean): void {
    const misses = res.missing.filter((m) => m.why !== "current");
    r.lastRound = { paired: res.plan.paired && misses.length === 0, txs: res.plan.txs.length, lpSettled: res.lpSettled, gapSlots: res.gapSlots, abandoned: res.abandoned, settled: res.settled.length, missing: misses.length, protective, at: this.now() };
    const summary = `${r.lastRound.paired ? "PAIRED" : "UNPAIRED"}${protective ? " (protective)" : ""} ${res.merged ? `MERGED 1 tx (phased plan was ${res.plan.txs.length})` : `${res.plan.txs.length} tx(s)`}, lp ${res.lpSettled ? "settled" : res.plan.lpDeferred ? "deferred (strict)" : "not settled"}, settled ${res.settled.length}/${positioned.counterparties.length} counterparties, missing ${misses.length}, pruned ${res.pruned}${res.gapSlots !== null ? `, gap ${res.gapSlots} slots` : ""}${res.abandoned ? `, ${res.abandoned}` : ""}${res.liq.length > 0 ? `, liq ${res.liq.map((l) => l.result).join("/")}` : ""}`;
    this.log(`[v22][sweep] ${ctx.label}: ${summary}`);
  }

  private async publishHealth(ctx: V22MarketCtx, r: MarketRuntime, positioned: V22Positioned, res: RoundResult): Promise<void> {
    let post = ctx.refresh;
    let postData: Uint8Array | null = null;
    try {
      const info = await this.d.conn.getAccountInfo(ctx.market, "processed");
      if (info) {
        postData = new Uint8Array(info.data);
        post = refreshStateForMarket(postData, ctx.marketAddress);
      }
    } catch {
      // keep the pre-read
    }
    const stale = isAssetLossStale(post);
    r.lossStaleCycles = stale ? r.lossStaleCycles + 1 : 0;
    setCrankRefreshHealth(ctx.marketAddress, {
      staleLong: Number(ctx.refresh.staleLong),
      staleShort: Number(ctx.refresh.staleShort),
      postStaleLong: Number(post.staleLong),
      postStaleShort: Number(post.staleShort),
      positioned: positioned.all.length,
      overflow: res.missing.filter((m) => m.why !== "current").length,
      overflowRefreshed: 0,
      overflowError: res.abandoned,
      lossStaleCycles: r.lossStaleCycles,
      status: r.lossStaleCycles >= LOSS_STALE_ALERT_CYCLES ? "loss-stale" : "ok",
      layout: { id: ctx.layout.id, problem: null, kind: "ok", accountLen: ctx.data.length, provisional: ctx.layout.provisional, hasPositions: positioned.all.length > 0 },
      updatedAt: this.now(),
      // K-9: this record replaces the cranker's on v2.2 sweep markets, so it must carry the ADL state itself.
      ...adlHealthOf(postData ?? ctx.data),
    });
  }

  /** One pass of the non-sweep jobs over every registry market. Never throws. */
  async tick(): Promise<void> {
    this.ticks++;
    this.lastTickAt = this.now();
    const f = this.d.flags;
    const exec = this.execCtx();
    this.lifecycle?.beginTick();
    for (const entry of this.d.markets()) {
      try {
        const load = await loadV22Market(this.d.conn, entry, this.d.programId);
        // An RPC failure (not "the account is gone") makes this tick an unclean observation for the lifecycle guards.
        if (!load.ok && load.reason === "unreadable" && load.detail !== "market account not found") this.lifecycle?.noteReadFailure();
        const ctx = this.noteLoad(entry, load);
        if (!ctx) continue;
        const r = this.rtFor(entry.marketAddress);
        r.lastBand = bandHealthFor(ctx);
        this.lifecycle?.observe(ctx); // dead-market classifier, read-only, no extra RPC
        await this.checkLpCert(ctx, r); // read-only; runs even while a round is in flight
        this.checkAdlCloseOnly(ctx, r); // D1, read-only, no extra RPC
        this.checkDepthCapacity(ctx, r, entry.dexType ?? null); // #174, read-only, no extra RPC
        if (r.sweepInflight) continue;
        const needsPositioned = f.feeCrankBond || f.holdingRent || f.dustSweep;
        const positioned = needsPositioned ? await this.positionedFor(ctx, r) : null;
        const pairing = pairingActive(f) ? f.pairing : "off";

        // With the sweep + pairing on, 78 runs at the end of a paired round (runRoundFor); this timer is the sweep-off path.
        if (f.feeCrankBond && ctx.bond && !pairingActive(f) && this.now() - r.lastFeeAtMs >= (this.d.feeIntervalMs ?? 200_000)) {
          r.lastFeeAtMs = this.now();
          const res = await crankBondFee(this.sweepDeps(), ctx, positioned, { mode: pairing, weightBudget: weightBudgetFor() });
          r.lastFee = res.kind === "skipped" ? `skipped: ${res.reason}` : res.kind;
        }
        // With the sweep + pairing on, rent settles ride the round (tag 106 in place of the refresh); this is the sweep-off path.
        if (f.holdingRent && ctx.isRent && positioned && !pairingActive(f)) {
          const res = await settleRentOnce(exec, ctx, positioned, r.rent, { cadenceSlots: f.rentCadenceSlots, pairingActive: pairingActive(f) });
          if (res.outcomes.length > 0) this.log(`[v22][rent] ${ctx.label}: ${res.outcomes.length} settle(s) ${res.outcomes.map((o) => o.outcome.kind).join(",")}`);
        }
        if (f.dustSweep && ctx.isBand && positioned) {
          await sweepDustOnce(exec, ctx, positioned, r.dust);
        }
        if (f.g9) {
          const unitsInfo = await this.d.conn.getAccountInfo(deriveInsuranceUnitsV22(this.d.programId, ctx.market)[0], "processed");
          const g = await g9Once(exec, ctx, unitsInfo ? new Uint8Array(unitsInfo.data) : null, r.g9, { dryRun: f.g9DryRun, allowAnyOracleMode: f.g9AllowAnyOracleMode, mainnetBuild: this.d.mainnetBuild === true, drawCapAtoms: f.g9DrawCapAtoms });
          r.lastG9 = g.action.kind === "none" || g.action.kind === "wait" ? `${g.action.kind}: ${g.action.reason}` : `${g.action.kind}: ${g.outcome?.kind ?? "n/a"}`;
        }
        if (f.stakeSync) {
          const poolInfo = await this.d.conn.getAccountInfo(deriveStakePool(ctx.market, STAKE_PROGRAM_ID)[0], "processed");
          const s = await stakeSyncOnce(exec, ctx, poolInfo ? new Uint8Array(poolInfo.data) : null, r.stake, { intervalMs: f.stakeSyncIntervalMs, nowMs: this.now() });
          r.lastStake = s.kind;
          if (s.kind === "diverged") this.log(`[v22][stake-sync] ${ctx.label}: InsuranceReadingsDiverged(44): backing off ${r.stake.diverged} time(s), no retry until the backoff ends`);
        }
        if (f.stakeCommitTarget) {
          const poolInfo = await this.d.conn.getAccountInfo(deriveStakePool(ctx.market, STAKE_PROGRAM_ID)[0], "processed");
          const c = await stakeCommitTargetOnce(exec, ctx, poolInfo ? new Uint8Array(poolInfo.data) : null, r.commitTarget);
          // "skipped: no pending deploy target" is the steady state; only a pending/waiting/sent target is worth a line in /health
          if (!(c.kind === "skipped")) r.lastCommitTarget = c.kind;
        }
        if (f.earnExit && this.now() - r.lastEarnAtMs >= 30_000) {
          r.lastEarnAtMs = this.now();
          const reqs = await fetchRedemptionRequests(this.d.conn, ctx);
          const ex = await executeKeeperExits(exec, ctx, reqs, 2, r.earn);
          r.lastEarn = ex.gate.ok ? `executed ${ex.outcomes.length}` : `gated: ${ex.gate.reason}`;
        }
      } catch (err) {
        this.log(`[v22] ${entry.label}: tick error: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
        this.lifecycle?.noteReadFailure();
      }
    }
    await this.reconcileLpCert();
    await this.reconcileAdlD1();
    await this.reconcileDepthCapacity();
    try {
      await this.lifecycle?.endTick();
    } catch (err) {
      this.log(`[v22][lifecycle] tick failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /**
   * D1 SLA rollup for /health: how many band markets are close-only, past the tag-104 bound, or overdue, and how many
   * have a stalled vault-LP crank (warn / critical). All zero = nothing is stuck.
   */
  private d1Rollup(): Record<string, unknown> {
    let closeOnly = 0;
    let windDownDue = 0;
    let overdue = 0;
    let lpWarn = 0;
    let lpCritical = 0;
    for (const r of this.rt.values()) {
      const eps = r.lastAdl?.episodes ?? [];
      if (eps.length > 0) closeOnly++;
      if (eps.some((e) => e.level === "wind-down-due" || e.level === "overdue")) windDownDue++;
      if (eps.some((e) => e.level === "overdue")) overdue++;
      if (r.lastLpCert?.level === "warn") lpWarn++;
      if (r.lastLpCert?.level === "critical") lpCritical++;
    }
    return {
      closeOnlyMarkets: closeOnly,
      windDownDueMarkets: windDownDue,
      windDownOverdueMarkets: overdue,
      lpCrankStaleWarnMarkets: lpWarn,
      lpCrankStaleCriticalMarkets: lpCritical,
      windDownBoundSlots: this.adlD1Thresholds.boundSlots.toString(),
      windDownGraceSlots: this.adlD1Thresholds.graceSlots.toString(),
    };
  }

  healthFields(): Record<string, unknown> {
    const markets: Record<string, unknown> = {};
    for (const [addr, r] of this.rt) {
      if (r.layoutNote === null) continue;
      markets[addr] = {
        layout: r.layoutNote,
        ...(r.lastBand ? { band: r.lastBand } : {}),
        ...(r.lastLpCert ? { vaultLpCert: r.lastLpCert } : {}),
        ...(r.lastAdl ? { adlCloseOnly: r.lastAdl } : {}),
        ...(r.lastDepth && r.lastDepth.length > 0 ? { depthCapacity: r.lastDepth.map((d) => ({ assetIndex: d.assetIndex, status: d.status, capDepthE6: d.capDepthE6 === null ? null : d.capDepthE6.toString(), stickyEpochs: d.stickyEpochs, epochsToZero: d.epochsToZero, depthAgeSlots: d.depthAgeSlots === null ? null : d.depthAgeSlots.toString(), depthSource: d.depthSource, depthDexPinned: d.depthDexPinned })) } : {}),
        ...(r.lastRound ? { lastRound: r.lastRound } : {}),
        ...(r.lastFee ? { fee78: r.lastFee } : {}),
        ...(r.lastG9 ? { g9: r.lastG9 } : {}),
        ...(r.lastStake ? { stakeSync: r.lastStake } : {}),
        ...(r.lastCommitTarget ? { stakeCommitTarget: r.lastCommitTarget } : {}),
        ...(r.lastEarn ? { earnExit: r.lastEarn } : {}),
        ...(r.escalated.size > 0 ? { persistentDeferrals: [...r.escalated].map(([k, v]) => ({ portfolio: k, rounds: v.count, sinceMsAgo: this.now() - v.atMs })) } : {}),
        ...(this.layoutProblems.has(addr) ? { layoutProblem: redactErrorText(this.layoutProblems.get(addr) as string, 200) } : {}),
        ...(this.lifecycle?.view(addr) ? { lifecycle: this.lifecycle.view(addr) } : {}),
      };
    }
    return {
      flags: describeV22Flags(this.d.flags),
      ticks: this.ticks,
      lastTickAgoMs: this.lastTickAt === null ? null : this.now() - this.lastTickAt,
      d1: this.d1Rollup(),
      pairing: { ...pairingStats },
      jobs: allJobCounters(),
      layoutProblems: Object.fromEntries([...this.layoutProblems].map(([k, v]) => [k, redactErrorText(v, 200)])),
      markets,
      ...(this.lifecycle ? { lifecycle: this.lifecycle.healthFields() } : {}),
    };
  }
}

/** Run `tick` on an interval until the process ends. Never throws out. */
export async function startV22Loop(loop: V22Loop, tickMs: number): Promise<void> {
  for (;;) {
    try {
      await loop.tick();
    } catch (err) {
      console.error(`[v22] tick crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

/**
 * Liveness repairs of every engine slot of a v2.2 market (lapsed Fresh backing buckets, finalizable ResetPending sides),
 * planned at the slot the market was read at (`planLivenessRepairs`). A slot that does not decode is skipped (never
 * guessed). Exported for tests.
 */
export function livenessRepairsFor(ctx: Pick<V22MarketCtx, "data" | "readSlot" | "slots">): LivenessRepair[] {
  const out: LivenessRepair[] = [];
  for (let i = 0; i < ctx.slots; i++) {
    try {
      out.push(...planLivenessRepairs(decodeLivenessState(ctx.data, i), BigInt(ctx.readSlot)));
    } catch {
      // unreadable slot: no repair planned for it
    }
  }
  return out;
}
