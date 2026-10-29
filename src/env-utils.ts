/**
 * Shared environment-variable parsing utilities.
 *
 * Kept in a standalone module so unit tests can import the pure helper
 * without triggering the oracle keeper's module-level side-effects
 * (RPC connection, keypair load, etc.).
 */

/**
 * Parse a safety-critical numeric environment variable.
 *
 * If the variable is unset or empty the fallback is used.
 * If the resulting value is not a finite positive number the process throws
 * immediately — a NaN/Infinity/zero/negative value would silently disable
 * guards (e.g. circuit breaker always-false when MAX_PRICE_MOVE_PCT is NaN).
 *
 * @param max - Optional exclusive upper bound. Throws if value >= max.
 *   Useful for percentage guards where >=100 would disable the guard entirely
 *   (e.g. MAX_PRICE_MOVE_PCT=100 means "accept everything" — #44 fix).
 */
export function parsePositiveNumberEnv(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  const value = raw == null || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a finite positive number (got: ${JSON.stringify(raw)})`,
    );
  }
  if (max !== undefined && value >= max) {
    throw new Error(
      `${name} must be less than ${max} (got: ${value}) — a value ≥ ${max} would disable the guard`,
    );
  }
  return value;
}

/**
 * Boot-time variant of {@link parsePositiveNumberEnv}: a bad value logs `[fatal] <message>` and exits with code 1.
 *
 * Why not just let the throw propagate: `cross-cluster.ts` installs a process-wide `uncaughtException` handler that logs
 * and stays up (a transient RPC fault must never kill the keeper), and that handler also swallows a throw at module
 * evaluation, so a bad CC_* value would end the boot with exit code 0 (follow-up to #166 / GH#165; L4 boot test
 * 2026-10-22). A fatal config error must exit non-zero so the supervisor records a failed boot. `exit` and `logError`
 * are injectable for tests.
 */
export function bootPositiveNumberEnv(
  name: string,
  fallback: number,
  max?: number,
  exit: (code: number) => never = (code) => process.exit(code),
  logError: (line: string) => void = (l) => console.error(l),
): number {
  try {
    return parsePositiveNumberEnv(name, fallback, max);
  } catch (err) {
    logError(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    return exit(1);
  }
}

/**
 * Validate that PROGRAM_ID is set when the oracle keeper is running in
 * Supabase-only discovery mode (no deployment file, no DEPLOYMENT_JSON).
 *
 * Supabase discovery surfaces slab addresses, oracle modes, and pool addresses
 * but does NOT supply a program id.  The keeper uses `programId` as a fallback
 * when building instructions before a slab's on-chain owner has been cached.
 * Without it, `new PublicKey(undefined)` throws the opaque "_bn" error from
 * inside @solana/web3.js — crashing the service after it has already logged
 * that Supabase-only mode is active (issue #29).
 *
 * @param programIdEnv - value of process.env.PROGRAM_ID (pass explicitly so
 *   the function is a pure helper that tests can drive without touching the
 *   real process.env).
 * @throws Error with a clear diagnostic message when the id is absent.
 */
export function requireProgramIdForSupabaseMode(
  programIdEnv: string | undefined,
): void {
  if (!programIdEnv || programIdEnv.trim() === "") {
    throw new Error(
      "PROGRAM_ID is required for Supabase-only discovery mode (no deployment file present). " +
      "Set PROGRAM_ID to your deployed program's public key, or provide a deployment file / DEPLOYMENT_JSON.",
    );
  }
}

/**
 * Number of lamports in one SOL.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000;
const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;

/**
 * Parse a positive SOL-denominated environment variable into lamports exactly.
 *
 * This intentionally parses the decimal string instead of multiplying a JS
 * floating-point number by 1e9. The keeper balance guard compares lamports at
 * runtime, so the converted value must be a positive, safe, whole-lamport
 * integer with no silent rounding.
 */
export function parsePositiveLamportsFromSolEnv(name: string, fallbackSol: number): number {
  const raw = process.env[name];
  const rawValue = raw == null || raw.trim() === "" ? String(fallbackSol) : raw.trim();

  if (!/^(?:\d+|\d+\.\d*|\.\d+)$/.test(rawValue)) {
    throw new Error(
      `${name} must be a finite positive decimal SOL amount (got: ${JSON.stringify(raw)})`,
    );
  }

  const [wholeRaw, fractionRaw = ""] = rawValue.split(".");
  const wholePart = wholeRaw === "" ? "0" : wholeRaw;
  const fractionPadded = fractionRaw.padEnd(9, "0");
  const lamportFraction = fractionPadded.slice(0, 9);
  const fractionalRemainder = fractionRaw.slice(9);

  const lamports =
    BigInt(wholePart) * LAMPORTS_PER_SOL_BIGINT +
    BigInt(lamportFraction === "" ? "0" : lamportFraction);

  if (lamports <= 0n) {
    throw new Error(
      `${name} must convert to at least 1 whole lamport (got: ${rawValue} SOL -> ${lamports} lamports)`,
    );
  }

  if (/[1-9]/.test(fractionalRemainder)) {
    throw new Error(
      `${name} converts to a fractional lamport amount (got: ${rawValue} SOL)`,
    );
  }

  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${name} converts to an unsafe lamport amount (got: ${rawValue} SOL -> ${lamports} lamports)`,
    );
  }

  return Number(lamports);
}
