/**
 * cross-cluster/p2b-allocate.ts
 *
 * P2b Earn-as-counterparty: periodic tag 103 (VaultLpAllocate) cranks on BOUND vault-LP markets
 * that have room (percolator-prog #526, d9e3e2d7).
 *
 * Tag 103 is permissionless and Live-only. It moves senior (Earn) principal into the vault LP's
 * capital, and the PROGRAM clamps the amount to
 * `min(alpha * C_eff - allocated, drawable - buffer * C_eff)`, so the keeper always sends
 * `u128::MAX` and lets the program decide how much fits. It is refused with Custom(100)
 * (VaultLpAllocateRefused) on: a senior draw outstanding/pending, an impaired vault, an insolvent
 * LP, junior < 5% of C_eff, a market that is not Live, or no room. Custom(100) therefore means
 * "skip this crank", never an error to page on.
 *
 * Discipline (a market with no room must cost nothing but a simulation):
 *   - paced per market (default ~60 s, jittered so markets do not synchronise);
 *   - eligibility checked locally first (bound, Live, no senior draw outstanding): no RPC beyond
 *     the tick's shared snapshot for an ineligible market;
 *   - SIMULATE first; only a clean simulation is sent. A refused / failed simulation is counted
 *     and never sent;
 *   - the wallet-balance guard pauses sends; consecutive hard failures back the market off;
 *   - the ext PDA is passed every time (the first call creates it, the cranker paying ~0.002 SOL
 *     rent); once it exists the registry flag is set and the tag-78 tail (lp-fee-cranker.ts)
 *     follows automatically on the next fee cycle.
 *
 * Compute: tag 103 runs a full certificate refresh of the vault LP; the SDK says to budget it
 * like tag 77. No tag-103 measurement was published, so the default is the SDK's heaviest
 * vault-LP figure (`RECOMMENDED_CU_P3.tradeCpi` = 600k, worst measured 405k there); override with
 * P2B_ALLOCATE_CU.
 */
import { ComputeBudgetProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { RECOMMENDED_CU_P3, buildVaultLpAllocateIxP2b } from "@percolatorct/sdk";
import type { Alert } from "./alerting.ts";
import { isLiveMarket } from "./market-state.ts";
import { isComputeExhaustion, parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import { classifyProbeError } from "./p2b-feature.ts";
import { VAULT_LP_ALLOCATE_REFUSED } from "./lock-codes.ts";
import type { VaultMarketSnapshot } from "./p2b-markets.ts";
import { lpVaultRegistryBondFlag } from "./registry-flags.ts";

export interface AllocateConfig {
  /** Mean pacing per market. */
  intervalMs: number;
  /** +- fraction of the interval, uniform (0.25 = +-25%). */
  jitter: number;
  computeUnits: number;
  /** Backoff ceiling after consecutive hard failures. */
  maxBackoffMs: number;
  dryRun: boolean;
}

export const DEFAULT_ALLOCATE_CONFIG: AllocateConfig = {
  intervalMs: 60_000,
  jitter: 0.25,
  computeUnits: RECOMMENDED_CU_P3.tradeCpi,
  maxBackoffMs: 10 * 60_000,
  dryRun: false,
};

type Env = Readonly<Record<string, string | undefined>>;

function envNum(env: Env, name: string, fallback: number, opts: { min: number; max: number; int?: boolean }): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < opts.min || n > opts.max || (opts.int && !Number.isInteger(n))) {
    throw new Error(`${name}="${raw}" must be ${opts.int ? "an integer" : "a number"} in [${opts.min}, ${opts.max}]`);
  }
  return n;
}

/** P2B_ALLOCATE_INTERVAL_MS (60000), P2B_ALLOCATE_JITTER_PCT (25), P2B_ALLOCATE_CU (600000). Throws on garbage. */
export function allocateConfigFromEnv(env: Env, dryRun: boolean): AllocateConfig {
  return {
    intervalMs: envNum(env, "P2B_ALLOCATE_INTERVAL_MS", DEFAULT_ALLOCATE_CONFIG.intervalMs, { min: 1_000, max: 86_400_000, int: true }),
    jitter: envNum(env, "P2B_ALLOCATE_JITTER_PCT", DEFAULT_ALLOCATE_CONFIG.jitter * 100, { min: 0, max: 90 }) / 100,
    computeUnits: envNum(env, "P2B_ALLOCATE_CU", DEFAULT_ALLOCATE_CONFIG.computeUnits, { min: 50_000, max: 1_400_000, int: true }),
    maxBackoffMs: DEFAULT_ALLOCATE_CONFIG.maxBackoffMs,
    dryRun,
  };
}

export type AllocateOutcome =
  | "not-due"
  | "ineligible"
  | "wallet-low"
  | "no-room"
  | "refused"
  | "unsupported"
  | "dry-run"
  | "sent"
  | "failed";

export interface AllocateStats {
  /** Simulations run. */
  sims: number;
  /** Simulations answered Custom(100): no room (healthy, silent). */
  noRoom: number;
  /** Simulations refused with another program error (counted by code in `refusedCodes`). */
  refusedOther: number;
  refusedCodes: Record<string, number>;
  sent: number;
  landed: number;
  failed: number;
  ineligible: number;
  walletLow: number;
}

export type AllocateConnection = Pick<Connection, "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses">;

export interface AllocateDeps {
  programId: PublicKey;
  conn: AllocateConnection;
  keeper: Keypair;
  /** True while the keeper wallet is below its minimum balance: sends are paused. */
  walletLow?: () => boolean;
  /** The feature gate's "a send hit InvalidInstructionData" hook. */
  onUnsupported?: () => void;
  confirm?: ConfirmOptions;
  now?: () => number;
  rand?: () => number;
  log?: (line: string) => void;
}

/** The tag-103 cranker. One instance per process. */
export class VaultLpAllocator {
  private readonly nextAt = new Map<string, number>();
  private readonly failStreak = new Map<string, { n: number; last: string; label: string }>();
  private readonly loggedRefusals = new Set<string>();
  private lastFail = "failed";
  readonly stats: AllocateStats = { sims: 0, noRoom: 0, refusedOther: 0, refusedCodes: {}, sent: 0, landed: 0, failed: 0, ineligible: 0, walletLow: 0 };

  constructor(
    private readonly cfg: AllocateConfig,
    private readonly deps: AllocateDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private rand(): number {
    return (this.deps.rand ?? Math.random)();
  }
  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Pace the next attempt for a market: interval +- jitter, doubled per consecutive hard failure up to the ceiling. */
  private schedule(market: string, hardFailures: number): void {
    const base = this.cfg.intervalMs * 2 ** Math.min(hardFailures, 4);
    const jittered = base * (1 + this.cfg.jitter * (this.rand() * 2 - 1));
    this.nextAt.set(market, this.now() + Math.min(this.cfg.maxBackoffMs, Math.max(1_000, jittered)));
  }

  /** Is this market's turn up? A market seen for the first time is staggered uniformly across one interval. */
  isDue(market: string): boolean {
    const at = this.nextAt.get(market);
    if (at === undefined) {
      this.nextAt.set(market, this.now() + Math.floor(this.rand() * this.cfg.intervalMs));
      return false;
    }
    return this.now() >= at;
  }

  /** Local eligibility from the shared snapshot: bound, Live, a decodable vault state and no senior draw outstanding. */
  static eligible(snap: VaultMarketSnapshot): boolean {
    if (!snap.bound || !snap.vaultLp || !snap.registry || !snap.marketData) return false;
    if (!isLiveMarket(snap.marketData)) return false;
    return snap.vaultLp.seniorDrawOutstandingAtoms === 0n;
  }

  /** Alerts for markets whose tag 103 keeps failing (hard failures only; no-room / refusals never alert). */
  activeAlerts(minStreak = 3): Alert[] {
    const out: Alert[] = [];
    for (const [market, f] of this.failStreak) {
      if (f.n >= minStreak) {
        out.push({
          kind: "fee-job-failed",
          severity: "warn",
          subject: f.label,
          message: `p2b-allocate failed ${f.n}x consecutively: ${f.last.slice(0, 160)}`,
          data: { job: "p2b-allocate", market, streak: f.n },
        });
      }
    }
    return out;
  }

  /** One market's turn. Never throws. */
  async runMarket(snap: VaultMarketSnapshot): Promise<AllocateOutcome> {
    const key = snap.ref.marketAddress;
    if (!this.isDue(key)) return "not-due";
    if (!VaultLpAllocator.eligible(snap)) {
      this.stats.ineligible++;
      this.schedule(key, 0);
      return "ineligible";
    }
    if (this.deps.walletLow?.()) {
      this.stats.walletLow++;
      this.schedule(key, 0);
      return "wallet-low";
    }
    const hard = this.failStreak.get(key)?.n ?? 0;
    try {
      const out = await this.attempt(snap);
      if (out === "failed") this.recordFailure(key, snap.ref.label, this.lastFail);
      else if (out === "sent" || out === "no-room" || out === "refused" || out === "dry-run") this.failStreak.delete(key);
      this.schedule(key, out === "failed" ? (this.failStreak.get(key)?.n ?? hard + 1) : 0);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.stats.failed++;
      this.recordFailure(key, snap.ref.label, msg);
      this.schedule(key, this.failStreak.get(key)?.n ?? 1);
      return "failed";
    }
  }

  private recordFailure(market: string, label: string, msg: string): void {
    const cur = this.failStreak.get(market);
    this.failStreak.set(market, { n: (cur?.n ?? 0) + 1, last: msg, label });
  }

  private async attempt(snap: VaultMarketSnapshot): Promise<AllocateOutcome> {
    const { conn, keeper, programId } = this.deps;
    const ix = buildVaultLpAllocateIxP2b(
      { programId, market: snap.market, registryDomain: snap.registry!.domain, lpPortfolio: snap.vaultLp!.lpPortfolio },
      keeper.publicKey,
      undefined,
      // EARN-10: on a market whose registry has the bond-tranche flag (byte 162) the program REQUIRES the
      // ["bond_tranche", market] account at [9]; without it tag 103 fails NotEnoughAccountKeys.
      { bondTranche: snap.registryData ? lpVaultRegistryBondFlag(snap.registryData) : false },
    );
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: this.cfg.computeUnits }));
    tx.add(ix);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    this.stats.sims++;
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      const ie = parseInstructionError(sim.value.err);
      if (ie?.custom === VAULT_LP_ALLOCATE_REFUSED) {
        this.stats.noRoom++;
        return "no-room";
      }
      if (classifyProbeError(sim.value.err) === "unsupported") {
        this.deps.onUnsupported?.();
        return "unsupported";
      }
      if (isComputeExhaustion(sim.value.err, sim.value.logs)) {
        this.stats.failed++;
        this.lastFail = `simulation ran out of compute at ${this.cfg.computeUnits} CU`;
        this.log(`[p2b-allocate] ${snap.ref.label}: simulation ran out of compute at ${this.cfg.computeUnits} CU — raise P2B_ALLOCATE_CU`);
        return "failed";
      }
      if (ie?.custom !== null && ie?.custom !== undefined) {
        const code = String(ie.custom);
        this.stats.refusedOther++;
        this.stats.refusedCodes[code] = (this.stats.refusedCodes[code] ?? 0) + 1;
        const lk = `${snap.ref.marketAddress}:${code}`;
        if (!this.loggedRefusals.has(lk)) {
          this.loggedRefusals.add(lk);
          this.log(`[p2b-allocate] ${snap.ref.label}: tag 103 refused in simulation with Custom(${code}) — skipped (logged once per code)`);
        }
        return "refused";
      }
      this.stats.failed++;
      this.lastFail = `simulation error ${JSON.stringify(sim.value.err).slice(0, 140)}`;
      this.log(`[p2b-allocate] ${snap.ref.label}: ${this.lastFail}`);
      return "failed";
    }
    if (this.cfg.dryRun) {
      this.log(`[p2b-allocate] [DRY-RUN] ${snap.ref.label}: tag 103 would succeed (not sent)`);
      return "dry-run";
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    this.stats.sent++;
    const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, this.deps.confirm);
    if (c.status === "landed") {
      this.stats.landed++;
      this.log(`[p2b-allocate] ${snap.ref.label}: tag 103 landed sig=${sig.slice(0, 16)}… (simulated ${sim.value.unitsConsumed ?? "?"} CU of ${this.cfg.computeUnits})`);
      return "sent";
    }
    if (c.status === "failed" && c.code === VAULT_LP_ALLOCATE_REFUSED) {
      // the state moved between the simulation and the landing: the same benign "no room"
      this.stats.noRoom++;
      return "no-room";
    }
    this.stats.failed++;
    this.lastFail = c.status === "failed" ? `landed but failed on chain ${JSON.stringify(c.err).slice(0, 100)}` : `not landed: ${c.reason}`;
    this.log(
      c.status === "failed"
        ? `[p2b-allocate] ${snap.ref.label}: landed but failed on chain ${JSON.stringify(c.err).slice(0, 100)} sig=${sig.slice(0, 16)}…`
        : `[p2b-allocate] ${snap.ref.label}: not landed (retry next turn): ${c.reason}`,
    );
    return "failed";
  }
}
