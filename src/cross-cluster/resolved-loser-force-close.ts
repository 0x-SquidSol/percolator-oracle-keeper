/**
 * cross-cluster/resolved-loser-force-close.ts
 *
 * SEC-RC §S16AC Info I-S1: with engine e59aa6a6 ("S1-6 a/c"), a winner on a Resolved market WITHOUT vault cover who
 * closes before the losing side has settled is refused with `EngineLockActive` (Custom 21) and the whole CloseResolved
 * reverts. The refusal clears once the loss side closes. If the losers never act, the only bound is the market's
 * force-close delay, after which ANYONE may close them. This job is that "anyone": once the delay has passed it closes the
 * resolved portfolios that are not themselves waiting, so the waiting winners are released.
 *
 * Gating (wrapper 367e3d08 = 75fca911 src, engine e59aa6a6):
 *   - CloseResolved (tag 30) `handle_close_resolved`, src/v16_program.rs:29036. The owner key at [0] is a KEY match,
 *     not a signature (`authorize_owner_or_nft_holder`, :29071 / :42660), EXCEPT before the delay:
 *       :29094-29099  if cfg.force_close_delay_slots != 0
 *                        && authenticated_slot - group.header.resolved_slot < cfg.force_close_delay_slots
 *                     { expect_signer(owner) }        -> ExpectedSigner = Custom(6) for an unsigned owner
 *     `authenticated_slot` = max(Clock.slot, header.current_slot) (:13582). The delay is validated to
 *     1..=MAX_FORCE_CLOSE_DELAY_SLOTS = 10,000,000 (:859, :28000).
 *   - `force_close_delay_slots` is the u64 at WrapperConfigV16 +144 (:2606), read here with the SDK's
 *     `parseWrapperConfigV17(...).forceCloseDelaySlots` (same offset). `resolved_slot` is the engine group header field
 *     (market-state.ts `decodeTerminalState`).
 *   - The wait itself: e59aa6a6 src/v16.rs:24542 (`if !self.source_domain_terminal_for_haircut_demote(..) { return
 *     Err(V16Error::LockActive) }`), mapped to EngineLockActive = 21 by the wrapper (:2023).
 *
 * What a pass does (bounded, idempotent, never throws):
 *   1. Not Resolved / nothing materialized -> nothing.
 *   2. Before the delay -> nothing at all (no simulation, no send): only the owner can close then.
 *   3. The deployed wrapper is not a known S1-6 a/c build (s16ac-engine-gate.ts) -> nothing: behaviour before the
 *      upgrade is unchanged.
 *   4. Simulate CloseResolved (owner unsigned) for at most `maxScanPerCycle` candidate portfolios (rotating window).
 *      Custom(21) = a claimant WAITING on the loss side. A simulation that changes the portfolio = closable now.
 *   5. No waiting claimant (this pass, or a previous pass while the scan is truncated) -> nothing sent: the S1-6 wait is
 *      not in play (e.g. a bound-vault market, whose winners are covered before the engine realises).
 *   6. Otherwise send CloseResolved for every candidate that is NOT waiting (the loss side, plus any claimant already
 *      payable, whose payout goes to its own owner's token account), at most `maxClosesPerCycle` portfolios and
 *      `maxChunkCallsPerPortfolio` chunk calls each (a bankrupt close advances one chunk per call; a call that would
 *      change nothing is never sent). Then re-simulate the waiting ones and report which are released. The waiting
 *      winners are NOT closed in the same pass: they close themselves (the app shows them a calm "waiting" line).
 * The emptied portfolios are left materialized with an empty claim; the existing late-finalize cleanup
 * (resolved-portfolio-cleanup.ts `closeFinalizedReceiptPortfolios`) deregisters them with tag 8.
 *
 * Every step logs one structured line: `[resolved-loser-force-close] {"event": ...}`.
 */
import { ComputeBudgetProgram, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import { parsePortfolioV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import { decodeTerminalState } from "./market-state.ts";
import {
  buildCloseResolvedIx,
  buildCreateAtaIdempotentIx,
  ownerAta,
  pdaOwnerKind,
  portfolioLenForMarketData,
} from "./resolved-portfolio-cleanup.ts";
import { parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";
import { addKeeperPriorityFee } from "./priority-fee.ts";
import { S16acGateState, s16acEngineDeployed } from "./s16ac-engine-gate.ts";
import type { FeeJob, FeeJobOutcome } from "./fee-jobs.ts";
import { WRAPPER_PROGRAM_ID, NFT_PROGRAM_ID } from "../program-ids.ts";

/** Wrapper EngineLockActive: the S1-6 (c) wait when a resolved close is refused on a Resolved market. */
export const WRAPPER_ERR_ENGINE_LOCK_ACTIVE = 21;
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const COMPUTE_UNIT_LIMIT = 400_000; // CloseResolved measured up to ~301k (app lib/limits/trader-resolved-exit.ts)

export interface LoserForceCloseConfig {
  wrapperProgramId: PublicKey;
  nftProgramId: PublicKey;
  /** CloseResolved simulations per market per pass (rotating window over the candidates). */
  maxScanPerCycle: number;
  /** Portfolios force-closed per market per pass. */
  maxClosesPerCycle: number;
  /** CloseResolved chunk calls per portfolio per pass. */
  maxChunkCallsPerPortfolio: number;
  /** Owner token accounts the keeper may create (it pays the rent) per market per pass. */
  maxAtaCreatesPerCycle: number;
  /** Re-read the deployed wrapper's build this often. */
  gateTtlMs: number;
  confirm?: ConfirmOptions;
  now?: () => number;
  /** Structured log sink (default console.log). */
  log?: (line: string) => void;
}

export function loserForceCloseConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LoserForceCloseConfig | null {
  if (env.RESOLVED_LOSER_FORCE_CLOSE_ENABLED === "false") return null;
  return {
    wrapperProgramId: WRAPPER_PROGRAM_ID,
    nftProgramId: NFT_PROGRAM_ID,
    maxScanPerCycle: 32,
    maxClosesPerCycle: 8,
    maxChunkCallsPerPortfolio: 16,
    maxAtaCreatesPerCycle: 4,
    gateTtlMs: 10 * 60_000,
  };
}

/** Per-process state: the build cache, the rotating scan cursor and the markets seen waiting while truncated. */
export class LoserForceCloseState {
  readonly gate = new S16acGateState();
  readonly cursor = new Map<string, number>();
  readonly waitingSeen = new Set<string>();
}

export interface ForceCloseWindow {
  delaySlots: bigint;
  resolvedSlot: bigint;
  /** First slot at which a non-owner may close. */
  opensAtSlot: bigint;
  open: boolean;
  slotsLeft: bigint;
}

/**
 * The wrapper's predicate (:29094-29099) with the cluster slot standing in for `authenticated_slot`: the owner must sign
 * while `delay != 0 && now - resolved_slot < delay`. A cluster slot of 0 (unknown) is never "open".
 */
export function forceCloseWindow(delaySlots: bigint, resolvedSlot: bigint, nowSlot: bigint): ForceCloseWindow {
  const opensAtSlot = resolvedSlot + delaySlots;
  if (nowSlot <= 0n) return { delaySlots, resolvedSlot, opensAtSlot, open: false, slotsLeft: delaySlots };
  const elapsed = nowSlot > resolvedSlot ? nowSlot - resolvedSlot : 0n;
  const open = delaySlots === 0n || elapsed >= delaySlots;
  return { delaySlots, resolvedSlot, opensAtSlot, open, slotsLeft: open ? 0n : delaySlots - elapsed };
}

export type LoserForceCloseOutcome =
  | "not-resolved"
  | "before-delay"
  | "engine-gate-off"
  | "no-candidates"
  | "no-wait"
  | "closed"
  | "nothing-closable"
  | "failed";

export interface LoserForceCloseResult {
  outcome: LoserForceCloseOutcome;
  window: ForceCloseWindow | null;
  /** Portfolios whose CloseResolved simulation answered Custom(21): claimants waiting on the loss side. */
  waiting: string[];
  /** Portfolios force-closed this pass (CloseResolved landed until no further progress). */
  closed: string[];
  /** Chunk calls sent. */
  calls: number;
  /** Waiting portfolios whose CloseResolved simulates OK after this pass's closes. */
  released: string[];
  /** Portfolios not closed this pass, with why. */
  skipped: Array<{ portfolio: string; reason: string }>;
  simulations: number;
  sends: number;
  detail: string;
}

export type LoserForceCloseConnection = Pick<
  Connection,
  "getProgramAccounts" | "getAccountInfo" | "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "getBlockHeight" | "getSignatureStatuses"
>;

interface Candidate {
  pubkey: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
  pda: boolean;
}

function hasClaim(d: Uint8Array): boolean {
  const p = parsePortfolioV17(d);
  return p.capital !== 0n || p.pnl !== 0n || p.reservedPnl !== 0n || p.cancelDepositEscrow !== 0n || p.legs.some((l) => l.active);
}

function errText(err: unknown): string {
  const ie = parseInstructionError(err);
  if (ie?.custom != null) return `ix ${ie.index} Custom(${ie.custom})`;
  return JSON.stringify(err).slice(0, 100);
}

/**
 * One pass for one market. `marketData` is the market account as read this cycle; `nowSlot` the cluster slot.
 * Never throws (an unexpected error returns outcome "failed").
 */
export async function forceCloseResolvedLosers(
  conn: LoserForceCloseConnection,
  keeper: Keypair,
  market: PublicKey,
  marketData: Uint8Array,
  nowSlot: bigint,
  dryRun: boolean,
  cfg: LoserForceCloseConfig,
  st: LoserForceCloseState,
): Promise<LoserForceCloseResult> {
  const mkt = market.toBase58();
  const log = cfg.log ?? ((l: string) => console.log(l));
  const ev = (event: string, data: Record<string, unknown>): void =>
    log(`[resolved-loser-force-close] ${JSON.stringify({ event, market: mkt, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const out: LoserForceCloseResult = { outcome: "not-resolved", window: null, waiting: [], closed: [], calls: 0, released: [], skipped: [], simulations: 0, sends: 0, detail: "" };
  try {
    const state = decodeTerminalState(marketData);
    if (!state || state.kind !== "resolved" || state.materializedPortfolios === 0n) {
      st.waitingSeen.delete(mkt);
      out.detail = "market is not Resolved with materialized portfolios";
      return out;
    }
    const cfgW = parseWrapperConfigV17(marketData);
    const w = forceCloseWindow(cfgW.forceCloseDelaySlots, state.resolvedSlot, nowSlot);
    out.window = w;
    if (!w.open) {
      out.outcome = "before-delay";
      out.detail = `force-close delay not passed: opens at slot ${w.opensAtSlot} (${w.slotsLeft} slots left); only owners can close`;
      return out; // nothing at all before the delay
    }
    const gate = await s16acEngineDeployed(conn, cfg.wrapperProgramId, st.gate, cfg.gateTtlMs, cfg.now);
    if (!gate.on) {
      out.outcome = "engine-gate-off";
      out.detail = `deployed wrapper is not a known S1-6 a/c build (${gate.state}): no change from pre-upgrade behaviour`;
      return out;
    }

    // Candidates: this market's portfolios with something to close, except the vault LP (tag 30 refuses it; tag 101).
    const accs = await conn.getProgramAccounts(cfg.wrapperProgramId, {
      filters: [
        { dataSize: portfolioLenForMarketData(marketData) },
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 16, bytes: mkt } },
      ],
    });
    const all: Candidate[] = [];
    for (const a of accs) {
      const d = new Uint8Array(a.account.data);
      const owner = parsePortfolioV17(d).owner;
      const kind = pdaOwnerKind(owner, market, cfg);
      if (kind === "lp-registry" || !hasClaim(d)) continue;
      all.push({ pubkey: a.pubkey, owner, data: d, pda: kind !== null });
    }
    all.sort((x, y) => x.pubkey.toBase58().localeCompare(y.pubkey.toBase58()));
    if (all.length === 0) {
      st.waitingSeen.delete(mkt);
      out.outcome = "no-candidates";
      out.detail = "no portfolio with a claim left";
      return out;
    }
    const truncated = all.length > cfg.maxScanPerCycle;
    const start = truncated ? (st.cursor.get(mkt) ?? 0) % all.length : 0;
    const window = truncated ? Array.from({ length: cfg.maxScanPerCycle }, (_, i) => all[(start + i) % all.length]) : all;
    if (truncated) st.cursor.set(mkt, (start + cfg.maxScanPerCycle) % all.length);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const mkTx = (ixs: TransactionInstruction[], n: number): Transaction => {
      const tx = new Transaction();
      // A distinct limit per chunk call so repeated chunks never share a signature.
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT - n }));
      for (const ix of ixs) tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = keeper.publicKey;
      addKeeperPriorityFee(tx);
      tx.sign(keeper);
      return tx;
    };
    const simWatch = async (tx: Transaction, watch: PublicKey) => {
      out.simulations++;
      const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        sigVerify: false,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: [watch.toBase58()] },
      });
      const a = r.value.accounts?.[0];
      return { err: r.value.err, post: a ? new Uint8Array(Buffer.from(a.data[0], "base64")) : null };
    };
    const send = async (tx: Transaction): Promise<boolean> => {
      if (dryRun) return true;
      out.sends++;
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      return (await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm)).status === "landed";
    };
    const closeIx = (c: Candidate): TransactionInstruction =>
      buildCloseResolvedIx({ wrapperProgramId: cfg.wrapperProgramId, owner: c.owner, market, portfolio: c.pubkey, collateralMint: cfgW.collateralMint });

    // Probe: which candidates wait on the loss side (21), which close now.
    const closable: Array<{ c: Candidate; pre: TransactionInstruction[] }> = [];
    const waiting: Candidate[] = [];
    let ataBudget = cfg.maxAtaCreatesPerCycle;
    let ataExists: Map<string, boolean> | null = null;
    for (const c of window) {
      const r = await simWatch(mkTx([closeIx(c)], 0), c.pubkey);
      const ie = parseInstructionError(r.err);
      if (r.err && ie?.index === 1 && ie.custom === WRAPPER_ERR_ENGINE_LOCK_ACTIVE) {
        waiting.push(c);
        continue;
      }
      if (!r.err) {
        if (r.post && !Buffer.from(r.post).equals(Buffer.from(c.data))) closable.push({ c, pre: [] });
        else out.skipped.push({ portfolio: c.pubkey.toBase58(), reason: "CloseResolved would make no progress" });
        continue;
      }
      // A payout needs the owner's token account: create it (bounded) and re-simulate. Never for a PDA owner.
      if (!c.pda && ataBudget > 0) {
        if (!ataExists) {
          const keys = window.map((q) => ownerAta(q.owner, cfgW.collateralMint));
          const infos = await conn.getMultipleAccountsInfo(keys, "confirmed");
          ataExists = new Map(window.map((q, i) => [q.pubkey.toBase58(), infos[i] != null]));
        }
        if (ataExists.get(c.pubkey.toBase58()) === false) {
          const pre = [buildCreateAtaIdempotentIx(keeper.publicKey, c.owner, cfgW.collateralMint)];
          const r2 = await simWatch(mkTx([...pre, closeIx(c)], 0), c.pubkey);
          if (!r2.err && r2.post && !Buffer.from(r2.post).equals(Buffer.from(c.data))) {
            ataBudget--;
            closable.push({ c, pre });
            continue;
          }
        }
      }
      out.skipped.push({ portfolio: c.pubkey.toBase58(), reason: `CloseResolved refused: ${errText(r.err)}` });
    }
    out.waiting = waiting.map((c) => c.pubkey.toBase58());
    if (waiting.length > 0) st.waitingSeen.add(mkt);
    else if (!truncated) st.waitingSeen.delete(mkt);
    if (waiting.length === 0 && !st.waitingSeen.has(mkt)) {
      out.outcome = "no-wait";
      out.detail = `no claimant waiting on the loss side (${window.length} scanned): nothing to release`;
      return out;
    }
    ev("wait_detected", { waiting: out.waiting, closable: closable.map((x) => x.c.pubkey.toBase58()), opensAtSlot: w.opensAtSlot, nowSlot });

    // Close the closable portfolios (the loss side), bounded; each chunk sent only if it changes the portfolio.
    for (const [k, { c, pre }] of closable.entries()) {
      const key = c.pubkey.toBase58();
      if (k >= cfg.maxClosesPerCycle) {
        out.skipped.push({ portfolio: key, reason: `over the ${cfg.maxClosesPerCycle}-per-cycle bound; next cycle` });
        continue;
      }
      let current = c.data;
      let calls = 0;
      let stop = "";
      for (;;) {
        if (calls >= cfg.maxChunkCallsPerPortfolio) {
          stop = `per-cycle cap of ${cfg.maxChunkCallsPerPortfolio} chunk calls`;
          break;
        }
        const ixs = calls === 0 ? [...pre, closeIx(c)] : [closeIx(c)];
        const tx = mkTx(ixs, calls);
        const r = await simWatch(tx, c.pubkey);
        if (r.err) {
          stop = calls === 0 ? `CloseResolved refused: ${errText(r.err)}` : "done";
          break;
        }
        if (!r.post || Buffer.from(r.post).equals(Buffer.from(current))) {
          stop = "done";
          break;
        }
        if (!(await send(tx))) {
          stop = "tx did not land";
          break;
        }
        calls++;
        out.calls++;
        current = r.post;
        if (!hasClaim(current)) {
          stop = "done";
          break;
        }
      }
      if (calls > 0) {
        out.closed.push(key);
        ev("loser_force_closed", { portfolio: key, owner: c.owner.toBase58(), calls, stop, dryRun });
      } else {
        out.skipped.push({ portfolio: key, reason: stop });
      }
    }

    // Which waiting claimants are now free to close (they close themselves).
    if (out.closed.length > 0 && !dryRun) {
      for (const c of waiting) {
        const r = await simWatch(mkTx([closeIx(c)], 0), c.pubkey);
        const ie = parseInstructionError(r.err);
        if (!(r.err && ie?.custom === WRAPPER_ERR_ENGINE_LOCK_ACTIVE)) out.released.push(c.pubkey.toBase58());
      }
      if (out.released.length > 0) ev("winners_released", { released: out.released });
    }
    out.outcome = out.closed.length > 0 ? "closed" : "nothing-closable";
    out.detail = out.closed.length > 0
      ? `force-closed ${out.closed.length} resolved portfolio(s) after the delay (${out.calls} call(s)); ${out.waiting.length} waiting, ${out.released.length} released`
      : `${out.waiting.length} claimant(s) waiting on the loss side, nothing closable this pass` +
        (out.skipped.length ? ` [${out.skipped.slice(0, 3).map((s) => `${s.portfolio.slice(0, 8)}…: ${s.reason}`).join("; ")}]` : "");
    if (out.outcome === "nothing-closable") ev("wait_unresolved", { waiting: out.waiting, skipped: out.skipped });
    return out;
  } catch (err) {
    out.outcome = "failed";
    out.detail = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    ev("failed", { error: out.detail });
    return out;
  }
}

/** Fee-job wrapper: one pass per market per cycle. */
export function makeResolvedLoserForceCloseJob(cfg: LoserForceCloseConfig, st = new LoserForceCloseState()): FeeJob {
  return {
    name: "resolved-loser-force-close",
    run: async (ctx, m): Promise<FeeJobOutcome> => {
      let market: PublicKey;
      try {
        market = new PublicKey(m.marketAddress);
      } catch {
        return { kind: "failed", error: "unparseable market address" };
      }
      const conn = ctx.conn;
      let data: Uint8Array;
      let nowSlot: bigint;
      try {
        const [mi] = await conn.getMultipleAccountsInfo([market], "confirmed");
        if (!mi || !mi.owner.equals(cfg.wrapperProgramId)) return { kind: "skipped", reason: "market not owned by the configured wrapper" };
        data = new Uint8Array(mi.data);
        const s = decodeTerminalState(data);
        if (!s || s.kind !== "resolved" || s.materializedPortfolios === 0n) return { kind: "nothing" };
        nowSlot = BigInt(await conn.getSlot("confirmed"));
      } catch (err) {
        return { kind: "failed", error: `read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
      }
      const r = await forceCloseResolvedLosers(conn, ctx.keeper, market, data, nowSlot, ctx.dryRun, cfg, st);
      switch (r.outcome) {
        case "closed":
          return { kind: "done", detail: r.detail };
        case "failed":
          return { kind: "failed", error: r.detail };
        case "nothing-closable":
          return { kind: "waiting", reason: r.detail };
        default:
          return { kind: "nothing", detail: r.detail };
      }
    },
  };
}
