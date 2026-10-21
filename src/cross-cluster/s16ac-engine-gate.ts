/**
 * cross-cluster/s16ac-engine-gate.ts
 *
 * Is the DEPLOYED wrapper built on engine e59aa6a6 ("S1-6 a/c")? That engine adds a wait to the resolved close
 * (e59aa6a6 src/v16.rs:24542, `realize_one_source_domain_for_resolved_close_not_atomic`): a zero-conversion winner that
 * closes before the losing side has settled gets `LockActive`, mapped to wrapper `EngineLockActive` = Custom(21)
 * (wrapper 367e3d08 src/v16_program.rs:2023). The whole CloseResolved reverts. The wait clears when the loss side
 * closes (`source_domain_terminal_for_haircut_demote`, e59aa6a6 src/v16.rs:24589).
 *
 * Neither build exposes a version byte, so this reads the PROGRAM BYTES, the same technique as the app's
 * lib/program-upgrade-detect.ts: the sha256 of the first 4096 bytes of the ELF (ProgramData offset 45). The ELF header
 * encodes the section-table offset (= the file size), so every rebuild of different code differs there.
 *
 * POSITIVE match only. The known S1-6 a/c builds (RC-S16AC.md §2 / §8.1, canonical double builds):
 *   rc-s16ac-build1.so        ddd5a2fa…89fa5  2,649,976 B  first 4096 B sha256 4613f80e…ac61  (wrapper 367e3d08)
 *   rollback-s16ac-build1.so  bae71e12…5c20   2,630,896 B  first 4096 B sha256 0c5eb29e…1fda  (wrapper 0e8bb0c9)
 * The rollback keeps engine e59aa6a6, so it keeps the wait (SEC-RC §S16AC). Anything else (the RC 357fc23f, its
 * rollback fac4d19c, today's deployed build, an unreadable account) is "other" or "unknown", and the gate is OFF:
 * behaviour before the upgrade is unchanged.
 *
 * A later rebuild on e59aa6a6 will read as "other": add its fingerprint here in the same runbook step that deploys it.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

export const ELF_FINGERPRINT_LEN = 4096;
/** BPF upgradeable loader ProgramData metadata: u32 tag + u64 slot + Option<Pubkey> (1 + 32) = 45 bytes. */
export const PROGRAMDATA_ELF_OFFSET = 45;

/** sha256 of the first 4096 ELF bytes of every known S1-6 a/c build (engine e59aa6a6). */
export const S16AC_WRAPPER_ELF_PREFIX_SHA256: ReadonlySet<string> = new Set([
  "4613f80ecbab0d2157e16005ad08ad332d291f14f3329bce6dfaded47ce0ac61", // rc-s16ac-build1.so (367e3d08)
  "0c5eb29e16466c52551697118d9f2e7e5a372b4815c7dbb272dcfa0332551fda", // rollback-s16ac-build1.so (0e8bb0c9)
]);

export type S16acState = "s16ac" | "other" | "unknown";

/** Pure: classify a program's first ELF bytes. A short or all-zero prefix is "unknown". */
export function classifyS16acElfPrefix(prefix: Uint8Array | null): S16acState {
  if (!prefix || prefix.length !== ELF_FINGERPRINT_LEN) return "unknown";
  if (prefix.every((b) => b === 0)) return "unknown";
  const h = createHash("sha256").update(prefix).digest("hex");
  return S16AC_WRAPPER_ELF_PREFIX_SHA256.has(h) ? "s16ac" : "other";
}

/** First 4096 ELF bytes of an upgradeable program (null when the program or its ProgramData is unreadable). */
export async function readElfPrefix(conn: Pick<Connection, "getAccountInfo">, programId: PublicKey): Promise<Uint8Array | null> {
  const prog = await conn.getAccountInfo(programId, "confirmed");
  if (!prog || prog.data.length < 36) return null;
  const programData = new PublicKey(new Uint8Array(prog.data).subarray(4, 36));
  const pd = await conn.getAccountInfo(programData, {
    commitment: "confirmed",
    dataSlice: { offset: PROGRAMDATA_ELF_OFFSET, length: ELF_FINGERPRINT_LEN },
  });
  return pd ? new Uint8Array(pd.data) : null;
}

/** Per-process cache of the classification. */
export class S16acGateState {
  value: { state: S16acState; at: number } | null = null;
}

/**
 * The deployed wrapper is a known S1-6 a/c build. Cached for `ttlMs` ("unknown" is re-read every call, so an RPC blip
 * never pins the answer). Unknown -> false. Never throws.
 */
export async function s16acEngineDeployed(
  conn: Pick<Connection, "getAccountInfo">,
  wrapperProgramId: PublicKey,
  st: S16acGateState,
  ttlMs: number,
  now: () => number = Date.now,
): Promise<{ on: boolean; state: S16acState }> {
  const t = now();
  if (st.value && st.value.state !== "unknown" && t - st.value.at < ttlMs) return { on: st.value.state === "s16ac", state: st.value.state };
  let state: S16acState;
  try {
    state = classifyS16acElfPrefix(await readElfPrefix(conn, wrapperProgramId));
  } catch {
    state = "unknown";
  }
  st.value = { state, at: t };
  return { on: state === "s16ac", state };
}
