/**
 * cross-cluster/vault-lp-crank.ts
 *
 * P3 FINAL d119eebd "senior draw": PermissionlessCrank on a market's BOUND vault-LP
 * portfolio (`AssetVaultLpV18.vault_lp_portfolio`), when that portfolio is liquidatable
 * after a mark move, draws its realised deficit from the vault's pots — junior first,
 * then the Earn seniors pro rata — BEFORE the engine can liquidate it into a bankrupt
 * close (handle_permissionless_crank_zero_copy -> vault_lp_physical_draw, d119eebd
 * v16_program.rs ~23390/26707). No draw happens unless something cranks THAT portfolio
 * after the move, so the keeper cranks it after every landed mark move on a bound market.
 *
 * Also parses the program's `p3_senior_draw*` log lines (d119eebd :26754/26814/26915/27019)
 * from any crank simulation into alerts:
 *   p3_senior_draw deficit=D moved=M unfunded=U …          U > 0 -> critical: senior
 *                                                          backing exhausted, the loss
 *                                                          reaches the engine
 *   p3_senior_draw_booked moved=M junior_cover=J senior_loss=S C=C outstanding=O
 *                                                          S > 0 -> warn "Earn absorbed S"
 *   p3_senior_draw_restored to_seniors=R C=C outstanding=O -> logged (recovery)
 */
import { ComputeBudgetProgram, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { buildObservationCrankIx, parseInstructionError } from "./positioned-refresh.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import type { Alert, AlertSink } from "./alerting.ts";
import { staleResolveWindow } from "./market-state.ts";
import type { StaleResolveWindow } from "./market-state.ts";
import { exhaustedAlert, getExhaustedRegistry } from "./p3-exhausted-resolve.ts";
import type { ExhaustedRegistry } from "./p3-exhausted-resolve.ts";
import { loneLpCrankSuppressedFor, triggerProtectiveRound } from "./v22/delegation.ts";
import { addKeeperPriorityFee } from "./priority-fee.ts";

export type SeniorDrawEvent =
  | { kind: "draw"; deficit: bigint; moved: bigint; unfunded: bigint }
  | { kind: "booked"; moved: bigint; juniorCover: bigint; seniorLoss: bigint; seniorClaim: bigint; outstanding: bigint }
  | { kind: "restored"; toSeniors: bigint; seniorClaim: bigint; outstanding: bigint };

/** Parse every p3_senior_draw* line in a program log. Order preserved. */
export function parseSeniorDrawLogs(logs: ReadonlyArray<string> | null | undefined): SeniorDrawEvent[] {
  const out: SeniorDrawEvent[] = [];
  for (const l of logs ?? []) {
    // `booked`: parsed BY FIELD NAME so both wrapper shapes work. v2.1: `... moved= junior_cover= senior_loss= C= outstanding=`;
    // v2.2 puts `nav= stray= c_eff= harvestable=` first (v16_program.rs:32580). Every field the alert needs must be present.
    if (/p3_senior_draw_booked\b/.test(l)) {
      const f = (name: string): bigint | null => {
        const mm = l.match(new RegExp(`(?:^|\\s)${name}=(\\d+)`));
        return mm ? BigInt(mm[1]) : null;
      };
      const moved = f("moved");
      const juniorCover = f("junior_cover");
      const seniorLoss = f("senior_loss");
      const seniorClaim = f("C");
      const outstanding = f("outstanding");
      if (moved !== null && juniorCover !== null && seniorLoss !== null && seniorClaim !== null && outstanding !== null) {
        out.push({ kind: "booked", moved, juniorCover, seniorLoss, seniorClaim, outstanding });
        continue;
      }
    }
    let m: RegExpMatchArray | null;
    m = l.match(/p3_senior_draw_restored to_seniors=(\d+) C=(\d+) outstanding=(\d+)/);
    if (m) {
      out.push({ kind: "restored", toSeniors: BigInt(m[1]), seniorClaim: BigInt(m[2]), outstanding: BigInt(m[3]) });
      continue;
    }
    m = l.match(/p3_senior_draw deficit=(\d+) moved=(\d+) unfunded=(\d+)/);
    if (m) out.push({ kind: "draw", deficit: BigInt(m[1]), moved: BigInt(m[2]), unfunded: BigInt(m[3]) });
  }
  return out;
}

/**
 * The "Earn absorbed X" alerts a batch of senior-draw events warrants (booked senior
 * losses). Exhaustion (a draw line with unfunded > 0) is `p3-senior-backing-exhausted`,
 * raised by `reportSeniorDraw` with the tag 39 window (p3-exhausted-resolve.ts).
 */
export function seniorDrawAlerts(market: string, label: string, events: ReadonlyArray<SeniorDrawEvent>): Alert[] {
  const alerts: Alert[] = [];
  for (const e of events) {
    if (e.kind === "booked" && e.seniorLoss > 0n) {
      alerts.push({
        kind: "p3-senior-draw",
        severity: "warn",
        subject: label,
        dedupe: `C=${e.seniorClaim}:O=${e.outstanding}:S=${e.seniorLoss}`,
        message:
          `Earn absorbed ${e.seniorLoss} atoms on ${market} (junior covered ${e.juniorCover}; senior claim C now ${e.seniorClaim}; ` +
          `outstanding senior loss ${e.outstanding} — vault-LP risk-increasing fills, 97 and 102 halted while > 0)`,
        data: { market, seniorLoss: e.seniorLoss.toString(), juniorCover: e.juniorCover.toString(), outstanding: e.outstanding.toString() },
      });
    }
  }
  return alerts;
}

/** The first draw line that could not be fully funded, if any. */
export function exhaustionOf(events: ReadonlyArray<SeniorDrawEvent>): { deficit: bigint; unfunded: bigint } | null {
  for (const e of events) if (e.kind === "draw" && e.unfunded > 0n) return { deficit: e.deficit, unfunded: e.unfunded };
  return null;
}

export type VaultLpCrankConnection = Pick<Connection, "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "getSlot">;

export interface VaultLpCrankConfig {
  wrapperProgramId: PublicKey;
  /** How long a market's vault-LP lookup (present or absent) is cached. */
  lookupTtlMs: number;
  /**
   * Wait this long after the push is SENT before simulating the crank, so the new mark
   * is in the processed state the simulation reads (the push loop does not await
   * confirmation). A crank against the old mark would miss the draw for this move.
   */
  settleMs?: number;
  /** Withhold mark pushes on an exhausted market so the tag 39 window can run. */
  withholdPushes?: boolean;
  registry?: ExhaustedRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Engine EngineNonProgress: this crank had nothing to do (e.g. already cranked this slot). */
const NON_PROGRESS = 22;

/**
 * Cranks a bound market's vault LP after every landed mark move. One instance per
 * process; `onPushLanded` never throws and never blocks the push loop for long
 * (at most one crank in flight per market; a move during one is covered by the next).
 */
export class VaultLpCranker {
  private readonly lookup = new Map<string, { vaultLp: PublicKey | null; at: number }>();
  private readonly lastMark = new Map<string, bigint>();
  private readonly inflight = new Set<string>();
  readonly stats = { cranked: 0, benign: 0, failed: 0, suppressed: 0 };

  constructor(
    private readonly conn: VaultLpCrankConnection,
    private readonly keeper: Keypair,
    private readonly sink: Pick<AlertSink, "fire">,
    private readonly cfg: VaultLpCrankConfig,
  ) {}

  /** The market's bound vault-LP portfolio, or null (not a P3 bound market). Cached. */
  async vaultLpFor(market: PublicKey): Promise<PublicKey | null> {
    const key = market.toBase58();
    const now = (this.cfg.now ?? Date.now)();
    const c = this.lookup.get(key);
    if (c && now - c.at < this.cfg.lookupTtlMs) return c.vaultLp;
    let vaultLp: PublicKey | null = null;
    try {
      const [si] = await this.conn.getMultipleAccountsInfo([deriveVaultLpState(this.cfg.wrapperProgramId, market)], "confirmed");
      const st = si ? decodeVaultLpState(new Uint8Array(si.data)) : null;
      vaultLp = st ? st.lpPortfolio : null;
    } catch {
      return c?.vaultLp ?? null; // keep the last answer on an RPC error
    }
    this.lookup.set(key, { vaultLp, at: now });
    return vaultLp;
  }

  /** The tag 39 window of a market now (null when unreadable / not Live). Never throws. */
  async windowFor(market: PublicKey): Promise<StaleResolveWindow | null> {
    try {
      const [[mi], slot] = await Promise.all([this.conn.getMultipleAccountsInfo([market], "confirmed"), this.conn.getSlot("confirmed")]);
      return mi ? staleResolveWindow(new Uint8Array(mi.data), BigInt(slot)) : null;
    } catch {
      return null;
    }
  }

  /** Call after a push LANDED for `marketAddress` at `priceE6`. Returns what happened (for tests/logs). */
  async onPushLanded(marketAddress: string, priceE6: bigint, label = marketAddress): Promise<"no-move" | "busy" | "not-bound" | "cranked" | "benign" | "failed" | "suppressed"> {
    // v2.2 SETTLE_PAIRING / VAULT_LP_LONE_CRANK=off: a LONE LP crank settles the LP without its counterparties, which
    // can strand value at a price peak (settle-pairing.ts). The suppressor is installed only when a v2.2 flag asks for
    // it; with nothing installed this is a no-op and the method is unchanged.
    if (loneLpCrankSuppressedFor(marketAddress)) {
      this.stats.suppressed++;
      // Not a lone LP crank: if the LP itself needs protection the v2.2 layer runs a full PAIRED round instead.
      if (this.lastMark.get(marketAddress) !== priceE6) {
        this.lastMark.set(marketAddress, priceE6);
        triggerProtectiveRound(marketAddress);
      }
      return "suppressed";
    }
    const prev = this.lastMark.get(marketAddress);
    if (prev === priceE6) return "no-move";
    this.lastMark.set(marketAddress, priceE6);
    if (this.inflight.has(marketAddress)) return "busy";
    this.inflight.add(marketAddress);
    try {
      const market = new PublicKey(marketAddress);
      const vaultLp = await this.vaultLpFor(market);
      if (!vaultLp) return "not-bound";
      const settle = this.cfg.settleMs ?? 1_500;
      if (settle > 0) await (this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(settle);
      const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(buildObservationCrankIx(this.keeper.publicKey, market, vaultLp));
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.keeper.publicKey;
      addKeeperPriorityFee(tx); // S3-A2: optional CU price, appended last (OFF by default)
      tx.sign(this.keeper);
      const sim = await this.conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "processed" });
      if (sim.value.err) {
        const ie = parseInstructionError(sim.value.err);
        if (ie?.custom === NON_PROGRESS) {
          this.stats.benign++;
          return "benign";
        }
        this.stats.failed++;
        this.lastMark.delete(marketAddress); // retry on the next landed push even at the same mark
        await reportSeniorDraw(this.sink, marketAddress, label, sim.value.logs ?? null, { registry: this.cfg.registry ?? getExhaustedRegistry() });
        console.warn(`[vault-lp-crank] ${label}: crank after mark move refused in simulation: ${JSON.stringify(sim.value.err)}`);
        return "failed";
      }
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      this.stats.cranked++;
      const logs = sim.value.logs ?? null;
      const window = exhaustionOf(parseSeniorDrawLogs(logs)) ? await this.windowFor(market) : undefined;
      await reportSeniorDraw(this.sink, marketAddress, label, logs, {
        registry: this.cfg.registry ?? getExhaustedRegistry(),
        window,
        withholdPushes: this.cfg.withholdPushes ?? true,
      });
      return "cranked";
    } catch (err) {
      this.stats.failed++;
      this.lastMark.delete(marketAddress);
      console.warn(`[vault-lp-crank] ${label}: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
      return "failed";
    } finally {
      this.inflight.delete(marketAddress);
    }
  }
}

/**
 * Parse a crank's logs and fire the senior-draw alerts. "Earn absorbed" is one-shot per
 * booking; exhaustion marks the market in the exhausted registry (push withholding +
 * the p3-exhausted job) and fires `p3-senior-backing-exhausted` with the tag 39 window
 * when the caller read it (`window`; undefined = the job reports it next fee cycle).
 * Never throws.
 */
export async function reportSeniorDraw(
  sink: Pick<AlertSink, "fire">,
  market: string,
  label: string,
  logs: ReadonlyArray<string> | null,
  opts: { registry?: ExhaustedRegistry; window?: StaleResolveWindow | null; withholdPushes?: boolean } = {},
): Promise<SeniorDrawEvent[]> {
  const events = parseSeniorDrawLogs(logs);
  const ex = exhaustionOf(events);
  if (ex) {
    const reg = opts.registry ?? getExhaustedRegistry();
    reg.mark(market, ex.deficit, ex.unfunded);
    if (opts.window) reg.setWindow(market, opts.window.enabled);
    const withholding = reg.shouldWithholdPush(market, opts.withholdPushes ?? true);
    const a = exhaustedAlert(market, label, ex, opts.window ?? null, withholding);
    if (opts.window === undefined) a.message += " (tag 39 window: reported by the p3-exhausted job on the next fee cycle)";
    try {
      await sink.fire(`p3-senior-backing-exhausted:${market}`, a);
    } catch {
      // alerting never breaks a crank path
    }
  }
  for (const e of events) {
    if (e.kind === "restored") console.log(`[vault-lp-crank] ${label}: senior draw recovery restored ${e.toSeniors} atoms to the seniors (C ${e.seniorClaim}, outstanding ${e.outstanding})`);
  }
  for (const a of seniorDrawAlerts(market, label, events)) {
    try {
      await sink.fire(`p3-senior-draw:${market}`, a);
    } catch {
      // alerting never breaks a crank path
    }
  }
  return events;
}
