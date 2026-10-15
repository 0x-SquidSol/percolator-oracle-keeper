/**
 * cross-cluster/recovery-cranker.ts
 *
 * Periodic maintenance crank: keeps each registry market's engine-side
 * accrual state (`asset.slot_last` / `header.current_slot`) from drifting
 * too far behind the live chain slot.
 *
 * Why this exists (root cause, verified on-chain 2026-07-06):
 *   The cross-cluster oracle loop (auth-mark-pusher.ts) only ever calls
 *   PushAuthMark, which updates the wrapper's oracle profile (mark_ewma_e6,
 *   oracle_target_price_e6, ...). It never touches the ENGINE's accrual
 *   state. `header.current_slot` only advances inside
 *   `accrue_asset_to_not_atomic`, which runs on a `PermissionlessCrank` or a
 *   trade/settle instruction — never on PushAuthMark.
 *
 *   Once ANY such instruction lands after a long gap, `header.current_slot`
 *   jumps to the live slot (uncapped), but `asset.slot_last` only advances by
 *   `max_accrual_dt_slots` (500 on these markets) per call. Until
 *   `asset.slot_last` catches back up, `asset_is_loss_stale()` reads true and
 *   every RISK-INCREASING trade (new opens / adding to a position) fails with
 *   `Custom(21)` (`PercolatorError::EngineLockActive`, mapped from the
 *   engine's `V16Error::LockActive` in `trade_preflight_risk_gate`).
 *   Risk-decreasing trades (closes) are not gated by this specific check, but
 *   the gap only ever grows while nothing cranks the market, so left alone a
 *   market eventually accumulates enough drift to affect other staleness
 *   gates too (`reject_exposed_target_effective_lag_view`, B-settlement
 *   chunks, etc). This loop prevents the drift from ever growing large by
 *   touching every market on a steady cadence.
 *
 * What it does:
 *   Every `intervalMs` (default 20s), fire one `PermissionlessCrank`
 *   per registry market, targeting that market's matcher-enabled ("LP
 *   vault") portfolio — any account whose stored `market` field matches the
 *   slab works, but the LP portfolio is a stable, market-owned account that
 *   won't disappear if a user closes their position, so it's the safest
 *   fixed target.
 *
 *   v16-migration wire (VERSION 18, integration `a9318945`, dcccrypto/
 *   percolator-prog @ `sync/integration-v16`): the old caller-chosen
 *   `action`/`assetIndex`/`recoveryReason` fields are GONE. The wrapper's
 *   handler (`handle_permissionless_crank_zero_copy`, v16_program.rs) no
 *   longer lets the caller pick an action at all — the engine's
 *   `AutoCrankPlanV16` selector does that internally. What the caller now
 *   supplies is a bounded set of `CrankObservationHint { asset_index,
 *   oracle_accounts }` — raw evidence hints naming which assets it has
 *   fresh price/funding evidence for, and how many trailing oracle
 *   AccountInfos (if any) that evidence occupies in the instruction's
 *   account list.
 *
 *   This loop sends exactly one hint, `{ assetIndex: 0, oracleAccounts: 0 }`
 *   — these are single-asset (asset_index 0) markets on AUTH_MARK oracle
 *   mode (the cross-cluster oracle loop only ever pushes PushAuthMark, see
 *   above), so `hybrid_effective_price_for_crank_view` takes its
 *   `profile_is_auth_mark` branch: the crank price comes straight from the
 *   wrapper's own committed `mark_ewma_e6` (set by the last PushAuthMark),
 *   with NO external oracle account reads at all — `oracle_accounts: 0` is
 *   therefore not an empty/placeholder hint, it is the CORRECT declared
 *   count for this asset's oracle mode, and matches
 *   `ACCOUNTS_PERMISSIONLESS_CRANK_BASE` (owner/market/portfolio only, no
 *   oracle tail). Sending the hint (rather than an empty `observations: []`)
 *   is what makes the engine actually walk this asset's per-hint
 *   oracle-reading loop and call `accrue_asset_to_not_atomic` for it — an
 *   empty observations array would still satisfy a market already in
 *   Recovery mode (mode==2 short-circuits before consuming any hint) but
 *   would do NO accrual work at all on a Live-mode market, defeating this
 *   loop's entire purpose. `nowSlot: 0n` remains correct: the wrapper
 *   authenticates against `Clock::get()` via `authenticated_slot_or_fallback`
 *   regardless of the caller-supplied value (only used as a fallback if the
 *   Clock sysvar read itself fails).
 *
 * Deliberately separate from the oracle push loop:
 *   - Independent interval (crank only needs to run every ~10-30s; the
 *     oracle push runs every ~0.5-7s and must not be slowed down by this).
 *   - Independent errors — a crank failure never touches oracle-push state.
 *   - One transaction per market per cycle, fire-and-forget (no confirm
 *     await), same as the push loop's style.
 *
 * Refreshing positioned portfolios (2026-09-28):
 *   The accrual crank above moves K/F, and every such move marks the whole
 *   positioned cohort stale (`stale_account_count_<side> =
 *   stored_pos_count_<side>`). Until each positioned portfolio is refreshed
 *   the market reads `loss_stale_active` and risk-increasing trades revert
 *   Custom(21). The accrual crank only refreshes the account it targets, so a
 *   market with any third-party position stayed loss-stale forever. Each cycle
 *   now sends, in ONE transaction:
 *     [bounded catch-up cranks if behind] -> accrue(LP, observation)
 *       -> refresh(p) with NO observation for every positioned portfolio p
 *          (non-LP first, LP last)
 *   The refreshes must share the accrual's slot: a no-observation crank is
 *   rejected (Custom(22)) while a mark/funding move is still pending. The
 *   transaction is simulated first; refreshes the engine rejects (e.g. a side
 *   the accrual did not re-stale selects NoAction -> Custom(22)) are pruned,
 *   and the simulated post-state confirms the market ends not loss-stale. See
 *   positioned-refresh.ts for the engine references. (The older note here
 *   that crank instructions cannot share a transaction predates the v18
 *   auto-crank planner; measured on devnet, the sequence above lands clean.)
 */
import {
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { getCachedBlockhash, invalidateBlockhash } from "./blockhash-cache.ts";
import {
  encodePermissionlessCrank,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  V17_PORTFOLIO_ACCOUNT_LEN,
  LAYOUTS_BY_VERSION,
  parsePortfolioV17,
} from "@percolatorct/sdk";
import type { CrankObservationHint } from "@percolatorct/sdk";
import type { MarketEntry, Registry } from "./registry.ts";
import {
  catchupAllowsRefresh,
  catchupCrankCount,
  isBankruptPortfolio,
  decodeMarketRefreshState,
  isAssetLossStale,
  marketHasPositions,
  parseInstructionError,
  isComputeExhaustion,
  legCostModelFor,
  MAX_TX_CU,
  chunkOverflowTargets,
  planCrankTx,
  planRefreshTx,
  positionedSetMatchesMarket,
  selectPositionedPortfolios,
} from "./positioned-refresh.ts";
import type { LegCostModel } from "./positioned-refresh.ts";
import { countLayoutProblem, holdPushes, releasePushes, setCrankRefreshHealth } from "./refresh-coordination.ts";
import { getSweepDelegate } from "./v22/delegation.ts";
import { observationAssetsFor, recordMarketAccrual, refreshStateForMarket } from "./multi-asset.ts";
import { formatProgramError } from "./v22/errors.ts";
import type { MarketLayoutHealth } from "./refresh-coordination.ts";
import { SDK_PORTFOLIO_LENS, describeUnknownLayout, detectLayout } from "./market-layout.ts";
import type { LayoutDetection } from "./market-layout.ts";
import {
  decodeSweepMarketState,
  evaluateCoverage,
  freshSweepCursor,
  markVisited,
  planSweepPace,
  planSweepTx,
  pruneVisits,
  refreshPositionedFrom,
  selectSweepBatch,
  sweepConfigFromEnv,
  sweepEnabledFromEnv,
  sweepHealth,
} from "./positioned-sweep.ts";
import type { SideEpochs, SweepConfig, SweepCoverage, SweepCursor, SweepHealth, SweepPace, SweepPlan } from "./positioned-sweep.ts";
import { createCrankLiveness, crankLivenessOptsFromEnv } from "./crank-liveness.ts";
import type { CrankLiveness } from "./crank-liveness.ts";
import type { CrankPlan, MarketRefreshState, PlannedCrank, PositionedPortfolio } from "./positioned-refresh.ts";
import { decodeLivenessState, describeRepair, planLivenessRepairs } from "./liveness-repair.ts";
import { adlHealth, adlHealthOf, decodeAdlState } from "./adl-state.ts";
import type { AdlAssetHealth } from "./adl-state.ts";
import { isTerminalMarket } from "./market-state.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { isLockFamilyCode } from "./lock-codes.ts";
import { isP2bSupported } from "./p2b-feature.ts";
import { reportSeniorDraw } from "./vault-lp-crank.ts";
import type { AdlState } from "./adl-state.ts";
import type { LivenessRepair } from "./liveness-repair.ts";
import { crankHealthRecord, evaluateCrankHealth, freshStreaks, getAlertSink } from "./alerting.ts";
import type { Alert, AlertSink, CrankHealthSample, CrankHealthStreaks } from "./alerting.ts";

import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
const COMPUTE_UNIT_LIMIT = 250_000;

// ── v17 portfolio account discriminator (verified against live devnet data) ──
// Every v17 portfolio account starts with this 8-byte tag. The market pubkey
// the portfolio belongs to is stored at byte offset 16. A trailing
// PortfolioMatcherConfigV16 block (104 bytes) marks a portfolio as an
// LP-vault / matcher counterparty when its `enabled` u64 (at block offset 96)
// reads 1 — that's the stable, market-owned account this loop targets.
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF = 16;

export interface CrankLoopConfig {
  /** Milliseconds between crank cycle starts. */
  intervalMs: number;
  /** If true, build instructions and log them but do not send. */
  dryRun: boolean;
}

interface CrankMarketState {
  /** Cached LP-vault portfolio bound to this market (from registry.json's seed, or discovered via getProgramAccounts). */
  lpPortfolio: PublicKey | null;
  /**
   * D5: once true, the registry's seeded `lpPortfolio` has been tried and
   * rejected on-chain (e.g. AccountNotFound) — permanently fall through to
   * real getProgramAccounts discovery for this market instead of retrying
   * the same known-bad seeded address forever.
   */
  seedRejected: boolean;
  lastDiscoveryAttemptAt: number;
  /** Cranks that PREFLIGHTED CLEAN and were submitted (real progress). */
  totalCranks: number;
  /** Send/RPC failures (not on-chain reverts). */
  totalErrors: number;
  /** On-chain reverts caught by preflight (EngineStale/EngineLockActive/etc). */
  totalReverts: number;
  /** Consecutive reverts since the last clean crank — the drift early-warning signal. */
  consecutiveReverts: number;
  lastRevertCode: number | null;
  lastCrankAt: number | null;
  lastSig: string | null;
  lastErrorMsg: string | null;
  /** Cached portfolios holding a position on asset 0 (refreshed after each accrual). */
  positioned: PositionedPortfolio[] | null;
  positionedFetchedAt: number;
  /** Set when a simulation still ended loss-stale: re-read the positioned set. */
  positionedDirty: boolean;
  /** Portfolio account length of this market's layout (9,563 B on v2.1; 10,603 B on v2.2 variant B). */
  portfolioLen: number;
  /** Last refresh summary logged, so steady-state cycles stay quiet. */
  lastRefreshSummary: string | null;
  decodeWarned: boolean;
  /** Ops-track health observation from the latest attempt (null until one read the market). */
  obs: CrankObservation | null;
  streaks: CrankHealthStreaks;
  /** B13: last read showed a Resolved market or tombstone — not cranked, no alerts. */
  terminal: boolean;
  /** B7: chain slot of the read behind this market's last landed crank (dedupe within a slot). */
  lastCrankSlot: bigint | null;
  /** B7: benign "no progress this slot" Custom(22) results (not reverts). */
  benignNoProgress: number;
  /** Consecutive cycles that ended with the market still loss-stale (stale count > 0 after our cranks). */
  lossStaleCycles: number;
  /** Last overflow (follow-up refresh) summary logged, so steady-state cycles stay quiet. */
  lastOverflowSummary: string | null;
  /** Sweep (drift-layout markets): last visit per portfolio + the current round (positioned-sweep.ts). */
  sweepCursor: SweepCursor;
  /** Last sweep summary logged, so steady-state cycles stay quiet. */
  lastSweepSummary: string | null;
  /** Last layout problem logged at error level, and how many reads have hit it since. */
  lastLayoutProblem: string | null;
  layoutProblemReads: number;
}

/** What one crank attempt saw — feeds alerting.ts. */
export interface CrankObservation {
  chainSlot: bigint;
  engineSlot: bigint | null;
  crankOk: boolean;
  crankReverted: boolean;
  lapsedBuckets: number;
  bankruptFound: number;
  bankruptLiquidated: number;
  /** ADL reduce-only inputs from the pre-crank read (null: not a v18 market header). */
  adl: AdlState | null;
  /** Multi-asset markets: every non-Disabled asset's ADL state (absent on single-asset markets). */
  adlAssets?: AdlAssetHealth[];
  /** stale_account_count_long/short at the pre-crank read (null: header did not decode). */
  staleLong: number | null;
  staleShort: number | null;
  /** Positioned portfolios targeted for refresh this cycle. */
  positioned: number;
  /** Refreshes that did not fit the accrual tx, and how many landed in follow-up txs. */
  overflow: number;
  overflowRefreshed: number;
  /** Consecutive cycles the market ended loss-stale (set by the cranker after its cranks). */
  lossStaleCycles: number;
  /** Sweep health (drift-layout markets only; absent on legacy markets). */
  sweep?: SweepHealth;
  /** Layout verdict of the market account for this read. */
  layout?: MarketLayoutHealth;
}

export function freshCrankMarketState(): CrankMarketState {
  return {
    lpPortfolio: null,
    seedRejected: false,
    lastDiscoveryAttemptAt: 0,
    totalCranks: 0,
    totalErrors: 0,
    totalReverts: 0,
    consecutiveReverts: 0,
    lastRevertCode: null,
    lastCrankAt: null,
    lastSig: null,
    lastErrorMsg: null,
    positioned: null,
    positionedFetchedAt: 0,
    positionedDirty: false,
    portfolioLen: V17_PORTFOLIO_ACCOUNT_LEN,
    lastRefreshSummary: null,
    decodeWarned: false,
    obs: null,
    streaks: freshStreaks(),
    terminal: false,
    lastCrankSlot: null,
    benignNoProgress: 0,
    lossStaleCycles: 0,
    lastOverflowSummary: null,
    sweepCursor: freshSweepCursor(),
    lastSweepSummary: null,
    lastLayoutProblem: null,
    layoutProblemReads: 0,
  };
}

/**
 * How often to retry LP-portfolio discovery for a market with no seeded
 * `lpPortfolio` (registered live via register-poll, or a seeded market whose
 * seed was rejected — see `seedRejected` above).
 *
 * D5: was 5 * 60_000 (5 min) — LONGER than the ~190s engine accrue-staleness
 * cliff, so a single transient discovery miss right after boot was enough to
 * leave a market un-cranked long enough to die (root cause of the
 * SOL/JUP/TRUMP deaths). 20s keeps every retry well inside the cliff.
 */
const DISCOVERY_RETRY_MS = 20_000;

/** Consecutive reverts on one market before we escalate to a loud ALERT log. */
const REVERT_ALERT_THRESHOLD = 3;

/** Log a full per-market health summary every N cycles so the loop is never silently "healthy". */
const HEALTH_SUMMARY_EVERY_CYCLES = 30;

/**
 * What to tell the operator after a reverted crank, per cause. Only the
 * engine's own staleness codes (19 EngineStale, 21 EngineLockActive) mean the
 * accrual is drifting toward deep-stale; a compute-exhausted plan is a
 * budgeting problem, and anything else is unclassified.
 */
export function revertAdvice(code: number | null, computeExhausted: boolean): string {
  if (computeExhausted) {
    return (
      "The plan ran out of compute even at the transaction maximum, so the engine clock is not advancing " +
      "while this persists: check the per-crank CU estimates against measured cost."
    );
  }
  if (code === 19 || isLockFamilyCode(code)) {
    return "Engine accrual is drifting toward an unrecoverable deep-stale state — investigate / re-seed if this persists.";
  }
  return "Unclassified revert (not compute exhaustion, not an engine staleness code) — investigate the simulation logs.";
}

/** Parse a Solana "custom program error: 0xNN" (or {"Custom":NN}) code out of an error/sim result. */
function parseCustomErrorCode(errLike: unknown): number | null {
  const text =
    typeof errLike === "string"
      ? errLike
      : errLike instanceof Error
        ? errLike.message
        : JSON.stringify(errLike ?? "");
  const hex = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = text.match(/"Custom":\s*(\d+)/);
  return dec ? parseInt(dec[1], 10) : null;
}

/**
 * Run an RPC call with bounded exponential backoff on transient failures
 * (429 rate-limit, fetch/network/5xx). Prevents a rate-limit blip from throwing
 * an UNHANDLED rejection that crashes the whole keeper process — that was the
 * 2026-07-06 crash (`keeper-new.log`: an un-retried 429 in a fire-and-forget
 * send bubbled to Node's unhandledRejection and exited the process).
 */
async function withRpcRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /429|rate.?limit|fetch failed|ETIMEDOUT|ECONNRESET|socket hang up|50[234]/i.test(msg);
      if (!transient || attempt >= maxAttempts) throw err;
      const backoff = Math.min(4_000, 250 * 2 ** (attempt - 1));
      console.warn(`[cranker] ${label}: transient RPC error (attempt ${attempt}/${maxAttempts}) — ${msg.slice(0, 80)}; retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * True iff `data` is a v18 portfolio account (exact `V17_PORTFOLIO_ACCOUNT_LEN`)
 * whose matcher config is enabled — i.e. the market's LP-vault / matcher
 * counterparty that the recovery crank must target.
 *
 * 2026-09-28 root cause of the 6-market engine-clock freeze: the old check
 * read a raw u64 `== 1` at `len - 104 + 96`. That is the v17 layout; v18
 * appends a 24-byte identity trailer after the matcher block AND packs the
 * matcher position epoch into the control word, so on a real LP portfolio it
 * read the wrong bytes (false), while a 240-byte kind-3 v18 account that
 * shares the magic + market prefix happens to end in `01 00..00` (true).
 * Discovery therefore picked that 240-byte account, every crank reverted
 * `InsufficientFundsForRent`, and no market's engine clock advanced from
 * 2026-09-25T02:02Z onward. Decode via the SDK instead of hand offsets, and
 * require the exact portfolio length.
 */
export function isLpVaultPortfolio(data: Uint8Array): boolean {
  if (!SDK_PORTFOLIO_LENS.has(data.length)) return false;
  try {
    return parsePortfolioV17(data).matcherEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Find a matcher-enabled ("LP vault") portfolio bound to `market`. Returns
 * null if none exists yet (e.g. a brand-new market with no LP vault) — the
 * caller should skip cranking that market until discovery succeeds.
 */
export function fetchMarketPortfolios(conn: Connection, market: PublicKey, portfolioLen: number = V17_PORTFOLIO_ACCOUNT_LEN) {
  return conn.getProgramAccounts(WRAPPER_PROGRAM_ID, {
    filters: [
      { dataSize: portfolioLen },
      { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
      { memcmp: { offset: V17_PF_MARKET_OFF, bytes: market.toBase58() } },
    ],
  });
}

/**
 * K-3: resolve the vault-LP portfolio of a market whose registry entry carries no `lpPortfolio` (every market that
 * arrives through register-poll / the create-market wizard). Two sources, both on chain, never a guess:
 *
 *  1. The market's `vault_lp` state PDA (`["vault_lp", market]`, wrapper-owned, kind 9): its `lp_portfolio` field
 *     names the portfolio directly, one read, any layout. Accepted only when that portfolio is a wrapper-owned,
 *     matcher-enabled portfolio of THIS market (same check as the scan below).
 *  2. Fallback: scan the market's portfolios for a matcher-enabled one, once per portfolio length the pinned SDK can
 *     decode (VERSION 18 = 9,563 B, VERSION 19 = 10,603 B). The scan used to filter on the v2.1 length only, so a
 *     v2.2 market (10,603 B portfolios) was never found and never cranked.
 *
 * Exported for tests.
 */
export async function findLpPortfolio(
  conn: Pick<Connection, "getAccountInfo" | "getProgramAccounts">,
  market: PublicKey,
): Promise<PublicKey | null> {
  try {
    const vls = await conn.getAccountInfo(deriveVaultLpState(WRAPPER_PROGRAM_ID, market), "confirmed");
    const st = vls && vls.owner.equals(WRAPPER_PROGRAM_ID) ? decodeVaultLpState(new Uint8Array(vls.data)) : null;
    if (st) {
      const pf = await conn.getAccountInfo(st.lpPortfolio, "confirmed");
      if (pf && pf.owner.equals(WRAPPER_PROGRAM_ID) && portfolioBelongsTo(pf.data, market) && isLpVaultPortfolio(pf.data)) {
        return st.lpPortfolio;
      }
      console.warn(`[cranker] ${market.toBase58().slice(0, 8)}…: vault_lp state names ${st.lpPortfolio.toBase58()}, which is not a matcher-enabled portfolio of this market — scanning instead`);
    }
  } catch {
    // an RPC blip or a mock without getAccountInfo: fall through to the scan
  }
  for (const len of SDK_PORTFOLIO_LENS) {
    const accounts = await fetchMarketPortfolios(conn as Connection, market, len);
    for (const { pubkey, account } of accounts) {
      if (isLpVaultPortfolio(account.data)) return pubkey;
    }
  }
  return null;
}

/** The portfolio's market field (`V17_PF_MARKET_OFF`, the same offset the scan's memcmp filters on) equals `market`. */
function portfolioBelongsTo(data: Uint8Array, market: PublicKey): boolean {
  if (data.length < V17_PF_MARKET_OFF + 32) return false;
  return new PublicKey(data.subarray(V17_PF_MARKET_OFF, V17_PF_MARKET_OFF + 32)).equals(market);
}

// These are single-asset markets — every registry market's only engine
// asset lives at index 0 (matches the pre-migration wire's fixed
// `assetIndex: 0` field). See the module doc comment above for why the
// observation hint below is `{ assetIndex: CRANKED_ASSET_INDEX,
// oracleAccounts: 0 }` and not an empty `observations: []`.
const CRANKED_ASSET_INDEX = 0;

// Exported for testing (see recovery-cranker.test.ts): pins the exact
// PermissionlessCrank wire format this loop sends on every cycle.
export function buildCrankIx(owner: PublicKey, market: PublicKey, portfolio: PublicKey): TransactionInstruction {
  const accountMetas = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
    owner,
    market,
    portfolio,
  });
  // v16-migration wire (VERSION 18, a9318945): PermissionlessCrank no longer
  // takes action/assetIndex/recoveryReason — it takes now_slot plus a bounded
  // list of CrankObservationHint{asset_index, oracle_accounts}. See the
  // module doc comment for the full reasoning; in short, one hint naming
  // this market's only asset (index 0) with 0 oracle accounts (AUTH_MARK
  // mode reads the wrapper's own committed mark_ewma_e6, no external oracle
  // accounts needed or attached) is what makes the engine actually accrue
  // this asset forward on a Live-mode market — an empty observations array
  // would be a true no-op crank here, not a "safe default".
  const observations: CrankObservationHint[] = [
    { assetIndex: CRANKED_ASSET_INDEX, oracleAccounts: 0 },
  ];
  const data = encodePermissionlessCrank({
    nowSlot: 0n, // program authenticates against Clock::get() regardless of this value (authenticated_slot_or_fallback)
    observations,
  });
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: accountMetas,
    data: data as unknown as Buffer,
  });
}

/**
 * One getMultipleAccounts (`processed`, 100 keys per call) for every market the cycle will crank, in
 * place of one getAccountInfo per market. Returns market address -> {value, context}. A market whose
 * chunk failed (or that came back null) is simply absent: crankOneMarket then reads it on its own,
 * which is the pre-existing behaviour, so a failed batch costs calls, never correctness.
 */
export async function readMarketsForCycle(
  devnetConn: Pick<Connection, "getMultipleAccountsInfoAndContext">,
  markets: ReadonlyArray<{ marketAddress: string }>,
  states: ReadonlyMap<string, CrankMarketState>,
): Promise<Map<string, { value: AccountInfo<Buffer>; context: { slot: number } }>> {
  const out = new Map<string, { value: AccountInfo<Buffer>; context: { slot: number } }>();
  // Terminal markets cost no RPC (crankOneMarket returns first); nothing to prefetch for them.
  const wanted = markets.filter((m) => !states.get(m.marketAddress)?.terminal);
  for (let i = 0; i < wanted.length; i += 100) {
    const slice = wanted.slice(i, i + 100);
    try {
      const res = await devnetConn.getMultipleAccountsInfoAndContext(
        slice.map((m) => new PublicKey(m.marketAddress)),
        { commitment: "processed" },
      );
      if (res.value.length !== slice.length) continue;
      slice.forEach((m, j) => {
        const v = res.value[j];
        if (v) out.set(m.marketAddress, { value: v, context: { slot: res.context.slot } });
      });
    } catch {
      /* this chunk's markets fall back to their own read */
    }
  }
  return out;
}

export async function crankOneMarket(
  devnetConn: Connection,
  keeper: Keypair,
  entry: Pick<MarketEntry, "marketAddress" | "label" | "lpPortfolio">,
  state: CrankMarketState,
  dryRun: boolean,
  /**
   * This cycle's market read, taken for ALL markets in one getMultipleAccounts at the start of the
   * cycle (see readMarketsForCycle). Same `processed` commitment and the same moment the per-market
   * reads used to fire (every market starts at once), so the data is no staler. Absent or null = read
   * this market on its own, exactly as before.
   */
  prefetched?: { value: AccountInfo<Buffer> | null; context: { slot: number } } | null,
): Promise<void> {
  // B13: a market seen Resolved/closed stays that way (resolution is one-way,
  // a tombstone is final), so it costs no RPC and no alert from here on.
  if (state.terminal) return;
  const marketAddress = entry.marketAddress;
  const label = entry.label;
  const market = new PublicKey(marketAddress);

  // ── D5: seeded fast path — use registry.json's known lpPortfolio directly,
  // no getProgramAccounts discovery at all. This is what makes crank-on-boot
  // (crankAllOnce, below) deterministic and fast for every seeded market.
  if (!state.lpPortfolio && entry.lpPortfolio && !state.seedRejected) {
    try {
      state.lpPortfolio = new PublicKey(entry.lpPortfolio);
      console.log(`[cranker] ${label}: using seeded LP portfolio ${state.lpPortfolio.toBase58()} (registry.json — no discovery needed)`);
    } catch {
      // Malformed registry data, not a runtime account problem — don't retry
      // parsing garbage every cycle, fall through to real discovery once.
      state.seedRejected = true;
      console.warn(`[cranker] ${label}: registry lpPortfolio "${entry.lpPortfolio}" is not a valid pubkey — falling back to discovery`);
    }
  }

  if (!state.lpPortfolio) {
    const now = Date.now();
    if (now - state.lastDiscoveryAttemptAt < DISCOVERY_RETRY_MS) return; // recently failed, don't hammer getProgramAccounts
    state.lastDiscoveryAttemptAt = now;
    try {
      state.lpPortfolio = await findLpPortfolio(devnetConn, market);
      if (!state.lpPortfolio) {
        console.warn(`[cranker] ${label}: no LP-vault portfolio found yet — skipping until one exists`);
        return;
      }
      console.log(`[cranker] ${label}: discovered LP portfolio ${state.lpPortfolio.toBase58()}`);
    } catch (err) {
      state.lastErrorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[cranker] ${label}: LP-portfolio discovery failed — ${state.lastErrorMsg}`);
      return;
    }
  }

  const lpPortfolio = state.lpPortfolio;
  /** True while this market's pushes are held for follow-up refreshes. */
  let held = false;
  /** This cycle's observation, once the market header decoded (feeds the loss-stale health). */
  let observed: CrankObservation | null = null;
  /** Stale counts after this cycle's cranks; null = unknown (revert, no simulation). */
  let postStale: MarketRefreshState | null = null;
  let overflowError: string | null = null;
  /** Sweep markets: whether a risk-increasing order would be refused at the end of this cycle (null = legacy market). */
  let sweepBlocked: boolean | null = null;

  try {
    // One read gives both the market state and the slot it was read at.
    const acct = prefetched?.value
      ? prefetched
      : await withRpcRetry(label, () => devnetConn.getAccountInfoAndContext(market, "processed"));
    if (!acct.value) throw new Error(`market ${marketAddress} could not find account`);
    // B13 (E2E 2026-09-30): a Resolved market / CloseSlab tombstone is never
    // cranked again. The engine refuses it, and cranking only produced critical
    // crank-reverts + slot-lag alert noise. No observation is recorded, so any
    // open crank alert for it resolves on the next health report.
    if (isTerminalMarket(acct.value.data)) {
      if (!state.terminal) console.log(`[cranker] ${label}: market is Resolved/closed — no longer cranked (wind-down is the terminal-insurance job's)`);
      state.terminal = true;
      state.obs = null;
      state.consecutiveReverts = 0;
      state.lastRevertCode = null;
      return;
    }
    state.terminal = false;
    // K-6: per-asset accrual lag of a multi-asset market for /health (no-op for single-asset markets).
    recordMarketAccrual(marketAddress, acct.value.data, BigInt(acct.context.slot));
    // B7: this market was already cranked (by us) at this slot or later — e.g. the
    // boot crank, then the loop's first cycle in the same slot. A second crank can
    // only return Custom(22) EngineNonProgress; skip it instead of counting a revert.
    if (state.lastCrankSlot !== null && BigInt(acct.context.slot) <= state.lastCrankSlot) return;
    // Which layout is this account? An unknown stride, or a layout whose portfolios the SDK
    // parser cannot read, is NEVER treated as a legacy market: no portfolio is refreshed (the
    // offsets would be guesses), the accrual crank alone keeps the engine clock moving, and the
    // market is reported unhealthy (error log, /health, [health] line, alert).
    const detection = detectLayout(acct.value.data);
    if (detection.known && SDK_PORTFOLIO_LENS.has(detection.layout.portfolioAccountLen)) state.portfolioLen = detection.layout.portfolioAccountLen;
    // v2.2 (KEEPER_V22_SWEEP): the v2.2 layer owns the positioned-refresh sweep of a variant-B market. No delegate is
    // installed unless the flags are on, so every other market (and every market with the flags off) skips this.
    const sweepDelegate = getSweepDelegate();
    /**
     * R3.22b: the v2.2 layer is installed and this is a variant-B market, so the v2.2 layer OWNS it. When its delegate
     * declines a cycle (a gap backoff after a split round, an unreadable positioned set, ...), this path only keeps the
     * engine clock moving: accrual crank (observing every asset), no legacy refresh / sweep, no layout verdict, and no
     * crank-health record (the v2.2 layer publishes that). It used to fall through to the legacy layout check and raise
     * "variant-B market on the legacy cranker" every time 2xhs backed off (flapping layoutProblemMarkets).
     * Without the v2.2 layer (no delegate) a variant-B market still gets the loud "unsupported" verdict, as before.
     */
    const v22Owned = sweepDelegate !== null && detection.known && detection.layout.id === "v2.2-b";
    if (v22Owned) {
      const handled = await sweepDelegate({ conn: devnetConn, keeper, entry, marketData: acct.value.data, slot: acct.context.slot, dryRun });
      if (handled) return;
    }
    let pre: MarketRefreshState | null = null;
    if (detection.known) {
      try {
        // K-6: over every observed asset (exactly decodeMarketRefreshState for a single-asset market).
        pre = refreshStateForMarket(acct.value.data, marketAddress);
      } catch (err) {
        if (!state.decodeWarned) {
          state.decodeWarned = true;
          console.warn(`[cranker] ${label}: market header decode failed (${err instanceof Error ? err.message : String(err)}) — sending accrual crank only`);
        }
      }
    }
    const layoutHealth = v22Owned ? v22OwnedLayoutHealth(detection, pre) : layoutHealthFor(detection, pre);
    if (layoutHealth.problem) noteLayoutProblem(label, marketAddress, state, layoutHealth);
    else state.lastLayoutProblem = null;
    /** The keeper's other v2.1 decoders (liveness repairs, ADL) only read v2.1-compatible headers. */
    const v21Decoders = detection.known && detection.layout.v21Decoders;
    const catchup = pre ? catchupCrankCount(BigInt(acct.context.slot) - pre.slotLast, pre.maxAccrualDtSlots) : 0;
    const positionedAll = pre && !v22Owned && !layoutHealth.problem && marketHasPositions(pre) && catchupAllowsRefresh(catchup)
      ? await positionedPortfoliosFor(devnetConn, market, label, pre, state)
      : [];
    // Drift-layout market (v21-funding-scale program): continuous round-robin sweep of
    // k portfolios per transaction instead of refreshing every positioned portfolio
    // in the accrual's slot. Legacy / unknown layout: sweepCtx stays null and the
    // cycle below is byte-for-byte the previous behaviour.
    const sweepCtx = pre && !v22Owned && !layoutHealth.problem ? sweepContextFor(acct.value.data, positionedAll, state, sweepCfg) : null;
    const targets = sweepCtx ? sweepCtx.firstBatch : positionedAll;

    // Liveness repairs (lapsed Fresh backing bucket, side stuck in ResetPending):
    // states no crank can leave, which revert every crank Custom(19) or every
    // open Custom(21). Prepended to this cycle's transaction; see liveness-repair.ts.
    // K-8: planned on EVERY known layout (offsets per VERSION, liveness-repair.ts livenessOffsetsFor), not only the
    // v2.1-compatible ones: on v2.2 this used to be skipped, so an ADL-reset side stayed ResetPending (opens refused 120).
    let repairs: LivenessRepair[] = [];
    if (detection.known) {
      try {
        repairs = planLivenessRepairs(decodeLivenessState(acct.value.data), BigInt(acct.context.slot));
      } catch {
        repairs = [];
      }
    }
    // K-9: the ADL decoder is per-layout now (v2.2 included); only an unknown layout skips it.
    const obs = observeMarket(acct.value.data, BigInt(acct.context.slot), pre, repairs, { skipAdl: !detection.known });
    obs.layout = layoutHealth;
    state.obs = obs;
    if (!v22Owned && (pre || layoutHealth.problem)) observed = obs;
    if (sweepCtx) {
      // Until this cycle's cranks prove otherwise, the market is as the pre-crank read says.
      sweepBlocked = sweepCtx.coverage.blocksRiskIncrease;
      obs.sweep = sweepHealth(sweepCtx.coverage, sweepCtx.pace, {
        txsSent: 0,
        refreshed: 0,
        pruned: 0,
        positioned: sweepCtx.positioned.length,
        neverVisited: sweepCtx.positioned.filter((p) => !state.sweepCursor.visits.has(p.pubkey.toBase58())).length,
      });
    }

    // Bankrupt positioned portfolios found in a clean simulation's post-state;
    // they get a second crank (the engine's Liquidate step) in the same tx.
    let liquidateTargets: PublicKey[] = [];

    // Leg-aware sizing is selected by the layout: a v2.2 market (up to 4 legs per account) gets it, every v2.1 layout and an
    // unknown one gets `undefined`, i.e. exactly the single-leg arithmetic that was here before.
    const legCost = legCostModelFor(detection.known ? detection.layout : null);
    const lpEntry = positionedAll.find((p) => p.isLp) ?? null;
    const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan =>
      sweepCtx
        ? planSweepTx({ owner: keeper.publicKey, market, lpPortfolio, targets: t, cfg: sweepCfg, catchup, repairs, liquidateTargets, cost: legCost })
        : planCrankTx({ owner: keeper.publicKey, market, lpPortfolio, catchup, refreshTargets: t, repairs, liquidateTargets, cost: legCost, lp: lpEntry });

    if (dryRun) {
      const plan = build(targets);
      console.log(
        `[cranker][DRY-RUN] ${label}: catchup=${catchup} accrue=${lpPortfolio.toBase58().slice(0, 8)}… ` +
          `refresh=[${plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58().slice(0, 8)).join(",")}]` +
          (sweepCtx ? ` sweep=${sweepCtx.pace.level} k=${sweepCtx.pace.k} txs=${sweepCtx.pace.txs} ratio=${sweepCtx.coverage.ratio}` : ""),
      );
      return;
    }

    obs.positioned = positionedAll.length;
    // More positioned portfolios than one transaction can refresh: the rest go out
    // as follow-up transactions, which only land while the mark has not moved since
    // this accrual. Hold this market's pushes from now until they land (auto-expires).
    // A sweep never holds pushes: every sweep transaction carries its own accrual.
    if (!sweepCtx && build(targets).overflow.length > 0) {
      holdPushes(marketAddress, OVERFLOW_PUSH_HOLD_MS);
      held = true;
    }

    const bh = await withRpcRetry(label, () => getCachedBlockhash(devnetConn, "processed"));
    const toTx = (plan: CrankPlan): Transaction => {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits }));
      for (const c of plan.cranks) tx.add(c.ix);
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = keeper.publicKey;
      tx.sign(keeper);
      return tx;
    };

    // PREFLIGHT FIRST so a reverting crank is VISIBLE instead of being silently
    // counted as a success (2026-07-06 root cause: skipPreflight fire-and-forget
    // counted every EngineStale(19)/EngineLockActive(21) revert as progress).
    // The simulation also prunes refreshes the engine would reject (Custom(22)
    // for a portfolio this accrual did not re-stale), and returns the market's
    // post-state so the loop can confirm the market ends not loss-stale.
    const simulate = async (plan: CrankPlan): Promise<SimOutcome> => simulateWith(toTx(plan), plan);
    const simulateWith = async (tx: Transaction, plan: CrankPlan): Promise<SimOutcome> => {
      const refreshed = plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio.toBase58());
      const sim = await withRpcRetry(label, () =>
        devnetConn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
          sigVerify: false,
          commitment: "processed",
          accounts: { encoding: "base64", addresses: [marketAddress, ...refreshed] },
        }),
      );
      const accs = sim.value.accounts ?? [];
      const acc = accs[0];
      const portfolioData = new Map<string, Uint8Array>();
      refreshed.forEach((pk, i) => {
        const a = accs[i + 1];
        if (a) portfolioData.set(pk, Buffer.from(a.data[0], "base64"));
      });
      return {
        err: sim.value.err,
        logs: sim.value.logs ?? null,
        marketData: acc ? Buffer.from(acc.data[0], "base64") : null,
        portfolioData,
      };
    };
    const onOptionalRejected = (c: PlannedCrank) => {
      if (c.kind === "repair") repairs = repairs.filter((x) => x !== c.repair);
      if (c.kind === "liquidate") liquidateTargets = liquidateTargets.filter((x) => !x.equals(c.portfolio));
    };
    let resolved = await resolveCrankPlan(build, targets, simulate, onOptionalRejected, refreshPruneBudget(targets.length));
    // Bankruptcy pass: a positioned account whose post-refresh equity is <= 0 is
    // re-planned with a second crank so the engine liquidates it this cycle.
    if (!resolved.sim.err && resolved.sim.portfolioData) {
      const bankrupt = [...resolved.sim.portfolioData.entries()]
        .filter(([, data]) => isBankruptPortfolio(data))
        .map(([pk]) => new PublicKey(pk));
      if (bankrupt.length > 0) {
        obs.bankruptFound = bankrupt.length;
        liquidateTargets = bankrupt;
        const remaining = targets.filter((t) => !resolved.pruned.some((p) => p.pubkey.equals(t.pubkey)));
        const withLiq = await resolveCrankPlan(build, remaining, simulate, onOptionalRejected, refreshPruneBudget(remaining.length));
        if (!withLiq.sim.err) {
          resolved = { ...withLiq, pruned: [...resolved.pruned, ...withLiq.pruned] };
        } else {
          liquidateTargets = [];
        }
      }
    }

    if (resolved.sim.err && isDuplicateOfLandedTx(resolved.sim.err)) {
      // R3.22b: "AlreadyProcessed" = this exact transaction (same cached blockhash, same instructions) already landed,
      // i.e. the previous cycle's identical crank. Not a revert and not progress: counters untouched, nothing sent.
      state.benignNoProgress++;
      return;
    }
    if (resolved.sim.err && isBenignNoProgress(resolved.sim.err, resolved.plan, pre, BigInt(acct.context.slot))) {
      // B7: EngineNonProgress on the accrual crank while the engine clock is already
      // current = nothing to accrue this slot (a duplicate crank). Not a revert, not
      // progress: counters untouched. A stuck clock is caught by the slot-lag alert.
      state.benignNoProgress++;
      if (state.benignNoProgress === 1) {
        console.log(`[cranker] ${label}: no progress this slot (Custom(22), engine clock current) — expected after a same-slot crank, not counted as a revert`);
      }
      return;
    }
    if (resolved.sim.err) {
      obs.crankReverted = true;
      const code =
        parseCustomErrorCode(resolved.sim.err) ?? parseCustomErrorCode(resolved.sim.logs?.join("\n"));
      state.totalReverts++;
      state.consecutiveReverts++;
      state.lastRevertCode = code;
      // v2.2: a wrapper error 104-124 is logged by NAME (PriceBandPinned(104), EngineLossStale(121), ...), same text otherwise.
      state.lastErrorMsg = `revert ${code != null ? `Custom(${code})${code >= 104 && code <= 124 ? ` ${formatProgramError("wrapper", code)}` : ""}` : JSON.stringify(resolved.sim.err)}`;
      const computeExhausted = isComputeExhaustion(resolved.sim.err, resolved.sim.logs);
      if (computeExhausted) {
        state.lastErrorMsg += ` — compute exhausted at ${resolved.plan.computeUnits} CU (${resolved.plan.cranks.length} cranks)`;
      }
      // 19=EngineStale, 21=EngineLockActive (or 120/121/122 on the P2b program, which split 21) = the deep-stale signature. A fresh /
      // lightly-stale market cranks CLEAN (only a rotting one reverts every cycle),
      // so escalate loudly once it persists.
      if (state.consecutiveReverts === 1 || state.consecutiveReverts % REVERT_ALERT_THRESHOLD === 0) {
        const tag = state.consecutiveReverts >= REVERT_ALERT_THRESHOLD ? "[cranker][ALERT]" : "[cranker][REVERT]";
        console.warn(`${tag} ${label}: crank ${state.lastErrorMsg} (${state.consecutiveReverts}× consecutive). ${revertAdvice(code, computeExhausted)}`);
      }
      return;
    }

    const plan = resolved.plan;
    const tx = toTx(plan);
    // Clean preflight → submit (skipPreflight because we just simulated). Still
    // fire-and-forget on confirmation, like the push loop — a dropped tx just
    // retries next cycle, but we now KNOW it would have executed.
    const signature = await withRpcRetry(label, () =>
      devnetConn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 }),
    );
    state.totalCranks++;
    state.lastCrankSlot = BigInt(acct.context.slot);
    // P3 senior draw: the accrual crank on a vault-LP market can draw its deficit too.
    void reportSeniorDraw(getAlertSink(), marketAddress, label, resolved.sim.logs);
    obs.crankOk = true;
    obs.bankruptLiquidated = plan.cranks.filter((c) => c.kind === "liquidate").length;
    state.lastCrankAt = Date.now();
    state.lastSig = signature;
    state.lastErrorMsg = null;
    if (state.consecutiveReverts > 0) {
      console.log(
        `[cranker] ${label}: RECOVERED — crank landed clean after ${state.consecutiveReverts} revert(s). sig=${signature.slice(0, 12)}…`,
      );
    }
    state.consecutiveReverts = 0;
    state.lastRevertCode = null;

    const liquidated = plan.cranks.filter((c) => c.kind === "liquidate").map((c) => c.portfolio.toBase58().slice(0, 8));
    if (liquidated.length > 0) {
      console.log(`[cranker] ${label}: bankrupt portfolio(s) liquidated: [${liquidated.join(", ")}] sig=${signature.slice(0, 12)}…`);
    }
    const landedRepairs = plan.cranks.filter((c) => c.kind === "repair" && c.repair).map((c) => describeRepair(c.repair!));
    if (landedRepairs.length > 0) {
      console.log(`[cranker] ${label}: liveness repair sent: ${landedRepairs.join(", ")} sig=${signature.slice(0, 12)}…`);
    }
    const rejectedRepairs = resolved.pruned.filter((p) => p.repair);
    if (rejectedRepairs.length > 0) {
      console.warn(
        `[cranker] ${label}: liveness repair rejected in simulation: ` +
          rejectedRepairs.map((p) => `${describeRepair(p.repair!)}:${p.code ?? "?"}`).join(", "),
      );
    }

    let finalPost = decodePostState(resolved.sim.marketData, marketAddress);
    if (sweepCtx) {
      // Visited = refreshed in this tx, or shown not stale by the simulation (Custom(22) prune).
      const visitedThisCycle = new Set<string>(targets.map((t) => t.pubkey.toBase58()));
      const firstVisited = [
        ...plan.cranks.filter((c) => c.kind === "refresh").map((c) => c.portfolio),
        ...resolved.pruned.filter((p) => !p.repair && p.code !== null).map((p) => p.pubkey),
      ];
      markVisited(state.sweepCursor, firstVisited);
      // Weights / epoch snaps / market epochs after the accrual tx steer the follow-ups' order.
      let epochs: SideEpochs = learnFromSim(sweepCtx, resolved.sim) ?? sweepCtx.epochs;
      let lastMarketData: Uint8Array | null = resolved.sim.marketData;
      let fu: SweepFollowupResult | null = null;
      if (sweepCtx.pace.txs > 1) {
        // Spread across slots: each follow-up is simulated only after the previous tx landed.
        const mainLanded = await waitLanded(devnetConn, signature);
        if (mainLanded === "landed") {
          const fuBh = await withRpcRetry(label, () => devnetConn.getLatestBlockhash("processed"));
          const toFuTx = (p: CrankPlan): Transaction => {
            const t = new Transaction();
            t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnits }));
            for (const c of p.cranks) t.add(c.ix);
            t.recentBlockhash = fuBh.blockhash;
            t.feePayer = keeper.publicKey;
            t.sign(keeper);
            return t;
          };
          fu = await runSweepFollowups(sweepCtx.pace.txs - 1, visitedThisCycle, {
            pickBatch: (exclude) => selectSweepBatch(sweepCtx.positioned, state.sweepCursor, sweepCtx.pace.k, exclude, epochs),
            plan: (t, accrue, liq) =>
              planSweepTx({ owner: keeper.publicKey, market, lpPortfolio, targets: t, cfg: sweepCfg, accrue, liquidateTargets: liq, cost: legCost }),
            simulate: (p) => simulateWith(toFuTx(p), p),
            send: (p) =>
              withRpcRetry(label, () => devnetConn.sendRawTransaction(toFuTx(p).serialize(), { skipPreflight: true, maxRetries: 2 })),
            waitLanded: (sig) => waitLanded(devnetConn, sig),
            onVisited: (pks) => markVisited(state.sweepCursor, pks),
            onLanded: (sim) => {
              epochs = learnFromSim(sweepCtx, sim) ?? epochs;
            },
          });
          if (fu.lastMarketData) lastMarketData = fu.lastMarketData;
          obs.bankruptFound += fu.bankruptFound;
          obs.bankruptLiquidated += fu.liquidated;
        } else {
          fu = emptySweepFollowup(`accrual tx ${mainLanded}`);
        }
      }
      finalPost = decodePostState(lastMarketData, marketAddress);
      const postSweep = lastMarketData ? decodeSweepMarketStateSafe(lastMarketData) : null;
      const cov = postSweep ? evaluateCoverage(postSweep) : sweepCtx.coverage;
      sweepBlocked = cov.blocksRiskIncrease;
      const refreshed = plan.cranks.filter((c) => c.kind === "refresh").length + (fu?.refreshed ?? 0);
      const pruned = resolved.pruned.filter((p) => !p.repair).length + (fu?.pruned.length ?? 0);
      obs.sweep = sweepHealth(cov, sweepCtx.pace, {
        txsSent: 1 + (fu?.txsSent ?? 0),
        refreshed,
        pruned,
        positioned: sweepCtx.positioned.length,
        neverVisited: sweepCtx.positioned.filter((p) => !state.sweepCursor.visits.has(p.pubkey.toBase58())).length,
      });
      reportSweepOutcome(label, state, obs.sweep, fu?.error ?? null);
      if (fu?.error) overflowError = `sweep: ${fu.error}`;
    } else if (plan.overflow.length > 0) {
      obs.overflow = plan.overflow.length;
      // Follow-up refreshes: after the accrual lands, before the next push (held above).
      const accrual = await waitLanded(devnetConn, signature);
      let ov: OverflowResult;
      if (accrual !== "landed") {
        ov = { attempted: plan.overflow.length, refreshed: 0, liquidated: 0, bankruptFound: 0, pruned: [], signatures: [], error: `accrual tx ${accrual}` };
      } else {
        const ovBh = await withRpcRetry(label, () => getCachedBlockhash(devnetConn, "processed"));
        const toOvTx = (p: CrankPlan): Transaction => {
          const t = new Transaction();
          t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnits }));
          for (const c of p.cranks) t.add(c.ix);
          t.recentBlockhash = ovBh.blockhash;
          t.feePayer = keeper.publicKey;
          t.sign(keeper);
          return t;
        };
        ov = await refreshOverflow({
          owner: keeper.publicKey,
          market,
          overflow: plan.overflow,
          cost: legCost,
          simulate: (p) => simulateWith(toOvTx(p), p),
          send: (p) =>
            withRpcRetry(label, () => devnetConn.sendRawTransaction(toOvTx(p).serialize(), { skipPreflight: true, maxRetries: 2 })),
          waitLanded: (sig) => waitLanded(devnetConn, sig),
        });
        // Verification read: the stale counts the market really ended with.
        try {
          const after = await withRpcRetry(label, () => devnetConn.getAccountInfo(market, "processed"));
          if (after) finalPost = decodePostState(after.data, marketAddress);
        } catch {
          /* keep the simulated post-state */
        }
      }
      obs.overflowRefreshed = ov.refreshed;
      obs.bankruptFound += ov.bankruptFound;
      obs.bankruptLiquidated += ov.liquidated;
      const staleAfter = finalPost !== null && (finalPost.staleLong !== 0n || finalPost.staleShort !== 0n);
      overflowError = ov.error ?? (staleAfter ? `stale ${finalPost!.staleLong}L/${finalPost!.staleShort}S after follow-ups (pruned ${ov.pruned.length})` : null);
      const ovSummary =
        `overflow=${ov.attempted} refreshed=${ov.refreshed} pruned=${ov.pruned.length}` +
        `${ov.pruned.length ? ` [${ov.pruned.map((p) => `${p.pubkey.toBase58().slice(0, 8)}:${p.code ?? "?"}`).join(",")}]` : ""}` +
        ` txs=${ov.signatures.length} stale_after=${finalPost ? `${finalPost.staleLong}L/${finalPost.staleShort}S` : "?"}` +
        `${ov.error ? ` error=${ov.error}` : ""}`;
      const failed = ov.error !== null || staleAfter;
      if (failed) {
        console.warn(`[cranker][overflow] ${label}: follow-up refreshes did not clear loss-stale (${ovSummary}) — retrying next cycle`);
      } else if (state.lastOverflowSummary !== ovSummary) {
        console.log(`[cranker][overflow] ${label}: follow-up refreshes landed (${ovSummary})`);
      }
      state.lastOverflowSummary = ovSummary;
    }
    if (!sweepCtx && !v22Owned) reportRefreshOutcome(label, pre, resolved, state, finalPost);
    postStale = finalPost;
  } catch (err) {
    state.totalErrors++;
    state.lastErrorMsg = err instanceof Error ? err.message : String(err);
    if (/blockhash/i.test(state.lastErrorMsg)) invalidateBlockhash(devnetConn);
    console.warn(`[cranker] ${label}: crank send failed — ${state.lastErrorMsg.slice(0, 160)}`);
    // A stale-account error (e.g. LP portfolio closed) is worth rediscovering next attempt.
    if (/AccountNotFound|could not find account/i.test(state.lastErrorMsg)) {
      if (entry.lpPortfolio && state.lpPortfolio?.toBase58() === entry.lpPortfolio && !state.seedRejected) {
        // The registry's SEEDED lpPortfolio doesn't exist on-chain — permanently
        // stop retrying it and fall through to real discovery next cycle instead
        // of spinning on the same known-bad address forever.
        state.seedRejected = true;
        console.warn(`[cranker][ALERT] ${label}: seeded LP portfolio ${entry.lpPortfolio} not found on-chain — falling back to discovery`);
      }
      state.lpPortfolio = null;
      state.positioned = null;
    }
  } finally {
    if (held) releasePushes(marketAddress);
    if (observed) publishRefreshHealth(marketAddress, state, observed, postStale, overflowError, sweepBlocked);
  }
}

/** Re-read the positioned set at most this often while it still matches the market. */
const POSITIONED_MAX_AGE_MS = 5 * 60_000;

/**
 * The market's positioned portfolios (active leg on asset 0), cached per
 * market. Re-read when the cached set's leg counts no longer match
 * `stored_pos_count_long/short` (a position opened or closed), when the last
 * simulation still ended loss-stale, or after POSITIONED_MAX_AGE_MS. Never
 * re-read more often than DISCOVERY_RETRY_MS.
 */
async function positionedPortfoliosFor(
  conn: Connection,
  market: PublicKey,
  label: string,
  pre: MarketRefreshState,
  state: CrankMarketState,
): Promise<PositionedPortfolio[]> {
  const now = Date.now();
  const cached = state.positioned;
  const stale =
    cached === null ||
    state.positionedDirty ||
    !positionedSetMatchesMarket(cached, pre) ||
    now - state.positionedFetchedAt > POSITIONED_MAX_AGE_MS;
  if (!stale || (cached !== null && now - state.positionedFetchedAt < DISCOVERY_RETRY_MS)) {
    return cached ?? [];
  }
  state.positionedFetchedAt = now;
  try {
    const accounts = await withRpcRetry(label, () => fetchMarketPortfolios(conn, market, state.portfolioLen));
    // K-6: a leg on ANY observed asset (asset 0 only on a single-asset market).
    const set = selectPositionedPortfolios(accounts.map((a) => ({ pubkey: a.pubkey, data: a.account.data })), observationAssetsFor(market.toBase58()));
    const changed =
      cached === null ||
      cached.length !== set.length ||
      set.some((p) => !cached.some((c) => c.pubkey.equals(p.pubkey)));
    if (changed) {
      console.log(
        `[cranker] ${label}: ${set.length} positioned portfolio(s) to refresh after each accrual: ` +
          `[${set.map((p) => `${p.pubkey.toBase58().slice(0, 8)}${p.isLp ? "(LP)" : ""}`).join(", ")}]`,
      );
    }
    if (!positionedSetMatchesMarket(set, pre)) {
      console.warn(
        `[cranker] ${label}: positioned legs found (${set.reduce((n, p) => n + p.longLegs, 0)}L/${set.reduce((n, p) => n + p.shortLegs, 0)}S) ` +
          `!= market stored_pos_count (${pre.storedPosLong}L/${pre.storedPosShort}S) — refreshing what was found`,
      );
    }
    state.positioned = set;
    state.positionedDirty = false;
    return set;
  } catch (err) {
    console.warn(`[cranker] ${label}: positioned-portfolio discovery failed — ${err instanceof Error ? err.message : String(err)}`);
    return cached ?? [];
  }
}

function decodePostState(data: Uint8Array | null, marketAddress: string): MarketRefreshState | null {
  if (!data) return null;
  try {
    return refreshStateForMarket(data, marketAddress);
  } catch {
    return null;
  }
}

// ── Market layout verdict (market-layout.ts) ─────────────────────────────────

/** Log the layout problem again every this many reads (it is also in /health and alerts). */
export const LAYOUT_PROBLEM_LOG_EVERY = 30;

/**
 * The layout verdict for one read. A problem is either an account that matches
 * no row of the layout table, or a known layout whose portfolio accounts the
 * SDK parser (`parsePortfolioV17`, fixed at V17_PORTFOLIO_ACCOUNT_LEN) cannot
 * read: without the parser the keeper cannot tell which portfolios are
 * positioned, and it does not hand-roll leg offsets.
 */
export function layoutHealthFor(
  detection: LayoutDetection,
  pre: Pick<MarketRefreshState, "storedPosLong" | "storedPosShort"> | null,
  sdkPortfolioLen?: number,
): MarketLayoutHealth {
  const hasPositions = pre ? pre.storedPosLong !== 0n || pre.storedPosShort !== 0n : null;
  if (!detection.known) {
    return {
      id: "unknown",
      problem: describeUnknownLayout(detection),
      kind: "unknown",
      accountLen: detection.accountLen,
      provisional: false,
      hasPositions: null,
    };
  }
  const L = detection.layout;
  const accountLen = L.groupOff + L.headerLen + detection.slots * L.slotStride;
  // The portfolio length the SDK parser reads for THIS layout's VERSION (VERSION-keyed since the v2.2 SDK:
  // 9,563 B for VERSION 18, 10,603 B for VERSION 19). An explicit argument overrides it (tests).
  // v2.2 variant B is NEVER driven by this legacy path (its [LP crank, refresh xN] sweep settles the LP in every tx, the
  // shape SETTLE_PAIRING exists to avoid). The v2.2 layer takes the market through the sweep delegate BEFORE this
  // verdict is reached; anything that gets here (no KEEPER_V22 / KEEPER_V22_SWEEP, or the delegate declined) gets the
  // accrual-only crank and a loud "unsupported" status (security review F-1 / F-5).
  if (L.id === "v2.2-b") {
    return {
      id: L.id,
      problem:
        "variant-B (VERSION 19) market on the legacy cranker: the legacy sweep is refused for v2.2. " +
        "Set KEEPER_V22=on and KEEPER_V22_SWEEP=on (accrual crank only until then)",
      kind: "unsupported",
      accountLen,
      provisional: L.provisional,
      hasPositions,
    };
  }
  sdkPortfolioLen ??= LAYOUTS_BY_VERSION.get(L.wrapperVersion)?.portfolio.accountLen ?? V17_PORTFOLIO_ACCOUNT_LEN;
  if (L.portfolioAccountLen !== sdkPortfolioLen) {
    return {
      id: L.id,
      problem:
        `layout ${L.id} uses ${L.portfolioAccountLen}-byte portfolios (leg ${L.portfolioLegLen} B) but the SDK ` +
        `portfolio parser (parsePortfolioV17) only reads ${sdkPortfolioLen}-byte portfolios`,
      kind: "unsupported",
      accountLen,
      provisional: L.provisional,
      hasPositions,
    };
  }
  return { id: L.id, problem: null, kind: "ok", accountLen, provisional: L.provisional, hasPositions };
}

/** Error-level log (first read, on change, then every LAYOUT_PROBLEM_LOG_EVERY reads) + the counter. */
function noteLayoutProblem(label: string, marketAddress: string, state: CrankMarketState, h: MarketLayoutHealth): void {
  if (h.kind !== "ok") countLayoutProblem(h.kind);
  state.layoutProblemReads = state.lastLayoutProblem === h.problem ? state.layoutProblemReads + 1 : 0;
  if (state.layoutProblemReads % LAYOUT_PROBLEM_LOG_EVERY === 0) {
    console.error(
      `[cranker][LAYOUT] ${label} (${marketAddress}): ${h.problem}; account length ${h.accountLen} — ` +
        "NOT refreshing positioned portfolios (accrual crank only), market reported unhealthy. " +
        "No legacy fallback: fix the layout table in market-layout.ts / the SDK parser.",
    );
  }
  state.lastLayoutProblem = h.problem;
}

// ── Continuous sweep (drift-layout markets, positioned-sweep.ts) ─────────────

/** Sweep sizing, read once at load (KEEPER_SWEEP_* env). */
const sweepCfg: SweepConfig = sweepConfigFromEnv();
const sweepEnabled: boolean = sweepEnabledFromEnv();

function decodeSweepMarketStateSafe(data: Uint8Array) {
  try {
    return decodeSweepMarketState(data);
  } catch {
    return null;
  }
}

export interface SweepContext {
  coverage: SweepCoverage;
  pace: SweepPace;
  /** KF epochs at the read (a leg with kf_epoch_snap below its side's epoch is stale). */
  epochs: SideEpochs;
  /** Every positioned portfolio of the market (the sweep universe). */
  positioned: PositionedPortfolio[];
  /** The first sweep transaction's targets (the cycle's accrual transaction). */
  firstBatch: PositionedPortfolio[];
}

/**
 * The sweep context for one cycle, or null when the market is not drift layout
 * (old program) or the sweep is disabled: the caller then keeps the legacy
 * refresh-everything cycle.
 */
export function sweepContextFor(
  data: Uint8Array,
  positioned: ReadonlyArray<PositionedPortfolio>,
  state: Pick<CrankMarketState, "sweepCursor">,
  cfg: SweepConfig,
  enabled: boolean = sweepEnabled,
): SweepContext | null {
  if (!enabled) return null;
  const s = decodeSweepMarketStateSafe(data);
  if (!s) return null;
  if (positioned.length > 0) pruneVisits(state.sweepCursor, positioned);
  const coverage = evaluateCoverage(s);
  const pace = planSweepPace(coverage, positioned.length, cfg);
  const epochs: SideEpochs = { long: s.kfEpochLong, short: s.kfEpochShort };
  return {
    coverage,
    pace,
    epochs,
    positioned: [...positioned],
    firstBatch: selectSweepBatch(positioned, state.sweepCursor, pace.k, new Set(), epochs),
  };
}

/**
 * Fold a clean simulation's post-state into the sweep context: refreshed
 * portfolios' new loss weights / epoch snaps, and the market's KF epochs (the
 * accrual in that tx bumped them). Returns the new epochs, or null if the market
 * post-state did not decode.
 */
function learnFromSim(ctx: SweepContext, sim: SimOutcome): SideEpochs | null {
  if (sim.portfolioData && sim.portfolioData.size > 0) {
    const fresh = selectPositionedPortfolios(
      [...sim.portfolioData.entries()].map(([pk, data]) => ({ pubkey: new PublicKey(pk), data })),
    );
    refreshPositionedFrom(ctx.positioned, fresh);
  }
  const post = sim.marketData ? decodeSweepMarketStateSafe(sim.marketData) : null;
  return post ? { long: post.kfEpochLong, short: post.kfEpochShort } : null;
}

export interface SweepFollowupDeps {
  /** Next batch, least recently visited first, excluding what this cycle already took. */
  pickBatch: (exclude: ReadonlySet<string>) => PositionedPortfolio[];
  /** `[observation crank (if accrue), refresh x batch]` (+ liquidate cranks for `liq`). */
  plan: (targets: ReadonlyArray<PositionedPortfolio>, accrue: boolean, liq: PublicKey[]) => SweepPlan;
  simulate: (plan: CrankPlan) => Promise<SimOutcome>;
  send: (plan: CrankPlan) => Promise<string>;
  waitLanded: (signature: string) => Promise<LandOutcome>;
  /** Portfolios visited by one landed tx (refreshed, or simulated not stale). */
  onVisited: (pubkeys: PublicKey[]) => void;
  /** The clean simulation of a tx that then landed (post-state of the market and refreshed portfolios). */
  onLanded?: (sim: SimOutcome) => void;
}

export interface SweepFollowupResult {
  txsSent: number;
  txsLanded: number;
  /** Of the landed txs, how many were refresh-only (an earlier tx had accrued the slot). */
  refreshOnly: number;
  refreshed: number;
  liquidated: number;
  bankruptFound: number;
  pruned: { pubkey: PublicKey; code: number | null }[];
  /** Simulated market post-state of the last landed tx. */
  lastMarketData: Uint8Array | null;
  error: string | null;
}

export function emptySweepFollowup(error: string | null = null): SweepFollowupResult {
  return { txsSent: 0, txsLanded: 0, refreshOnly: 0, refreshed: 0, liquidated: 0, bankruptFound: 0, pruned: [], lastMarketData: null, error };
}

/**
 * The cycle's extra sweep transactions, one at a time: each is simulated only
 * after the previous one landed, so the simulation sees the real slot state.
 * If the observation crank is rejected Custom(22) (the asset is already accrued
 * in this slot because the previous sweep tx landed in it), the batch is sent
 * refresh-only instead. Refreshes the simulation rejects are pruned (a
 * non-stale portfolio counts as visited); a bankrupt post-refresh portfolio
 * gets its liquidate crank. Stops at the first failure, or when every
 * positioned portfolio has been taken this cycle. Never throws.
 */
export async function runSweepFollowups(
  count: number,
  takenThisCycle: Set<string>,
  deps: SweepFollowupDeps,
): Promise<SweepFollowupResult> {
  const out = emptySweepFollowup();
  try {
    for (let i = 0; i < count; i++) {
      const batch = deps.pickBatch(takenThisCycle);
      if (batch.length === 0) break;
      for (const p of batch) takenThisCycle.add(p.pubkey.toBase58());
      let liquidate: PublicKey[] = [];
      let accrue = true;
      const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan => deps.plan(t, accrue, liquidate);
      const onOptional = (c: PlannedCrank) => {
        if (c.kind === "liquidate") liquidate = liquidate.filter((x) => !x.equals(c.portfolio));
      };
      const budget = refreshPruneBudget(batch.length, { uncapped: true });
      let resolved = await resolveCrankPlan(build, batch, deps.simulate, onOptional, budget);
      if (resolved.sim.err) {
        const ie = parseInstructionError(resolved.sim.err);
        const crank = ie && ie.index >= 1 ? resolved.plan.cranks[ie.index - 1] : undefined;
        if (crank?.kind === "accrue" && ie?.custom === ENGINE_NON_PROGRESS) {
          accrue = false;
          resolved = await resolveCrankPlan(build, batch, deps.simulate, onOptional, budget);
        }
      }
      if (!resolved.sim.err && resolved.sim.portfolioData) {
        const bankrupt = [...resolved.sim.portfolioData.entries()]
          .filter(([, d]) => isBankruptPortfolio(d))
          .map(([pk]) => new PublicKey(pk));
        if (bankrupt.length > 0) {
          out.bankruptFound += bankrupt.length;
          liquidate = bankrupt;
          const remaining = batch.filter((t) => !resolved.pruned.some((p) => p.pubkey.equals(t.pubkey)));
          const withLiq = await resolveCrankPlan(build, remaining, deps.simulate, onOptional, budget);
          if (!withLiq.sim.err) resolved = { ...withLiq, pruned: [...resolved.pruned, ...withLiq.pruned] };
          else liquidate = [];
        }
      }
      const prunedNow = resolved.pruned.filter((p) => !p.repair);
      for (const p of prunedNow) out.pruned.push({ pubkey: p.pubkey, code: p.code });
      if (resolved.sim.err) {
        const code = parseInstructionError(resolved.sim.err)?.custom ?? null;
        out.error = `sweep simulation failed ${code !== null ? `Custom(${code})` : JSON.stringify(resolved.sim.err)}`;
        break;
      }
      const notStale = prunedNow.filter((p) => p.code !== null).map((p) => p.pubkey);
      const refreshes = resolved.plan.cranks.filter((c) => c.kind === "refresh");
      if (refreshes.length === 0) {
        if (notStale.length > 0) deps.onVisited(notStale);
        continue; // nothing stale in this batch: no tx
      }
      const sig = await deps.send(resolved.plan);
      out.txsSent++;
      const landed = await deps.waitLanded(sig);
      if (landed !== "landed") {
        out.error = `sweep tx ${sig.slice(0, 12)}… ${landed}`;
        break;
      }
      out.txsLanded++;
      if (!accrue) out.refreshOnly++;
      out.refreshed += refreshes.length;
      out.liquidated += resolved.plan.cranks.filter((c) => c.kind === "liquidate").length;
      if (resolved.sim.marketData) out.lastMarketData = resolved.sim.marketData;
      deps.onVisited([...refreshes.map((c) => c.portfolio), ...notStale]);
      deps.onLanded?.(resolved.sim);
    }
  } catch (err) {
    out.error = `sweep send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
  return out;
}

function reportSweepOutcome(label: string, state: CrankMarketState, h: SweepHealth, error: string | null): void {
  const summary =
    `pace=${h.pace} k=${h.k} txs=${h.txsSent}/${h.txsPlanned} refreshed=${h.refreshed} pruned=${h.pruned} ` +
    `positioned=${h.positioned} unvisited=${h.neverVisited} stale=${h.staleLong}L/${h.staleShort}S ` +
    `laggards=${h.laggardLong}L/${h.laggardShort}S covered=${h.covered} ratio=${h.coverageRatio ?? "inf"}` +
    `${h.relaxedEligible ? "" : ` ineligible=${h.ineligibleReason}`}${error ? ` error=${error}` : ""}`;
  // Log on a change of regime, not every cycle (the counts move every cycle by design).
  const regime = `${h.pace}|${h.covered}|${h.relaxedEligible}|${h.blocksRiskIncrease}|${error !== null}`;
  if (h.blocksRiskIncrease || error) {
    if (state.lastSweepSummary !== regime) console.warn(`[cranker][sweep] ${label}: orders would be refused or the sweep failed (${summary})`);
  } else if (state.lastSweepSummary !== regime) {
    console.log(`[cranker][sweep] ${label}: ${summary}`);
  }
  state.lastSweepSummary = regime;
}

function reportRefreshOutcome(
  label: string,
  pre: MarketRefreshState | null,
  resolved: ResolvedCrankPlan,
  state: CrankMarketState,
  /** Market state after ALL of this cycle's cranks (accrual tx + follow-up refreshes). */
  post: MarketRefreshState | null,
): void {
  const refreshed = resolved.plan.cranks.filter((c) => c.kind === "refresh").length + (state.obs?.overflowRefreshed ?? 0);
  // A positioned portfolio left unrefreshed shows up as a non-zero stale count;
  // the slot_last < current_slot clause of the predicate is not a refresh problem.
  const postStale = post ? post.staleLong !== 0n || post.staleShort !== 0n : null;
  const summary =
    `refreshed=${refreshed} pruned=${resolved.pruned.length}` +
    `${resolved.pruned.length ? ` [${resolved.pruned.map((p) => `${p.pubkey.toBase58().slice(0, 8)}:${p.code ?? "?"}`).join(",")}]` : ""}` +
    ` loss_stale ${pre ? Number(pre.lossStaleActive) : "?"}→${post ? Number(post.lossStaleActive) : "?"}` +
    ` stale ${pre ? `${pre.staleLong}L/${pre.staleShort}S` : "?"}→${post ? `${post.staleLong}L/${post.staleShort}S` : "?"}`;
  if (postStale && pre && marketHasPositions(pre)) {
    // Something positioned was not refreshed: re-read the set next cycle.
    state.positionedDirty = true;
    if (state.lastRefreshSummary !== summary) {
      console.warn(`[cranker] ${label}: market still loss-stale after crank (${summary}) — re-discovering positioned portfolios`);
    }
  } else if (state.lastRefreshSummary !== summary && (refreshed > 0 || resolved.pruned.length > 0)) {
    console.log(`[cranker] ${label}: accrue + refresh ok (${summary})`);
  }
  state.lastRefreshSummary = summary;
}

export interface SimOutcome {
  err: unknown;
  logs: string[] | null;
  marketData: Uint8Array | null;
  /** Post-simulation data of each refreshed portfolio, keyed by base58. */
  portfolioData?: Map<string, Uint8Array>;
}

export interface ResolvedCrankPlan {
  plan: CrankPlan;
  sim: SimOutcome;
  /** Refreshes (and, with `repair` set, liveness repairs) dropped after a simulated rejection. */
  pruned: { pubkey: PublicKey; code: number | null; repair?: LivenessRepair }[];
}

/** Refreshes pruned one at a time before giving up on refreshing this cycle. */
export const MAX_REFRESH_PRUNES = 3;
/**
 * Prune budget the cranker actually uses: one per positioned portfolio, capped.
 * When an accrual does not move K/F, every refresh of a NON-stale portfolio
 * returns Custom(22) (NoAction), so a budget of 3 gave up before reaching the
 * stale one (live 2026-10-02: Percolator pruned=12 with 1L still stale).
 */
export function refreshPruneBudget(targets: number, opts: { uncapped?: boolean } = {}): number {
  const scaled = Math.max(MAX_REFRESH_PRUNES, targets);
  // R3-M1 (P2b): on a P2b program every open portfolio must be TOUCHED each cycle (the Earn exit's
  // touch-order skim is bounded by what is left stale), so the budget must never drop a refresh
  // merely because the set outgrew the cap: above MAX_REFRESH_PRUNE_BUDGET positioned portfolios
  // the capped budget used to drop every remaining refresh (even a stale one) after 16 NoAction
  // rejections. Uncapped it is one prune per target, i.e. each target is simulated (refreshed or
  // genuinely rejected by the engine) before the cycle degrades. Today's programs keep the cap.
  const uncapped = opts.uncapped ?? isP2bSupported();
  return uncapped ? scaled : Math.min(MAX_REFRESH_PRUNE_BUDGET, scaled);
}
export const MAX_REFRESH_PRUNE_BUDGET = 16;
/** Optional instructions (<= 2 expiries + 2 finalizes, plus liquidations) dropped before giving up. */
export const MAX_REPAIR_DROPS = 8;

/**
 * Simulate the plan and drop refreshes the engine rejects, one per
 * simulation, until the transaction simulates clean. A failure on a catch-up
 * or accrual crank is returned as-is for the revert path. After
 * MAX_REFRESH_PRUNES prunes every remaining refresh is dropped, so the cycle
 * degrades to the accrual-only crank this loop always sent (at most
 * MAX_REFRESH_PRUNES + 2 simulations).
 *
 * Instruction 0 of every crank transaction is the compute-budget ix, so
 * simulation index i maps to plan.cranks[i - 1].
 */
export async function resolveCrankPlan(
  build: (targets: ReadonlyArray<PositionedPortfolio>) => CrankPlan,
  targets: ReadonlyArray<PositionedPortfolio>,
  simulate: (plan: CrankPlan) => Promise<SimOutcome>,
  /**
   * Called when a liveness repair or a bankruptcy liquidate crank is the
   * rejected instruction. The caller must drop it from what `build` emits; the plan is then re-simulated without it,
   * so a repair the engine refuses can never block the ordinary crank.
   */
  onOptionalRejected?: (crank: PlannedCrank) => void,
  /** Refreshes pruned before every remaining one is dropped (default MAX_REFRESH_PRUNES). */
  maxPrunes: number = MAX_REFRESH_PRUNES,
): Promise<ResolvedCrankPlan> {
  let remaining = [...targets];
  const pruned: { pubkey: PublicKey; code: number | null; repair?: LivenessRepair }[] = [];
  let repairDrops = 0;
  for (;;) {
    let plan = build(remaining);
    let sim = await simulate(plan);
    // Compute exhaustion is not an engine verdict on the failing instruction:
    // the whole transaction ran out of budget, and the instruction it stopped
    // at is just the one the meter reached. Pruning it (the old behaviour)
    // shrank the budget with it and cascaded to an accrual-only plan that was
    // itself under-budget (OTC 2026-10-03/04: ProgramFailedToComplete at the
    // accrual, streaks of 3-8 cycles). Re-simulate the SAME plan once at the
    // transaction maximum; only a failure there is attributed to an instruction.
    if (sim.err && plan.computeUnits < MAX_TX_CU && isComputeExhaustion(sim.err, sim.logs)) {
      plan = { ...plan, computeUnits: MAX_TX_CU };
      sim = await simulate(plan);
    }
    if (!sim.err) return { plan, sim, pruned };
    const ie = parseInstructionError(sim.err);
    const crank = ie && ie.index >= 1 ? plan.cranks[ie.index - 1] : undefined;
    if (
      crank &&
      (crank.kind === "repair" || crank.kind === "liquidate") &&
      onOptionalRejected &&
      repairDrops < MAX_REPAIR_DROPS
    ) {
      repairDrops++;
      if (crank.kind === "repair") pruned.push({ pubkey: crank.portfolio, code: ie?.custom ?? null, repair: crank.repair });
      onOptionalRejected(crank);
      continue;
    }
    if (!crank || crank.kind !== "refresh") return { plan, sim, pruned };
    pruned.push({ pubkey: crank.portfolio, code: ie?.custom ?? null });
    remaining = remaining.filter((p) => !p.pubkey.equals(crank.portfolio));
    if (pruned.filter((p) => !p.repair).length >= maxPrunes && remaining.length > 0) {
      for (const p of remaining) pruned.push({ pubkey: p.pubkey, code: null });
      remaining = [];
    }
  }
}

// ── Overflow refreshes (2026-10-02 Percolator outage) ───────────────────────
//
// A market with more positioned portfolios than one transaction can refresh
// (7 at 145k CU each under the 1.4M cap, after the accrual and its headroom) used to leave the
// rest stale: stale_account_count stayed > 0, loss_stale held, and every
// risk-increasing trade reverted Custom(21) indefinitely (Percolator 9EPm8nB8,
// 12 positioned, locked for opens from ~18:55Z). The rest now go out as
// follow-up refresh-only transactions once the accrual has landed. A
// no-observation refresh is only accepted while the committed mark has not
// moved since the accrual, so the market's pushes are held (refresh-
// coordination.ts) from before the accrual until the follow-ups land.

/** Push hold for a market with overflow refreshes (auto-expires; released as soon as they land). */
export const OVERFLOW_PUSH_HOLD_MS = 12_000;
/** How long to wait for one transaction to show up (processed) before giving up on it this cycle. */
export const LAND_TIMEOUT_MS = 6_000;
const LAND_POLL_MS = 400;
/** Consecutive cycles ending loss-stale before the market's crank status turns "loss-stale". */
export const LOSS_STALE_ALERT_CYCLES = (() => {
  const n = Number(process.env.ALERT_LOSS_STALE_CYCLES ?? "3");
  return Number.isInteger(n) && n > 0 ? n : 3;
})();

export type LandOutcome = "landed" | "failed" | "timeout";

/** Poll the signature status until it is processed (or better), failed, or LAND_TIMEOUT_MS passes. */
export async function waitLanded(
  conn: Pick<Connection, "getSignatureStatuses">,
  signature: string,
  timeoutMs = LAND_TIMEOUT_MS,
  pollMs = LAND_POLL_MS,
): Promise<LandOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const st = (await conn.getSignatureStatuses([signature])).value[0];
      if (st) return st.err ? "failed" : "landed";
    } catch {
      /* transient: keep polling until the deadline */
    }
    if (Date.now() >= deadline) return "timeout";
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface OverflowResult {
  attempted: number;
  /** Refresh cranks in follow-up transactions that landed. */
  refreshed: number;
  liquidated: number;
  bankruptFound: number;
  /** Refreshes dropped after a simulated rejection (Custom(22): not stale, or the mark moved). */
  pruned: { pubkey: PublicKey; code: number | null }[];
  signatures: string[];
  /** Why the follow-ups did not all go out / land; null when they did. */
  error: string | null;
}

/**
 * Send the overflow refreshes as follow-up transactions: chunked to the CU cap,
 * each chunk simulated (pruning rejected refreshes, adding a liquidate crank for
 * an account the simulation shows bankrupt) and then sent. Waits for every
 * chunk to land. Never throws for an RPC/simulation failure: the error is
 * returned and the next cycle (a fresh accrual) tries again.
 */
export async function refreshOverflow(params: {
  owner: PublicKey;
  market: PublicKey;
  overflow: ReadonlyArray<PositionedPortfolio>;
  /** Leg-aware sizing (v2.2); omitted = the single-leg arithmetic, unchanged. */
  cost?: LegCostModel;
  simulate: (plan: CrankPlan) => Promise<SimOutcome>;
  send: (plan: CrankPlan) => Promise<string>;
  waitLanded: (signature: string) => Promise<LandOutcome>;
}): Promise<OverflowResult> {
  const { owner, market, overflow } = params;
  const out: OverflowResult = {
    attempted: overflow.length, refreshed: 0, liquidated: 0, bankruptFound: 0, pruned: [], signatures: [], error: null,
  };
  const sent: { sig: string; refreshes: number; liquidates: number }[] = [];
  // Every refresh of a chunk pruned: nothing left to simulate (an empty tx is not a test of anything).
  const simulate = async (plan: CrankPlan): Promise<SimOutcome> =>
    plan.cranks.length === 0 ? { err: null, logs: [], marketData: null } : params.simulate(plan);
  try {
    for (const chunk of chunkOverflowTargets(overflow, undefined, params.cost)) {
      let liquidate: PublicKey[] = [];
      const build = (t: ReadonlyArray<PositionedPortfolio>): CrankPlan =>
        planRefreshTx({ owner, market, targets: t, liquidateTargets: liquidate, cost: params.cost });
      const onOptional = (c: PlannedCrank) => {
        if (c.kind === "liquidate") liquidate = liquidate.filter((x) => !x.equals(c.portfolio));
      };
      let resolved = await resolveCrankPlan(build, chunk, simulate, onOptional, refreshPruneBudget(chunk.length));
      if (!resolved.sim.err && resolved.sim.portfolioData) {
        const bankrupt = [...resolved.sim.portfolioData.entries()]
          .filter(([, d]) => isBankruptPortfolio(d))
          .map(([pk]) => new PublicKey(pk));
        if (bankrupt.length > 0) {
          out.bankruptFound += bankrupt.length;
          liquidate = bankrupt;
          const remaining = chunk.filter((t) => !resolved.pruned.some((p) => p.pubkey.equals(t.pubkey)));
          const withLiq = await resolveCrankPlan(build, remaining, simulate, onOptional, refreshPruneBudget(remaining.length));
          if (!withLiq.sim.err) resolved = { ...withLiq, pruned: [...resolved.pruned, ...withLiq.pruned] };
        }
      }
      for (const p of resolved.pruned) if (!p.repair) out.pruned.push({ pubkey: p.pubkey, code: p.code });
      if (resolved.sim.err) {
        const code = parseInstructionError(resolved.sim.err)?.custom ?? null;
        out.error = `follow-up simulation failed ${code !== null ? `Custom(${code})` : JSON.stringify(resolved.sim.err)}`;
        break;
      }
      const refreshes = resolved.plan.cranks.filter((c) => c.kind === "refresh").length;
      if (refreshes === 0) continue; // every refresh of this chunk was rejected (pruned, reported above)
      const sig = await params.send(resolved.plan);
      out.signatures.push(sig);
      sent.push({ sig, refreshes, liquidates: resolved.plan.cranks.filter((c) => c.kind === "liquidate").length });
    }
  } catch (err) {
    out.error = `follow-up send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
  const outcomes = await Promise.all(sent.map((x) => params.waitLanded(x.sig)));
  outcomes.forEach((o, i) => {
    if (o === "landed") {
      out.refreshed += sent[i].refreshes;
      out.liquidated += sent[i].liquidates;
    } else if (out.error === null) {
      out.error = `follow-up tx ${sent[i].sig.slice(0, 12)}… ${o}`;
    }
  });
  // Every refresh rejected is not an error by itself: Custom(22) is also what a
  // portfolio that is not stale returns. The caller's verification read decides.
  return out;
}

/** Stale counts the market ended this cycle with: the post-state when known, else the pre-crank read. */
export function endedLossStale(
  obs: Pick<CrankObservation, "staleLong" | "staleShort">,
  post: Pick<MarketRefreshState, "staleLong" | "staleShort"> | null,
): boolean {
  if (post) return post.staleLong !== 0n || post.staleShort !== 0n;
  return (obs.staleLong ?? 0) !== 0 || (obs.staleShort ?? 0) !== 0;
}

function publishRefreshHealth(
  marketAddress: string,
  state: CrankMarketState,
  obs: CrankObservation,
  post: MarketRefreshState | null,
  overflowError: string | null,
  /**
   * Drift-layout (sweep) markets: whether a risk-increasing order is refused at
   * the end of the cycle. Stale portfolios are the steady state there (every
   * accrual re-stales them with funding > 0); what blocks orders is a bound the
   * insurance does not cover, so that is what the loss-stale streak counts.
   * null = legacy market: the streak counts non-zero stale counts, as before.
   */
  sweepBlocked: boolean | null = null,
): void {
  const ended = sweepBlocked !== null ? sweepBlocked : endedLossStale(obs, post);
  state.lossStaleCycles = ended ? state.lossStaleCycles + 1 : 0;
  obs.lossStaleCycles = state.lossStaleCycles;
  setCrankRefreshHealth(marketAddress, {
    staleLong: obs.staleLong ?? 0,
    staleShort: obs.staleShort ?? 0,
    postStaleLong: post ? Number(post.staleLong) : null,
    postStaleShort: post ? Number(post.staleShort) : null,
    positioned: obs.positioned,
    overflow: obs.overflow,
    overflowRefreshed: obs.overflowRefreshed,
    overflowError,
    lossStaleCycles: state.lossStaleCycles,
    status:
      obs.layout?.kind === "unknown"
        ? "layout-unknown"
        : obs.layout?.kind === "unsupported"
          ? "layout-unsupported"
          : state.lossStaleCycles >= LOSS_STALE_ALERT_CYCLES
            ? "loss-stale"
            : "ok",
    updatedAt: Date.now(),
    ...(obs.layout ? { layout: obs.layout } : {}),
    ...(obs.adl ? { adl: adlHealth(obs.adl) } : {}),
    ...(obs.adlAssets ? { adlAssets: obs.adlAssets } : {}),
    ...(obs.sweep ? { sweep: obs.sweep } : {}),
  });
}

/**
 * D1: Deterministic crank-on-boot. Cranks every SEEDED market (one with a
 * known `lpPortfolio` in registry.json) exactly once, using ONLY that seeded
 * address — no getProgramAccounts discovery calls — so this resolves in a
 * small, bounded number of RPC round-trips regardless of registry size.
 *
 * Call this AWAITED, before starting any of the recurring background loops.
 * It guarantees every seeded market gets a real crank attempt within a few
 * RPC calls of process boot, closing the exact gap that killed
 * SOL/JUP/TRUMP: previously the very first crank for a market came from the
 * recurring loop's own (fire-and-forget, un-awaited) first cycle, so a slow
 * boot or one bad discovery round-trip in that first cycle could leave a
 * market un-cranked with no guarantee of a fast retry.
 *
 * Markets with no seeded `lpPortfolio` (only ones registered live via
 * register-poll, whose payload has no lpPortfolio field) are skipped here —
 * they're picked up by startRecoveryCrankLoop's discovery fallback on its
 * normal cadence.
 */
export async function crankAllOnce(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  dryRun: boolean,
): Promise<Map<string, CrankMarketState>> {
  const bootStates = new Map<string, CrankMarketState>();
  const seeded = registry.markets.filter((m) => !!m.lpPortfolio);
  if (seeded.length === 0) {
    console.log("[cranker][boot] no seeded (lpPortfolio-known) markets in registry.json — skipping crank-on-boot");
    return bootStates;
  }
  console.log(`[cranker][boot] cranking ${seeded.length} seeded market(s) once before starting the recurring loops…`);

  const results = await Promise.allSettled(
    seeded.map(async (m) => {
      const state = freshCrankMarketState();
      bootStates.set(m.marketAddress, state);
      await crankOneMarket(devnetConn, keeper, m, state, dryRun);
      return { market: m, state };
    }),
  );

  let ok = 0;
  let notClean = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      const { market, state } = r.value;
      if (dryRun || state.lastSig) {
        ok++;
      } else {
        notClean++;
        if (state.lastErrorMsg) {
          console.warn(`[cranker][boot] ${market.label}: not clean this attempt — ${state.lastErrorMsg}`);
        }
      }
    } else {
      notClean++;
      console.error(`[cranker][boot] unexpected crank-on-boot failure: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }
  console.log(
    `[cranker][boot] crank-on-boot complete: ${ok} clean, ${notClean} not-clean` +
      `${notClean > 0 ? " (will keep retrying on the recurring crank loop)" : ""}.`,
  );
  // B7: handed to startRecoveryCrankLoop so its first cycle knows what boot cranked.
  return bootStates;
}

/**
 * The ops-track observation for one pre-crank market read. Exported (pure) so
 * the exact decode the cranker performs is under test, not a hand-built copy.
 */
export function observeMarket(
  data: Uint8Array,
  chainSlot: bigint,
  pre: (Pick<MarketRefreshState, "currentSlot"> & Partial<Pick<MarketRefreshState, "staleLong" | "staleShort">>) | null,
  repairs: ReadonlyArray<LivenessRepair>,
  /** skipAdl: the account is not a v2.1-compatible header, so the ADL decoder would read the wrong bytes. */
  opts: { skipAdl?: boolean } = {},
): CrankObservation {
  let adl: AdlState | null = null;
  if (!opts.skipAdl) {
    try {
      adl = decodeAdlState(data);
    } catch {
      adl = null;
    }
  }
  return {
    chainSlot,
    engineSlot: pre ? pre.currentSlot : null,
    crankOk: false,
    crankReverted: false,
    lapsedBuckets: repairs.filter((r) => r.kind === "expire").length,
    bankruptFound: 0,
    bankruptLiquidated: 0,
    adl,
    ...(adl ? (({ adlAssets }) => (adlAssets ? { adlAssets } : {}))(adlHealthOf(data)) : {}),
    staleLong: pre?.staleLong !== undefined ? Number(pre.staleLong) : null,
    staleShort: pre?.staleShort !== undefined ? Number(pre.staleShort) : null,
    positioned: 0,
    overflow: 0,
    overflowRefreshed: 0,
    lossStaleCycles: 0,
  };
}

/** Engine EngineNonProgress (enum position 22, 6377376a / b2b2559e). */
export const ENGINE_NON_PROGRESS = 22;
/** Slots the engine clock may trail the read slot and still count as "current". */
export const NO_PROGRESS_CURRENT_SLOTS = 2n;

/**
 * B7 (E2E 2026-09-30): Custom(22) on the ACCRUAL (or catch-up) crank while the
 * engine clock is already current (read slot − current_slot ≤ 2) means there is
 * nothing to accrue in this slot — a duplicate crank, e.g. the boot crank then
 * the loop's first cycle. Anything else (another code, a repair/liquidate/refresh
 * instruction, a clock that is behind) stays a real revert.
 */
/**
 * R3.22b: the simulation refused the tx as a duplicate of one that already landed ("AlreadyProcessed": the same
 * message, i.e. same blockhash and instructions, was processed). Not a program revert.
 */
export function isDuplicateOfLandedTx(err: unknown): boolean {
  if (err === "AlreadyProcessed") return true;
  return typeof err === "object" && err !== null && "AlreadyProcessed" in err;
}

/** R3.22b: the layout verdict of a variant-B market the v2.2 layer owns (never a problem: the layer reads it). */
export function v22OwnedLayoutHealth(
  detection: LayoutDetection,
  pre: Pick<MarketRefreshState, "storedPosLong" | "storedPosShort"> | null,
): MarketLayoutHealth {
  if (!detection.known) return layoutHealthFor(detection, pre);
  const L = detection.layout;
  return {
    id: L.id,
    problem: null,
    kind: "ok",
    accountLen: L.groupOff + L.headerLen + detection.slots * L.slotStride,
    provisional: L.provisional,
    hasPositions: pre ? pre.storedPosLong !== 0n || pre.storedPosShort !== 0n : null,
  };
}

export function isBenignNoProgress(
  err: unknown,
  plan: Pick<CrankPlan, "cranks">,
  pre: Pick<MarketRefreshState, "currentSlot"> | null,
  readSlot: bigint,
): boolean {
  const ie = parseInstructionError(err);
  if (!ie || ie.custom !== ENGINE_NON_PROGRESS || ie.index < 1) return false;
  const crank = plan.cranks[ie.index - 1];
  if (!crank || (crank.kind !== "accrue" && crank.kind !== "catchup")) return false;
  if (!pre) return false;
  return readSlot <= pre.currentSlot + NO_PROGRESS_CURRENT_SLOTS;
}

/** Emit the structured `[health]` line every N crank cycles (ops track). */
export const HEALTH_LINE_EVERY_CYCLES = 3;

export function crankSample(label: string, market: string, st: Pick<CrankMarketState, "obs" | "totalCranks" | "totalReverts" | "consecutiveReverts" | "lastRevertCode">): CrankHealthSample | null {
  if (!st.obs) return null;
  return {
    label,
    market,
    ...st.obs,
    totalOk: st.totalCranks,
    totalReverts: st.totalReverts,
    consecutiveReverts: st.consecutiveReverts,
    lastRevertCode: st.lastRevertCode,
  };
}

/**
 * Evaluate every market's latest observation, reconcile alerts, and every
 * HEALTH_LINE_EVERY_CYCLES cycles print one `[health]` line. Observations are
 * consumed (set to null) so a market that did not read its account this
 * cycle (e.g. discovery pending) is not re-evaluated on stale data.
 */
export async function reportCrankHealth(
  registry: Registry,
  states: Map<string, CrankMarketState>,
  cycle: number,
  sink: AlertSink,
): Promise<Alert[]> {
  const active: Alert[] = [];
  const records: Array<Record<string, string | number | null>> = [];
  for (const m of registry.markets) {
    const st = states.get(m.marketAddress);
    if (!st) continue;
    const sample = crankSample(m.label, m.marketAddress, st);
    if (!sample) continue;
    const ev = evaluateCrankHealth(sample, st.streaks, sink.thresholds);
    st.streaks = ev.streaks;
    active.push(...ev.active);
    records.push(crankHealthRecord(sample));
    st.obs = null;
  }
  if (cycle % HEALTH_LINE_EVERY_CYCLES === 0 && records.length > 0) {
    sink.health("crank", { cycle, markets: records });
  }
  await sink.reconcile("crank", active);
  return active;
}

/**
 * Start the periodic recovery/maintenance crank loop. Runs indefinitely on
 * its own interval, completely independent of the oracle push loop — call
 * this WITHOUT awaiting it (`void startRecoveryCrankLoop(...)`) so it runs
 * concurrently with `startKeeperLoop`.
 */
export async function startRecoveryCrankLoop(
  devnetConn: Connection,
  keeper: Keypair,
  registry: Registry,
  config: CrankLoopConfig,
  sink: AlertSink = getAlertSink(),
  bootStates?: Map<string, CrankMarketState>,
  liveness: CrankLiveness = createCrankLiveness(crankLivenessOptsFromEnv(process.env, config.intervalMs)),
): Promise<void> {
  const states = new Map<string, CrankMarketState>(
    registry.markets.map((m) => [m.marketAddress, bootStates?.get(m.marketAddress) ?? freshCrankMarketState()]),
  );

  console.log(
    `[cranker] Recovery crank loop starting: ${registry.markets.length} markets,` +
      ` interval=${config.intervalMs}ms, mode=${config.dryRun ? "DRY-RUN" : "LIVE"}`,
  );

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  // K3 (2026-10-01): a hung crank call stalled this loop for 35 min with the process, pushes and /health all
  // looking fine. Exit non-zero if nothing settles for > 2 intervals so Railway restarts the service.
  liveness.beat();
  const stopLiveness = liveness.start();
  const limitMs = liveness.limitMs();
  console.log(
    `[cranker] liveness watchdog: ${limitMs === null ? "disabled" : `exit 1 after ${Math.round(limitMs / 1000)}s of silence`}`,
  );

  let cycleCount = 0;
  // The watchdog must die with THIS loop however it ends. The supervisor in cross-cluster.ts restarts a
  // loop that threw with a NEW watchdog; an orphaned one would exit(1) ~limit later against a healthy loop.
  try {
  while (!stopping) {
    const cycleStart = Date.now();
    liveness.beat();
    // A market the registry dropped (retired) leaves the cranker's own state too.
    {
      const live = new Set(registry.markets.map((m) => m.marketAddress));
      for (const addr of [...states.keys()]) if (!live.has(addr)) states.delete(addr);
    }
    // G8: crank every market in the cycle CONCURRENTLY instead of sequentially
    // (was a `for...await` loop — N markets meant N sequential RPC round-trips
    // per cycle, so cycle wall-time grew linearly with registry size). Each
    // market's errors are already fully isolated inside crankOneMarket / the
    // per-iteration try/catch below, so Promise.allSettled here is defense in
    // depth, not a correctness requirement — it just keeps cycle time flat.
    const cycleMarkets = [...registry.markets];
    const prefetched = await readMarketsForCycle(devnetConn, cycleMarkets, states).catch(() => new Map());
    await Promise.allSettled(
      cycleMarkets.map(async (m) => {
        // Lazily track markets registered AFTER boot (added live by the register-poll
        // loop, or hot-reloaded — see registry-reload.ts). The states Map was seeded
        // only from the markets present at startup, so without this a newly-registered
        // market would hit `undefined` here and its crank would throw every cycle — it
        // would never un-stale and stay untradeable.
        let state = states.get(m.marketAddress);
        if (!state) {
          state = freshCrankMarketState();
          states.set(m.marketAddress, state);
          console.log(`[cranker] now tracking newly-registered market ${m.label} (${m.marketAddress.slice(0, 8)}…)`);
        }
        try {
          await crankOneMarket(devnetConn, keeper, m, state, config.dryRun, prefetched.get(m.marketAddress));
        } catch (err) {
          // Defense in depth: crankOneMarket already isolates errors per-market,
          // but never let an unexpected throw kill the whole loop.
          console.error(`[cranker] ${m.label}: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          liveness.beat();
        }
      }),
    );
    cycleCount++;
    liveness.beat();
    await reportCrankHealth(registry, states, cycleCount, sink);
    liveness.beat();
    if (cycleCount % HEALTH_SUMMARY_EVERY_CYCLES === 0) {
      const summary = registry.markets
        .map((m) => {
          // A market admitted by register-poll mid-run has no state until its first crank:
          // the old non-null assertion crashed the whole cranker loop (2026-10-01).
          const st = states.get(m.marketAddress);
          if (!st) return `${m.label}=pending`;
          const flag = st.consecutiveReverts >= REVERT_ALERT_THRESHOLD ? "⚠STUCK" : st.consecutiveReverts > 0 ? "~drift" : "ok";
          return `${m.label}=${flag}(ok:${st.totalCranks} rev:${st.totalReverts}${st.consecutiveReverts ? ` cons:${st.consecutiveReverts}` : ""}${st.lastRevertCode != null ? ` last:${st.lastRevertCode}` : ""})`;
        })
        .join("  ");
      console.log(`[cranker][health] cycle ${cycleCount}: ${summary}`);
    }
    const elapsed = Date.now() - cycleStart;
    const remaining = config.intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
  } finally {
    stopLiveness();
  }
  console.log("[cranker] Recovery crank loop stopped.");
}
