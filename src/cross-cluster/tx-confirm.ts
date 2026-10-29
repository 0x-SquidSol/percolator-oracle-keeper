/**
 * cross-cluster/tx-confirm.ts
 *
 * Decide whether a sent transaction LANDED by asking the cluster for its
 * signature status — never by whether `confirmTransaction` happened to return
 * before its block-height deadline.
 *
 * Why (fee-flow audit F6, 2026-09-29): the LP-fee cranker logged SOLCAT
 * `5xq4yAXH…` and ANSEM `4RJv6kJt…` as "block height exceeded" FAILURES, but
 * both had landed OK (the slab counters showed lp_fee_withdrawn == accrued).
 * `confirmTransaction({signature, blockhash, lastValidBlockHeight})` throws
 * `TransactionExpiredBlockheightExceededError` when its websocket/poll loop
 * does not observe the confirmation before the blockhash's last valid block
 * height — which says nothing about whether the transaction executed. The
 * reverse bug was there too: a confirmation that returned `value.err` (the
 * transaction landed but FAILED on chain) was counted as success because the
 * result was never read.
 *
 * The rule here: the signature status is the source of truth.
 *   - status found, err == null, commitment >= confirmed  -> "landed"
 *   - status found, err != null, commitment >= confirmed   -> "failed" (on-chain)
 *   - status not found after the deadline and a re-check   -> "not-landed"
 *     (dropped/expired; safe to retry next cycle — it can no longer land,
 *      because its blockhash is past lastValidBlockHeight)
 *   - no verdict before `deadlineMs` (RPC down or hung)    -> "not-landed"
 *     (the blockhash may still be valid: unknown, retried next cycle)
 *
 * A7-1 (2026-10-22): the wait is getSignatureStatuses + getBlockHeight polling
 * over HTTP, no longer `confirmTransaction`. That one subscribes on the
 * websocket web3.js derives from the PRIMARY RPC URL and checks the status over
 * HTTP only once that subscription is up, so with the primary down (the case
 * rpc-failover.ts exists for) a tx that landed in ~1 s was reported only at
 * blockhash expiry, and with HTTP down as well the wait never returned. The
 * polls go through the failover fetch (pinned to the sending endpoint), and
 * the whole wait is bounded by `deadlineMs`.
 */
import type { Connection, SignatureStatus, TransactionError } from "@solana/web3.js";

export type ConfirmOutcome =
  | { status: "landed"; signature: string; via: "signature-status"; /** the slot it landed in */ slot: number }
  | { status: "failed"; signature: string; err: TransactionError; code: number | null }
  | { status: "not-landed"; signature: string; reason: string };

/** The subset of Connection this module uses — lets tests stub it precisely. */
export type ConfirmConnection = Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;

export interface ConfirmOptions {
  /** Re-checks of the signature status after the blockhash expired (0 = none). */
  statusRetries?: number;
  /** Delay between status polls after the first few seconds, and between those re-checks. */
  statusRetryDelayMs?: number;
  /** Hard bound on the whole wait (every RPC down, chain halted). Default 90 s: 150 blocks at 600 ms. */
  deadlineMs?: number;
}

/** The first polls are quick: a tx confirms in ~1-2 s, and the v2.2 round's slot-gap check (8 slots) waits on this. */
const FAST_POLLS = 10;
const FAST_POLL_MS = 400;
/** One RPC read may not outlive this (a hung fetch, or web3.js retrying a 429 inside the call): the next poll asks again. */
const READ_CAP_MS = 5_000;

/** `{"InstructionError":[i,{"Custom":N}]}` -> N. */
export function customCodeOf(err: unknown): number | null {
  const text = typeof err === "string" ? err : JSON.stringify(err ?? "");
  const dec = text.match(/"Custom"\s*:\s*(\d+)/);
  if (dec) return Number(dec[1]);
  const hex = text.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  return hex ? parseInt(hex[1], 16) : null;
}

function isConfirmed(s: SignatureStatus): boolean {
  return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized";
}

async function readStatus(conn: ConfirmConnection, signature: string): Promise<SignatureStatus | null> {
  const res = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
  return res.value[0] ?? null;
}

/**
 * Wait for `signature` and classify it by its signature status. Never throws:
 * an RPC failure while checking is reported as "not-landed" with the reason,
 * and the caller retries next cycle (every keeper fee instruction is
 * idempotent against its on-chain counters — a second attempt after a landed
 * first one returns the program's "nothing to do" code).
 *
 * Polls the status (FAST_POLLS every FAST_POLL_MS, then every
 * statusRetryDelayMs with a block-height check) until it is confirmed or
 * failed, the block height passes lastValidBlockHeight, or `deadlineMs` runs
 * out; then re-checks it `statusRetries` times (a lagging node may not show a
 * just-confirmed tx yet). While waiting that is ~1 RPC call/s, as the old
 * confirmTransaction expiry loop made. `blockhash` is unused (the expiry is
 * lastValidBlockHeight); it stays so every caller's call is unchanged.
 */
export async function confirmBySignature(
  conn: ConfirmConnection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  opts: ConfirmOptions = {},
): Promise<ConfirmOutcome> {
  const retries = opts.statusRetries ?? 3;
  const delayMs = opts.statusRetryDelayMs ?? 2_000;
  const t0 = Date.now();
  const deadline = t0 + (opts.deadlineMs ?? 90_000);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Each RPC call races READ_CAP_MS and the deadline: a hung request must not hold the wait open.
  const bounded = <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      const left = deadline - Date.now();
      timer = setTimeout(() => reject(new Error(left > READ_CAP_MS ? `read timed out after ${READ_CAP_MS} ms` : "confirm deadline reached")), Math.max(0, Math.min(READ_CAP_MS, left)));
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };

  let confirmError: string | null = null;
  const check = async (): Promise<ConfirmOutcome | null> => {
    try {
      const s = await bounded(readStatus(conn, signature));
      if (s) {
        // An error seen only at "processed" is not final (a minority fork): wait for "confirmed" either way.
        if (s.err && isConfirmed(s)) return { status: "failed", signature, err: s.err, code: customCodeOf(s.err) };
        if (!s.err && isConfirmed(s)) return { status: "landed", signature, via: "signature-status", slot: s.slot };
        // "processed" only: keep polling — it may still be confirmed.
      }
    } catch (err) {
      confirmError = `status read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  };

  let ended = "confirm deadline reached";
  for (let poll = 1; ; poll++) {
    await sleep(poll <= FAST_POLLS ? Math.min(FAST_POLL_MS, delayMs) : delayMs); // nothing is confirmed the instant it is sent
    const out = await check();
    if (out) return out;
    if (Date.now() >= deadline) break;
    if (poll >= FAST_POLLS || Date.now() - t0 >= FAST_POLLS * FAST_POLL_MS) { // capped hung reads must not stretch the fast window
      try {
        const height = await bounded(conn.getBlockHeight("confirmed"));
        if (height > lastValidBlockHeight) {
          ended = `block height exceeded (${height} > ${lastValidBlockHeight})`;
          break;
        }
      } catch (err) {
        confirmError = `block height read failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  for (let attempt = 0; attempt < retries && Date.now() < deadline; attempt++) {
    await sleep(delayMs);
    const out = await check();
    if (out) return out;
  }
  return {
    status: "not-landed",
    signature,
    reason: `no confirmed signature status (${`${ended}${confirmError ? ` | ${confirmError}` : ""}`.slice(0, 120)})`,
  };
}
