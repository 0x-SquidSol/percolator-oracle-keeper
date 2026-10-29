/**
 * cross-cluster/v22/exec.ts
 *
 * The one place a v2.2 transaction is built, SIMULATED, and (when armed) sent.
 *
 *  - Every send is preceded by a simulation. A simulation error is never sent through.
 *  - Dry-run (KEEPER_V22_DRY_RUN, DRY_RUN, or a per-job dry flag such as G9's): the simulation runs, the would-be
 *    transaction is LOGGED ("[v22][DRY-RUN] would send ..."), and nothing is sent.
 *  - Refusals carry the program error NAME (errors.ts); band-market expected states (104/111/112/113) are reported
 *    as `expected`, not as failures.
 *  - No signing happens in dry-run (the transaction is compiled unsigned for the simulation).
 */
import { ComputeBudgetProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import { confirmBySignature } from "../tx-confirm.ts";
import type { ConfirmOptions } from "../tx-confirm.ts";
import { BAND_EXPECTED_CODES, errorCodeOf, formatProgramError } from "./errors.ts";
import type { ProgramKind } from "./errors.ts";
import { parseInstructionError } from "../positioned-refresh.ts";
import { addKeeperPriorityFee } from "../priority-fee.ts";
import { redactErrorText } from "./redact.ts";

/** Compute-budget instructions buildTx puts in front of the caller's list (heap frame + unit limit). */
export const COMPUTE_IX_COUNT = 2;

export type ExecConnection = Pick<Connection, "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "getBlockHeight" | "getSignatureStatuses">;

export interface ExecContext {
  conn: ExecConnection;
  keeper: Keypair;
  /** Global dry run (DRY_RUN / --dry-run or KEEPER_V22_DRY_RUN). */
  dryRun: boolean;
  confirm?: ConfirmOptions;
  /** Extra signers (a new account being created); the keeper always signs. */
  extraSigners?: ReadonlyArray<Keypair>;
  log?: (line: string) => void;
}

export interface ExecOptions {
  /** Short stable name of the job ("sweep", "fee-78", "rent-106", ...). */
  job: string;
  label: string;
  /** Compute-unit limit (the heap frame is requested too, as the wrapper needs it). */
  units: number;
  /** Which program's error table names a refusal. */
  program?: ProgramKind;
  /** Per-job dry run on top of the global one (G9 default). */
  dryRun?: boolean;
  /** Codes that are expected states for this call (default: the band set). */
  expected?: ReadonlySet<number>;
  /** Send even when the simulation reports a compute-budget overrun? Never. Kept explicit for tests. */
  priorityMicroLamportsPerCu?: number;
  /** Evaluated AFTER a clean simulation and BEFORE the send: return a reason to hold the tx (nothing is sent). */
  beforeSend?: () => string | null;
  /**
   * F1: accounts whose POST-simulation state the first simulation returns (base58, market first). Used with `extend`.
   */
  accounts?: ReadonlyArray<string>;
  /**
   * F1: called with the post-simulation accounts (index-aligned with `accounts`, null where missing) after a CLEAN first
   * simulation. Returning a list REPLACES the instruction list: it is simulated again and what that simulation says is the
   * outcome (a refusal index is relative to the returned list). Returning null keeps the original. Must not throw (a throw
   * is treated as null). The original list is never sent once an extended list was returned.
   */
  extend?: (post: ReadonlyArray<Uint8Array | null>) => readonly TransactionInstruction[] | null;
  /**
   * F1: called with the post-simulation accounts of the EXTENDED (second) simulation, when it was clean. Returning a reason rejects the
   * extension: the original list (already simulated clean) is sent instead. Must not throw (a throw rejects nothing).
   */
  verifyExtended?: (post: ReadonlyArray<Uint8Array | null>) => string | null;
}

export type ExecOutcome =
  | { kind: "sent"; signature: string; landed: "landed" | "failed" | "not-landed"; /** program error code of a landed-but-failed tx */ failCode: number | null; landedSlot: number | null; unitsConsumed: number | null; logs: string[] }
  | { kind: "dry-run"; unitsConsumed: number | null; logs: string[]; ixCount: number }
  | { kind: "refused"; code: number | null; /** instruction index inside the SENT list (compute-budget ixs excluded), or null */ index: number | null; name: string; expected: boolean; logs: string[] }
  | { kind: "held"; reason: string }
  | { kind: "failed"; error: string };

/** Per-job counters, exported through /health (health.ts). */
export interface JobCounters {
  sent: number;
  /** Of `sent`: landed but failed on chain / never seen landed (`sent` counts every send). */
  landedFailed: number;
  notLanded: number;
  dryRun: number;
  refused: number;
  expected: number;
  failed: number;
  held: number;
  byError: Record<string, number>;
  lastError: string | null;
  lastAt: number | null;
}

const counters = new Map<string, JobCounters>();

export function jobCounters(job: string): JobCounters {
  let c = counters.get(job);
  if (!c) {
    c = { sent: 0, landedFailed: 0, notLanded: 0, dryRun: 0, refused: 0, expected: 0, failed: 0, held: 0, byError: {}, lastError: null, lastAt: null };
    counters.set(job, c);
  }
  return c;
}

export function allJobCounters(): Record<string, JobCounters> {
  return Object.fromEntries([...counters].map(([k, v]) => [k, { ...v, byError: { ...v.byError } }]));
}

export function resetJobCounters(): void {
  counters.clear();
}

function bump(job: string, o: ExecOutcome, now: () => number): void {
  const c = jobCounters(job);
  c.lastAt = now();
  if (o.kind === "sent") {
    c.sent++;
    if (o.landed === "failed") c.landedFailed++;
    else if (o.landed === "not-landed") c.notLanded++;
  } else if (o.kind === "dry-run") c.dryRun++;
  else if (o.kind === "refused") {
    if (o.expected) c.expected++;
    else c.refused++;
    c.byError[o.name] = (c.byError[o.name] ?? 0) + 1;
    if (!o.expected) c.lastError = o.name;
  } else if (o.kind === "held") {
    c.held++;
  } else {
    c.failed++;
    c.lastError = redactErrorText(o.error);
  }
}

function buildTx(keeper: Keypair, ixs: readonly TransactionInstruction[], o: ExecOptions, blockhash: string): Transaction {
  const tx = new Transaction();
  // Heap frame first, as computeBudgetPrelude does (the wrapper needs the 128 KiB heap on every tx).
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: o.units }));
  if (o.priorityMicroLamportsPerCu && o.priorityMicroLamportsPerCu > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.priorityMicroLamportsPerCu }));
  }
  for (const ix of ixs) tx.add(ix);
  // S3-A2: the env-configured price (OFF by default) when no explicit per-call price is set, appended LAST so the refusal
  // index arithmetic above (COMPUTE_IX_COUNT prelude) is unchanged.
  addKeeperPriorityFee(tx);
  tx.recentBlockhash = blockhash;
  tx.feePayer = keeper.publicKey;
  return tx;
}

/** Simulate; on a clean simulation send (unless dry-run). Never throws. */
export async function simulateAndSend(
  ctx: ExecContext,
  ixs: readonly TransactionInstruction[],
  o: ExecOptions,
  now: () => number = Date.now,
): Promise<ExecOutcome> {
  const log = ctx.log ?? ((l: string) => console.log(l));
  const out = await run();
  bump(o.job, out, now);
  return out;

  async function run(): Promise<ExecOutcome> {
    try {
      const { blockhash, lastValidBlockHeight } = await ctx.conn.getLatestBlockhash("confirmed");
      const dry = ctx.dryRun || o.dryRun === true;
      let list: readonly TransactionInstruction[] = ixs;
      const make = (l: readonly TransactionInstruction[]): Transaction => {
        const t = buildTx(ctx.keeper, l, o, blockhash);
        if (!dry) t.sign(ctx.keeper, ...(ctx.extraSigners ?? []));
        return t;
      };
      const simulate = (t: Transaction, withAccounts: boolean) =>
        ctx.conn.simulateTransaction(new VersionedTransaction(t.compileMessage()), {
          sigVerify: false,
          commitment: "processed",
          ...(withAccounts && o.accounts ? { accounts: { encoding: "base64" as const, addresses: [...o.accounts] } } : {}),
        });
      let tx = make(list);
      let sim = await simulate(tx, o.extend !== undefined && o.accounts !== undefined);
      const firstSim = sim;
      if (!sim.value.err && o.extend && o.accounts) {
        let ext: readonly TransactionInstruction[] | null = null;
        try {
          const raw = (sim.value.accounts as Array<{ data: [string, string] } | null> | null | undefined) ?? [];
          ext = o.extend(o.accounts.map((_, i) => (raw[i] ? new Uint8Array(Buffer.from(raw[i]!.data[0], "base64")) : null)));
        } catch {
          ext = null;
        }
        if (ext && ext.length > 0) {
          list = ext;
          tx = make(list);
          sim = await simulate(tx, o.verifyExtended !== undefined);
          if (!sim.value.err && o.verifyExtended) {
            let why: string | null = null;
            try {
              const raw2 = (sim.value.accounts as Array<{ data: [string, string] } | null> | null | undefined) ?? [];
              why = o.verifyExtended(o.accounts.map((_, i) => (raw2[i] ? new Uint8Array(Buffer.from(raw2[i]!.data[0], "base64")) : null)));
            } catch {
              why = null;
            }
            if (why) {
              list = ixs;
              tx = make(list);
              sim = firstSim;
            }
          }
        }
      }
      const logs = sim.value.logs ?? [];
      const units = sim.value.unitsConsumed ?? null;
      if (sim.value.err) {
        const ie = parseInstructionError(sim.value.err);
        const code = ie?.custom ?? errorCodeOf(sim.value.err);
        const expected = code !== null && (o.expected ?? BAND_EXPECTED_CODES).has(code);
        const index = ie ? ie.index - COMPUTE_IX_COUNT - (o.priorityMicroLamportsPerCu && o.priorityMicroLamportsPerCu > 0 ? 1 : 0) : null;
        return { kind: "refused", code, index: index !== null && index >= 0 ? index : null, name: formatProgramError(o.program ?? "wrapper", code), expected, logs };
      }
      if (dry) {
        log(`[v22][DRY-RUN] ${o.job} ${o.label}: would send ${list.length} instruction(s) [${list.map((i) => `tag ${i.data[0]}`).join(", ")}] units=${o.units} simulated=${units ?? "n/a"}`);
        return { kind: "dry-run", unitsConsumed: units, logs, ixCount: list.length };
      }
      const hold = o.beforeSend?.() ?? null;
      if (hold) return { kind: "held", reason: hold };
      const sig = await ctx.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      const c = await confirmBySignature(ctx.conn, sig, blockhash, lastValidBlockHeight, ctx.confirm);
      const landedSlot = c.status === "landed" ? c.slot : null;
      const failCode = c.status === "failed" ? c.code : null;
      return { kind: "sent", signature: sig, landed: c.status, failCode, landedSlot, unitsConsumed: units, logs };
    } catch (err) {
      return { kind: "failed", error: redactErrorText(err instanceof Error ? err.message : String(err)) };
    }
  }
}

/** Simulate only (a quote). Never sends, never signs. */
export async function simulateOnly(
  ctx: Pick<ExecContext, "conn" | "keeper">,
  ixs: readonly TransactionInstruction[],
  o: Pick<ExecOptions, "units" | "program">,
  extra?: { accounts?: string[] },
): Promise<{ err: unknown; logs: string[]; unitsConsumed: number | null; code: number | null; accounts: Array<{ data: [string, string] } | null> | null }> {
  const { blockhash } = await ctx.conn.getLatestBlockhash("confirmed");
  const tx = buildTx(ctx.keeper, ixs, { job: "sim", label: "sim", units: o.units }, blockhash);
  const sim = await ctx.conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false,
    commitment: "processed",
    ...(extra?.accounts ? { accounts: { encoding: "base64" as const, addresses: extra.accounts } } : {}),
  });
  const err = sim.value.err;
  return {
    err,
    logs: sim.value.logs ?? [],
    unitsConsumed: sim.value.unitsConsumed ?? null,
    code: err ? parseInstructionError(err)?.custom ?? errorCodeOf(err) : null,
    accounts: (sim.value.accounts as Array<{ data: [string, string] } | null> | null | undefined) ?? null,
  };
}
