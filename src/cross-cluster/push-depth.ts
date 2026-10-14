/**
 * G8 depth input for PushAuthMark (tag 63), v2.2 growth work (ledger v22-growth-overnight-2026-10-14 section 1.3).
 *
 * The wrapper's PushAuthMark gains an optional 44-byte form: the 35 B
 * `[63][asset u16][market_id u64][now u64][mark_e6 u64][obs_seq u64]` plus
 * `[depth_mode u8][depth_e6 u64 LE]`. depth_mode 1 = keeper-attested. A 35 B push zeroes the stored depth on chain,
 * and the chain caps attested depth at tier 1 ($25k of +-2% depth), so this can only ever unlock up to 5x.
 *
 * The on-chain wrapper accepts the 44 B form only after the upgrade, so everything here is behind
 * `KEEPER_PUSH_DEPTH` (default OFF). Off = byte-identical to the SDK's `encodePushAuthMark`.
 */
import { encodePushAuthMark } from "@percolatorct/sdk";

/** depth_mode value for "keeper-attested". */
export const DEPTH_MODE_KEEPER_ATTESTED = 1;
/** Size of the legacy and the depth-carrying PushAuthMark data. */
export const PUSH_AUTH_MARK_LEN = 35;
export const PUSH_AUTH_MARK_WITH_DEPTH_LEN = 44;
const U64_MAX = (1n << 64n) - 1n;

/** The only venue the keeper attests depth for: x*y=k pools. CLMM / DLMM and unknown venues send no depth. */
export const DEPTH_SOURCE_PUMPSWAP_CPMM = "pumpswap-cpmm";

/** `KEEPER_PUSH_DEPTH` is on only for an explicit "1" / "true" / "on" / "yes" (case-insensitive). Unset = OFF. */
export function pushDepthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.KEEPER_PUSH_DEPTH ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** floor(sqrt(n)) for a non-negative bigint (Newton iteration, exact). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt: negative input");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1); // >= sqrt(n)
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * +2% depth of a constant-product pool from its quote reserve:
 *
 *   depth = floor( R * (1 - 1/sqrt(1.02)) ),   R = quote reserve in collateral e6 (USD * 1e6)
 *
 * Exact in bigint. 1/sqrt(1.02) = sqrt(50/51), so R - R*sqrt(50/51) = R - sqrt(50 R^2 / 51), and
 * floor(R - y) = R - ceil(y). ceil(sqrt(50 R^2 / 51)) is the smallest integer m with 51 m^2 >= 50 R^2,
 * found from an isqrt seed and corrected by the exact integer inequality (no scaling, no float).
 *
 * Rounding: DOWN. The depth is a floor of the true real-valued figure, so it is never overstated. (Also note
 * R*(1 - 1/sqrt(1.02)) is itself the conservative one of the two +2% figures; the quote that must be paid in
 * is R*(sqrt(1.02) - 1), about 1% larger. We deliberately attest the smaller one.)
 *
 * Returns 0n for a zero reserve; throws RangeError on a negative one.
 */
export function plus2PctDepthE6(quoteReserveE6: bigint): bigint {
  if (quoteReserveE6 < 0n) throw new RangeError("plus2PctDepthE6: negative reserve");
  if (quoteReserveE6 === 0n) return 0n;
  const target = 50n * quoteReserveE6 * quoteReserveE6;
  let m = isqrt(target / 51n);
  while (51n * m * m < target) m += 1n;
  while (m > 0n && 51n * (m - 1n) * (m - 1n) >= target) m -= 1n;
  return quoteReserveE6 - m;
}

/** An attested depth to put on the wire. */
export interface PushDepth {
  depthE6: bigint;
  source: string;
}

/**
 * The depth to attest for one market this cycle, or null (= send the 35 B form). null when the flag is off,
 * when the venue is not constant-product, when the reserve is unknown (unreadable vault, no SOL/USD rate this
 * cycle), or when the resulting depth is zero or does not fit a u64. Never guesses.
 */
export function resolvePushDepth(
  enabled: boolean,
  cpmmQuoteReserveUsdE6: bigint | undefined,
): PushDepth | null {
  if (!enabled || cpmmQuoteReserveUsdE6 === undefined || cpmmQuoteReserveUsdE6 <= 0n) return null;
  const depthE6 = plus2PctDepthE6(cpmmQuoteReserveUsdE6);
  if (depthE6 <= 0n || depthE6 > U64_MAX) return null;
  return { depthE6, source: DEPTH_SOURCE_PUMPSWAP_CPMM };
}

export type PushAuthMarkArgs = Parameters<typeof encodePushAuthMark>[0];

/**
 * PushAuthMark data. No depth (or undefined) = exactly the SDK's 35 B bytes. With depth = the same 35 B plus
 * `[mode u8 = 1][depth_e6 u64 LE]` (44 B).
 */
export function encodePushAuthMarkMaybeDepth(args: PushAuthMarkArgs, depth?: PushDepth | null): Uint8Array {
  const base = encodePushAuthMark(args);
  if (!depth) return base;
  if (depth.depthE6 <= 0n || depth.depthE6 > U64_MAX) throw new RangeError("depth_e6 out of u64 range or zero");
  const out = new Uint8Array(PUSH_AUTH_MARK_WITH_DEPTH_LEN);
  out.set(base, 0);
  out[PUSH_AUTH_MARK_LEN] = DEPTH_MODE_KEEPER_ATTESTED;
  new DataView(out.buffer).setBigUint64(PUSH_AUTH_MARK_LEN + 1, depth.depthE6, true);
  return out;
}

/**
 * PushAuthMark mode 2 (on-chain DEX depth): the SDK 35 B + `[mode u8 = 2][depth_e6 u64 = 0]`. depth_e6 is ZERO by
 * definition (the program reads the reserves itself). This is the ONLY place a 44 B push with depth 0 is produced; the
 * mode-1 encoder above refuses a zero depth, so an attested push can never go out with depth 0 by accident.
 */
export function encodePushAuthMarkDexMode(args: PushAuthMarkArgs): Uint8Array {
  const base = encodePushAuthMark(args);
  const out = new Uint8Array(PUSH_AUTH_MARK_WITH_DEPTH_LEN);
  out.set(base, 0);
  out[PUSH_AUTH_MARK_LEN] = 2;
  return out; // bytes 36..44 stay zero
}
