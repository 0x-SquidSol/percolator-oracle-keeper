/**
 * cross-cluster/auth-mark-pusher.ts
 *
 * Builds and sends (or dry-runs) PushAuthMark instructions to devnet markets.
 *
 * Pre-push authority check:
 *   Before each push the keeper reads the market's oracle_authority from the
 *   devnet slab. If it does not match the keeper's pubkey, the push is skipped
 *   with a warning (never throws). This prevents wasted SOL on markets that
 *   have had their oracle authority changed.
 *
 * Dry-run mode:
 *   Builds and logs the instruction payload but does not call simulate or send.
 *   Zero SOL consumed.
 *
 * Live mode:
 *   Simulate first via connection.simulateTransaction (fast fail for wrong authority
 *   or bad state), then send via connection.sendTransaction + confirmTransaction.
 *
 * NOTE on module-identity fix:
 *   The SDK (@percolatorct/sdk) has its own nested node_modules/@solana/web3.js.
 *   Using the SDK's simulateOrSend / buildIx causes the Transaction object it
 *   creates (SDK's Transaction class) to fail the `instanceof Transaction` check
 *   inside connection.simulateTransaction (which uses the keeper's Transaction
 *   class). This gives "Cannot read properties of undefined (reading
 *   'numRequiredSignatures')". Fix: import Transaction / TransactionInstruction /
 *   ComputeBudgetProgram directly from "@solana/web3.js" here — they resolve to
 *   the keeper's own node_modules copy — and build/sign/send without going
 *   through the SDK's simulateOrSend.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  ACCOUNTS_PUSH_AUTH_MARK,
  buildAccountMetas,
  parseAssetOracleProfileV17,
  parseAssetControlSequencesV17,
  tokenPriceToLotE6V22,
  V17_ASSET_ORACLE_PROFILE_LEN,
} from "@percolatorct/sdk";
import { assetSlotOffset, selectMarketGroupOffset, VERSION_19 } from "../wrapper-market-group-offset.ts";
import { isLiveMarket, isTerminalMarket } from "./market-state.ts";
import { encodePushAuthMarkMaybeDepth, type PushDepth } from "./push-depth.ts";
import { getMultipleAccountsInfoChunked } from "./rpc-chunk.ts";

/**
 * B20 (E2E 2026-09-30): Resolved markets and CloseSlab tombstones are never
 * pushed. PushAuthMark on them reverts Custom(21) in preflight every cycle —
 * pure log/alert noise — and resolution is one-way, so they are dropped from
 * the batch before it is built and logged once per market.
 */
const terminalLogged = new Set<string>();
/** A decodable kind-1 market whose mode is not Live (i.e. Recovery; Resolved is caught by isTerminalMarket). */
function marketModeIsNotLive(data: Uint8Array): boolean {
  return !isLiveMarket(data) && !isTerminalMarket(data) && data.length > 16 && data[10] === 1;
}
export function resetTerminalPushLogForTests(): void {
  terminalLogged.clear();
}

/**
 * Wrapper program the auth-mark-pusher targets for PushAuthMark. Resolved by
 * ../program-ids.ts: env WRAPPER_PROGRAM_ID (or legacy PROGRAM_ID), else the
 * SDK PROGRAM_IDS_V17 constant — so the fresh-ID relaunch is a config change — see auth-mark-pusher.test.ts for
 * a literal-pinned regression guard against silent drift back to the
 * superseded 2026-06-26 wrapper (69VUZ7a2...).
 *
 * Exported (not just module-private) so tests can assert on it directly
 * instead of only re-importing the same SDK constant this file reads from,
 * which would be a vacuous self-check.
 */
export { WRAPPER_PROGRAM_ID } from "../program-ids.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const COMPUTE_UNIT_LIMIT = 200_000;

// ── VERSION-gated market-group offset (security review 3 must-fix) ────────────
//
// The wrapper's account header is [magic:8][version:2 LE][kind:1][pad:1][reserved:4]
// (V17_HEADER_LEN = 16), and MARKET_GROUP_OFF = HEADER_LEN + WRAPPER_CONFIG_LEN is
// CONFIG-RELATIVE, not a fixed constant across program versions. The protocol-fee
// program change (percolator-prog@626fb617) grew WrapperConfigV16 432 -> 496 bytes
// and bumped the header's VERSION field 16 -> 17 in the SAME commit, so
// MARKET_GROUP_OFF moves 448 -> 512 and every asset-profile slot (including the
// oracle_authority field this file reads) shifts by the same +64 downstream.
//
// During the mixed-fleet window — some devnet markets re-seeded at VERSION 17,
// others still VERSION 16 — computing profileOff with the V17 offset
// UNCONDITIONALLY decodes 64 bytes into the wrong struct on any VERSION-16
// account: still in-bounds (passes the length check), still parses as a
// plausible-looking pubkey, but it is NOT oracle_authority. The on-chain
// PushAuthMark signer check backstops this (worst case: a skipped push), but the
// keeper should never present a wrong-but-plausible authority as ground truth.
//
// Fix: read the account's own header VERSION byte and select the matching
// MARKET_GROUP_OFF via the shared `selectMarketGroupOffset` helper (also used
// by src/index.ts's oracle-mode read path, so the version table lives in one
// place). On an unrecognized VERSION, fail loud — warn and return null (skip
// push) rather than guess an offset this file was never verified against.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PushResult {
  /** Whether a transaction was sent (false in dry-run or on authority mismatch). */
  pushed: boolean;
  /** True when the instruction was built but not sent (dry-run). */
  dryRun?: boolean;
  /** Transaction signature — present only when pushed=true and dryRun=false. */
  signature?: string;
  /** True when the market's oracle_authority does not match the keeper. */
  authorityMismatch?: boolean;
  /** Price that was pushed (or would have been). */
  priceE6: bigint;
  /** Devnet slot used in the instruction. */
  nowSlot: bigint;
}

// ── Oracle-authority read ─────────────────────────────────────────────────────

/**
 * Fetch the oracle_authority for a given asset slot from a devnet slab account.
 *
 * Returns null if:
 *   - The account does not exist on devnet
 *   - The data is too short to hold an oracle profile at the requested slot
 *   - Any parse error occurs
 *
 * The caller should treat null as "cannot verify — skip push with warning."
 */
export async function fetchOracleAuthority(
  devnetConn: Connection,
  marketAddress: string,
  assetIndex: number,
): Promise<PublicKey | null> {
  try {
    const pk = new PublicKey(marketAddress);
    const info = await devnetConn.getAccountInfo(pk, "confirmed");
    if (!info) return null;
    const data = new Uint8Array(info.data);

    // ── VERSION gate (security review 3 must-fix) ────────────────────────────
    // Refuse to decode with a guessed offset: check magic + read the header's
    // own VERSION byte and select the MARKET_GROUP_OFF that actually applies
    // to THIS account (see shared helper module for the full root cause).
    const groupOffResult = selectMarketGroupOffset(data);
    if (!groupOffResult.ok) {
      switch (groupOffResult.reason) {
        case "too-short":
          return null;
        case "bad-magic":
          console.warn(
            `[pusher] ${marketAddress.slice(0, 8)}… bad account magic ` +
              `0x${groupOffResult.magic.toString(16)} — refusing to read a stale/guessed offset`,
          );
          return null;
        case "unrecognized-version":
          // FAIL LOUD, not silently-plausible: an unrecognized VERSION means
          // the on-chain layout changed again and this file's offsets need
          // updating. Do NOT fall back to guessing an offset from an
          // unverified version.
          console.warn(
            `[pusher] ${marketAddress.slice(0, 8)}… unrecognized account VERSION=` +
              `${groupOffResult.version} — oracle_authority offset unknown for this layout, ` +
              `skipping (update MARKET_GROUP_OFF_BY_VERSION in wrapper-market-group-offset.ts)`,
          );
          return null;
      }
    }

    // K-2: the slot base uses THIS version's group length and stride (VERSION 19: 806 / 2,661), not the v2.1 constants.
    const profileOff = assetSlotOffset(groupOffResult, assetIndex);
    // parseAssetOracleProfileV17 requires V17_ASSET_ORACLE_PROFILE_LEN (400)
    // bytes after profileOff — check up front so a too-short buffer returns
    // null (skip) instead of throwing inside the parse call. The v17-only
    // trailing asset_admin field (offset 368-399) is read-but-unused here on
    // VERSION-16 accounts; only oracleAuthority (offset 120-152, unchanged
    // across VERSION 16/17 per the SDK) is consumed by this function.
    if (data.length < profileOff + V17_ASSET_ORACLE_PROFILE_LEN) return null;
    const profile = parseAssetOracleProfileV17(data, profileOff);
    return profile.oracleAuthority;
  } catch (err) {
    // A THROW means we could not READ the authority (RPC 429, socket hang-up,
    // timeout) — NOT that the authority differs. The caller used to treat both
    // as "permanently not pushable", so one rate-limit burst at boot (when
    // every market is checked at once) could silently latch markets out of the
    // push set for the entire process lifetime, with /health still green.
    // Rethrow so the caller can retry this market on a later cycle.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Minimal LE u64 reader — `@percolatorct/sdk`'s own `readU64LE` (slab.ts) is module-private, not exported. */
function readU64LE(data: Uint8Array, off: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lo = view.getUint32(off, true);
  const hi = view.getUint32(off + 4, true);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

// ── v18 PushAuthMark generation fields (market_id + observation_sequence) ──────
//
// The v18 wire (percolator-prog sync/integration-v16@a9318945) grew
// PushAuthMarkArgs from {assetIndex, nowSlot, markE6} to {assetIndex, marketId,
// nowSlot, markE6, observationSequence} — both new fields must be LIVE-READ per
// push, never cached/constant, or every push after the first is rejected on-chain.
//
// market_id (this asset's generation counter):
//   handle_push_auth_mark calls require_asset_generation_view(group, asset_index,
//   expected_market_id), which compares the caller-supplied value against
//   group.markets[asset_index].engine.asset.market_id — AssetStateV16Account's
//   OWN market_id field (percolator engine, frozen `~/percolator@c141d47f`,
//   src/v16.rs `struct AssetStateV16Account`), the FIRST field (byte offset 0),
//   immediately AFTER the asset's full 1024-byte wrapper-T slot
//   ({@link V17_ASSET_ORACLE_WRAPPER_LEN}) — NOT inside AssetOracleProfileV16.
//   This relative offset (0) is cross-checked against the SDK's own
//   dump_layout-ground-truthed oi_eff_long_q/oi_eff_short_q offsets (289/305,
//   slab.ts V17_ASSET_STATE_OI_LONG_REL/SHORT_REL): AssetStateV16Account is
//   #[repr(C)] + bytemuck::Pod (zero implicit padding, every field an align-1
//   wrapper), so manually walking its declared field order from market_id(0)
//   reproduces 289/305 exactly — confirming market_id sits at relative offset 0.
//   A mismatch here throws AssetGenerationMismatch, not a silent misprice, so a
//   wrong value fails closed on-chain.
//
// observation_sequence (replay nonce, NOT a CAS):
//   handle_push_auth_mark calls advance_control_sequence_view(group,
//   asset_index, ControlSequenceLane::OracleObservation, observation_sequence),
//   which resolves to state::require_newer_control_sequence(current, proposed) =
//   `if proposed <= current { Err(EngineStale) }`. That is a STRICTLY-INCREASING
//   nonce, distinct from the CAS mechanism `require_current_authority_epoch`
//   uses for authority_epoch (expected == current, exact match) — the wrapper's
//   own doc comment on `advance_authority_epoch_view` explicitly calls out that
//   `authority_epoch` was carved OUT of this uniform-nonce lane precisely
//   because the other 13 tags (OracleObservation included) keep the
//   strictly-increasing contract. On success the stored watermark becomes
//   EXACTLY `proposed` (no implicit +1), so this reads the CURRENT
//   `oracle_observation` watermark (AssetControlSequencesV16, {@link
//   parseAssetControlSequencesV17}) and submits current+1 — the minimal valid
//   value, matching the SDK JSDoc's own `nextObservationSequence` naming.
//
// Returns null on any parse failure (bad magic/version, unrecognized VERSION,
// or a buffer too short for this asset's slot) — callers must skip this push
// this cycle, never guess a value.
export function parsePushAuthMarkGenerationFields(
  data: Uint8Array,
  assetIndex: number,
): { marketId: bigint; observationSequence: bigint; lotExp: number } | null {
  const groupOffResult = selectMarketGroupOffset(data);
  if (!groupOffResult.ok) return null;
  const profileOff = assetSlotOffset(groupOffResult, assetIndex);

  const engineAssetOff = profileOff + groupOffResult.wrapperSlotLen;
  if (data.length < engineAssetOff + 8) return null;
  const marketId = readU64LE(data, engineAssetOff);

  const lotExp = readMarketLotExp(data, groupOffResult.version, profileOff);
  if (lotExp === null) return null;

  try {
    const seqs = parseAssetControlSequencesV17(data, profileOff);
    return { marketId, observationSequence: seqs.oracleObservation + 1n, lotExp };
  } catch {
    return null;
  }
}

// ── K-1: per-lot mark scaling (v2.2 lot_exp) ──────────────────────────────────
//
// A v2.2 market's base unit is a LOT of 10^lot_exp tokens and every mark is PER LOT (percolator-prog
// release/v22-wrapper-rem 6c078a0e, v16_program.rs:776-782: `AssetOracleProfileV16::_padding0[PROFILE_LOT_EXP_IDX = 0]`
// = profile byte +19, `LOT_EXP_MAX = 15`; the program only validates and keeps it immutable, "the SDK / keeper /
// indexer do the unit conversion"). The DEX pipeline produces a per-TOKEN USD price, so PushAuthMark must carry
// price x 10^lot_exp. Same rule as the seed kit and the stop-gap pusher (relaunch/v22/plan22.ts `perLotPriceE6`).
// lot_exp is read from the market account on every push (never from config), next to market_id / the nonce.

/** Program constant `LOT_EXP_MAX` (RC constants.rs). */
export const LOT_EXP_MAX = 15;
/** Engine `MAX_ORACLE_PRICE` (percolator src/lib.rs): a per-lot mark above it is refused on chain. */
export const MAX_ORACLE_PRICE_E6 = 1_000_000_000_000n;
/** Profile byte holding lot_exp (`_padding0[0]`), relative to the asset's wrapper slot / oracle profile. */
export const PROFILE_LOT_EXP_OFF = 19;

/**
 * lot_exp of the asset whose profile starts at `profileOff`. 0 on VERSION < 19 (the byte is padding there, always zero
 * on v2.1, but it is never read). null (= skip the push, never guess) when the byte is above LOT_EXP_MAX or out of range.
 */
export function readMarketLotExp(data: Uint8Array, version: number, profileOff: number): number | null {
  if (version < VERSION_19) return 0;
  const off = profileOff + PROFILE_LOT_EXP_OFF;
  if (off >= data.length) return null;
  const v = data[off];
  return v <= LOT_EXP_MAX ? v : null;
}

/**
 * Per-lot e6 mark from the UNROUNDED per-token price (QA 2026-10-12): `round(priceE12 x 10^lotExp / 1e6)`.
 *
 * The e6 token price of a cheap token has few significant digits (CHILLHOUSE $0.001206 = 1,206), so
 * `priceE6 x 10^lotExp` moves in steps of 10^lotExp (~0.08% there). With the e12 price the per-lot mark keeps the
 * digits the e6 rounding dropped. The e6 price stays authoritative: it is what the smoother and circuit breaker
 * accepted, so the fine mark is used only when it is the SAME price to within one e6 unit per token
 * (|fine - priceE6 x 10^lotExp| <= 10^lotExp). Anything else (no e12, lotExp 0, disagreement) falls back to the
 * exact old value `perLotMarkE6(priceE6, lotExp)`; out-of-range still returns null (skip, never clamp).
 */
export function perLotMarkFromE12(tokenPriceE6: bigint, tokenPriceE12: bigint | undefined, lotExp: number): bigint | null {
  const coarse = perLotMarkE6(tokenPriceE6, lotExp);
  if (coarse === null || lotExp === 0 || tokenPriceE12 === undefined || tokenPriceE12 <= 0n) return coarse;
  const unit = 10n ** BigInt(lotExp);
  const fine = (tokenPriceE12 * unit + 500_000n) / 1_000_000n;
  const diff = fine > coarse ? fine - coarse : coarse - fine;
  if (fine <= 0n || diff > unit || fine > MAX_ORACLE_PRICE_E6) return coarse;
  return fine;
}

/**
 * Per-lot e6 mark for a per-token e6 price: `tokenPriceE6 * 10^lotExp` (exact, via the SDK's shared lot helper).
 * null when the inputs are invalid or the mark would exceed MAX_ORACLE_PRICE (the push is skipped, not clamped).
 */
export function perLotMarkE6(tokenPriceE6: bigint, lotExp: number): bigint | null {
  if (tokenPriceE6 <= 0n || !Number.isInteger(lotExp) || lotExp < 0 || lotExp > LOT_EXP_MAX) return null;
  const mark = tokenPriceToLotE6V22(tokenPriceE6, lotExp);
  return mark > MAX_ORACLE_PRICE_E6 ? null : mark;
}

// ── Push instruction ──────────────────────────────────────────────────────────

/**
 * Build a TransactionInstruction for PushAuthMark using the keeper's own
 * @solana/web3.js TransactionInstruction (not the SDK's copy).
 *
 * The instruction encoding and account spec come from the SDK (pure data),
 * but the TransactionInstruction class is from the keeper's web3.js so it
 * is identity-compatible with keeper-owned Transaction objects.
 */
export function buildPushAuthMarkIx(
  oracleAuthority: PublicKey,
  market: PublicKey,
  assetIndex: number,
  marketId: bigint,
  nowSlot: bigint,
  priceE6: bigint,
  observationSequence: bigint,
  /** G8: keeper-attested +2% depth. Omitted/null = the legacy 35 B bytes, exactly as before. */
  depth?: PushDepth | null,
): TransactionInstruction {
  const accountMetas = buildAccountMetas(ACCOUNTS_PUSH_AUTH_MARK, {
    oracleAuthority,
    market,
  });
  const data = encodePushAuthMarkMaybeDepth(
    {
      assetIndex,
      marketId,
      nowSlot,
      markE6: priceE6,
      observationSequence,
    },
    depth,
  );
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM_ID,
    keys: accountMetas,
    // TransactionInstruction accepts Buffer | Uint8Array at runtime.
    data: data as unknown as Buffer,
  });
}

/**
 * Push (or dry-run) a PushAuthMark instruction to a devnet market.
 *
 * The authority check is always performed — even in dry-run mode — because
 * reporting an authority mismatch is useful feedback when iterating on
 * market creation flows without spending SOL.
 *
 * @param devnetConn    Devnet RPC connection
 * @param keeper        Keeper keypair (oracle_authority on the market)
 * @param marketAddress Devnet slab address
 * @param assetIndex    Asset slot index (almost always 0)
 * @param priceE6       Price to push, in e6 format (must be > 0)
 * @param dryRun        If true, build the ix and log it but do not send
 */
export async function pushAuthMark(
  devnetConn: Connection,
  keeper: Keypair,
  marketAddress: string,
  assetIndex: number,
  priceE6: bigint,
  dryRun: boolean,
): Promise<PushResult> {
  // ── 1. Fetch current devnet slot ─────────────────────────────────────────
  const nowSlot = BigInt(await devnetConn.getSlot("confirmed"));

  // ── 2. Oracle-authority pre-check ────────────────────────────────────────
  const onChainAuthority = await fetchOracleAuthority(
    devnetConn,
    marketAddress,
    assetIndex,
  );
  if (onChainAuthority === null) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… oracle_authority not readable — skipping`,
    );
    return { pushed: false, authorityMismatch: true, priceE6, nowSlot };
  }
  if (!onChainAuthority.equals(keeper.publicKey)) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… oracle_authority=` +
        `${onChainAuthority.toBase58().slice(0, 8)}…` +
        ` != keeper=${keeper.publicKey.toBase58().slice(0, 8)}… — skipping`,
    );
    return { pushed: false, authorityMismatch: true, priceE6, nowSlot };
  }

  // ── 3. Live-read market_id + observation_sequence for THIS push ─────────
  // See parsePushAuthMarkGenerationFields's doc comment for the exact
  // handler-derived semantics of each field. Fresh read every call — never
  // cached — because observation_sequence is a strictly-increasing nonce
  // that the wrapper rejects if it is not greater than the last one it saw.
  const marketPk = new PublicKey(marketAddress);
  const acctInfo = await devnetConn.getAccountInfo(marketPk, "confirmed");
  if (!acctInfo) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… account not found — skipping`,
    );
    return { pushed: false, authorityMismatch: false, priceE6, nowSlot };
  }
  const genFields = parsePushAuthMarkGenerationFields(
    new Uint8Array(acctInfo.data),
    assetIndex,
  );
  if (!genFields) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… could not read market_id/observation_sequence — skipping`,
    );
    return { pushed: false, authorityMismatch: false, priceE6, nowSlot };
  }

  // ── 3b. K-1: per-lot mark (price x 10^lot_exp, lot_exp read from this account) ─
  const markE6 = perLotMarkE6(priceE6, genFields.lotExp);
  if (markE6 === null) {
    console.warn(
      `[pusher] ${marketAddress.slice(0, 8)}… per-lot mark out of range (price ${priceE6} x 10^${genFields.lotExp}) — skipping`,
    );
    return { pushed: false, authorityMismatch: false, priceE6, nowSlot };
  }

  // ── 4. Build instruction (using keeper's web3.js TransactionInstruction) ─
  const ix = buildPushAuthMarkIx(
    keeper.publicKey,
    marketPk,
    assetIndex,
    genFields.marketId,
    nowSlot,
    markE6,
    genFields.observationSequence,
  );

  // ── 5. Dry-run: log and return ───────────────────────────────────────────
  if (dryRun) {
    console.log(
      `[DRY-RUN] PushAuthMark market=${marketAddress.slice(0, 8)}…` +
        ` assetIndex=${assetIndex}` +
        ` priceE6=${priceE6} ($${(Number(priceE6) / 1e6).toFixed(4)})` +
        ` nowSlot=${nowSlot}`,
    );
    return { pushed: false, dryRun: true, priceE6, nowSlot };
  }

  // ── 6. Simulate first (fast-fail for wrong authority / bad state) ────────
  const bh = await devnetConn.getLatestBlockhash("confirmed");

  {
    const simTx = new Transaction();
    simTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    simTx.add(ix);
    simTx.recentBlockhash = bh.blockhash;
    simTx.feePayer = keeper.publicKey;
    simTx.sign(keeper);

    // Pass the already-signed Transaction without re-supplying signers so the
    // web3.js instanceof Transaction check succeeds (same module scope).
    const simResult = await devnetConn.simulateTransaction(simTx);
    if (simResult.value.err) {
      const lastLogs = (simResult.value.logs ?? []).slice(-5).join(" | ");
      throw new Error(
        `PushAuthMark sim failed [${marketAddress.slice(0, 8)}…]:` +
          ` ${JSON.stringify(simResult.value.err)} | logs: ${lastLogs}`,
      );
    }
  }

  // ── 7. Send ───────────────────────────────────────────────────────────────
  const sendTx = new Transaction();
  sendTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
  sendTx.add(ix);
  sendTx.recentBlockhash = bh.blockhash;
  sendTx.feePayer = keeper.publicKey;
  sendTx.sign(keeper);

  const signature = await devnetConn.sendRawTransaction(sendTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await devnetConn.confirmTransaction(
    {
      signature,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    },
    "confirmed",
  );

  return { pushed: true, signature, priceE6, nowSlot };
}

/**
 * FAST PATH: push PushAuthMark for MANY markets in ONE devnet transaction, and
 * do NOT wait for confirmation. One slot + one blockhash + one send per cycle
 * (vs a simulate/send/confirm per market) — this is what lets the on-chain mark
 * update near per-slot. The mark lands within a slot regardless of when we'd
 * confirm, so awaiting confirmation only adds latency.
 *
 * A batched tx is ATOMIC: every market in `pushes` must be pushable
 * (keeper == oracle_authority), so callers pass only markets that passed the
 * one-time authority check — a single bad market can't fail the whole batch.
 */
/** Solana hard limit on a serialized transaction. */
/**
 * Markets whose PushAuthMark reverted in preflight, and for how long to skip
 * them. A market only enters quarantine after repeated reverts, so a transient
 * blip does not silence a healthy market; it leaves automatically when the
 * timer lapses and its next push preflights clean.
 *
 * Purpose: keep ONE bad market from freezing everyone else's price. The atomic
 * batch means a single ineligible market reverts the whole chunk, and the
 * 2026-07-23 owner filter does not catch this case (a broken market owned by
 * the CURRENT wrapper still passes it).
 */
const quarantinedUntil = new Map<string, number>();
const quarantineStrikes = new Map<string, number>();
const QUARANTINE_AFTER_STRIKES = 3;
const QUARANTINE_MS = 10 * 60_000;

/** Exported for the health log + tests. */
export function getQuarantinedMarkets(): string[] {
  const now = Date.now();
  return [...quarantinedUntil.entries()].filter(([, t]) => t > now).map(([m]) => m);
}

const MAX_TX_BYTES = 1232;
/** Safety margin under MAX_TX_BYTES (signature/blockhash jitter). */
const TX_SIZE_MARGIN = 32;

/** Caller-facing push request — unchanged shape, so keeper-loop.ts needs no edits. */
type AuthMarkPushInput = {
  marketAddress: string;
  assetIndex: number;
  priceE6: bigint;
  /** Optional: the same per-token price at e12, used only for the per-lot mark of a lot market (perLotMarkFromE12). */
  priceE12?: bigint;
  /** G8: keeper-attested depth for the 44 B form. Absent = the 35 B form (also zeroes the stored depth on chain). */
  depth?: PushDepth | null;
};

/**
 * Internal, enriched push item — `AuthMarkPushInput` plus the two v18-NEW
 * fields {@link parsePushAuthMarkGenerationFields} live-reads per market per
 * cycle. Only constructed AFTER a fresh account read succeeds; a market whose
 * fields could not be read never reaches this shape (it is reported via
 * `skippedMarkets` instead — see `pushAuthMarkBatch`).
 */
type AuthMarkPushItem = AuthMarkPushInput & {
  marketId: bigint;
  observationSequence: bigint;
  /** K-1: the market's lot exponent (0 on v2.1 / single-token markets). */
  lotExp: number;
  /** K-1: what PushAuthMark carries: `priceE6` (per token) x 10^lotExp. */
  markE6: bigint;
};

/**
 * Build one PushAuthMark tx for a slice of markets and return it with its
 * serialized size, so the caller can size-check BEFORE sending.
 */
function buildPushTx(
  keeper: Keypair,
  pushes: AuthMarkPushItem[],
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): { tx: Transaction; size: number } {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.min(COMPUTE_UNIT_LIMIT * pushes.length, 1_200_000),
    }),
  );
  for (const p of pushes) {
    tx.add(
      buildPushAuthMarkIx(
        keeper.publicKey,
        new PublicKey(p.marketAddress),
        p.assetIndex,
        p.marketId,
        nowSlot,
        p.markE6,
        p.observationSequence,
        p.depth,
      ),
    );
  }
  tx.recentBlockhash = blockhash.blockhash;
  tx.feePayer = keeper.publicKey;
  // web3.js's serialize() THROWS ("Transaction too large: N > 1232") instead of
  // returning an oversized length, so a naive `.length` size probe crashes the
  // very loop that is supposed to split the batch. Treat a throw as "does not
  // fit" (Infinity) and let the caller close the chunk.
  let size: number;
  try {
    size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  return { tx, size };
}

/**
 * Split `pushes` into chunks that each serialize under the 1232-byte tx limit.
 *
 * OUTAGE 2026-07-13: this used to build ONE transaction containing EVERY
 * registered market. At 18 markets it fit (1230B); the 19th and 20th
 * registration pushed it to 1270B — over Solana's hard 1232-byte limit — so
 * `sendRawTransaction` threw "Transaction too large: 1270 > 1232" on EVERY
 * cycle. Because the batch was all-or-nothing, a single oversized batch froze
 * the AuthMark for ALL markets simultaneously (every market's mark stuck at
 * the same slot), and since the failure happened before submission, it left
 * no on-chain trace at all. The keeper had no chunking and no size check, so
 * it could never recover on its own — and it would break again at whatever
 * market count the next registration crossed.
 *
 * Chunking on MEASURED serialized size (not a hard-coded market count) means
 * the batch is now correct for any registry size, and for markets whose
 * account lists differ in size.
 */
function chunkPushes(
  keeper: Keypair,
  pushes: AuthMarkPushItem[],
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): AuthMarkPushItem[][] {
  const chunks: AuthMarkPushItem[][] = [];
  let current: AuthMarkPushItem[] = [];

  for (const p of pushes) {
    const candidate = [...current, p];
    const { size } = buildPushTx(keeper, candidate, nowSlot, blockhash);
    if (size <= MAX_TX_BYTES - TX_SIZE_MARGIN) {
      current = candidate;
      continue;
    }
    // Adding this market overflows the tx — close the current chunk.
    if (current.length > 0) {
      chunks.push(current);
      current = [p];
    } else {
      // A single market that somehow doesn't fit on its own: push it alone and
      // let the send surface the real error rather than silently dropping it.
      chunks.push([p]);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Composite key — the same market address can (in principle) carry more than one asset index. */
function pushGenerationKey(p: { marketAddress: string; assetIndex: number }): string {
  return `${p.marketAddress}:${p.assetIndex}`;
}

/**
 * Batched live-read of market_id + observation_sequence for every push this
 * cycle, via `getMultipleAccountsInfo` in chunks of 100 keys (one call up to 100 markets) — not one `getAccountInfo`
 * per market. `pushAuthMarkBatch` was specifically optimized down to "~3 RPC
 * calls per cycle (was ~25)" (see `runCycle`'s doc comment in keeper-loop.ts);
 * this keeps that budget by adding exactly one more batched call, not N.
 *
 * A market whose account could not be fetched, or whose bytes fail to parse
 * (bad magic/version, unrecognized VERSION, buffer too short for this
 * asset's slot), is simply absent from the returned map — the caller must
 * treat that as "skip this push this cycle" (see
 * {@link parsePushAuthMarkGenerationFields}'s doc comment), never guess.
 */
export async function fetchPushAuthMarkGenerationFields(
  devnetConn: Connection,
  pushes: AuthMarkPushInput[],
  terminal: Set<string>,
): Promise<Map<string, { marketId: bigint; observationSequence: bigint; lotExp: number }>> {
  const uniqueAddrs = [...new Set(pushes.map((p) => p.marketAddress))];
  // "processed", not "confirmed" (#Custom19, 2026-09-28): the watermark this
  // reads is advanced ONLY by this keeper's own pushes, which land ~1-3 slots
  // before they are confirmed. A confirmed read routinely misses the previous
  // cycle's push. Reading a higher (even later-dropped-fork) value is always
  // safe — the nonce only has to be strictly greater, gaps are allowed.
  // Chunked at 100 keys (RPC hard cap; web3.js does not chunk). A chunk that fails leaves ITS
  // markets absent from the result (the caller already skips an absent market this cycle with a
  // warning) and never fails the other chunks' markets — one flaky chunk must not stop every price.
  const read = await getMultipleAccountsInfoChunked(devnetConn, uniqueAddrs.map((a) => new PublicKey(a)), "processed");
  if (read.failedChunks > 0) {
    console.warn(
      `[push] generation read: ${read.failedChunks}/${read.totalChunks} chunk(s) failed — ` +
        `${read.failedKeys} market(s) skipped this cycle (will retry next cycle)`,
    );
  }
  const dataByAddr = new Map<string, Uint8Array>();
  uniqueAddrs.forEach((addr, i) => {
    const info = read.infos[i];
    if (info) dataByAddr.set(addr, new Uint8Array(info.data));
  });

  const result = new Map<string, { marketId: bigint; observationSequence: bigint; lotExp: number }>();
  for (const p of pushes) {
    const key = pushGenerationKey(p);
    if (result.has(key)) continue;
    const data = dataByAddr.get(p.marketAddress);
    if (!data) continue;
    // B20 + Recovery: push only LIVE markets. A market the expired-close valve moved to
    // Recovery is refused (21) like a Resolved one; it is cranked, not priced.
    if (isTerminalMarket(data) || marketModeIsNotLive(data)) {
      terminal.add(p.marketAddress);
      continue;
    }
    const fields = parsePushAuthMarkGenerationFields(data, p.assetIndex);
    if (fields) {
      result.set(key, {
        marketId: fields.marketId,
        observationSequence: nextObservationSequence(key, fields.observationSequence),
        lotExp: fields.lotExp,
      });
    }
  }
  return result;
}

// ── Local observation_sequence watermark (Custom(19) self-race, 2026-09-28) ───
//
// ROOT CAUSE of the recurring `{"InstructionError":[1,{"Custom":19}]}`
// (PercolatorError::EngineStale) on PushAuthMark: the keeper raced ITSELF on the
// OracleObservation nonce. handle_push_auth_mark (percolator-prog v18.2
// @6377376a, src/v16_program.rs:20568) calls advance_control_sequence_view ->
// require_newer_control_sequence, which is `if proposed <= current { EngineStale }`.
// Nothing but this keeper's own PushAuthMark advances that lane (the cranks do
// not touch it; the slot checks authenticate against Clock, so they cannot fire
// for a well-formed push).
//
// Each cycle (~1.5s ≈ 3-4 slots) read the watermark from chain and proposed
// current+1, then sent fire-and-forget. The previous cycle's tx routinely had
// not landed / confirmed yet, so two consecutive cycles proposed the SAME value:
//   slot 505273955 ok   nowSlot=…951 seq=253915   (cycle N+1)
//   slot 505273956 ERR  nowSlot=…944 seq=253915   (cycle N, landed late) Custom(19)
// Depending on which bank the preflight saw, the loser reverted either in
// preflight (the whole chunk dropped, then every single-market retry failed
// the same way, accruing quarantine strikes on HEALTHY markets) or on-chain
// after a clean preflight (a silent revert, logged as "batched push × N").
// The last chunk of each cycle (eacc/CATE/swordcat) is sent latest, so the next
// cycle's read was the most likely to miss it — hence their lower push count.
//
// Fix: remember the highest sequence this process has SENT per (market, asset)
// and propose max(chain, lastSent) + 1. The nonce needs only to be strictly
// increasing (gaps are fine), so this never proposes an invalid value; a
// restart or another pusher is covered by the max with chain.
const lastSentObservationSequence = new Map<string, bigint>();

/** Forget nonce, quarantine and terminal-log state of every market not in `keep` (deregistered). */
export function pruneAuthMarkPusherState(keep: ReadonlySet<string>): void {
  for (const m of [...quarantinedUntil.keys()]) if (!keep.has(m)) quarantinedUntil.delete(m);
  for (const m of [...quarantineStrikes.keys()]) if (!keep.has(m)) quarantineStrikes.delete(m);
  // K-7: these keys are `${market}:${assetIndex}` (pushGenerationKey), NOT bare market addresses. Comparing the
  // whole key against `keep` deleted EVERY nonce reservation on every cycle (pruneDeregisteredMarkets runs at the
  // top of each cycle), which silently disabled the 2026-09-28 self-race fix: each cycle proposed chain + 1 again,
  // and whenever the previous cycle's batch had not landed by the read the two carried the same nonce; the later
  // one reverted Custom(19) on chain (~15/h on the fresh v2.2 devnet, 411 in 30 h, always "ix 1").
  for (const k of [...lastSentObservationSequence.keys()]) if (!keep.has(generationKeyMarket(k))) lastSentObservationSequence.delete(k);
  for (const m of [...terminalLogged]) if (!keep.has(m)) terminalLogged.delete(m);
  for (const m of [...soloUntil.keys()]) if (!keep.has(m)) soloUntil.delete(m);
  for (const m of [...landedRevertTimes.keys()]) if (!keep.has(m)) landedRevertTimes.delete(m);
}

/** The market part of a {@link pushGenerationKey} (`${market}:${assetIndex}`). */
export function generationKeyMarket(key: string): string {
  const i = key.lastIndexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

// ── K-7: landed-revert fault isolation ────────────────────────────────────────
//
// A batched PushAuthMark tx is atomic: if ONE market's push reverts on chain, every market in the batch loses that
// cycle's price. Preflight already isolates a market that reverts in simulation (pushChunk), but a market whose nonce
// is advanced by someone else between our preflight and our landing (another pusher on it, a duplicate keeper) reverts
// only ON CHAIN, every time, taking the whole batch with it. reconcilePushOutcomes now attributes each landed revert
// that is NOT a superseded late duplicate to the market at the failing instruction; after SOLO_AFTER_LANDED_REVERTS
// such reverts within SOLO_STRIKE_WINDOW_MS, that market is pushed in its OWN tx for SOLO_MS, so it can only cost itself.
export const SOLO_AFTER_LANDED_REVERTS = 2;
export const SOLO_STRIKE_WINDOW_MS = 10 * 60_000;
export const SOLO_MS = 10 * 60_000;
const soloUntil = new Map<string, number>();
const landedRevertTimes = new Map<string, number[]>();

/** Markets currently pushed in their own tx (for /health and tests). */
export function getSoloMarkets(nowMs: number = Date.now()): string[] {
  return [...soloUntil].filter(([, until]) => until > nowMs).map(([m]) => m);
}

function noteLandedRevert(market: string, nowMs: number): void {
  const times = (landedRevertTimes.get(market) ?? []).filter((t) => nowMs - t < SOLO_STRIKE_WINDOW_MS);
  times.push(nowMs);
  landedRevertTimes.set(market, times);
  if (times.length >= SOLO_AFTER_LANDED_REVERTS && !((soloUntil.get(market) ?? 0) > nowMs)) {
    soloUntil.set(market, nowMs + SOLO_MS);
    console.warn(
      `[push][SOLO] ${market.slice(0, 8)}… reverted on chain ${times.length}x in ${SOLO_STRIKE_WINDOW_MS / 60_000} min — ` +
        `pushing it in its own tx for ${SOLO_MS / 60_000} min so it cannot void the other markets' batch`,
    );
  }
}

/**
 * Next nonce for `key`, given `chainNext` (= chain watermark + 1, as
 * parsePushAuthMarkGenerationFields returns it): strictly above both the chain
 * watermark and anything this process already sent.
 */
function nextObservationSequence(key: string, chainNext: bigint): bigint {
  const localNext = (lastSentObservationSequence.get(key) ?? 0n) + 1n;
  return chainNext > localNext ? chainNext : localNext;
}

function recordSentObservationSequence(p: AuthMarkPushItem): void {
  const key = pushGenerationKey(p);
  const prev = lastSentObservationSequence.get(key) ?? 0n;
  if (p.observationSequence > prev) lastSentObservationSequence.set(key, p.observationSequence);
}

/** PercolatorError::EngineStale — the wrapper's error for a non-increasing observation_sequence. */
const ENGINE_STALE_CUSTOM = 19;

// ── Late-duplicate Custom(19) (landed reverts, 2026-10-04) ────────────────────
//
// The self-race above is fixed (no two cycles propose the same nonce), yet
// ~2.6-4.6% of LANDED push txs still reverted `[1,{"Custom":19}]`, in every
// chunk, with no preflight failure logged. Measured on chain (the 1000 most
// recent txs touching Percolator 9EPm8nB8, 03:52Z-04:16Z, deployment 7b8998ac):
//   - 46 of 1000 failed, all `InstructionError [1, Custom(19)]` (ix 1 is just
//     the first market of the atomic chunk; every market in it shares the fate);
//   - ZERO had a nonce equal to another tx's -- the nonces are unique;
//   - in all 46 a tx with a HIGHER nonce for the same markets had already landed
//     (the failing tx landed 1-13 slots after its successor);
//   - landing age (landing slot - nowSlot) is 4-5 slots for a normal push (p99 9,
//     none in 10-11) but 12-22 slots for every failure: the failures are
//     delayed copies, not first deliveries.
// Cycles are 1.5s (~4 slots) apart, so cycle N is still in flight when N+1 is
// sent. If N is dropped on first delivery, the RPC node's `maxRetries`
// rebroadcast puts a copy on chain seconds later, AFTER N+1 has advanced the
// watermark: the copy is `proposed <= current` -> EngineStale. It is harmless to
// prices (N+1, fresher, already landed -- verified for all 598 failed pushes) but
// wastes a fee, shows up as a failed tx, and is invisible to the keeper (it sends
// with skipPreflight and never looks at the outcome), which is how it was
// misread as "the cycle's price update was lost for the whole chunk".
//
// A stale push has no value once its successor is in flight, so never let the
// node resend it: maxRetries 0. The next cycle (1.5s) is the retry.
export const PUSH_SEND_OPTIONS = { skipPreflight: true, maxRetries: 0 } as const;

/** One landed-or-not push tx we are still waiting to hear about. */
interface InFlightPush {
  signature: string;
  sentAtMs: number;
  items: Array<{ key: string; market: string; seq: bigint }>;
}
const inFlightPushes: InFlightPush[] = [];
const MAX_IN_FLIGHT_PUSHES = 64;
/** Do not ask about a tx until it has had time to land. */
const PUSH_STATUS_MIN_AGE_MS = 4_000;
/** A signature unknown to the cluster this long after sending is treated as dropped. */
const PUSH_STATUS_GIVE_UP_MS = 90_000;
const LATE_DUPLICATE_LOG_EVERY_MS = 60_000;

/** Observed outcomes of pushes this process sent (read back from chain). */
export const pushLandingStats = {
  landedOk: 0,
  /** Custom(19) on a tx whose markets were all already superseded by a higher nonce we sent: benign. */
  lateDuplicateReverts: 0,
  /** Any other landed revert, including Custom(19) on a nonce nothing superseded: needs a human. */
  otherReverts: 0,
  /** Never landed (dropped, or unknown after PUSH_STATUS_GIVE_UP_MS). */
  unlanded: 0,
};
let lastLateDuplicateLogMs = 0;
let lateDuplicatesSinceLog = 0;

/** Test hook. */
export function resetPushLandingState(): void {
  inFlightPushes.length = 0;
  pushLandingStats.landedOk = 0;
  pushLandingStats.lateDuplicateReverts = 0;
  pushLandingStats.otherReverts = 0;
  pushLandingStats.unlanded = 0;
  lastLateDuplicateLogMs = 0;
  lateDuplicatesSinceLog = 0;
  soloUntil.clear();
  landedRevertTimes.clear();
}

/**
 * Read back what happened to the push txs we sent: one batched
 * `getSignatureStatuses` over the ones old enough to have landed (no RPC at all
 * when there are none). A landed push revert is classified rather than ignored:
 * Custom(19) on markets we have since pushed a higher nonce for is the benign
 * late duplicate described above (counted, summarised once a minute); anything
 * else is logged loudly. Never throws.
 */
export async function reconcilePushOutcomes(devnetConn: Connection, nowMs: number = Date.now()): Promise<void> {
  try {
    const due = inFlightPushes.filter((f) => nowMs - f.sentAtMs >= PUSH_STATUS_MIN_AGE_MS);
    if (due.length === 0) return;
    const { value } = await devnetConn.getSignatureStatuses(due.map((f) => f.signature));
    due.forEach((f, i) => {
      const st = value[i];
      if (!st) {
        if (nowMs - f.sentAtMs < PUSH_STATUS_GIVE_UP_MS) return; // may still land
        pushLandingStats.unlanded++;
      } else if (!st.err) {
        pushLandingStats.landedOk++;
      } else {
        const failing = parseFailingPush(st.err, f.items.length);
        const superseded =
          failing !== null &&
          failing.custom === ENGINE_STALE_CUSTOM &&
          f.items.every((it) => (lastSentObservationSequence.get(it.key) ?? 0n) > it.seq);
        if (superseded) {
          pushLandingStats.lateDuplicateReverts++;
          lateDuplicatesSinceLog++;
        } else {
          pushLandingStats.otherReverts++;
          if (failing !== null && failing.position < f.items.length) noteLandedRevert(f.items[failing.position].market, nowMs);
          console.error(
            `[push] LANDED REVERT ${f.signature.slice(0, 16)}… ${JSON.stringify(st.err).slice(0, 100)} — ` +
              `markets: ${f.items.map((it) => it.market.slice(0, 8) + "…").join(", ")}; not a superseded late duplicate`,
          );
        }
      }
      const at = inFlightPushes.indexOf(f);
      if (at >= 0) inFlightPushes.splice(at, 1);
    });
    if (lateDuplicatesSinceLog > 0 && nowMs - lastLateDuplicateLogMs >= LATE_DUPLICATE_LOG_EVERY_MS) {
      console.log(
        `[push] ${lateDuplicatesSinceLog} landed push tx(s) reverted Custom(19) as late duplicates of already-superseded ` +
          `pushes (a higher nonce landed first; no price update lost; totals ${JSON.stringify(pushLandingStats)})`,
      );
      lateDuplicatesSinceLog = 0;
      lastLateDuplicateLogMs = nowMs;
    }
  } catch {
    // Observability only: an RPC failure here must never touch the push path.
  }
}

/**
 * Parse a simulate `err` of the real RPC shape `{"InstructionError":[i,{"Custom":n}]}`
 * into the offending push's position within `chunkLen` pushes (ix 0 is the
 * ComputeBudget ix, so push k is ix k+1). Returns null for any other shape
 * (InsufficientFundsForFee, AccountNotFound, a non-push index, …) so the caller
 * falls back to per-market isolation instead of blaming the wrong market.
 */
export function parseFailingPush(
  simErr: unknown,
  chunkLen: number,
): { position: number; custom: number | null } | null {
  if (typeof simErr !== "object" || simErr === null) return null;
  const ie = (simErr as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2 || typeof ie[0] !== "number") return null;
  const position = ie[0] - 1;
  if (!Number.isInteger(position) || position < 0 || position >= chunkLen) return null;
  const detail = ie[1] as { Custom?: unknown } | unknown;
  const custom =
    typeof detail === "object" && detail !== null && typeof (detail as { Custom?: unknown }).Custom === "number"
      ? ((detail as { Custom: number }).Custom)
      : null;
  return { position, custom };
}

export async function pushAuthMarkBatch(
  devnetConn: Connection,
  keeper: Keypair,
  pushes: AuthMarkPushInput[],
  nowSlot: bigint,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
  dryRun: boolean,
): Promise<{
  pushed: boolean;
  signature?: string;
  count: number;
  /** Markets whose push actually went out — NOT the whole input batch. */
  pushedMarkets: string[];
  /** Markets dropped this cycle (reverted in preflight, or quarantined). */
  skippedMarkets: string[];
  /** B20: Resolved / tombstoned markets, not pushed and not counted as drops. */
  terminalMarkets?: string[];
}> {
  if (pushes.length === 0) {
    return { pushed: false, count: 0, pushedMarkets: [], skippedMarkets: [] };
  }

  // Read back the outcome of earlier cycles' txs (no-op unless some are old enough).
  void reconcilePushOutcomes(devnetConn);

  // Drop markets currently quarantined for repeated reverts, so they cannot be
  // batched with healthy ones and freeze their prices. They re-enter
  // automatically when the timer lapses.
  const now = Date.now();
  const eligible = pushes.filter((p) => {
    const until = quarantinedUntil.get(p.marketAddress);
    if (until === undefined) return true;
    if (until > now) return false;
    quarantinedUntil.delete(p.marketAddress);
    quarantineStrikes.delete(p.marketAddress);
    console.log(`[push] ${p.marketAddress.slice(0, 8)}… leaving quarantine — will retry`);
    return true;
  });
  const skipped = pushes.length - eligible.length;
  if (skipped > 0) {
    console.warn(`[push] skipping ${skipped} quarantined market(s): ${getQuarantinedMarkets().map((m) => m.slice(0, 8) + "…").join(", ")}`);
  }
  if (eligible.length === 0) {
    return { pushed: false, count: 0, pushedMarkets: [], skippedMarkets: pushes.map((p) => p.marketAddress) };
  }

  // Live-read market_id + observation_sequence for every eligible market —
  // fresh every call, never cached. observation_sequence is the
  // OracleObservation control-sequence lane's strictly-increasing replay
  // nonce (see parsePushAuthMarkGenerationFields's doc comment): the wrapper
  // rejects a push whose proposed value is not STRICTLY GREATER than the
  // value it last stored, so reusing a stale/cached sequence across pushes
  // would make every push after the first one revert.
  const terminal = new Set<string>();
  const generationFields = await fetchPushAuthMarkGenerationFields(devnetConn, eligible, terminal);
  for (const m of terminal) {
    if (!terminalLogged.has(m)) {
      terminalLogged.add(m);
      console.log(`[push] ${m.slice(0, 8)}… is not Live (Recovery/Resolved/closed) — not pushed (B20)`);
    }
  }
  const terminalMarkets = [...terminal];
  const pushable: AuthMarkPushItem[] = [];
  const missingGeneration: string[] = [];
  for (const p of eligible) {
    if (terminal.has(p.marketAddress)) continue;
    const fields = generationFields.get(pushGenerationKey(p));
    if (!fields) {
      missingGeneration.push(p.marketAddress);
      continue;
    }
    const markE6 = perLotMarkFromE12(p.priceE6, p.priceE12, fields.lotExp);
    if (markE6 === null) {
      console.warn(
        `[push] ${p.marketAddress.slice(0, 8)}… per-lot mark out of range (price ${p.priceE6} x 10^${fields.lotExp}) — skipped this cycle`,
      );
      missingGeneration.push(p.marketAddress);
      continue;
    }
    pushable.push({ ...p, marketId: fields.marketId, observationSequence: fields.observationSequence, lotExp: fields.lotExp, markE6 });
  }
  if (missingGeneration.length > 0) {
    console.warn(
      `[push] skipping ${missingGeneration.length} market(s) — could not live-read market_id/observation_sequence this cycle: ` +
        missingGeneration.map((m) => m.slice(0, 8) + "…").join(", "),
    );
  }
  if (pushable.length === 0) {
    return {
      pushed: false,
      count: 0,
      pushedMarkets: [],
      skippedMarkets: pushes.map((p) => p.marketAddress).filter((m) => !terminal.has(m)),
      terminalMarkets,
    };
  }

  // K-7: a market isolated for landed reverts goes in its own tx; the rest batch as before.
  const solo = new Set(getSoloMarkets());
  const chunks = [
    ...chunkPushes(keeper, pushable.filter((p) => !solo.has(p.marketAddress)), nowSlot, blockhash),
    ...pushable.filter((p) => solo.has(p.marketAddress)).map((p) => [p]),
  ].filter((c) => c.length > 0);

  if (dryRun) {
    console.log(
      `[DRY-RUN] PushAuthMark × ${pushable.length} in ${chunks.length} tx(s) @ slot ${nowSlot} ` +
        `(${pushable.map((p) => `$${(Number(p.priceE6) / 1e6).toFixed(4)}${p.lotExp ? ` x1e${p.lotExp} = mark ${p.markE6}` : ""}`).join(", ")})`,
    );
    return {
      pushed: false,
      count: pushable.length,
      pushedMarkets: pushable.map((p) => p.marketAddress),
      skippedMarkets: missingGeneration,
      terminalMarkets,
    };
  }

  let firstSig: string | undefined;
  const pushedMarkets: string[] = [];
  const errors: string[] = [];

  /**
   * Preflight one tx so an ON-CHAIN revert is visible before we send.
   * Returns the simulate `err` (null = would execute, or could not validate).
   *
   * PREFLIGHT (2026-07-27). This used to send with skipPreflight:true and never
   * await confirmation, so a chunk that REVERTED on-chain was counted as pushed —
   * the phantom-success problem. PushAuthMark reverts for the whole atomic batch
   * if ANY market in it is ineligible (`group.header.mode != 0` ->
   * EngineLockActive, a non-increasing observation_sequence -> EngineStale, or a
   * junk slab -> Unauthorized), so one bad market silently froze the price for
   * every market batched with it (the 2026-07-13 outage shape).
   */
  const preflight = async (chunk: AuthMarkPushItem[]): Promise<unknown> => {
    const { tx } = buildPushTx(keeper, chunk, nowSlot, blockhash);
    tx.sign(keeper);
    let simErr: unknown = null;
    try {
      const sim = await devnetConn.simulateTransaction(tx);
      simErr = sim.value.err;
    } catch {
      // A simulate that cannot even run (RPC hiccup) must not drop the push —
      // fall through and send, which is the old behaviour.
      simErr = null;
    }
    // BlockhashNotFound is NOT a program revert. On a load-balanced devnet RPC
    // pool (the padre endpoint) the node that runs simulateTransaction often lags
    // the node that served getLatestBlockhash, so the preflight fails
    // "BlockhashNotFound" even though the SEND lands fine. Reclassify it to
    // "couldn't validate" and fall through to the send; a genuine program revert
    // still surfaces as Custom(N), so isolation/quarantine is unaffected.
    if (simErr && /Blockhash\s*not\s*found/i.test(JSON.stringify(simErr))) {
      simErr = null;
    }
    return simErr;
  };

  /** Record a proven revert against ONE market (strikes -> quarantine). */
  const strike = (bad: AuthMarkPushItem, simErr: unknown): void => {
    const strikes = (quarantineStrikes.get(bad.marketAddress) ?? 0) + 1;
    quarantineStrikes.set(bad.marketAddress, strikes);
    if (strikes >= QUARANTINE_AFTER_STRIKES) {
      quarantinedUntil.set(bad.marketAddress, Date.now() + QUARANTINE_MS);
      console.error(
        `[push][QUARANTINE] ${bad.marketAddress.slice(0, 8)}… reverted ${strikes}× ` +
          `(${JSON.stringify(simErr).slice(0, 80)}) — skipping it for ${QUARANTINE_MS / 60_000}min ` +
          `so it cannot freeze the other markets' prices. Investigate: is it Live (mode 0)?`,
      );
    }
    errors.push(`${bad.marketAddress.slice(0, 8)}…: ${JSON.stringify(simErr).slice(0, 80)}`);
  };

  /** Submit a chunk that preflighted clean. Fire-and-forget on confirmation. */
  const send = async (chunk: AuthMarkPushItem[]): Promise<void> => {
    const { tx } = buildPushTx(keeper, chunk, nowSlot, blockhash);
    tx.sign(keeper);
    try {
      const signature = await devnetConn.sendRawTransaction(tx.serialize(), PUSH_SEND_OPTIONS);
      firstSig ??= signature;
      inFlightPushes.push({
        signature,
        sentAtMs: Date.now(),
        items: chunk.map((p) => ({ key: pushGenerationKey(p), market: p.marketAddress, seq: p.observationSequence })),
      });
      if (inFlightPushes.length > MAX_IN_FLIGHT_PUSHES) inFlightPushes.splice(0, inFlightPushes.length - MAX_IN_FLIGHT_PUSHES);
      for (const p of chunk) {
        pushedMarkets.push(p.marketAddress);
        // A clean push clears any accumulated strikes…
        quarantineStrikes.delete(p.marketAddress);
        // …and reserves its nonce, so the NEXT cycle proposes above it even if
        // this tx has not landed/confirmed by the time that cycle reads chain.
        recordSentObservationSequence(p);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${chunk.length} market(s): ${msg.slice(0, 120)}`);
    }
  };

  /**
   * Re-read observation_sequence for `items` after an EngineStale preflight and
   * propose strictly above both the fresh chain value and what we tried. Returns
   * null if the re-read itself failed (caller then isolates instead).
   */
  const refreshSequences = async (items: AuthMarkPushItem[]): Promise<AuthMarkPushItem[] | null> => {
    try {
      const fresh = await fetchPushAuthMarkGenerationFields(devnetConn, items, terminal);
      return items.map((p) => {
        const f = fresh.get(pushGenerationKey(p));
        const bumped = p.observationSequence + 1n;
        const seq = f && f.observationSequence > bumped ? f.observationSequence : bumped;
        return { ...p, observationSequence: seq };
      });
    } catch {
      return null;
    }
  };

  /**
   * Push one chunk so that ONE failing market can never black out the rest.
   *
   * On a preflight revert the real RPC error names the failing instruction
   * (`{"InstructionError":[i,{"Custom":n}]}`, ix 0 = ComputeBudget, so push i-1).
   * - Custom(19) EngineStale -> re-read the nonces once and retry the SAME chunk
   *   (a stale observation_sequence is a keeper-side race, not a bad market, so
   *   it must not cost the market a cycle or a quarantine strike).
   * - anything else -> exclude exactly that market (strike it) and re-preflight
   *   the remainder as ONE tx, in the same cycle.
   * - an error that does not name a push ix -> fall back to one-at-a-time.
   */
  const pushChunk = async (chunk: AuthMarkPushItem[]): Promise<void> => {
    let pending = chunk;
    let refreshed = false;
    // Each non-refresh iteration removes one market, so this is bounded.
    for (let guard = 0; pending.length > 0 && guard <= chunk.length + 1; guard++) {
      const simErr = await preflight(pending);
      if (!simErr) {
        await send(pending);
        return;
      }
      const failing = parseFailingPush(simErr, pending.length);
      if (failing === null) {
        if (pending.length === 1) {
          strike(pending[0], simErr);
          return;
        }
        console.warn(
          `[push] chunk of ${pending.length} reverted in preflight (${JSON.stringify(simErr).slice(0, 80)}) ` +
            `— retrying individually to isolate the bad market`,
        );
        for (const single of pending) {
          const singleErr = await preflight([single]);
          if (singleErr) strike(single, singleErr);
          else await send([single]);
        }
        return;
      }
      const culprit = pending[failing.position];
      if (failing.custom === ENGINE_STALE_CUSTOM && !refreshed) {
        refreshed = true;
        const next = await refreshSequences(pending);
        if (next) {
          console.warn(
            `[push] ${culprit.marketAddress.slice(0, 8)}… observation_sequence stale (Custom(19)) — ` +
              `re-read nonces, retrying the chunk of ${pending.length}`,
          );
          pending = next;
          continue;
        }
      }
      strike(culprit, simErr);
      pending = pending.filter((_, i) => i !== failing.position);
      if (pending.length > 0) {
        console.warn(
          `[push] ${culprit.marketAddress.slice(0, 8)}… reverted in preflight ` +
            `(${JSON.stringify(simErr).slice(0, 80)}) — excluded; re-sending the other ${pending.length}`,
        );
      }
    }
  };

  for (const chunk of chunks) {
    await pushChunk(chunk);
  }

  if (errors.length > 0) {
    console.error(`[push] ${errors.length} push(es) failed — ${errors.join(" | ")}`);
  }

  const pushedSet = new Set(pushedMarkets);
  return {
    pushed: pushedMarkets.length > 0,
    signature: firstSig,
    count: pushedMarkets.length,
    pushedMarkets,
    // Everything asked for that did NOT go out — quarantined or reverting. The
    // caller must not stamp these as freshly pushed (that was the /health lie).
    skippedMarkets: pushes.map((p) => p.marketAddress).filter((m) => !pushedSet.has(m) && !terminal.has(m)),
    terminalMarkets,
  };
}
