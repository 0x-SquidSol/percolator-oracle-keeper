/**
 * cross-cluster/p3-exhausted-resolve.ts
 *
 * `p3-senior-backing-exhausted` (security review, P3 FINAL d119eebd). When a bound
 * vault LP is liquidatable and its pots cannot fund the deficit, the crank's physical
 * draw logs `p3_senior_draw deficit=D moved=M unfunded=U` with U > 0 and returns
 * exhausted = true: the program then lets the engine open a bankrupt close on the vault
 * LP (`vault_lp_refuse_new_bankrupt_close` only refuses one while the pots could still
 * pay). The loss now reaches the engine, and the market needs a resolve:
 *
 *   - permissionless: tag 39 ResolveStalePermissionless once
 *     `now - last_good_oracle_slot >= permissionless_resolve_stale_slots` (and the
 *     latter is non-zero), see market-state.ts `staleResolveWindow`;
 *   - otherwise the market admin.
 *
 * Every accepted mark push advances `last_good_oracle_slot`, so the window can only run
 * while the keeper stops pushing that market. With the window enabled the keeper
 * WITHHOLDS pushes on an exhausted market (P3_EXHAUSTED_WITHHOLD_PUSHES=false to keep
 * pushing) and sends tag 39 itself once it has matured. With the window disabled
 * (stale_slots = 0, which is how every live v18 market was seeded) there is no
 * permissionless exit: the alert says admin, and pushes continue.
 *
 * Detection is sticky per process and restart-safe: the vault-LP crank after a mark
 * move (vault-lp-crank.ts) and the accrual cranker mark a market as soon as a crank
 * logs U > 0; this job also re-simulates the vault-LP crank for any bound Live market
 * it does not yet know about, so a keeper restart re-learns the state.
 */
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { buildObservationCrankIx } from "./positioned-refresh.ts";
import { marketMode, staleResolveWindow } from "./market-state.ts";
import type { StaleResolveWindow } from "./market-state.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import type { Alert } from "./alerting.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import { addKeeperPriorityFee } from "./priority-fee.ts";

export const WRAPPER_TAG_RESOLVE_STALE_PERMISSIONLESS = 39;

export interface ExhaustedEntry {
  deficit: bigint;
  unfunded: bigint;
  /** ms timestamp of first detection. */
  since: number;
  /** Last known state of the tag 39 window (null until read). */
  windowEnabled: boolean | null;
}

/** Markets whose vault-LP senior backing was found exhausted. */
export class ExhaustedRegistry {
  private readonly m = new Map<string, ExhaustedEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Record a detection; returns true when this is new. */
  mark(market: string, deficit: bigint, unfunded: bigint): boolean {
    const cur = this.m.get(market);
    if (cur) {
      cur.deficit = deficit;
      cur.unfunded = unfunded;
      return false;
    }
    this.m.set(market, { deficit, unfunded, since: this.now(), windowEnabled: null });
    return true;
  }
  get(market: string): ExhaustedEntry | undefined {
    return this.m.get(market);
  }
  has(market: string): boolean {
    return this.m.has(market);
  }
  clear(market: string): void {
    this.m.delete(market);
  }
  setWindow(market: string, enabled: boolean): void {
    const e = this.m.get(market);
    if (e) e.windowEnabled = enabled;
  }
  /** Push-loop gate: withhold only where a permissionless window exists to run. */
  shouldWithholdPush(market: string, withholdEnabled: boolean): boolean {
    return withholdEnabled && this.m.get(market)?.windowEnabled === true;
  }
  markets(): string[] {
    return [...this.m.keys()];
  }
}

let singleton: ExhaustedRegistry | null = null;
/** Process-wide registry shared by the cranks, the push loop gate and the job. */
export function getExhaustedRegistry(): ExhaustedRegistry {
  if (!singleton) singleton = new ExhaustedRegistry();
  return singleton;
}

export function buildResolveStalePermissionlessIx(wrapperProgramId: PublicKey, market: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = WRAPPER_TAG_RESOLVE_STALE_PERMISSIONLESS;
  data.writeBigUInt64LE(0n, 1); // now_slot: the wrapper authenticates against Clock
  return new TransactionInstruction({ programId: wrapperProgramId, keys: [{ pubkey: market, isSigner: false, isWritable: true }], data });
}

/** Human status of the resolve path for an exhausted market. */
export function resolvePathText(w: StaleResolveWindow): string {
  if (!w.enabled) {
    return "permissionless resolve is DISABLED on this market (permissionless_resolve_stale_slots = 0): only the market admin can resolve it";
  }
  if (w.matured) return `tag 39 (ResolveStalePermissionless) is possible now (stale window ${w.staleSlots} slots has passed)`;
  return `tag 39 (ResolveStalePermissionless) becomes possible in ${w.remaining} slots (window ${w.staleSlots}, last good oracle slot ${w.lastGoodOracleSlot}); or the market admin can resolve sooner`;
}

export function exhaustedAlert(market: string, label: string, e: Pick<ExhaustedEntry, "deficit" | "unfunded">, w: StaleResolveWindow | null, withholding: boolean): Alert {
  const path = w ? resolvePathText(w) : "resolve window unknown (market not readable as Live)";
  return {
    kind: "p3-senior-backing-exhausted",
    severity: "critical",
    subject: label,
    message:
      `senior backing EXHAUSTED on ${market}: ${e.unfunded} of a ${e.deficit}-atom vault-LP deficit cannot be drawn from the pots, ` +
      `so the loss reaches the engine and the market needs a resolve. ${path}.` +
      (withholding ? " The keeper is withholding mark pushes on this market so the stale window can run, and will send tag 39 itself when it matures." : ""),
    data: {
      market,
      deficit: e.deficit.toString(),
      unfunded: e.unfunded.toString(),
      permissionlessResolve: w ? w.enabled : null,
      slotsUntilTag39: w && w.enabled ? w.remaining.toString() : null,
      withholdingPushes: withholding,
    },
  };
}

export type ExhaustedJobConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getSlot" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses"
>;

export interface ExhaustedJobConfig {
  wrapperProgramId: PublicKey;
  registry: ExhaustedRegistry;
  /** Bound vault-LP portfolio lookup (VaultLpCranker.vaultLpFor), for restart-safe detection. */
  vaultLpFor?: (market: PublicKey) => Promise<PublicKey | null>;
  withholdPushes: boolean;
  confirmOpts?: ConfirmOptions;
}

/** Parse only the draw lines' unfunded part (avoids a cycle with vault-lp-crank.ts). */
function unfundedFromLogs(logs: ReadonlyArray<string> | null | undefined): { deficit: bigint; unfunded: bigint } | null {
  for (const l of logs ?? []) {
    const m = l.match(/p3_senior_draw deficit=(\d+) moved=(\d+) unfunded=(\d+)/);
    if (m && BigInt(m[3]) > 0n) return { deficit: BigInt(m[1]), unfunded: BigInt(m[3]) };
  }
  return null;
}

async function simulate(conn: ExhaustedJobConnection, keeper: { publicKey: PublicKey }, ix: TransactionInstruction) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = keeper.publicKey;
  const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
  return r.value;
}

export function makeExhaustedResolveJob(cfg: ExhaustedJobConfig): FeeJob {
  return {
    name: "p3-exhausted",
    async run(ctx, m): Promise<FeeJobOutcome> {
      const conn = ctx.conn as unknown as ExhaustedJobConnection;
      const reg = cfg.registry;
      let market: PublicKey;
      try {
        market = new PublicKey(m.marketAddress);
      } catch {
        return { kind: "skipped", reason: "unparseable market address" };
      }
      const [info] = await conn.getMultipleAccountsInfo([market], "confirmed");
      const d = info ? new Uint8Array(info.data) : null;
      if (!d || marketMode(d) !== 0) {
        // Resolved / Recovery / closed: the resolve happened (or the valve took it); stop withholding.
        if (reg.has(m.marketAddress)) {
          reg.clear(m.marketAddress);
          return { kind: "done", detail: "exhausted market left Live; push withholding lifted" };
        }
        return { kind: "nothing" };
      }
      if (!reg.has(m.marketAddress)) {
        if (!cfg.vaultLpFor) return { kind: "nothing" };
        const vaultLp = await cfg.vaultLpFor(market);
        if (!vaultLp) return { kind: "nothing" };
        const sim = await simulate(conn, ctx.keeper, buildObservationCrankIx(ctx.keeper.publicKey, market, vaultLp));
        const hit = unfundedFromLogs(sim.logs);
        if (!hit) return { kind: "nothing" };
        reg.mark(m.marketAddress, hit.deficit, hit.unfunded);
      }
      const e = reg.get(m.marketAddress)!;
      const slot = BigInt(await conn.getSlot("confirmed"));
      const w = staleResolveWindow(d, slot);
      if (!w) return { kind: "nothing" };
      reg.setWindow(m.marketAddress, w.enabled);
      const withholding = reg.shouldWithholdPush(m.marketAddress, cfg.withholdPushes);
      const alert = exhaustedAlert(m.marketAddress, m.label, e, w, withholding);
      if (!w.enabled || !w.matured || ctx.dryRun) {
        return { kind: "blocked", reason: alert.message, alertKind: "p3-senior-backing-exhausted", severity: "critical" };
      }
      // Window matured: send tag 39 ourselves, simulation first.
      const ix = buildResolveStalePermissionlessIx(cfg.wrapperProgramId, market);
      const sim = await simulate(conn, ctx.keeper, ix);
      if (sim.err) return { kind: "failed", error: `tag 39 refused in simulation: ${JSON.stringify(sim.err).slice(0, 120)}` };
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = ctx.keeper.publicKey;
      addKeeperPriorityFee(tx); // S3-A2: optional CU price, appended last (OFF by default)
      tx.sign(ctx.keeper);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirmOpts);
      if (c.status !== "landed") {
        return { kind: "failed", error: `tag 39 ${c.status === "failed" ? `failed on chain: ${JSON.stringify(c.err).slice(0, 100)}` : `not landed: ${c.reason}`} sig=${sig.slice(0, 16)}…` };
      }
      reg.clear(m.marketAddress);
      return {
        kind: "done",
        detail: `tag 39 ResolveStalePermissionless sent (senior backing exhausted) sig=${sig.slice(0, 16)}…`,
        signature: sig,
        events: [
          {
            kind: "p3-senior-backing-exhausted",
            severity: "critical",
            subject: m.label,
            message: `keeper RESOLVED ${m.marketAddress} with tag 39 after senior backing was exhausted (unfunded ${e.unfunded}); wind-down takes over`,
            data: { market: m.marketAddress, signature: sig },
          },
        ],
      };
    },
  };
}
