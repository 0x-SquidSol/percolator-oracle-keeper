/**
 * cross-cluster/v22/lev-guard.ts
 *
 * Keeper support for the v2.2 on-chain leverage guard (wrapper tag 124). Three jobs, EACH BEHIND ITS OWN FLAG, ALL DEFAULT OFF;
 * with every flag off nothing here is constructed, no instruction is built and no RPC is made. Every send goes through exec.ts
 * (simulate first; global dry-run simulates and LOGS "would send", sending nothing). No flag needs KEEPER_V22: a market without a
 * guard PDA is a cached no-op, so the jobs are inert on every deployment that has no guarded market.
 *
 *   KEEPER_LEV_POKE=1          op 4 POKE (with NAV sampling: vault_lp_state [4] + vault_lp_ext [5]) after each landed mark push on a market
 *                              whose guard PDA exists, and immediately BEFORE a tag-103 Earn -> LP allocation send (night fix F1: shrinks the
 *                              deposit / loss ambiguity window of the NAV sample).
 *   KEEPER_LEV_HOLDER_JOB=1    hourly per guarded market: (a) op 3 TIGHTEN without a holder (refreshes the mint / freeze authority flags);
 *                              (b) the base mint's largest token accounts, the pool's vaults and every program / pool / PDA-owned account
 *                              dropped, the CPMM dump 1-(R/(R+q))^2 against the pool base vault balance R, op 3 with the single largest;
 *                              (c) with KEEPER_LEV_RISK_KEY_PATH set, op 2 REPORT signed by that key (m_ind from the FULL balance, H9; j_dump
 *                              from the holder model with every unknown holder a "whale"; l_cap_x100 0 = no cap; n_mult_bps 10000).
 *                              Reports merge tighten-only on chain; every bps field is still clamped to [0, 10000].
 *   KEEPER_LEV_W1=1            op 5 LP_STOP: when the guard says the stop holds (levLpStopTriggeredV22) or a round is open (levW1RoundLiveV22),
 *                              cut the user portfolios opposite the vault LP in batches until the round closes or the program answers 135
 *                              (LpStopNotTriggered = nothing to do). The LP itself is never listed.
 *
 * Tunables (all optional): KEEPER_LEV_POKE_MIN_GAP_MS (1500), KEEPER_LEV_HOLDER_INTERVAL_MS (3600000), KEEPER_LEV_W1_BATCH (4),
 * KEEPER_LEV_W1_MAX_TXS (12), KEEPER_LEV_RISK_KEY_PATH (a keypair file; its contents are never logged).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import * as fs from "node:fs";
import {
  deriveDepthSourceV22,
  parsePortfolioV17,
  buildLevGuardLpStopIxV22,
  buildLevGuardPokeIxV22,
  buildLevGuardReportIxV22,
  buildLevGuardTightenIxV22,
  decodeLevGuardV22,
  deriveLevGuardV22,
  deriveVaultLpStateV22,
  levLpStopTriggeredV22,
  levW1RoundLiveV22,
  LEV_SLOTS_PER_DAY_V22,
} from "@percolatorct/sdk";
import type { LevGuardV22 } from "@percolatorct/sdk";
import { STAKE_PROGRAM_ID } from "../../program-ids.ts";
import { fetchMarketPortfolios } from "../recovery-cranker.ts";
import { detectLayout } from "../market-layout.ts";
import { decodeVaultLpState } from "../resolved-portfolio-cleanup.ts";
import { decodeActiveDepthSource } from "../depth-source.ts";
import { simulateAndSend } from "./exec.ts";
import type { ExecConnection, ExecContext, ExecOutcome } from "./exec.ts";
import { V22FlagError, parseFlag } from "./flags.ts";
import { redactErrorText } from "./redact.ts";
import { buildReport, cpmmDumpBps, filterHolders, holderAttemptOrder, knownExcludedOwners, totalsByOwner } from "./lev-guard-math.ts";
import type { CandidateHolder, OwnerView, TokenAccountView } from "./lev-guard-math.ts";

// ── config ──────────────────────────────────────────────────────────────────────────────────────

export interface LevGuardConfig {
  poke: boolean;
  holderJob: boolean;
  w1: boolean;
  /** Keypair file of the guard's risk key; null = no REPORT (the holder job still tightens). */
  riskKeyPath: string | null;
  /** Least ms between two pushes-triggered pokes of one market. */
  pokeMinGapMs: number;
  holderIntervalMs: number;
  /** Opposing portfolios per op 5 transaction. */
  w1BatchSize: number;
  /** Most op 5 transactions of one run (a run ends earlier when the round closes). */
  w1MaxTxs: number;
}

export const LEV_GUARD_DEFAULTS: LevGuardConfig = {
  poke: false,
  holderJob: false,
  w1: false,
  riskKeyPath: null,
  pokeMinGapMs: 1_500,
  holderIntervalMs: 3_600_000,
  w1BatchSize: 4,
  w1MaxTxs: 12,
};

/** Hard ceiling of opposing portfolios in ONE op 5 tx: the 1,232 B legacy packet (test: lev-guard.test.ts "w1 packet size"). */
export const W1_MAX_VICTIMS_PER_TX = 24;

/** Compute-unit limits of the sends (the simulation reports the real figure in the log). */
export const LEV_POKE_UNITS = 400_000;
export const LEV_TIGHTEN_UNITS = 200_000;
export const LEV_REPORT_UNITS = 100_000;
export const LEV_W1_UNITS = 1_400_000;
/** Wrapper `LpStopNotTriggered`: op 5 with nothing to do. */
export const LP_STOP_NOT_TRIGGERED = 135;
/** Wrapper `LevGuardInvalid`: bad op / data / accounts (a holder account the program will not take). */
export const LEV_GUARD_INVALID = 134;

type Env = Readonly<Record<string, string | undefined>>;

function posInt(env: Env, key: string, def: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new V22FlagError(key, raw, `an integer in 1..${max}`);
  return n;
}

/** Strict, like every v2.2 flag: an unrecognised value is a startup error. */
export function levGuardConfigFromEnv(env: Env = process.env): LevGuardConfig {
  const riskRaw = env.KEEPER_LEV_RISK_KEY_PATH?.trim();
  if (riskRaw && !riskRaw.startsWith("/")) throw new V22FlagError("KEEPER_LEV_RISK_KEY_PATH", "<redacted path>", "an absolute path");
  return {
    poke: parseFlag(env, "KEEPER_LEV_POKE", false),
    holderJob: parseFlag(env, "KEEPER_LEV_HOLDER_JOB", false),
    w1: parseFlag(env, "KEEPER_LEV_W1", false),
    riskKeyPath: riskRaw ? riskRaw : null,
    pokeMinGapMs: posInt(env, "KEEPER_LEV_POKE_MIN_GAP_MS", LEV_GUARD_DEFAULTS.pokeMinGapMs, 3_600_000),
    holderIntervalMs: posInt(env, "KEEPER_LEV_HOLDER_INTERVAL_MS", LEV_GUARD_DEFAULTS.holderIntervalMs, 86_400_000),
    w1BatchSize: posInt(env, "KEEPER_LEV_W1_BATCH", LEV_GUARD_DEFAULTS.w1BatchSize, W1_MAX_VICTIMS_PER_TX),
    w1MaxTxs: posInt(env, "KEEPER_LEV_W1_MAX_TXS", LEV_GUARD_DEFAULTS.w1MaxTxs, 200),
  };
}

export const levGuardEnabled = (c: LevGuardConfig): boolean => c.poke || c.holderJob || c.w1;

/**
 * Load the risk key. Never logs the file's contents. THROWS (a clear startup error) when the file is group- or world-readable (mode & 0o077 != 0);
 * any other failure (missing, unreadable, not a 64-byte keypair array) logs the path only and returns null (REPORT disabled).
 */
export function loadRiskKey(path: string, log: (s: string) => void = console.log): Keypair | null {
  try {
    const mode = fs.statSync(path).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(`KEEPER_LEV_RISK_KEY_PATH ${path} is group- or world-readable (mode ${(mode & 0o777).toString(8)}); refusing to load it. chmod 600 the file`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("KEEPER_LEV_RISK_KEY_PATH")) throw err;
    log(`[lev-guard] KEEPER_LEV_RISK_KEY_PATH ${path}: unreadable; REPORT disabled`);
    return null;
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
      log(`[lev-guard] KEEPER_LEV_RISK_KEY_PATH ${path}: not a 64-byte keypair JSON array; REPORT disabled`);
      return null;
    }
    return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
  } catch {
    log(`[lev-guard] KEEPER_LEV_RISK_KEY_PATH ${path}: unreadable or invalid; REPORT disabled`);
    return null;
  }
}

// ── deps ────────────────────────────────────────────────────────────────────────────────────────

export type LevConnection = ExecConnection &
  Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getSlot" | "getTokenLargestAccounts" | "getTokenSupply">;

export interface LevGuardDeps {
  conn: LevConnection;
  keeper: Keypair;
  programId: PublicKey;
  /** Global DRY_RUN / --dry-run / KEEPER_V22_DRY_RUN. */
  dryRun: boolean;
  config: LevGuardConfig;
  /** The risk key (null = no REPORT). */
  riskKey?: Keypair | null;
  /** All portfolios of a market at the layout's length. Default: getProgramAccounts through recovery-cranker. */
  loadPortfolios?: (market: PublicKey, portfolioLen: number) => Promise<Array<{ pubkey: PublicKey; data: Uint8Array }>>;
  stakeProgramId?: PublicKey;
  now?: () => number;
  log?: (s: string) => void;
}

export interface MarketRef {
  marketAddress: string;
  label: string;
}

interface MarketState {
  guard: { present: boolean; checkedAt: number } | null;
  vaultLp: { key: PublicKey | null; at: number } | null;
  lastPokeAtMs: number;
  pokeInflight: boolean;
  w1Inflight: boolean;
  nextHolderAtMs: number;
  holderInflight: boolean;
  /** `${roundId}:${portfolio}` already listed in a W1 tx this process (a lost tx is retried on a later round only). */
  w1Listed: Set<string>;
  lastHolder: string | null;
  lastW1: string | null;
}

export interface LevGuardStats {
  pokes: { sent: number; dryRun: number; refused: number; failed: number; held: number; noGuard: number; gap: number };
  tightens: { sent: number; dryRun: number; refused: number; failed: number };
  reports: { sent: number; dryRun: number; refused: number; failed: number; skipped: number };
  holderRuns: number;
  /** program-owned kind-17 account at a guard PDA with an unexpected length (alerted) */
  guardBadLength: number;
  holderDropped: Record<string, number>;
  w1: { checks: number; roundsOpened: number; txs: number; victimsListed: number; closed: number; nothingToDo: number; refused: number; failed: number };
}

const NO_EXPECTED: ReadonlySet<number> = new Set();
const NOTHING_TO_DO: ReadonlySet<number> = new Set([LP_STOP_NOT_TRIGGERED]);
/** Guard account lengths the program may produce: 16 + 344 + 4096, and the burst-memory build 16 + 360 + 4096. */
const GUARD_LENGTHS: readonly number[] = [4456, 4472];
const GUARD_RECHECK_MS = 600_000;
const VAULT_LP_TTL_MS = 600_000;

/**
 * Tag width (`KEY_TAG_LEN`, prog#610/#611). The tag is a portfolio address PREFIX and is that account's identity in the W1 touched set, so the
 * width is a security parameter: at 8 bytes a birthday search over client-chosen portfolio addresses costs ~2^32, at 16 it costs ~2^64.
 */
export const KEY_TAG_LEN = 16;

/**
 * The tag the program stores for a cut portfolio: the first `KEY_TAG_LEN` bytes of its key as a LE unsigned integer. Kept local (a test pins this
 * to the SDK's `levKeyTagV22`, which must be on the matching width -- see the pin in package.json).
 */
export function keyTagOf(k: PublicKey): bigint {
  const b = k.toBytes();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return (v.getBigUint64(8, true) << 64n) | v.getBigUint64(0, true);
}

const u64le = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

/** Fields of an SPL token account (165 B base layout; Token-2022 extensions follow). */
export function parseTokenAccountView(address: string, programOwner: string, data: Uint8Array): TokenAccountView | null {
  if (data.length < 165) return null;
  return {
    address,
    programOwner,
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: u64le(data, 64),
    state: data[108],
  };
}

export type PokeResult = "disabled" | "no-guard" | "no-vault-lp" | "busy" | "gap" | "sent" | "dry-run" | "refused" | "failed" | "held";

function describeOutcome(o: ExecOutcome): string {
  switch (o.kind) {
    case "sent":
      return `sent ${o.landed}${o.failCode !== null ? ` code=${o.failCode}` : ""} sig=${o.signature.slice(0, 16)}... units=${o.unitsConsumed ?? "n/a"}`;
    case "dry-run":
      return `dry-run units=${o.unitsConsumed ?? "n/a"}`;
    case "refused":
      return `refused ${o.name}${o.expected ? " (expected)" : ""}`;
    case "held":
      return `held: ${o.reason}`;
    case "failed":
      return `failed: ${o.error}`;
  }
}

/** The leverage-guard keeper. One per process; every public method never throws. */
export class LevGuardKeeper {
  private readonly st = new Map<string, MarketState>();
  private readonly log: (s: string) => void;
  private readonly now: () => number;
  private readonly stakeProgramId: PublicKey;
  readonly stats: LevGuardStats = {
    pokes: { sent: 0, dryRun: 0, refused: 0, failed: 0, held: 0, noGuard: 0, gap: 0 },
    tightens: { sent: 0, dryRun: 0, refused: 0, failed: 0 },
    reports: { sent: 0, dryRun: 0, refused: 0, failed: 0, skipped: 0 },
    holderRuns: 0,
    guardBadLength: 0,
    holderDropped: {},
    w1: { checks: 0, roundsOpened: 0, txs: 0, victimsListed: 0, closed: 0, nothingToDo: 0, refused: 0, failed: 0 },
  };

  constructor(private readonly d: LevGuardDeps) {
    this.log = d.log ?? ((s) => console.log(s));
    this.now = d.now ?? Date.now;
    this.stakeProgramId = d.stakeProgramId ?? STAKE_PROGRAM_ID;
  }

  private m(market: string): MarketState {
    let s = this.st.get(market);
    if (!s) {
      s = { guard: null, vaultLp: null, lastPokeAtMs: 0, pokeInflight: false, w1Inflight: false, nextHolderAtMs: 0, holderInflight: false, w1Listed: new Set(), lastHolder: null, lastW1: null };
      this.st.set(market, s);
    }
    return s;
  }

  private exec(extraSigners?: ReadonlyArray<Keypair>): ExecContext {
    return { conn: this.d.conn, keeper: this.d.keeper, dryRun: this.d.dryRun, log: this.log, ...(extraSigners && extraSigners.length > 0 ? { extraSigners } : {}) };
  }

  private ctxOf(market: PublicKey): { programId: PublicKey; market: PublicKey } {
    return { programId: this.d.programId, market };
  }

  /**
   * Cached: does the market's guard PDA exist (program-owned, header kind 17, length 4,456 B or 4,472 B (burst-memory build, record 360 B))?
   * A positive answer is final; a negative one is rechecked every 10 min. A program-owned kind-17 account of any OTHER length is counted
   * (`stats.guardBadLength`) and logged as an ALERT, and treated as no guard.
   */
  async hasGuard(marketAddress: string): Promise<boolean> {
    const s = this.m(marketAddress);
    const t = this.now();
    if (s.guard?.present) return true;
    if (s.guard && t - s.guard.checkedAt < GUARD_RECHECK_MS) return false;
    try {
      const info = await this.d.conn.getAccountInfo(deriveLevGuardV22(this.d.programId, new PublicKey(marketAddress))[0], "confirmed");
      const owned = !!info && info.owner.equals(this.d.programId) && info.data.length > 10 && info.data[10] === 17;
      const present = owned && GUARD_LENGTHS.includes(info!.data.length);
      if (owned && !present) {
        this.stats.guardBadLength++;
        this.log(`[lev-guard][ALERT] ${marketAddress}: the guard PDA is program-owned kind 17 but ${info!.data.length} B (expected ${GUARD_LENGTHS.join(" or ")}); treated as no guard`);
      }
      s.guard = { present, checkedAt: t };
      return present;
    } catch {
      return false; // unreadable: not cached, retried on the next call
    }
  }

  /** The decoded guard and the current slot, or null (no guard / unreadable / fails the program's own validation). */
  async readGuard(marketAddress: string): Promise<{ guard: LevGuardV22; slot: bigint } | null> {
    try {
      const market = new PublicKey(marketAddress);
      const [info, slot] = await Promise.all([this.d.conn.getAccountInfo(deriveLevGuardV22(this.d.programId, market)[0], "confirmed"), this.d.conn.getSlot("confirmed")]);
      if (!info || !info.owner.equals(this.d.programId)) return null;
      // decodeLevGuardV22 (SDK 0a6ac576) accepts exactly 4,456 B or 4,472 B and throws on any other length (-> null below).
      return { guard: decodeLevGuardV22(new Uint8Array(info.data)), slot: BigInt(slot) };
    } catch {
      return null;
    }
  }

  private async vaultLpFor(market: PublicKey): Promise<PublicKey | null> {
    const s = this.m(market.toBase58());
    const t = this.now();
    if (s.vaultLp && t - s.vaultLp.at < VAULT_LP_TTL_MS) return s.vaultLp.key;
    try {
      const info = await this.d.conn.getAccountInfo(deriveVaultLpStateV22(this.d.programId, market)[0], "confirmed");
      const st = info ? decodeVaultLpState(new Uint8Array(info.data)) : null;
      s.vaultLp = { key: st ? st.lpPortfolio : null, at: t };
      return s.vaultLp.key;
    } catch {
      return s.vaultLp?.key ?? null;
    }
  }

  // ── 1. POKE ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Op 4 POKE with NAV sampling. `reason` "push" honours the per-market minimum gap; "pre-allocate" (just before a tag 103 send) does not.
   * Returns what happened (tests / logs).
   */
  async pokeOnce(marketAddress: string, label: string, reason: "push" | "pre-allocate"): Promise<PokeResult> {
    if (!this.d.config.poke) return "disabled";
    const s = this.m(marketAddress);
    if (s.pokeInflight) return "busy";
    const t = this.now();
    if (reason === "push" && t - s.lastPokeAtMs < this.d.config.pokeMinGapMs) {
      this.stats.pokes.gap++;
      return "gap";
    }
    s.pokeInflight = true;
    try {
      if (!(await this.hasGuard(marketAddress))) {
        this.stats.pokes.noGuard++;
        return "no-guard";
      }
      const market = new PublicKey(marketAddress);
      const lp = await this.vaultLpFor(market);
      if (!lp) return "no-vault-lp";
      s.lastPokeAtMs = t;
      const ix = buildLevGuardPokeIxV22(this.ctxOf(market), this.d.keeper.publicKey, { vaultLpPortfolio: lp, sampleNav: true });
      const out = await simulateAndSend(this.exec(), [ix], { job: "lev-poke", label, units: LEV_POKE_UNITS, program: "wrapper", expected: NO_EXPECTED }, this.now);
      this.log(`[lev-guard][poke] ${label} (${reason}): ${describeOutcome(out)}`);
      if (out.kind === "sent") {
        if (out.landed === "landed") this.stats.pokes.sent++;
        else this.stats.pokes.failed++;
        return out.landed === "landed" ? "sent" : "failed";
      }
      if (out.kind === "dry-run") this.stats.pokes.dryRun++;
      else if (out.kind === "refused") this.stats.pokes.refused++;
      else if (out.kind === "held") this.stats.pokes.held++;
      else this.stats.pokes.failed++;
      return out.kind === "dry-run" ? "dry-run" : out.kind === "refused" ? "refused" : out.kind === "held" ? "held" : "failed";
    } catch (err) {
      this.stats.pokes.failed++;
      this.log(`[lev-guard][poke] ${label}: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
      return "failed";
    } finally {
      s.pokeInflight = false;
    }
  }

  /** The mark-push hook: after a LANDED push, poke (KEEPER_LEV_POKE) and then run the W1 check (KEEPER_LEV_W1). Never throws. */
  async onPushLanded(marketAddress: string, label: string): Promise<void> {
    try {
      const c = this.d.config;
      if (c.poke) await this.pokeOnce(marketAddress, label, "push");
      if (c.w1) await this.w1Once(marketAddress, label);
    } catch (err) {
      this.log(`[lev-guard] ${label}: push hook failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`);
    }
  }

  /** The allocator hook: poke immediately before an Earn -> LP allocation send. Never throws. */
  async beforeAllocate(marketAddress: string, label: string): Promise<void> {
    try {
      await this.pokeOnce(marketAddress, label, "pre-allocate");
    } catch {
      // never blocks the allocation
    }
  }

  // ── 2. HOLDER JOB ────────────────────────────────────────────────────────────────────────────

  /** Call on a short timer; each market runs at most once per `holderIntervalMs` (first run staggered by a stable per-market offset). */
  async holderTick(markets: ReadonlyArray<MarketRef>): Promise<void> {
    if (!this.d.config.holderJob) return;
    const t = this.now();
    for (const mk of markets) {
      const s = this.m(mk.marketAddress);
      if (s.holderInflight) continue;
      if (s.nextHolderAtMs === 0) {
        // stagger: spread first runs across the interval by the key's first bytes
        const off = Number(new PublicKey(mk.marketAddress).toBytes()[1]) / 256;
        s.nextHolderAtMs = t + Math.floor(off * Math.min(this.d.config.holderIntervalMs, 600_000));
      }
      if (t < s.nextHolderAtMs) continue;
      s.nextHolderAtMs = t + this.d.config.holderIntervalMs;
      s.holderInflight = true;
      try {
        await this.holderOnce(mk.marketAddress, mk.label);
      } catch (err) {
        s.lastHolder = `failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 100)}`;
        this.log(`[lev-guard][holder] ${mk.label}: ${s.lastHolder}`);
      } finally {
        s.holderInflight = false;
      }
    }
  }

  /** One market's hourly holder run: (a) tighten, (b) tighten with the largest holder, (c) report. */
  async holderOnce(marketAddress: string, label: string): Promise<string> {
    const s = this.m(marketAddress);
    const out = await this.holderRun(marketAddress, label);
    s.lastHolder = out;
    this.log(`[lev-guard][holder] ${label}: ${out}`);
    return out;
  }

  private async holderRun(marketAddress: string, label: string): Promise<string> {
    if (!(await this.hasGuard(marketAddress))) return "no guard";
    const market = new PublicKey(marketAddress);
    const gs = await this.readGuard(marketAddress);
    if (!gs) return "guard unreadable";
    const pdaInfo = await this.d.conn.getAccountInfo(deriveDepthSourceV22(this.d.programId, market)[0], "confirmed");
    if (!pdaInfo || !pdaInfo.owner.equals(this.d.programId)) return "no depth-source pin";
    const pdaData = new Uint8Array(pdaInfo.data);
    const pin = decodeActiveDepthSource(pdaData, deriveDepthSourceV22(this.d.programId, market)[0]);
    if (!pin) return "depth-source pin inactive or invalid";
    const baseMint = new PublicKey(pdaData.subarray(16 + 160, 16 + 192));
    this.stats.holderRuns++;
    const c = this.ctxOf(market);
    const kp = this.d.keeper.publicKey;

    // (a) op 3 without a holder: the mint / freeze authority flags.
    const plain = await simulateAndSend(this.exec(), [buildLevGuardTightenIxV22(c, kp, { baseMint, poolBaseVault: pin.baseVault })], { job: "lev-tighten", label, units: LEV_TIGHTEN_UNITS, program: "wrapper", expected: NO_EXPECTED }, this.now);
    this.countTighten(plain);
    this.log(`[lev-guard][tighten] ${label} (flags refresh): ${describeOutcome(plain)}`);

    // (b) the largest individual holders.
    const [vaultInfo, quoteInfo, supplyRes, largest] = await Promise.all([
      this.d.conn.getAccountInfo(pin.baseVault, "confirmed"),
      this.d.conn.getAccountInfo(pin.quoteVault, "confirmed"),
      this.d.conn.getTokenSupply(baseMint, "confirmed"),
      this.d.conn.getTokenLargestAccounts(baseMint, "confirmed"),
    ]);
    const vault = vaultInfo ? parseTokenAccountView(pin.baseVault.toBase58(), vaultInfo.owner.toBase58(), new Uint8Array(vaultInfo.data)) : null;
    if (!vault || vault.mint !== baseMint.toBase58()) return "pool base vault unreadable";
    const reserve = vault.amount;
    const supply = BigInt(supplyRes.value.amount);
    const addrs = largest.value.map((x) => new PublicKey(x.address));
    const accts = addrs.length > 0 ? await this.d.conn.getMultipleAccountsInfo(addrs, "confirmed") : [];
    const views: TokenAccountView[] = [];
    accts.forEach((a, i) => {
      if (!a) return;
      const v = parseTokenAccountView(addrs[i].toBase58(), a.owner.toBase58(), new Uint8Array(a.data));
      if (v) views.push(v);
    });
    const ownerKeys = [...new Set(views.map((v) => v.owner))].map((o) => new PublicKey(o));
    const ownerInfos = ownerKeys.length > 0 ? await this.d.conn.getMultipleAccountsInfo(ownerKeys, "confirmed") : [];
    const owners = new Map<string, OwnerView>();
    ownerKeys.forEach((k, i) => owners.set(k.toBase58(), { onCurve: PublicKey.isOnCurve(k.toBytes()), accountOwner: ownerInfos[i] ? ownerInfos[i]!.owner.toBase58() : null }));
    const excluded = knownExcludedOwners([
      vault.owner, // the pool's authority (vault token accounts of one pool share it)
      quoteInfo ? (parseTokenAccountView(pin.quoteVault.toBase58(), quoteInfo.owner.toBase58(), new Uint8Array(quoteInfo.data))?.owner ?? "") : "",
      pin.pool.toBase58(),
      pin.ammProgram.toBase58(),
      this.d.programId.toBase58(),
      this.stakeProgramId.toBase58(),
      kp.toBase58(),
    ].filter((x) => x !== ""));
    const f = filterHolders(views, { baseMint: baseMint.toBase58(), poolVaults: new Set([pin.baseVault.toBase58(), pin.quoteVault.toBase58()]), excludedOwners: excluded, owners });
    for (const dr of f.dropped) this.stats.holderDropped[dr.reason] = (this.stats.holderDropped[dr.reason] ?? 0) + 1;
    const order = holderAttemptOrder(f.kept);
    let submitted: string;
    if (order.length === 0) {
      submitted = "no individual holder after filtering";
    } else {
      submitted = await this.submitLargest(c, label, baseMint, pin.baseVault, reserve, order);
    }

    // (c) the report.
    const rep = await this.reportOnce(c, label, gs.guard, gs.slot, { reserve, supply, kept: f.kept });
    return `reserve=${reserve} supply=${supply} listed=${views.length} kept=${f.kept.length} dropped=${f.dropped.length}; holder: ${submitted}; report: ${rep}`;
  }

  /** Op 3 with the single largest holder; a refusal as LevGuardInvalid falls to the next largest (at most 3 tries). */
  private async submitLargest(c: { programId: PublicKey; market: PublicKey }, label: string, baseMint: PublicKey, baseVault: PublicKey, reserve: bigint, order: readonly CandidateHolder[]): Promise<string> {
    let last = "none";
    for (const cand of order.slice(0, 3)) {
      const dump = cpmmDumpBps(reserve, cand.amount);
      const ix = buildLevGuardTightenIxV22(c, this.d.keeper.publicKey, { baseMint, poolBaseVault: baseVault, holderTokenAccount: new PublicKey(cand.address) });
      const out = await simulateAndSend(this.exec(), [ix], { job: "lev-tighten", label, units: LEV_TIGHTEN_UNITS, program: "wrapper", expected: NO_EXPECTED }, this.now);
      this.countTighten(out);
      last = `${cand.address.slice(0, 8)}... amount=${cand.amount} dump_bps=${dump}: ${describeOutcome(out)}`;
      this.log(`[lev-guard][tighten] ${label} (holder): ${last}`);
      if (!(out.kind === "refused" && out.code === LEV_GUARD_INVALID)) break;
    }
    return last;
  }

  private countTighten(o: ExecOutcome): void {
    const t = this.stats.tightens;
    if (o.kind === "sent") (o.landed === "landed" ? t.sent++ : t.failed++);
    else if (o.kind === "dry-run") t.dryRun++;
    else if (o.kind === "refused") t.refused++;
    else t.failed++;
  }

  private async reportOnce(c: { programId: PublicKey; market: PublicKey }, label: string, g: LevGuardV22, slot: bigint, h: { reserve: bigint; supply: bigint; kept: readonly CandidateHolder[] }): Promise<string> {
    const rk = this.d.riskKey ?? null;
    if (!this.d.config.riskKeyPath || !rk) {
      return "skipped (no risk key)";
    }
    if (!g.riskKey.equals(rk.publicKey)) {
      this.stats.reports.skipped++;
      return "skipped (the guard's risk key is a different key)";
    }
    const ageDays = Number(slot > g.t0Slot ? slot - g.t0Slot : 0n) / Number(LEV_SLOTS_PER_DAY_V22);
    const fields = buildReport({ reserve: h.reserve, supply: h.supply, ownerTotals: totalsByOwner(h.kept), ageDays });
    if (!fields) {
      this.stats.reports.skipped++;
      return "skipped (figures not finite or supply 0)";
    }
    const ix = buildLevGuardReportIxV22(c, rk.publicKey, fields);
    const extra = rk.publicKey.equals(this.d.keeper.publicKey) ? [] : [rk];
    const out = await simulateAndSend(this.exec(extra), [ix], { job: "lev-report", label, units: LEV_REPORT_UNITS, program: "wrapper", expected: NO_EXPECTED }, this.now);
    const r = this.stats.reports;
    if (out.kind === "sent") (out.landed === "landed" ? r.sent++ : r.failed++);
    else if (out.kind === "dry-run") r.dryRun++;
    else if (out.kind === "refused") r.refused++;
    else r.failed++;
    const text = `j_dump=${fields.jDumpBps} m_ind=${fields.mIndBps} l_cap_x100=${fields.lCapX100} n_mult=${fields.nMultBps}: ${describeOutcome(out)}`;
    this.log(`[lev-guard][report] ${label}: ${text}`);
    return text;
  }

  // ── 3. W1 ────────────────────────────────────────────────────────────────────────────────────

  /**
   * One W1 run for a market: read the guard; when the stop holds or a round is open, cut the
   * opposing portfolios in batches until the round closes, the program answers 135, nothing is left to list, or `w1MaxTxs` is reached.
   */
  async w1Once(marketAddress: string, label: string): Promise<string> {
    if (!this.d.config.w1) return "disabled";
    const s = this.m(marketAddress);
    if (s.w1Inflight) return "busy";
    s.w1Inflight = true;
    try {
      const out = await this.w1Run(marketAddress, label);
      s.lastW1 = out;
      if (out !== "idle" && out !== "no-guard") this.log(`[lev-guard][w1] ${label}: ${out}`);
      return out;
    } catch (err) {
      this.stats.w1.failed++;
      const out = `failed: ${redactErrorText(err instanceof Error ? err.message : String(err), 140)}`;
      s.lastW1 = out;
      this.log(`[lev-guard][w1] ${label}: ${out}`);
      return out;
    } finally {
      s.w1Inflight = false;
    }
  }

  private async w1Run(marketAddress: string, label: string): Promise<string> {
    if (!(await this.hasGuard(marketAddress))) return "no-guard";
    const market = new PublicKey(marketAddress);
    let gs = await this.readGuard(marketAddress);
    if (!gs) return "guard unreadable";
    this.stats.w1.checks++;
    const live0 = levW1RoundLiveV22(gs.guard, gs.slot);
    if (!live0 && !levLpStopTriggeredV22(gs.guard)) return "idle";
    const lp = await this.vaultLpFor(market);
    if (!lp) return "no vault LP portfolio";
    const c = this.ctxOf(market);
    const send = async (victims: readonly PublicKey[]): Promise<ExecOutcome> => {
      const ix = buildLevGuardLpStopIxV22(c, this.d.keeper.publicKey, lp, victims);
      const out = await simulateAndSend(this.exec(), [ix], { job: "lev-w1", label, units: LEV_W1_UNITS, program: "wrapper", expected: NOTHING_TO_DO }, this.now);
      this.stats.w1.txs++;
      this.stats.w1.victimsListed += victims.length;
      this.log(`[lev-guard][w1] ${label}: op 5 with ${victims.length} portfolio(s): ${describeOutcome(out)}`);
      return out;
    };
    const stop = (o: ExecOutcome): string | null => {
      if ((o.kind === "refused" && o.code === LP_STOP_NOT_TRIGGERED) || (o.kind === "sent" && o.landed === "failed" && o.failCode === LP_STOP_NOT_TRIGGERED)) {
        this.stats.w1.nothingToDo++;
        return "nothing to do (135)";
      }
      if (o.kind === "refused") {
        this.stats.w1.refused++;
        return `refused ${o.name}`;
      }
      if (o.kind === "dry-run") return "dry-run (would send)";
      if (o.kind === "held") return `held: ${o.reason}`;
      if (o.kind === "failed") {
        this.stats.w1.failed++;
        return `failed: ${o.error}`;
      }
      if (o.landed !== "landed") {
        this.stats.w1.failed++;
        return `tx ${o.landed}`;
      }
      return null;
    };
    // The portfolios (one read). The round-opening call MUST carry the first batch of victims: the program opens the round and then answers 135 when
    // nothing was cut, which reverts the open. So the LP side comes from the vault LP's own net position when no round is open (guard.roundLpLong
    // when one is), and a call that lists no victim is never sent.
    const mdata = await this.d.conn.getAccountInfo(market, "confirmed");
    if (!mdata) return "market unreadable";
    const det = detectLayout(new Uint8Array(mdata.data));
    if (!det.known) return "market layout unknown";
    const load = this.d.loadPortfolios ?? (async (m: PublicKey, len: number) => (await fetchMarketPortfolios(this.d.conn as unknown as Connection, m, len)).map((a) => ({ pubkey: a.pubkey, data: a.account.data })));
    const all = await load(market, det.layout.portfolioAccountLen);
    const s = this.m(marketAddress);
    const batch = Math.min(this.d.config.w1BatchSize, W1_MAX_VICTIMS_PER_TX);
    const asset = gs.guard.assetIndex;
    let opening = !live0;
    let lpSide: boolean | null = null;
    if (opening) {
      const lpData = all.find((x) => x.pubkey.equals(lp))?.data;
      const net = lpData ? netPosOnAsset(lpData, asset) : null;
      lpSide = net === null || net === 0n ? null : net > 0n;
      if (lpSide === null) return "stop holds but the vault LP has no readable net position on the asset: nothing to cut";
    }
    let txs = 0;
    for (;;) {
      const g = gs.guard;
      if (!opening && !levW1RoundLiveV22(g, gs.slot)) {
        this.stats.w1.closed++;
        s.w1Listed.clear();
        return `round closed after ${txs} tx(s)`;
      }
      const lpLong = opening ? (lpSide as boolean) : g.roundLpLong;
      // an opening call starts a fresh round: the touched set resets on chain
      const victims = w1Victims(all, { assetIndex: asset, lpLong, roundId: g.roundId, touchedTags: opening ? [] : g.touchedTags, lp, listed: s.w1Listed });
      if (victims.length === 0) return opening ? "stop holds, no opposing portfolio to cut (no call sent)" : `round ${g.roundId} open, no opposing portfolio left to list (${txs} tx(s))`;
      if (txs >= this.d.config.w1MaxTxs) return `round ${g.roundId} still open after ${txs} tx(s) (limit); continues next cycle`;
      const list = victims.slice(0, batch);
      for (const v of list) s.w1Listed.add(`${g.roundId}:${v.toBase58()}`);
      const o = await send(list);
      txs++;
      const why = stop(o);
      if (why) {
        // not landed: the batch is not "listed" (a later run may list it again); a landed batch is in the guard's touched tags
        for (const v of list) s.w1Listed.delete(`${g.roundId}:${v.toBase58()}`);
        return why;
      }
      const next = await this.readGuard(marketAddress);
      if (!next) return "guard unreadable after batch";
      if (opening) {
        opening = false;
        this.stats.w1.roundsOpened++;
        if (!next.guard.roundActive) {
          this.stats.w1.closed++;
          s.w1Listed.clear();
          return `round opened and closed in the first call (${list.length} portfolio(s))`;
        }
      }
      gs = next;
    }
  }

  // ── health ──────────────────────────────────────────────────────────────────────────────────

  /** /health `levGuard` block (additive: absent unless a flag is on). */
  healthFields(): Record<string, unknown> {
    const c = this.d.config;
    const perMarket: Record<string, { holder: string | null; w1: string | null }> = {};
    for (const [k, v] of this.st) if (v.lastHolder || v.lastW1) perMarket[k] = { holder: v.lastHolder, w1: v.lastW1 };
    return { poke: c.poke, holderJob: c.holderJob, w1: c.w1, riskKey: !!this.d.riskKey, dryRun: this.d.dryRun, stats: this.stats, markets: perMarket };
  }
}

/** Signed net position of a portfolio on one asset (sum of `basis_pos_q` over its active legs on it), or null when it does not decode. */
export function netPosOnAsset(data: Uint8Array, assetIndex: number): bigint | null {
  try {
    let net = 0n;
    for (const leg of parsePortfolioV17(data).legs) if (leg.active && leg.assetIndex === assetIndex) net += leg.basisPosQ;
    return net;
  } catch {
    return null;
  }
}

/**
 * The opposing user portfolios: users whose EFFECTIVE (signed net) position on the asset is opposite the vault LP's (`lpLong`: the LP long faces users
 * with a negative net). Never the LP itself; portfolios already cut this round (the guard's touched tags) or already listed by this keeper this
 * round are skipped. Sorted by key, so the batches are deterministic.
 */
export function w1Victims(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  p: { assetIndex: number; lpLong: boolean; roundId: bigint; touchedTags: readonly bigint[]; lp: PublicKey; listed: ReadonlySet<string> },
): PublicKey[] {
  const touched = new Set(p.touchedTags);
  const out: PublicKey[] = [];
  for (const x of accounts) {
    if (x.pubkey.equals(p.lp) || touched.has(keyTagOf(x.pubkey)) || p.listed.has(`${p.roundId}:${x.pubkey.toBase58()}`)) continue;
    const net = netPosOnAsset(x.data, p.assetIndex);
    if (net === null || net === 0n) continue;
    if (p.lpLong ? net < 0n : net > 0n) out.push(x.pubkey);
  }
  return out.sort((a, b) => (a.toBase58() < b.toBase58() ? -1 : 1));
}
