/**
 * cross-cluster/resolved-portfolio-cleanup.ts
 *
 * Close every materialized portfolio on a RESOLVED market, permissionlessly,
 * so stake tag 29 (wrapper tag 41 underneath) can recover the stakers'
 * terminal insurance budget. E2E B12: tag 41 on a Resolved market requires
 * `materialized_portfolio_count == 0`, and one abandoned account stranded the
 * budget forever on 6377376a.
 *
 * Closed on the P3 FINAL wrapper b2b2559e (feat/p3-vault-owned-lp). Verified
 * against that source:
 *   CloseResolved (tag 30, `[30][fee_rate_per_slot u128]`, handler
 *     v16_program.rs:22430): [0] portfolio OWNER (need not sign, except inside
 *     `force_close_delay_slots` or for an NFT-escrowed portfolio, GH#496),
 *     [1] market (w), [2] portfolio (w), and when there is a payout
 *     [3] a token account OWNED BY the portfolio owner (w, unencumbered, same
 *     mint), [4] canonical wrapper vault (w), [5] vault authority, [6] SPL Token.
 *     The payout can only go to the owner. A vault-LP portfolio (owner = the
 *     market's LP-vault registry PDA) is refused: it settles via tag 101.
 *   ClosePortfolio (tag 8, `[8][portfolio_id u64][expected_sequence u64]
 *     [position_epoch u64]`, handler :15742): [0] closer (signer, w),
 *     [1] market (w), [2] portfolio (w), [3] the portfolio OWNER (w) — in
 *     Resolved mode anyone may deregister an EMPTY portfolio when [3] is its
 *     owner, and the rent goes there. The engine's emptiness predicate still
 *     refuses anything holding a claim. The call binds (portfolio_id,
 *     matcher sequence, position epoch), read live from the account.
 *   Portfolio layout block is byte-identical to deployed 6377376a.
 *
 * PDA owners (P3 ledger §0.7 "Wind-down", refs at b2b2559e; coordinator
 * 2026-09-30). A permissionless tag-8 close pays the rent to [3] = the owner:
 *   - VAULT LP (owner = LP-vault registry PDA): tag 101 does NOT dematerialize
 *     it (no deregister in handle_vault_lp_settle_resolved). Sequence, at once,
 *     no grace: 101 topup=0 -> 101 topup=1 (a 21 = nothing pending, harmless)
 *     -> tag 8 [closer s,w][market w][vault_lp portfolio w][registry w]. The
 *     registry is wrapper-owned and simply receives the rent: expected.
 *   - NFT-ESCROWED and EMPTY (owner = NFT program ["mint_authority"] PDA): left
 *     for the holder for `pdaGraceSlots` after resolve (default 216,000 ≈ 24 h),
 *     then tag 8 alone with [3] = the escrow PDA (the NFT program tolerates the
 *     closed account on a later Burn/EmergencyBurn, nft db4aa09 #131). Logged
 *     and alerted.
 *   - NFT-ESCROWED WITH A CLAIM: only the holder can settle it (GH#496:
 *     require_signer_for_escrowed_terminal_payout — paying the unsigned escrow
 *     PDA would burn the funds). Never attempted; reported as "insurance
 *     recovery waiting on NFT holder X" with the portfolio, NFT mint (from the
 *     NFT program's PositionNftV16 record: portfolio_account @10, nft_mint @42,
 *     last_holder @167; 239 B at layout v3 = nft 95dcece, 199 B legacy v2) and claim size. An
 *     accepted devnet limitation. (Devnet 2026-09-30: 6 such portfolios exist.)
 *
 * F-14 (P3 WIP 31efd250): tag 101 moves NO SPL — the whole vault-LP payout goes back
 * into the vault's own backing pot; the junior is paid only by its own tag 102 after
 * the seniors' 77 (watched by vault-lp-junior-watch.ts). The keeper passes the junior
 * dest [7] (and ensures that ATA exists) only because 101 still requires and verifies
 * it; nothing here assumes 101 pays the junior.
 *
 * Tag 101 accounts (:26676): [caller s,w] [market w] [registry] [vault_lp state
 * w] [lp portfolio w] [own ledger w] [sibling ledger] [junior dest w = token
 * account of state.junior_owner] [vault token w] [vault authority] [token]
 * [system]; data [101][topup u8].
 *
 * Gate: 6377376a checks the same binding and then answers a non-owner closer
 * with `Unauthorized` = Custom(8) (v18.2 handle_close_portfolio). So a
 * simulated tag 8 on a real portfolio with a fresh binding and the owner at [3]
 * returns Custom(8) on 6377376a — "unsupported", a no-op — and anything else
 * on b2b2559e. Cached with a TTL so an upgrade is picked up without a restart.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  deriveMarketVaultAccounts,
  parseLpVaultRegistry,
  decodeResolvedPayoutReceiptP3,
  parsePortfolioV17,
  RESOLVED_RECEIPT_ACCOUNT_OFF_P3,
  RESOLVED_RECEIPT_LEN_P3,
  V17_PORTFOLIO_ACCOUNT_LEN,
  LAYOUTS_BY_VERSION,
} from "@percolatorct/sdk";
import { parseInstructionError } from "./positioned-refresh.ts";
import { confirmBySignature } from "./tx-confirm.ts";
import { getMultipleAccountsInfoChunked } from "./rpc-chunk.ts";
import type { ConfirmOptions } from "./tx-confirm.ts";

export const WRAPPER_TAG_CLOSE_PORTFOLIO = 8;
export const WRAPPER_TAG_CLOSE_RESOLVED = 30;
/** Wrapper `Unauthorized` (enum position 8, b2b2559e and 6377376a). */
export const WRAPPER_ERR_UNAUTHORIZED = 8;
/** Wrapper `ExpectedSigner` (enum position 6, b2b2559e): an escrowed terminal payout without the holder's signature. */
export const WRAPPER_ERR_EXPECTED_SIGNER = 6;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const COMPUTE_UNIT_LIMIT = 800_000;

export function encodeCloseResolved(): Buffer {
  const b = Buffer.alloc(17);
  b[0] = WRAPPER_TAG_CLOSE_RESOLVED; // fee_rate_per_slot is ignored by the handler (`_fee_rate_per_slot`); 0
  return b;
}

export function encodeClosePortfolio(portfolioId: bigint, expectedSequence: bigint, positionEpoch: bigint): Buffer {
  const b = Buffer.alloc(25);
  b[0] = WRAPPER_TAG_CLOSE_PORTFOLIO;
  b.writeBigUInt64LE(portfolioId, 1);
  b.writeBigUInt64LE(expectedSequence, 9);
  b.writeBigUInt64LE(positionEpoch, 17);
  return b;
}

export function ownerAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

export function buildCreateAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ownerAta(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export function buildCloseResolvedIx(p: {
  wrapperProgramId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  collateralMint: PublicKey;
}): TransactionInstruction {
  const v = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, p.collateralMint);
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: [
      { pubkey: p.owner, isSigner: false, isWritable: false },
      { pubkey: p.market, isSigner: false, isWritable: true },
      { pubkey: p.portfolio, isSigner: false, isWritable: true },
      { pubkey: ownerAta(p.owner, p.collateralMint), isSigner: false, isWritable: true },
      { pubkey: v.vaultToken, isSigner: false, isWritable: true },
      { pubkey: v.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: v.tokenProgram, isSigner: false, isWritable: false },
      // [7]: GH#496 proof that the owner is not NFT-escrowed, read by
      // require_signer_for_escrowed_terminal_payout whenever there is a payout.
      // (A lone account here is not the optional NFT-holder trio, which needs 3.)
      { pubkey: deriveNftRegistry(p.wrapperProgramId, p.market), isSigner: false, isWritable: false },
    ],
    data: encodeCloseResolved(),
  });
}

/**
 * Account offset of `PortfolioAccountV16Account.resolved_payout_receipt` — re-exported from the
 * SDK (`RESOLVED_RECEIPT_ACCOUNT_OFF_P3` = 9369, rustc `offset_of!` + HEADER_LEN 16, pinned by the
 * SDK parity fixture). 66 bytes (`RESOLVED_RECEIPT_LEN_P3`): 4 × u128, `present` @+64, `finalized` @+65.
 */
export const RESOLVED_RECEIPT_OFF: number = RESOLVED_RECEIPT_ACCOUNT_OFF_P3;
/**
 * A PARTIAL resolved receipt: `present && !finalized` (5544302a: a CloseResolved that ran before
 * the vault LP's 101 leaves one; only a later tag 46 ClaimResolvedPayoutTopup finalises it).
 * Decoded by the SDK's `decodeResolvedPayoutReceiptP3`; data too short to carry a receipt → false.
 */
export function receiptOpen(d: Uint8Array): boolean {
  if (d.length < RESOLVED_RECEIPT_ACCOUNT_OFF_P3 + RESOLVED_RECEIPT_LEN_P3) return false;
  return decodeResolvedPayoutReceiptP3(d).open;
}
/** Tag 46 ClaimResolvedPayoutTopup, permissionless: the CloseResolved account list (owner unsigned, [7] nft_registry), data [46]. */
export function buildClaimResolvedPayoutTopupIx(p: Parameters<typeof buildCloseResolvedIx>[0]): TransactionInstruction {
  const ix = buildCloseResolvedIx(p);
  return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.from([46]) });
}

/** `["nft_registry", market_group]` under the wrapper (b2b2559e derive_nft_registry :5981). */
export function deriveNftRegistry(wrapperProgramId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("nft_registry"), market.toBuffer()], wrapperProgramId)[0];
}

/** `["vault_lp", market]` under the wrapper (VAULT_LP_STATE_SEED, derive_vault_lp_state :5632). */
export function deriveVaultLpState(wrapperProgramId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_lp"), market.toBuffer()], wrapperProgramId)[0];
}

export const WRAPPER_TAG_VAULT_LP_SETTLE_RESOLVED = 101;
const KIND_VAULT_LP_STATE = 9;
const VAULT_LP_STATE_VERSION = 1;

export interface VaultLpState {
  registry: PublicKey;
  lpPortfolio: PublicKey;
  juniorOwner: PublicKey;
  /** d119eebd: cumulative senior backing moved into the vault LP (booked draws). @16+224 u128. */
  seniorDrawnAtoms: bigint;
  /** d119eebd: senior loss still outstanding; while > 0, 97 / 102 / risk-increasing fills halt. @16+240 u128. */
  seniorDrawOutstandingAtoms: bigint;
}

function u128le(d: Uint8Array, o: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(o, true) | (v.getBigUint64(o + 8, true) << 64n);
}

/** VaultLpStateV18 at HEADER_LEN (b2b2559e :5647; 256 B at d119eebd :5678, senior-draw fields @224/@240). null unless kind 9 / version 1 / long enough. */
export function decodeVaultLpState(d: Uint8Array): VaultLpState | null {
  const H = 16;
  if (d.length < H + 256 || d[10] !== KIND_VAULT_LP_STATE || d[H + 214] !== VAULT_LP_STATE_VERSION) return null;
  return {
    registry: new PublicKey(d.subarray(H + 32, H + 64)),
    lpPortfolio: new PublicKey(d.subarray(H + 64, H + 96)),
    juniorOwner: new PublicKey(d.subarray(H + 96, H + 128)),
    seniorDrawnAtoms: u128le(d, H + 224),
    seniorDrawOutstandingAtoms: u128le(d, H + 240),
  };
}

export function buildVaultLpSettleResolvedIx(p: {
  wrapperProgramId: PublicKey;
  caller: PublicKey;
  market: PublicKey;
  vaultLpState: PublicKey;
  state: VaultLpState;
  registryDomain: number;
  collateralMint: PublicKey;
  /** 0 = the CloseResolved step, 1 = claim a pending resolved top-up. */
  topup: 0 | 1;
}): TransactionInstruction {
  const v = deriveMarketVaultAccounts(p.wrapperProgramId, p.market, p.collateralMint);
  const [own] = deriveLpBackingLedger(p.wrapperProgramId, p.market, p.registryDomain);
  const [sib] = deriveLpBackingLedger(p.wrapperProgramId, p.market, p.registryDomain ^ 1);
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: [
      { pubkey: p.caller, isSigner: true, isWritable: true },
      { pubkey: p.market, isSigner: false, isWritable: true },
      { pubkey: p.state.registry, isSigner: false, isWritable: false },
      { pubkey: p.vaultLpState, isSigner: false, isWritable: true },
      { pubkey: p.state.lpPortfolio, isSigner: false, isWritable: true },
      { pubkey: own, isSigner: false, isWritable: true },
      // d119eebd vault_lp_draw_then_book: 101 books a pending senior draw only when the
      // ledger of EVERY pot drawn from is writable (else it defers, require_booking=false).
      { pubkey: sib, isSigner: false, isWritable: true },
      { pubkey: ownerAta(p.state.juniorOwner, p.collateralMint), isSigner: false, isWritable: true },
      { pubkey: v.vaultToken, isSigner: false, isWritable: true },
      { pubkey: v.vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: v.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([WRAPPER_TAG_VAULT_LP_SETTLE_RESOLVED, p.topup]),
  });
}

export function buildClosePortfolioIx(p: {
  wrapperProgramId: PublicKey;
  closer: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  owner: PublicKey;
  portfolioId: bigint;
  expectedSequence: bigint;
  positionEpoch: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.wrapperProgramId,
    keys: [
      { pubkey: p.closer, isSigner: true, isWritable: true },
      { pubkey: p.market, isSigner: false, isWritable: true },
      { pubkey: p.portfolio, isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: false, isWritable: true },
    ],
    data: encodeClosePortfolio(p.portfolioId, p.expectedSequence, p.positionEpoch),
  });
}

export type CleanupSupport = "supported" | "unsupported" | "unknown";

/**
 * Classify a simulation of [CU, ClosePortfolio(owner at [3])]. Custom(8) at
 * the ClosePortfolio instruction is the 6377376a signature -> unsupported.
 * Any other instruction error there (e.g. the engine refusing a non-empty
 * portfolio) means the permissionless path exists -> supported.
 */
export function classifyCleanupProbe(err: unknown, simOk: boolean): CleanupSupport {
  if (simOk) return "supported";
  const ie = parseInstructionError(err);
  if (!ie || ie.index !== 1) return "unknown";
  return ie.custom === WRAPPER_ERR_UNAUTHORIZED ? "unsupported" : "supported";
}

/** The NFT program's `["mint_authority"]` PDA: owner of every NFT-escrowed portfolio. */
export function nftEscrowAuthority(nftProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], nftProgramId)[0];
}

export type PdaOwnerKind = "lp-registry" | "nft-escrow";

/**
 * PositionNftV16 (nft state_v16.rs): portfolio_account @10, nft_mint @42, last_holder @167. Layout v3 (S1-2, nft 95dcece)
 * is 239 B and appends the portfolio INCARNATION: portfolio_market_group @199..231, portfolio_id_at_mint @231..239 (u64 LE).
 * Legacy v2 (pre-S1-2) is 199 B with no incarnation.
 */
export const POSITION_NFT_LEN = 239;
export const POSITION_NFT_LEN_LEGACY = 199;
export interface PositionNftRecord {
  portfolio: PublicKey;
  nftMint: PublicKey;
  holder: PublicKey;
  /** null for a legacy 199 B record (no incarnation binding). */
  marketGroup: PublicKey | null;
  portfolioIdAtMint: bigint | null;
}
export function decodePositionNft(d: Uint8Array): PositionNftRecord | null {
  if (d.length !== POSITION_NFT_LEN && d.length !== POSITION_NFT_LEN_LEGACY) return null;
  const v3 = d.length === POSITION_NFT_LEN;
  return {
    portfolio: new PublicKey(d.subarray(10, 42)),
    nftMint: new PublicKey(d.subarray(42, 74)),
    holder: new PublicKey(d.subarray(167, 199)),
    marketGroup: v3 ? new PublicKey(d.subarray(199, 231)) : null,
    portfolioIdAtMint: v3 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(231, true) : null,
  };
}

/**
 * The escrowed portfolio's NFT record (mint + current holder). null if not found. Never throws.
 *
 * S1-2: a portfolio keypair can be closed and re-created, leaving an NFT of the EARLIER incarnation behind with the same
 * `portfolio_account`. That NFT is not the holder of the live escrow, so (`live` is REQUIRED: omitting it would accept a stale v3 record) a v3 record is accepted only if its (market group, id) match it. Stale v3 records are
 * skipped. A legacy 199 B record (no incarnation to compare) is used only when NO v3 record exists for the portfolio (a
 * pre-S1-2 program); once any v3 record names it, legacy is a dead NFT and the holder is unknown (null). The escrow itself is identified by the portfolio's owner being the NFT
 * program's `["mint_authority"]` PDA ({@link pdaOwnerKind}), which does not depend on this record.
 */
export async function positionNftFor(
  conn: Pick<Connection, "getProgramAccounts">,
  nftProgramId: PublicKey,
  portfolio: PublicKey,
  live: { marketGroup: PublicKey; portfolioId: bigint },
): Promise<{ nftMint: string; holder: string } | null> {
  try {
    const [v3All, legacy] = await Promise.all(
      [POSITION_NFT_LEN, POSITION_NFT_LEN_LEGACY].map((dataSize) =>
        conn.getProgramAccounts(nftProgramId, { filters: [{ dataSize }, { memcmp: { offset: 10, bytes: portfolio.toBase58() } }] }),
      ),
    );
    const v3 = v3All.filter((r) => r.account.data.length === POSITION_NFT_LEN);
    for (const r of v3) {
      const d = decodePositionNft(new Uint8Array(r.account.data));
      if (!d || !d.portfolio.equals(portfolio)) continue;
      if (!(d.portfolioIdAtMint === live.portfolioId && live.portfolioId !== 0n && d.marketGroup?.equals(live.marketGroup))) continue;
      return { nftMint: d.nftMint.toBase58(), holder: d.holder.toBase58() };
    }
    // K-2: any v3 record naming this portfolio proves the program is the S1-2 build, where a legacy 199 B record is a dead
    // NFT (rejected by Burn/EmergencyBurn/Reconcile and by the wrapper). Its last_holder must not be named as the party to
    // wait on, so the holder is unknown. A legacy record is used only when NO v3 record exists for the portfolio.
    if (v3.some((r) => decodePositionNft(new Uint8Array(r.account.data))?.portfolio.equals(portfolio))) return null;
    for (const r of legacy) {
      const d = decodePositionNft(new Uint8Array(r.account.data));
      if (d && d.portfolio.equals(portfolio)) return { nftMint: d.nftMint.toBase58(), holder: d.holder.toBase58() };
    }
    return null;
  } catch {
    return null;
  }
}

/** Which rent-stranding PDA (if any) owns this portfolio. */
export function pdaOwnerKind(owner: PublicKey, market: PublicKey, cfg: Pick<CleanupConfig, "wrapperProgramId" | "nftProgramId">): PdaOwnerKind | null {
  if (owner.equals(deriveLpVaultRegistry(cfg.wrapperProgramId, market)[0])) return "lp-registry";
  if (owner.equals(nftEscrowAuthority(cfg.nftProgramId))) return "nft-escrow";
  return null;
}

/** Slots of grace left after resolve, or 0 once it has passed (unknown resolve slot = full grace). */
export function pdaGraceLeft(nowSlot: bigint, resolvedSlot: bigint | null, graceSlots: bigint): bigint {
  if (resolvedSlot === null || resolvedSlot === 0n) return graceSlots;
  const elapsed = nowSlot > resolvedSlot ? nowSlot - resolvedSlot : 0n;
  return elapsed >= graceSlots ? 0n : graceSlots - elapsed;
}

export interface CleanupConfig {
  wrapperProgramId: PublicKey;
  nftProgramId: PublicKey;
  /** Portfolios attempted per market per cycle. */
  maxPerCycle: number;
  /** Owner token accounts the keeper may create (rent it pays) per market per cycle. */
  maxAtaCreatesPerCycle: number;
  /** Slots after resolve during which PDA-owned portfolios are left for their holders (default 216,000 ≈ 24 h). */
  pdaGraceSlots: bigint;
  /**
   * C-7: CloseResolved (30) and VaultLpSettleResolved (101) advance a bankrupt close by ONE
   * chunk per call. Max chunk calls per portfolio per cycle (default 16); a portfolio that
   * made progress but is not done continues next cycle.
   */
  maxChunkCallsPerCycle?: number;
  probeTtlMs: number;
  confirm?: ConfirmOptions;
  now?: () => number;
}

export class CleanupState {
  support: { value: CleanupSupport; at: number } | null = null;
}

export type CleanupConnection = Pick<
  Connection,
  "getProgramAccounts" | "getMultipleAccountsInfo" | "getAccountInfo" | "getLatestBlockhash" | "simulateTransaction" | "sendRawTransaction" | "confirmTransaction" | "getSignatureStatuses"
>;

export interface CleanupResult {
  support: CleanupSupport;
  closed: number;
  progressed: number;
  /** Portfolios that could not be closed this cycle, with why. */
  remaining: Array<{ portfolio: string; reason: string }>;
  /** Empty NFT-escrowed portfolios closed after the grace period (rent went to the escrow PDA) — logged + alerted. */
  pdaClosed: Array<{ portfolio: string; owner: string; kind: PdaOwnerKind; rentLamports: number }>;
  /** Vault-LP portfolios closed (tag 101 then tag 8; rent to the registry — expected). */
  vaultLpClosed: string[];
  /** NFT-escrowed portfolios WITH a claim: only the holder can settle them (GH#496). */
  waitingOnHolder: Array<{ portfolio: string; nftMint: string | null; holder: string | null; capital: bigint; pnl: bigint; reservedPnl: bigint; activeLegs: number }>;
  /** Vault-LP settles (tag 101) sent this pass. */
  vaultLpSettled: number;
  /**
   * `p3_senior_draw*` log lines from the sends' simulations (d119eebd: tag 101 books a
   * pending senior draw when both pot ledgers are writable) — the caller alerts on them.
   */
  seniorDrawLogs: string[];
  /** Resolved-receipt revisit (5e4c15ff): portfolios revisited this pass (tag 46, or a repeat CloseResolved). */
  topupSwept: string[];
}

interface Pf {
  pubkey: PublicKey;
  lamports: number;
  /** Raw account bytes as read: the baseline for the chunk-progress check. */
  data: Uint8Array;
  /** capital / pnl / reservedPnl / active legs / cancel-deposit escrow: anything the owner still has to claim. */
  claim: { capital: bigint; pnl: bigint; reservedPnl: bigint; activeLegs: number; cancelDepositEscrow: bigint };
  owner: PublicKey;
  portfolioId: bigint;
  matcherSequence: bigint;
  positionEpoch: bigint;
}

function why(err: unknown, logs: string[] | null, ixIndex: Record<number, string>): string {
  const ie = parseInstructionError(err);
  const where = ie ? (ixIndex[ie.index] ?? `ix ${ie.index}`) : "tx";
  const detail = ie?.custom != null ? `Custom(${ie.custom})` : JSON.stringify(ie ? (err as { InstructionError: unknown[] }).InstructionError[1] : err);
  const hint = /MissingRequiredSignature/.test(JSON.stringify(err))
    ? " — needs the owner's signature (force-close delay not elapsed, or NFT-escrowed)"
    : ie?.custom === WRAPPER_ERR_EXPECTED_SIGNER
      ? " — NFT-escrowed payout needs the NFT holder's signature (GH#496): not closable by any keeper"
      : "";
  const log = (logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-1).join("");
  return `${where} ${detail}${hint}${log ? ` (${log.slice(0, 80)})` : ""}`;
}

/**
 * K-10: the portfolio account length of `market`'s program version, for the discovery scans below.
 *
 * Both scans filtered on the v2.1 length (9,563 B), so on a v2.2 market (VERSION 19, 10,603 B portfolios) they found
 * nothing and a Resolved v2.2 market was never wound down. The length now comes from the market account's own header
 * VERSION through the SDK layout table (the same table `parsePortfolioV17` / `decodeResolvedPayoutReceiptP3` already
 * resolve every portfolio with, so the receipt offset 9,369 / 10,409 needs no change here). The header survives a
 * CloseSlab tombstone. A VERSION the pinned SDK has no table for THROWS (the callers report "portfolio discovery
 * failed"; nothing is scanned at a guessed size). An unreadable / absent market account keeps the v2.1 length.
 */
export function portfolioLenForMarketData(data: Uint8Array | null | undefined): number {
  if (!data || data.length < 10) return V17_PORTFOLIO_ACCOUNT_LEN;
  const version = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(8, true);
  const t = LAYOUTS_BY_VERSION.get(version);
  if (!t) throw new Error(`market VERSION ${version} has no portfolio layout in the pinned SDK`);
  return t.portfolio.accountLen;
}

async function portfolioLenForMarket(conn: Pick<CleanupConnection, "getAccountInfo">, market: PublicKey): Promise<number> {
  let data: Uint8Array | null = null;
  try {
    const info = await conn.getAccountInfo(market, "confirmed");
    data = info ? new Uint8Array(info.data) : null;
  } catch {
    data = null; // unreadable this cycle: v2.1 length (a wrong-size scan finds nothing and the next cycle retries)
  }
  return portfolioLenForMarketData(data);
}

/**
 * One cleanup pass for a Resolved market. Never throws. dryRun simulates only.
 */
export async function cleanupResolvedPortfolios(
  conn: CleanupConnection,
  keeper: Keypair,
  market: PublicKey,
  collateralMint: PublicKey,
  dryRun: boolean,
  cfg: CleanupConfig,
  st: CleanupState,
  /** Chain slot now, and the market's engine resolved_slot (grace clock for PDA owners). */
  clock: { nowSlot: bigint; resolvedSlot: bigint | null } = { nowSlot: 0n, resolvedSlot: null },
): Promise<CleanupResult> {
  const out: CleanupResult = { support: "unknown", closed: 0, progressed: 0, remaining: [], pdaClosed: [], vaultLpClosed: [], waitingOnHolder: [], vaultLpSettled: 0, seniorDrawLogs: [], topupSwept: [] };
  let pfs: Pf[];
  try {
    const accs = await conn.getProgramAccounts(cfg.wrapperProgramId, {
      filters: [
        { dataSize: await portfolioLenForMarket(conn, market) },
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 16, bytes: market.toBase58() } },
      ],
    });
    pfs = accs.map((a) => {
      const p = parsePortfolioV17(new Uint8Array(a.account.data));
      const claim = { capital: p.capital, pnl: p.pnl, reservedPnl: p.reservedPnl, activeLegs: p.legs.filter((l) => l.active).length, cancelDepositEscrow: p.cancelDepositEscrow };
      return { pubkey: a.pubkey, lamports: a.account.lamports, data: new Uint8Array(a.account.data), claim, owner: p.owner, portfolioId: p.portfolioId, matcherSequence: p.matcherSequence, positionEpoch: p.matcherPositionEpoch };
    });
  } catch (err) {
    out.remaining.push({ portfolio: "*", reason: `portfolio discovery failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` });
    return out;
  }
  if (pfs.length === 0) {
    out.support = st.support?.value ?? "unknown";
    return out;
  }

  const closeIx = (p: Pf) =>
    buildClosePortfolioIx({
      wrapperProgramId: cfg.wrapperProgramId, closer: keeper.publicKey, market, portfolio: p.pubkey, owner: p.owner,
      portfolioId: p.portfolioId, expectedSequence: p.matcherSequence, positionEpoch: p.positionEpoch,
    });
  const resolvedIx = (p: Pf) =>
    buildCloseResolvedIx({ wrapperProgramId: cfg.wrapperProgramId, owner: p.owner, market, portfolio: p.pubkey, collateralMint });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const mk = (ixs: TransactionInstruction[]): Transaction => {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
    for (const ix of ixs) tx.add(ix);
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    return tx;
  };
  const sim = async (tx: Transaction) => {
    const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
    return { err: r.value.err, logs: r.value.logs ?? null };
  };
  /** Chunk tx `n`: a distinct compute-unit limit per call so repeated chunks never share a signature. */
  const mkChunk = (ixs: TransactionInstruction[], n: number): Transaction => {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT - n }));
    for (const ix of ixs) tx.add(ix);
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);
    return tx;
  };
  /** Simulate and return the post-state of `watch` (null if the RPC returned none). */
  const simWatch = async (tx: Transaction, watch: PublicKey) => {
    const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      sigVerify: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [watch.toBase58()] },
    });
    const a = r.value.accounts?.[0];
    return { err: r.value.err, logs: r.value.logs ?? null, post: a ? new Uint8Array(Buffer.from(a.data[0], "base64")) : null };
  };
  const chunkCap = cfg.maxChunkCallsPerCycle ?? 16;
  /**
   * C-7 chunk loop: repeat `chunk()` while it keeps changing the portfolio, trying `finish()`
   * (the close) before every chunk. Stops on: finish() closing it, a chunk error, a chunk that
   * would change nothing (no progress — never spins), a tx that did not land, or the cap.
   */
  const runChunks = async (
    p: Pf,
    chunk: (n: number) => TransactionInstruction[],
    finish: () => Promise<boolean>,
    label: string,
    /** false: run at least one chunk before the first finish attempt (vault LP: 101(0) always first). */
    finishFirst = true,
  ): Promise<{ closed: boolean; calls: number; stop: string }> => {
    let current = p.data;
    let calls = 0;
    for (;;) {
      if ((finishFirst || calls > 0) && (await finish())) return { closed: true, calls, stop: "closed" };
      if (calls >= chunkCap) return { closed: false, calls, stop: `per-cycle cap of ${chunkCap} ${label} chunk calls reached` };
      const tx = mkChunk(chunk(calls), calls);
      const r = await simWatch(tx, p.pubkey);
      if (r.err) return { closed: false, calls, stop: why(r.err, r.logs, { 1: label }) };
      if (!r.post || Buffer.from(r.post).equals(Buffer.from(current))) {
        return { closed: false, calls, stop: `${label} would make no progress` };
      }
      if (!(await send(tx))) return { closed: false, calls, stop: `${label} chunk tx did not land` };
      for (const l of r.logs ?? []) if (l.includes("p3_senior_draw")) out.seniorDrawLogs.push(l);
      calls++;
      out.progressed++;
      current = r.post;
    }
  };

  // Gate (cached).
  const now = (cfg.now ?? Date.now)();
  if (!st.support || st.support.value === "unknown" || now - st.support.at >= cfg.probeTtlMs) {
    let value: CleanupSupport = "unknown";
    try {
      // Probe with a portfolio we would actually close (never a PDA-owned one).
      const target = pfs.find((q) => pdaOwnerKind(q.owner, market, cfg) === null) ?? pfs[0];
      const r = await sim(mk([closeIx(target)]));
      value = classifyCleanupProbe(r.err, !r.err);
    } catch {
      value = "unknown";
    }
    st.support = { value, at: now };
  }
  out.support = st.support.value;
  if (out.support !== "supported") {
    for (const p of pfs) {
      out.remaining.push({
        portfolio: p.pubkey.toBase58(),
        reason: out.support === "unsupported"
          ? "deployed wrapper has no permissionless resolved ClosePortfolio (6377376a answers Custom(8)); needs P3 b2b2559e"
          : "cleanup support unknown this cycle (probe failed)",
      });
    }
    return out;
  }

  // Which owner token accounts exist (payout destinations)?
  const atas = pfs.map((p) => ownerAta(p.owner, collateralMint));
  let ataExists: boolean[];
  try {
    // Chunked at 100 (RPC cap): a resolved market can hold >100 portfolios. A failed chunk reads as "absent" (undefined -> false), as a whole-call failure did.
    const { infos } = await getMultipleAccountsInfoChunked(conn, atas, "confirmed");
    ataExists = infos.map((i) => i != null);
  } catch {
    ataExists = atas.map(() => false);
  }

  let ataCreates = 0;
  const send = async (tx: Transaction): Promise<boolean> => {
    if (dryRun) return true;
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm);
    return c.status === "landed";
  };

  // Order (coordinator, P3 07a1d0eb): every other portfolio first (CloseResolved +
  // tag 8), THEN the vault LP (tag 101 settle, then its tag 8), so the senior-first
  // settle of the vault LP sees the other positions already settled.
  pfs.sort((x, y) => Number(pdaOwnerKind(x.owner, market, cfg) === "lp-registry") - Number(pdaOwnerKind(y.owner, market, cfg) === "lp-registry"));
  const graceLeft = pdaGraceLeft(clock.nowSlot, clock.resolvedSlot, cfg.pdaGraceSlots);
  // Vault LP (tag 101 first): its state names the LP portfolio and junior owner.
  let vaultLp: { key: PublicKey; state: VaultLpState; domain: number } | null = null;
  if (pfs.some((q) => pdaOwnerKind(q.owner, market, cfg) === "lp-registry")) {
    try {
      const key = deriveVaultLpState(cfg.wrapperProgramId, market);
      const [si] = await conn.getMultipleAccountsInfo([key], "confirmed");
      const state = si ? decodeVaultLpState(new Uint8Array(si.data)) : null;
      if (state) {
        const ri = await conn.getAccountInfo(state.registry, "confirmed");
        if (ri) vaultLp = { key, state, domain: Number(parseLpVaultRegistry(new Uint8Array(ri.data)).domain) };
      }
    } catch {
      vaultLp = null;
    }
  }
  const settleIx = (topup: 0 | 1): TransactionInstruction =>
    buildVaultLpSettleResolvedIx({
      wrapperProgramId: cfg.wrapperProgramId, caller: keeper.publicKey, market, vaultLpState: vaultLp!.key,
      state: vaultLp!.state, registryDomain: vaultLp!.domain, collateralMint, topup,
    });

  for (let i = 0; i < pfs.length; i++) {
    const p = pfs[i];
    const pdaKind = pdaOwnerKind(p.owner, market, cfg);
    if (i >= cfg.maxPerCycle) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `over the ${cfg.maxPerCycle}-per-cycle bound; next cycle` });
      continue;
    }
    if (pdaKind === "lp-registry") {
      // §0.7: 101 topup=0 -> 101 topup=1 (21 = nothing pending, harmless) -> tag 8, at once.
      if (!vaultLp || !vaultLp.state.lpPortfolio.equals(p.pubkey)) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "registry-PDA-owned portfolio with no bound vault-LP state (cannot run tag 101)" });
        continue;
      }
      try {
        // C-7: 101(0) advances the vault LP's resolved close one chunk per call — loop it.
        // Between chunks try the finish: 101(1) (a 21 = nothing pending, harmless) then tag 8.
        const vlp = vaultLp;
        const finish = async (): Promise<boolean> => {
          const t1 = mk([settleIx(1)]);
          if (!(await sim(t1)).err && (await send(t1))) out.vaultLpSettled++;
          const close = mk([closeIx(p)]);
          return !(await sim(close)).err && (await send(close));
        };
        const r: { closed: boolean; calls: number; stop: string } = await runChunks(
          p,
          (n) => (n === 0 ? [buildCreateAtaIdempotentIx(keeper.publicKey, vlp.state.juniorOwner, collateralMint), settleIx(0)] : [settleIx(0)]),
          finish,
          "VaultLpSettleResolved(0)",
          false,
        );
        // 101(0) stopped (no further progress, an error such as "already settled", or the cap)
        // without closing: try the finish once more — the settle may have completed in an
        // earlier cycle or with this cycle's last chunk.
        if (!r.closed && (await finish())) r.closed = true;
        out.vaultLpSettled += r.calls;
        if (r.closed) {
          out.closed++;
          out.vaultLpClosed.push(p.pubkey.toBase58());
        } else {
          out.remaining.push({
            portfolio: p.pubkey.toBase58(),
            reason: r.calls > 0
              ? `vault LP: tag 101 made progress (${r.calls} chunk call(s)), not done — continues next cycle (${r.stop})`
              : `vault LP: not closable this cycle (${r.stop})`,
          });
        }
      } catch (err) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
      }
      continue;
    }
    if (pdaKind === "nft-escrow") {
      const c = p.claim;
      const hasClaim = c.capital !== 0n || c.pnl !== 0n || c.reservedPnl !== 0n || c.activeLegs > 0 || c.cancelDepositEscrow !== 0n;
      if (hasClaim) {
        // GH#496: never attempted — only the holder can settle an escrowed payout.
        const nft = await positionNftFor(conn, cfg.nftProgramId, p.pubkey, { marketGroup: market, portfolioId: p.portfolioId });
        out.waitingOnHolder.push({ portfolio: p.pubkey.toBase58(), nftMint: nft?.nftMint ?? null, holder: nft?.holder ?? null, capital: c.capital, pnl: c.pnl, reservedPnl: c.reservedPnl, activeLegs: c.activeLegs });
        out.remaining.push({
          portfolio: p.pubkey.toBase58(),
          reason: `NFT-escrowed WITH a claim (capital ${c.capital}, pnl ${c.pnl}, reserved ${c.reservedPnl}, ${c.activeLegs} leg(s)): waiting on NFT holder ${nft?.holder ?? "?"} (mint ${nft?.nftMint ?? "?"}) — GH#496, holder-only`,
        });
        continue;
      }
      if (graceLeft > 0n) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `EMPTY NFT-escrowed portfolio: left for the holder to unwrap/burn and reclaim the rent — grace period, ${graceLeft} slots left` });
        continue;
      }
      try {
        const close = mk([closeIx(p)]);
        const rc = await sim(close);
        if (!rc.err && (await send(close))) {
          out.closed++;
          out.pdaClosed.push({ portfolio: p.pubkey.toBase58(), owner: p.owner.toBase58(), kind: pdaKind, rentLamports: p.lamports });
        } else {
          out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `EMPTY NFT-escrowed after grace: tag 8 ${rc.err ? why(rc.err, rc.logs, { 1: "ClosePortfolio" }) : "did not land"}` });
        }
      } catch (err) {
        out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
      }
      continue;
    }
    if (i >= cfg.maxPerCycle) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: `over the ${cfg.maxPerCycle}-per-cycle bound; next cycle` });
      continue;
    }
    try {
      const pre: TransactionInstruction[] = [];
      if (!ataExists[i]) {
        if (ataCreates >= cfg.maxAtaCreatesPerCycle) {
          out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "owner token account missing; ATA-create budget for this cycle used" });
          continue;
        }
        pre.push(buildCreateAtaIdempotentIx(keeper.publicKey, p.owner, collateralMint));
      }
      const idx = (n: number): Record<number, string> =>
        n === 2 ? { [pre.length + 1]: "CloseResolved", [pre.length + 2]: "ClosePortfolio" } : { [pre.length + 1]: n === 1 ? "CloseResolved" : "ClosePortfolio" };

      // (a) CloseResolved + ClosePortfolio.
      const a = mk([...pre, resolvedIx(p), closeIx(p)]);
      const ra = await sim(a);
      if (!ra.err) {
        if (await send(a)) {
          out.closed++;
          if (pre.length) ataCreates++;
        } else out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "close tx did not land; retry next cycle" });
        continue;
      }
      // (b) Already resolved-closed: ClosePortfolio alone.
      const b = mk([closeIx(p)]);
      const rb = await sim(b);
      if (!rb.err) {
        if (await send(b)) {
          out.closed++;
        }
        else out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: "close tx did not land; retry next cycle" });
        continue;
      }
      // (c) C-7: CloseResolved advances a bankrupt close one chunk per call — loop it, trying
      // tag 8 alone before every chunk, until the portfolio closes, stops progressing, or the cap.
      const closeOnly = async (): Promise<boolean> => {
        const t = mk([closeIx(p)]);
        return !(await sim(t)).err && (await send(t));
      };
      const firstChunk = mkChunk([...pre, resolvedIx(p)], 0);
      const probeChunk = await simWatch(firstChunk, p.pubkey);
      if (!probeChunk.err) {
        const r = await runChunks(p, (n) => (n === 0 ? [...pre, resolvedIx(p)] : [resolvedIx(p)]), async () => false, "CloseResolved");
        if (r.calls > 0 && pre.length) ataCreates++;
        if (r.calls > 0 && (await closeOnly())) {
          out.closed++;
          continue;
        }
        out.remaining.push({
          portfolio: p.pubkey.toBase58(),
          reason: r.calls > 0
            ? `CloseResolved made progress (${r.calls} chunk call(s)), not done — continues next cycle (${r.stop})`
            : `CloseResolved: ${r.stop}`,
        });
        continue;
      }
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: why(ra.err, ra.logs, idx(2)) });
    } catch (err) {
      out.remaining.push({ portfolio: p.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
  }

  // ── Resolved-receipt revisit (5e4c15ff rule), after the claimants' closes and the vault LP's 101 ──
  // Dilution comes from ANY claimant whose pot-backed claim is still unreceipted: every portfolio
  // whose receipt is present && !finalized gets a tag 46, or — if 46 is refused — a repeat
  // CloseResolved, EVERY cycle until all are finalised; a portfolio is closed (tag 8) only once its
  // receipt is finalised. Until then the market is not terminal-flat and the seniors' 77 fails with
  // 21. Runs once the vault LP is settled (closed this pass, or no registry-owned portfolio left).
  // Fresh reads each cycle. Escrowed owners are reported: only the holder can sign.
  const lpPending = pfs.some((q) => pdaOwnerKind(q.owner, market, cfg) === "lp-registry") && out.vaultLpClosed.length === 0;
  if (!lpPending) {
    const cands = pfs.filter((q) => pdaOwnerKind(q.owner, market, cfg) !== "lp-registry");
    let infos: Array<{ data: Buffer | Uint8Array } | null> = [];
    try {
      infos = cands.length ? (await getMultipleAccountsInfoChunked(conn, cands.map((q) => q.pubkey), "confirmed")).infos.map((i) => i ?? null) : [];
    } catch {
      infos = [];
    }
    let sends = 0;
    for (let k = 0; k < cands.length; k++) {
      const q = cands[k];
      const info = infos[k];
      if (!info || !receiptOpen(new Uint8Array(info.data))) continue;
      if (pdaOwnerKind(q.owner, market, cfg) === "nft-escrow") {
        out.remaining.push({ portfolio: q.pubkey.toBase58(), reason: "open (partial) resolved receipt on an NFT-escrowed portfolio: the holder must sign tag 46" });
        continue;
      }
      if (sends >= cfg.maxPerCycle) {
        out.remaining.push({ portfolio: q.pubkey.toBase58(), reason: `open resolved receipt: tag-46 sweep over the ${cfg.maxPerCycle}-per-cycle bound; next cycle` });
        continue;
      }
      try {
        // 46 first; if refused, a repeat CloseResolved (both permissionless).
        let t = mk([buildClaimResolvedPayoutTopupIx({ wrapperProgramId: cfg.wrapperProgramId, owner: q.owner, market, portfolio: q.pubkey, collateralMint })]);
        let rt = await sim(t);
        let kind = "46";
        if (rt.err) {
          const t30 = mk([resolvedIx(q)]);
          const r30 = await sim(t30);
          if (r30.err) {
            out.remaining.push({ portfolio: q.pubkey.toBase58(), reason: `open resolved receipt: tag 46 ${why(rt.err, rt.logs, { 1: "ClaimResolvedPayoutTopup" })}; repeat CloseResolved ${why(r30.err, r30.logs, { 1: "CloseResolved" })} — revisit next cycle` });
            continue;
          }
          t = t30; rt = r30; kind = "30";
        }
        sends++;
        if (!(await send(t))) {
          out.remaining.push({ portfolio: q.pubkey.toBase58(), reason: `receipt revisit (${kind}) tx did not land; retry next cycle` });
          continue;
        }
        out.topupSwept.push(q.pubkey.toBase58());
        // Close only once the receipt is finalised (tag 8 refuses otherwise); else revisit next cycle.
        const c8 = mk([closeIx(q)]);
        if (!(await sim(c8)).err && (await send(c8))) {
          out.closed++;
          const at = out.remaining.findIndex((x) => x.portfolio === q.pubkey.toBase58());
          if (at >= 0) out.remaining.splice(at, 1);
        } else {
          out.remaining.push({ portfolio: q.pubkey.toBase58(), reason: `receipt revisited (${kind}), not yet finalised — revisit next cycle` });
        }
      } catch (err) {
        out.remaining.push({ portfolio: q.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
      }
    }
  }
  return out;
}

// ── Late-finalize cleanup (gate-100 finding on bd4fe5f8) ─────────────────────────────────────────
// After ANY late receipt finalize (a tag 46 or a repeat CloseResolved on a Resolved bound market — by
// this keeper, the frontend, or the owner), the portfolio stays MATERIALIZED with capital 0, pnl 0 and
// its receipt finalized. While it exists the market is not terminal-flat: the Resolved 78 harvest is
// skipped and the junior's tag 102 is refused with 21 (EngineLockActive). bd4fe5f8 lets the seniors'
// Resolved 77 ignore receipt-only portfolios, but NOT 102. So every cycle, on every Resolved market
// (stake-bound or not), the keeper closes each such receipt-only portfolio with the permissionless
// tag 8 ([3] = the recorded owner, which receives the rent) — escrowed ones included, with no holder
// grace: the holder has already been paid (bd4fe5f8 pays the proven holder), nothing is left to claim,
// and the NFT program tolerates the closed account on a later burn (nft db4aa09 #131). Then the caller
// re-reads the market and runs 78 once terminal-flat, which unblocks the junior's 102.

/**
 * A portfolio with nothing left to claim and NO OPEN receipt: either its receipt was finalized (late
 * 46 / repeat CloseResolved) or it never got one (a full CloseResolved leaves `present` = 0 — fork
 * rehearsal-33 on bd4fe5f8: both traders sat materialized at cap 0 / pnl 0 / no receipt). Either way
 * it still counts as materialized and only a tag 8 removes it. An OPEN (present && !finalized)
 * receipt is excluded: that is the revisit's job (46 first).
 */
export function isFinalizedReceiptOnly(d: Uint8Array): boolean {
  if (d.length < RESOLVED_RECEIPT_ACCOUNT_OFF_P3 + RESOLVED_RECEIPT_LEN_P3) return false;
  const r = decodeResolvedPayoutReceiptP3(d);
  if (r.open) return false;
  const p = parsePortfolioV17(d);
  return p.capital === 0n && p.pnl === 0n && p.reservedPnl === 0n && p.cancelDepositEscrow === 0n && !p.legs.some((l) => l.active);
}

export interface FinalizedCleanupResult {
  /** Receipt-only portfolios closed by tag 8 this pass. */
  closed: string[];
  /** Receipt-only portfolios that could not be closed this pass (retried next cycle). */
  failed: Array<{ portfolio: string; reason: string }>;
}

/**
 * Close every receipt-only portfolio (receipt present && finalized, empty claim) of `market` with the
 * permissionless tag 8 ([3] = owner). Skips the vault LP (registry-owned: it closes via 101 + 8 in the
 * main cleanup). Bounded by `cfg.maxPerCycle`. Never throws.
 * @param conn    Devnet connection.
 * @param keeper  Fee payer and tag-8 closer.
 * @param market  Resolved market (slab).
 * @param dryRun  Simulate only.
 * @param cfg     Cleanup config (wrapper/nft ids, per-cycle bound, confirm options).
 * @returns The closed and failed portfolios.
 * @example
 * ```ts
 * const r = await closeFinalizedReceiptPortfolios(conn, keeper, market, false, cfg.cleanup!);
 * if (r.closed.length) await crankLpFeesOnce(conn, keeper, market.toBase58(), false);
 * ```
 */
export async function closeFinalizedReceiptPortfolios(
  conn: CleanupConnection,
  keeper: Keypair,
  market: PublicKey,
  dryRun: boolean,
  cfg: CleanupConfig,
): Promise<FinalizedCleanupResult> {
  const out: FinalizedCleanupResult = { closed: [], failed: [] };
  let accs: Awaited<ReturnType<CleanupConnection["getProgramAccounts"]>>;
  try {
    accs = await conn.getProgramAccounts(cfg.wrapperProgramId, {
      filters: [
        { dataSize: await portfolioLenForMarket(conn, market) },
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 16, bytes: market.toBase58() } },
      ],
    });
  } catch (err) {
    out.failed.push({ portfolio: "*", reason: `portfolio discovery failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` });
    return out;
  }
  const targets = accs.filter((a) => {
    const d = new Uint8Array(a.account.data);
    if (!isFinalizedReceiptOnly(d)) return false;
    return pdaOwnerKind(parsePortfolioV17(d).owner, market, cfg) !== "lp-registry";
  });
  if (targets.length === 0) return out;
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"));
  } catch (err) {
    out.failed.push({ portfolio: "*", reason: `blockhash: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}` });
    return out;
  }
  for (const [i, a] of targets.entries()) {
    if (i >= cfg.maxPerCycle) {
      out.failed.push({ portfolio: a.pubkey.toBase58(), reason: `over the ${cfg.maxPerCycle}-per-cycle bound; next cycle` });
      continue;
    }
    try {
      const p = parsePortfolioV17(new Uint8Array(a.account.data));
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
      tx.add(buildClosePortfolioIx({
        wrapperProgramId: cfg.wrapperProgramId, closer: keeper.publicKey, market, portfolio: a.pubkey, owner: p.owner,
        portfolioId: p.portfolioId, expectedSequence: p.matcherSequence, positionEpoch: p.matcherPositionEpoch,
      }));
      tx.recentBlockhash = blockhash;
      tx.feePayer = keeper.publicKey;
      tx.sign(keeper);
      const s = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
      if (s.value.err) {
        out.failed.push({ portfolio: a.pubkey.toBase58(), reason: `tag 8 ${why(s.value.err, s.value.logs ?? null, { 1: "ClosePortfolio" })}` });
        continue;
      }
      if (!dryRun) {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
        const c = await confirmBySignature(conn, sig, blockhash, lastValidBlockHeight, cfg.confirm);
        if (c.status !== "landed") {
          out.failed.push({ portfolio: a.pubkey.toBase58(), reason: "tag 8 did not land; retry next cycle" });
          continue;
        }
      }
      out.closed.push(a.pubkey.toBase58());
    } catch (err) {
      out.failed.push({ portfolio: a.pubkey.toBase58(), reason: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
  }
  return out;
}
