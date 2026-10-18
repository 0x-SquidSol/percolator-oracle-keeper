/**
 * cross-cluster/p2b-wind-down.ts
 *
 * P2b L2 (percolator-prog #525): tag 104 `AdlWindDown` cranks for ADL reduce-only ("close-only")
 * markets.
 *
 * The problem: after a bankruptcy ADL an asset stays reduce-only while either side's A factor is
 * below ADL_ONE, and A returns to ADL_ONE only through a side reset, which needs that side's
 * effective OI at zero. A matched book reopens only when one whole side is flat, which used to
 * wait on abandoned holders indefinitely. Tag 104 lets ANYONE force-close one leg at the mark
 * once the episode has outlived its bound (default 9000 slots, tighten-only per-asset override) or
 * the larger side's notional is dust (<= 10^collateral_decimals atoms).
 *
 * Program facts the design follows (checked against the #526 head's handle_adl_wind_down):
 *   - accounts: [0] caller (any, NOT a signer) [1] market (w) [2] target portfolio (w)
 *     [3] the market's collateral mint [4..] the asset's oracle accounts (none for AUTH_MARK);
 *   - the first call during an episode ARMS it (records the start slot) and closes nothing; a later
 *     start only delays expiry. Not in ADL reduce-only -> EngineNonProgress (22);
 *   - a close needs a fresh committed mark: a lagging / pending mark -> 21, an AUTH_MARK/EWMA_MARK
 *     mark older than 150 slots -> 27 (OracleStale); a stale (portfolio_id, position_epoch)
 *     binding -> 16 (EngineProvenanceMismatch); a deficit account is refused (21: liquidation owns it).
 *   - sol_log_64(104, 0, since, N, now) is logged when armed/not eligible, (104, 1, closed_q,
 *     adl_cleared, now) when a leg was closed: the simulation tells "would close" from "would arm".
 *
 * What the keeper does each cycle, per close-only asset:
 *   1. not armed and not dust  -> ONE arming call on any holder of the leg (sim first);
 *   2. armed, not expired      -> wait (counted);
 *   3. expired or dust         -> if the last landed mark is older than ~140 slots skip (counted;
 *      the program would answer 27), else call it for the portfolios holding the leg on the
 *      reduce-only side (A < ADL_ONE; the engine accepts either side), each with its LIVE
 *      (portfolio_id, position_epoch), simulating first and sending only a simulation that logs a
 *      close. Refusals (21 / 27 / 16 / 22) are classified and counted, never raised.
 *   Bounds: at most `maxSendsPerMarket` sends per market and `maxSendsPerCycle` per cycle, and at
 *   most `maxSimsPerMarket` simulations per market per cycle.
 *
 * The SDK has no decoder for the asset's `market_id` / side-reset epochs, which
 * `adlEpisodeSlotsRemaining` needs; the offsets below are summed from the engine's
 * `AssetStateV16Account` field order (market_id @0, epoch_long @497, epoch_short @505).
 */
import { ComputeBudgetProgram, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  RECOMMENDED_CU_P3,
  ADL_WIND_DOWN_MAX_MARK_AGE_SLOTS,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  V17_ASSET_ORACLE_PROFILE_LEN,
  adlEpisodeSlotsRemaining,
  adlWindDownDustNotionalAtoms,
  buildAdlWindDownIx,
  decodeAdlEpisode,
  parseAssetOracleProfileV17,
  parsePortfolioV17,
  V17_PORTFOLIO_ACCOUNT_LEN,
} from "@percolatorct/sdk";
import type { AdlEpisode } from "@percolatorct/sdk";
import { ADL_ONE, decodeAdlState, isV18MarketHeader } from "./adl-state.ts";
import type { AdlState } from "./adl-state.ts";
import { isComputeExhaustion, parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import { readU64 } from "./p2b-markets.ts";
import type { VaultMarketSnapshot } from "./p2b-markets.ts";
import {
  WIND_DOWN_LOCK_ACTIVE,
  WIND_DOWN_NON_PROGRESS,
  WIND_DOWN_ORACLE_STALE,
  WIND_DOWN_STALE_BINDING,
} from "./lock-codes.ts";
import { addKeeperPriorityFee } from "./priority-fee.ts";

const AS_MARKET_ID = 0;
const AS_EFFECTIVE_PRICE = 25;
const AS_EPOCH_LONG = 497;
const AS_EPOCH_SHORT = 505;
const ASSET_WRAPPER_LEN = 1024;
const POS_SCALE = 1_000_000n;
/** `collateral_mint` inside the wrapper config at market-account offset 16 + 32. */
const CFG_COLLATERAL_MINT_OFF = 16 + 32;

/** Mark age (slots) above which the keeper does not even try a close; the program's own bound is 150. */
export const DEFAULT_WIND_DOWN_MAX_MARK_AGE_SLOTS = 140;

// ── Pure decision ────────────────────────────────────────────────────────────

export interface WindDownView {
  adl: AdlState;
  marketId: bigint;
  epochLong: bigint;
  epochShort: bigint;
  effectivePriceE6: bigint;
  episode: AdlEpisode;
  /** Slots until expiry; null = not armed for the current episode key; 0n = expired. */
  slotsRemaining: bigint | null;
  /** max(larger side's effective OI * effective price / POS_SCALE) in collateral atoms. */
  notionalAtoms: bigint;
  /** `nowSlot - max(profile.last_good_oracle_slot, profile.mark_ewma_last_slot)`; null when the profile does not decode. */
  markAgeSlots: bigint | null;
}

/** Decode everything the decision needs from the raw market account. null when it is not a v18 market / too short. */
export function readWindDownView(marketData: Uint8Array, assetIndex: number, nowSlot: bigint): WindDownView | null {
  // K-9: this view reads the rest of the asset at v2.1 offsets below, so it stays v2.1-only (decodeAdlState itself now
  // decodes v2.2 too, which it used to refuse, and that refusal was this function's only gate).
  if (!isV18MarketHeader(marketData)) return null;
  const adl = decodeAdlState(marketData, assetIndex);
  if (!adl) return null;
  const a = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
  if (marketData.length < a + AS_EPOCH_SHORT + 8) return null;
  const marketId = readU64(marketData, a + AS_MARKET_ID);
  const epochLong = readU64(marketData, a + AS_EPOCH_LONG);
  const epochShort = readU64(marketData, a + AS_EPOCH_SHORT);
  const effectivePriceE6 = readU64(marketData, a + AS_EFFECTIVE_PRICE);
  let episode: AdlEpisode;
  try {
    episode = decodeAdlEpisode(marketData, assetIndex);
  } catch {
    return null;
  }
  const oi = adl.oiEffLong > adl.oiEffShort ? adl.oiEffLong : adl.oiEffShort;
  let markAgeSlots: bigint | null = null;
  try {
    const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
    if (marketData.length >= profileOff + V17_ASSET_ORACLE_PROFILE_LEN) {
      const p = parseAssetOracleProfileV17(marketData, profileOff);
      const last = p.lastGoodOracleSlot > p.markEwmaLastSlot ? p.lastGoodOracleSlot : p.markEwmaLastSlot;
      markAgeSlots = nowSlot > last ? nowSlot - last : 0n;
    }
  } catch {
    markAgeSlots = null;
  }
  return {
    adl,
    marketId,
    epochLong,
    epochShort,
    effectivePriceE6,
    episode,
    slotsRemaining: adlEpisodeSlotsRemaining(episode, marketId, epochLong, epochShort, nowSlot),
    notionalAtoms: (oi * effectivePriceE6) / POS_SCALE,
    markAgeSlots,
  };
}

export type WindDownDecision =
  | { kind: "not-close-only" }
  | { kind: "arm" }
  | { kind: "wait"; slotsRemaining: bigint }
  | { kind: "close"; reason: "expired" | "dust" }
  | { kind: "stale-mark"; reason: "expired" | "dust"; ageSlots: bigint };

/**
 * What to do for one asset this cycle. Pure.
 *   - not reduce-only                    -> nothing;
 *   - dust or expired                    -> close (unless the last mark is older than `maxMarkAgeSlots`: stale-mark);
 *   - otherwise not armed                -> arm; armed and not expired -> wait.
 * Arming needs no fresh mark (the program only checks freshness before a close).
 */
export function decideWindDown(view: WindDownView, dustAtoms: bigint, maxMarkAgeSlots: number): WindDownDecision {
  if (!view.adl.reduceOnly) return { kind: "not-close-only" };
  const dust = view.notionalAtoms <= dustAtoms;
  const expired = view.slotsRemaining === 0n;
  if (dust || expired) {
    const reason = expired ? "expired" : "dust";
    if (view.markAgeSlots !== null && view.markAgeSlots > BigInt(maxMarkAgeSlots)) return { kind: "stale-mark", reason, ageSlots: view.markAgeSlots };
    return { kind: "close", reason };
  }
  if (view.slotsRemaining === null) return { kind: "arm" };
  return { kind: "wait", slotsRemaining: view.slotsRemaining };
}

/** Which side the keeper winds down: the one whose A factor is below ADL_ONE (both: the side with fewer holders). */
export function reduceOnlySide(adl: Pick<AdlState, "aLong" | "aShort">, holdersLong: number, holdersShort: number): "long" | "short" {
  const longRo = adl.aLong !== ADL_ONE;
  const shortRo = adl.aShort !== ADL_ONE;
  if (longRo && !shortRo) return "long";
  if (shortRo && !longRo) return "short";
  return holdersLong <= holdersShort ? "long" : "short";
}

// ── Holders ──────────────────────────────────────────────────────────────────

export interface LegHolder {
  pubkey: PublicKey;
  portfolioId: bigint;
  positionEpoch: bigint;
  longLegs: number;
  shortLegs: number;
  isLp: boolean;
}

/** Portfolios with an active leg on `assetIndex`, with the live binding `(portfolio_id, position_epoch)`. Pure. */
export function selectLegHolders(accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>, assetIndex: number): LegHolder[] {
  const out: LegHolder[] = [];
  for (const { pubkey, data } of accounts) {
    if (data.length !== V17_PORTFOLIO_ACCOUNT_LEN) continue;
    let p;
    try {
      p = parsePortfolioV17(data);
    } catch {
      continue;
    }
    let longLegs = 0;
    let shortLegs = 0;
    for (const leg of p.legs) {
      if (!leg.active || leg.assetIndex !== assetIndex) continue;
      if (leg.side === 0) longLegs++;
      else shortLegs++;
    }
    if (longLegs + shortLegs === 0) continue;
    out.push({ pubkey, portfolioId: p.portfolioId, positionEpoch: p.matcherPositionEpoch, longLegs, shortLegs, isLp: p.matcherEnabled === true });
  }
  return out;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface WindDownConfig {
  maxSendsPerMarket: number;
  maxSendsPerCycle: number;
  maxSimsPerMarket: number;
  maxMarkAgeSlots: number;
  computeUnits: number;
  /**
   * After a turn that sent nothing (every holder refused, or no effect), leave the market alone this
   * long: bounds the holder lookup (getProgramAccounts) and the simulations in a stuck state.
   */
  cooldownMs: number;
  dryRun: boolean;
}

export const DEFAULT_WIND_DOWN_CONFIG: WindDownConfig = {
  maxSendsPerMarket: 3,
  maxSendsPerCycle: 8,
  maxSimsPerMarket: 6,
  maxMarkAgeSlots: DEFAULT_WIND_DOWN_MAX_MARK_AGE_SLOTS,
  computeUnits: RECOMMENDED_CU_P3.tradeCpi,
  cooldownMs: 60_000,
  dryRun: false,
};

type Env = Readonly<Record<string, string | undefined>>;

function envInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}="${raw}" must be an integer in [${min}, ${max}]`);
  return n;
}

/** P2B_WIND_DOWN_MAX_PER_MARKET (3), _MAX_PER_CYCLE (8), _MAX_SIMS (6), _MAX_MARK_AGE_SLOTS (140), _CU (600000), _COOLDOWN_MS (60000). */
export function windDownConfigFromEnv(env: Env, dryRun: boolean): WindDownConfig {
  const d = DEFAULT_WIND_DOWN_CONFIG;
  const maxMarkAge = envInt(env, "P2B_WIND_DOWN_MAX_MARK_AGE_SLOTS", d.maxMarkAgeSlots, 1, ADL_WIND_DOWN_MAX_MARK_AGE_SLOTS);
  return {
    maxSendsPerMarket: envInt(env, "P2B_WIND_DOWN_MAX_PER_MARKET", d.maxSendsPerMarket, 1, 64),
    maxSendsPerCycle: envInt(env, "P2B_WIND_DOWN_MAX_PER_CYCLE", d.maxSendsPerCycle, 1, 256),
    maxSimsPerMarket: envInt(env, "P2B_WIND_DOWN_MAX_SIMS", d.maxSimsPerMarket, 1, 256),
    maxMarkAgeSlots: maxMarkAge,
    computeUnits: envInt(env, "P2B_WIND_DOWN_CU", d.computeUnits, 50_000, 1_400_000),
    cooldownMs: envInt(env, "P2B_WIND_DOWN_COOLDOWN_MS", d.cooldownMs, 0, 3_600_000),
    dryRun,
  };
}

export type RefusalClass = "lagging-or-pending-mark" | "oracle-stale" | "stale-binding" | "not-in-adl" | "other" | "compute";

/** Classify a simulation error of tag 104. Pure. */
export function classifyWindDownError(err: unknown, logs?: ReadonlyArray<string> | null): RefusalClass {
  if (isComputeExhaustion(err, logs)) return "compute";
  const ie = parseInstructionError(err);
  switch (ie?.custom) {
    case WIND_DOWN_LOCK_ACTIVE:
      return "lagging-or-pending-mark";
    case WIND_DOWN_ORACLE_STALE:
      return "oracle-stale";
    case WIND_DOWN_STALE_BINDING:
      return "stale-binding";
    case WIND_DOWN_NON_PROGRESS:
      return "not-in-adl";
    default:
      return "other";
  }
}

/** What a successful simulation of tag 104 logged: "closed" (104, 1, ...), "armed" (104, 0, ...) or nothing recognisable. */
export function windDownSimEffect(logs: ReadonlyArray<string> | null | undefined): "closed" | "armed" | "none" {
  for (const l of logs ?? []) {
    const m = l.match(/0x68, 0x([01]),/);
    if (m) return m[1] === "1" ? "closed" : "armed";
  }
  return "none";
}

export interface WindDownStats {
  cycles: number;
  closeOnlyMarkets: number;
  armed: number;
  waiting: number;
  closed: number;
  sims: number;
  sent: number;
  skippedStaleMark: number;
  skippedCap: number;
  skippedWalletLow: number;
  skippedCooldown: number;
  refusals: Record<RefusalClass, number>;
}

export type WindDownConnection = Pick<
  Connection,
  "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses"
>;

export interface WindDownDeps {
  programId: PublicKey;
  conn: WindDownConnection;
  keeper: Keypair;
  /** Portfolios of `market` holding a leg on `assetIndex` (fresh binding). */
  fetchHolders: (market: PublicKey, assetIndex: number) => Promise<LegHolder[]>;
  /** Collateral decimals of `mint` (cached by the caller / runner). */
  mintDecimals: (mint: PublicKey) => Promise<number>;
  walletLow?: () => boolean;
  confirm?: ConfirmOptions;
  log?: (line: string) => void;
  now?: () => number;
}

export type WindDownMarketResult =
  | { kind: "none" }
  | { kind: "skipped"; why: "wallet-low" | "no-holders" | "cap" | "stale-mark" | "wait" | "cooldown" | "unreadable" }
  | { kind: "acted"; armed: number; closed: number; sims: number; sent: number };

/** The tag-104 runner. One instance per process; `beginCycle()` resets the global send cap. */
export class AdlWindDownRunner {
  private cycleSends = 0;
  private readonly decimals = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  readonly stats: WindDownStats = {
    cycles: 0,
    closeOnlyMarkets: 0,
    armed: 0,
    waiting: 0,
    closed: 0,
    sims: 0,
    sent: 0,
    skippedStaleMark: 0,
    skippedCap: 0,
    skippedWalletLow: 0,
    skippedCooldown: 0,
    refusals: { "lagging-or-pending-mark": 0, "oracle-stale": 0, "stale-binding": 0, "not-in-adl": 0, other: 0, compute: 0 },
  };

  constructor(
    private readonly cfg: WindDownConfig,
    private readonly deps: WindDownDeps,
  ) {}

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  beginCycle(): void {
    this.cycleSends = 0;
    this.stats.cycles++;
  }

  private async decimalsOf(mint: PublicKey): Promise<number> {
    const k = mint.toBase58();
    const c = this.decimals.get(k);
    if (c !== undefined) return c;
    const d = await this.deps.mintDecimals(mint);
    this.decimals.set(k, d);
    return d;
  }

  /** One close-only asset's turn. Never throws. */
  async runMarket(snap: VaultMarketSnapshot): Promise<WindDownMarketResult> {
    try {
      return await this.run(snap);
    } catch (err) {
      this.log(`[p2b-wind-down] ${snap.ref.label}: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
      return { kind: "skipped", why: "unreadable" };
    }
  }

  private async run(snap: VaultMarketSnapshot): Promise<WindDownMarketResult> {
    if (!snap.marketData) return { kind: "none" };
    const assetIndex = snap.ref.assetIndex;
    const nowSlot = BigInt(snap.slot);
    const view = readWindDownView(snap.marketData, assetIndex, nowSlot);
    if (!view || !view.adl.reduceOnly) return { kind: "none" };
    this.stats.closeOnlyMarkets++;
    const mint = new PublicKey(snap.marketData.subarray(CFG_COLLATERAL_MINT_OFF, CFG_COLLATERAL_MINT_OFF + 32));
    const dustAtoms = adlWindDownDustNotionalAtoms(await this.decimalsOf(mint));
    const decision = decideWindDown(view, dustAtoms, this.cfg.maxMarkAgeSlots);
    if (decision.kind === "not-close-only") return { kind: "none" };
    if (decision.kind === "wait") {
      this.stats.waiting++;
      return { kind: "skipped", why: "wait" };
    }
    if (decision.kind === "stale-mark") {
      this.stats.skippedStaleMark++;
      this.log(`[p2b-wind-down] ${snap.ref.label}: ${decision.reason} but the mark is ${decision.ageSlots} slots old (> ${this.cfg.maxMarkAgeSlots}) — skipped until a push lands`);
      return { kind: "skipped", why: "stale-mark" };
    }
    if (this.deps.walletLow?.()) {
      this.stats.skippedWalletLow++;
      return { kind: "skipped", why: "wallet-low" };
    }
    const key = snap.ref.marketAddress;
    const now = (this.deps.now ?? Date.now)();
    const cd = this.cooldownUntil.get(key);
    if (cd !== undefined && now < cd) {
      this.stats.skippedCooldown++;
      return { kind: "skipped", why: "cooldown" };
    }
    const holders = await this.deps.fetchHolders(snap.market, assetIndex);
    if (holders.length === 0) {
      this.cooldownUntil.set(key, now + this.cfg.cooldownMs);
      return { kind: "skipped", why: "no-holders" };
    }

    let sims = 0;
    let sent = 0;
    let armed = 0;
    let closed = 0;
    let capped = false;
    let targets: LegHolder[];
    if (decision.kind === "arm") {
      targets = [holders[0]]; // any holder of the leg: the call only records the episode start
    } else {
      const longHolders = holders.filter((h) => h.longLegs > 0);
      const shortHolders = holders.filter((h) => h.shortLegs > 0);
      const side = reduceOnlySide(view.adl, longHolders.length, shortHolders.length);
      const onSide = side === "long" ? longHolders : shortHolders;
      targets = onSide.length > 0 ? onSide : holders;
    }
    for (const h of targets) {
      if (sims >= this.cfg.maxSimsPerMarket || sent >= this.cfg.maxSendsPerMarket || this.cycleSends >= this.cfg.maxSendsPerCycle) {
        capped = true;
        break;
      }
      const r = await this.callOne(snap, mint, h, nowSlot, decision.kind === "arm" ? "arm" : "close");
      sims++;
      this.stats.sims++;
      if (r === "sent-armed") {
        sent++;
        armed++;
      } else if (r === "sent-closed") {
        sent++;
        closed++;
      }
      if (r === "sent-armed" || r === "sent-closed") {
        this.cycleSends++;
        this.stats.sent++;
      }
      if (decision.kind === "arm") break; // one observation is enough
    }
    if (capped) this.stats.skippedCap++;
    // a turn that sent nothing (all refused / no effect) must not repeat the holder scan every tick
    if (sent === 0 && !capped) this.cooldownUntil.set(key, now + this.cfg.cooldownMs);
    else this.cooldownUntil.delete(key);
    this.stats.armed += armed;
    this.stats.closed += closed;
    return { kind: "acted", armed, closed, sims, sent };
  }

  /** Simulate one tag 104; send it only if the simulation shows the effect we want. */
  private async callOne(
    snap: VaultMarketSnapshot,
    mint: PublicKey,
    h: LegHolder,
    nowSlot: bigint,
    want: "arm" | "close",
  ): Promise<"sent-armed" | "sent-closed" | "refused" | "no-effect" | "dry-run" | "failed"> {
    const { conn, keeper, programId } = this.deps;
    const ix = buildAdlWindDownIx(
      programId,
      { caller: keeper.publicKey, market: snap.market, portfolio: h.pubkey, collateralMint: mint },
      { nowSlot, assetIndex: snap.ref.assetIndex, portfolioId: h.portfolioId, positionEpoch: h.positionEpoch },
      [],
    );
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: this.cfg.computeUnits }));
    tx.add(ix);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    addKeeperPriorityFee(tx); // S3-A2: optional CU price, appended last (OFF by default)
    tx.sign(keeper);
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      const cls = classifyWindDownError(sim.value.err, sim.value.logs);
      this.stats.refusals[cls]++;
      return "refused";
    }
    const effect = windDownSimEffect(sim.value.logs);
    // arming wants the "armed" log; a close wants the "closed" log. Anything else (an Ok catch-up-only
    // return, or a close that would arm because the bound is not met on chain yet) changes nothing worth a tx.
    if ((want === "close" && effect !== "closed") || (want === "arm" && effect !== "armed")) return "no-effect";
    if (this.cfg.dryRun) {
      this.log(`[p2b-wind-down] [DRY-RUN] ${snap.ref.label}: tag 104 (${want}) on ${h.pubkey.toBase58().slice(0, 8)}… would succeed (not sent)`);
      return "dry-run";
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    // wait for the landing: the next simulation (and the on-chain A / OI it reads) must see this close
    const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, this.deps.confirm);
    if (c.status !== "landed") {
      this.log(`[p2b-wind-down] ${snap.ref.label}: tag 104 (${want}) ${c.status === "failed" ? "landed but failed on chain" : "not landed"} sig=${sig.slice(0, 16)}…`);
      return "failed";
    }
    this.log(`[p2b-wind-down] ${snap.ref.label}: tag 104 (${want}) landed on ${h.pubkey.toBase58().slice(0, 8)}… sig=${sig.slice(0, 16)}… (simulated ${sim.value.unitsConsumed ?? "?"} CU of ${this.cfg.computeUnits})`);
    return want === "close" ? "sent-closed" : "sent-armed";
  }
}
