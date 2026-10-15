/**
 * cross-cluster/fee-error.ts
 *
 * Two things every fee job needs when a wrapper instruction is refused:
 *
 * 1. THE CODE, NEVER CUT OFF. A web3.js SendTransactionError reads
 *      "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1b. \nLogs: …"
 *    and the fee-job cycle line's `.slice(0, 100)` cut it to "… Instruction 1: custom p", so the code (27,
 *    OracleStale) was lost (R3.20, 2026-10-15; lp-fee's own `.slice(0, 140)` was one stack trace away from the same). `describeProgramError` puts `Name(code)` FIRST and only then a short,
 *    clipped human text; `clipKeepingCode` is the safe replacement for a bare `.slice(0, n)` on any error string.
 *
 * 2. THE STALE-RESOLVE WAIT. Tag 78 (handle_lp_vault_crank_fees) and tag 87 (WithdrawInsuranceReserveToStake) both
 *    call `reject_permissionless_resolve_matured_live_view` (percolator-prog 153c62fc src/v16_program.rs:13546), which
 *    answers OracleStale (27) on a LIVE market once
 *      permissionless_resolve_stale_slots != 0 && now_slot - config.last_good_oracle_slot >= permissionless_resolve_stale_slots
 *    (oracle_v16::permissionless_stale_matured, :11714). Only a mark push (PushAuthMark tag 63, or a crank mirroring a
 *    pushed profile) advances `last_good_oracle_slot`. So after a keeper outage longer than the window (18,000 slots on
 *    the v2.2 markets), or for a market newly added to the registry that nobody pushed for that long, the fee loop's
 *    first cycle — which starts at boot, concurrently with the push loop — meets 27 until the first push lands.
 *    That is a wait, not a fault: `staleResolveWait` confirms it from the market bytes and the cluster slot, and a 27
 *    WITHOUT a matured window stays a failure.
 */
import { PERCOLATOR_ERRORS } from "@percolatorct/sdk";
import { customCodeOf } from "./tx-confirm.ts";
import { staleResolveWindow } from "./market-state.ts";

/** Wrapper OracleStale — what the matured stale-resolve gate answers. */
export const ORACLE_STALE = 27;

/**
 * Slots of skew allowed between the RPC's slot and the program's `max(Clock, engine slot)` when confirming that the
 * window has matured. The program already said 27; this only absorbs the read happening a few slots off.
 */
export const STALE_WAIT_SLOT_SKEW = 32n;

/** The text of anything thrown or returned as an error. */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const logs = (err as Error & { logs?: unknown }).logs;
    return Array.isArray(logs) && logs.length ? `${err.message}\n${logs.join("\n")}` : err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err ?? null) ?? String(err);
}

/** The custom program code of an error value / message / SendTransactionError (incl. its logs), or null. */
export function programErrorCode(err: unknown): number | null {
  return customCodeOf(errorText(err));
}

/** `OracleStale(27)`; `Custom(999)` for an unnamed code. */
export function formatWrapperCode(code: number): string {
  const name = PERCOLATOR_ERRORS[code]?.name;
  return name ? `${name}(${code})` : `Custom(${code})`;
}

/** First line of the human text, minus web3.js's "Simulation failed. Message:" boilerplate. */
function shortText(text: string): string {
  return text
    .replace(/^Simulation failed\.\s*/i, "")
    .replace(/^Message:\s*/i, "")
    .split("\n")[0]
    .trim();
}

/**
 * `"<where> OracleStale(27) — <short text>"`: the code always comes first and is never clipped; only the human
 * text is limited to `maxText` characters.
 */
export function describeProgramError(where: string, err: unknown, maxText = 100): string {
  const text = errorText(err);
  const code = customCodeOf(text);
  const short = shortText(text);
  const clipped = short.length > maxText ? `${short.slice(0, maxText)}…` : short;
  return code === null ? `${where}: ${clipped}` : `${where} ${formatWrapperCode(code)}${clipped ? ` — ${clipped}` : ""}`;
}

/**
 * `text.slice(0, max)` that never loses the error code: when the full text carries a custom code that the clipped
 * part no longer shows, ` [Name(code)]` is appended.
 */
export function clipKeepingCode(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const code = customCodeOf(text);
  if (code === null || customCodeOf(head) === code || head.includes(`(${code})`)) return head;
  return `${head}… [${formatWrapperCode(code)}]`;
}

/**
 * Is a refusal with `code` the stale-resolve wait (see the header)? True only for OracleStale on a LIVE market whose
 * stale-resolve window has matured at `chainSlot`. Returns the human reason, or null (= a real failure).
 */
export function staleResolveWait(code: number | null, marketData: Uint8Array | null, chainSlot: bigint | null): string | null {
  if (code !== ORACLE_STALE || !marketData || chainSlot === null) return null;
  const w = staleResolveWindow(marketData, chainSlot + STALE_WAIT_SLOT_SKEW);
  if (!w || !w.enabled || !w.matured) return null;
  const age = chainSlot > w.lastGoodOracleSlot ? chainSlot - w.lastGoodOracleSlot : 0n;
  return (
    `OracleStale(27): stale-resolve window matured (last good oracle slot ${w.lastGoodOracleSlot}, ` +
    `${age} slots ago >= ${w.staleSlots}); waiting for the next mark push (retry next cycle)`
  );
}

/** Read the cluster slot for `staleResolveWait`; null when the read fails (the refusal then stays a failure). */
export async function chainSlotOrNull(conn: { getSlot?: (c?: "confirmed") => Promise<number> }): Promise<bigint | null> {
  try {
    if (typeof conn.getSlot !== "function") return null;
    return BigInt(await conn.getSlot("confirmed"));
  } catch {
    return null;
  }
}
