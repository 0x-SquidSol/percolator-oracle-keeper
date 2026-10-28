/**
 * cross-cluster/v22/lev-guard-math.ts
 *
 * Pure maths and filtering for the leverage-guard holder job (wrapper tag 124 op 2 REPORT and op 3 TIGHTEN):
 *
 *   - `cpmmDumpBps`   the program's own integer CPMM dump (`lev_guard_v22::cpmm_dump_bps`): `1 - (R / (R + q))^2`, bps,
 *                     the ratio floored to 1e9 before squaring, so the result is rounded UP. r == 0 is 100 %.
 *   - `holderTerms`   a port of the sim model `ops/sims/v22lev/levmodel.py` `holder_terms` (J = likelihood-weighted dump,
 *                     m_ind = largest individual dump, H = expected dump) with `S_DEFAULT`, `pi_default` and `P_TGT`.
 *                     H9 rule (night 2026-10-28): `m_ind` sizes the dump from the holder's FULL balance (s = 1), exactly as
 *                     the on-chain holder proof does; the partial-sale share `s` stays in J only.
 *   - `filterHolders` drops the accounts that are not an individual holder: the pool's own vaults, anything owned by a known
 *                     program / pool authority / burn address, and any account whose OWNER is a program-owned or off-curve
 *                     (PDA) address. Dropping too much only makes the guard less tight; keeping a pool vault as a "holder"
 *                     would report a dump that no individual can cause, so the filter errs on the dropping side.
 *   - `buildReport`   a REPORT's four fields, every bps field clamped to [0, 10000] and rounded up (tighten-only direction).
 */

export const BPS_MAX = 10_000;
/** Sim `P_TGT`: the dump probability per hour at which a holder is fully weighted. */
export const P_TGT = 0.02;
/** The report's `n_mult_bps` "no multiplier" value and `l_cap_x100` "no cap" value. */
export const N_MULT_NONE_BPS = 10_000;
export const L_CAP_NONE_X100 = 0;

/** `lev_guard_v22::cpmm_dump_bps(r, q)`, bit for bit (u64 inputs, u16 result). */
export function cpmmDumpBps(r: bigint, q: bigint): number {
  if (q <= 0n) return 0;
  if (r <= 0n) return BPS_MAX;
  const den = r + q;
  const ratio = (r * 1_000_000_000n) / den; // floor, <= 1e9
  const keptBps = (ratio * ratio) / 100_000_000_000_000n; // floor(ratio^2 * 1e4 / 1e18)
  return Number(BigInt(BPS_MAX) - keptBps);
}

export type HolderKind = "dev" | "insider" | "bundle" | "sniper" | "early" | "whale" | "top10" | "cex" | "treasury" | "unlock";

export interface Holder {
  kind: HolderKind;
  /** Fraction of total supply. */
  frac: number;
  /** Share sold at once (default `S_DEFAULT[kind]`). */
  s?: number;
  /** Likelihood per hour (default `piDefault`). */
  pi?: number;
  /** Default true. */
  individual?: boolean;
}

export const S_DEFAULT: Readonly<Record<HolderKind, number>> = {
  dev: 1.0, insider: 1.0, bundle: 1.0, sniper: 0.75, early: 0.5, whale: 0.5, top10: 0.5, treasury: 0.25, unlock: 0.25, cex: 0.1,
};

export function piDefault(kind: HolderKind, ageDays: number, inUnlockWindow = false): number {
  if (kind === "dev" || kind === "insider" || kind === "bundle") return ageDays < 7 ? 0.01 : ageDays < 30 ? 0.002 : 0.0005;
  if (kind === "sniper") return ageDays < 1 ? 0.01 : ageDays < 7 ? 0.002 : 0.0005;
  if (kind === "early") return ageDays < 7 ? 0.005 : 0.0005;
  if (kind === "whale") return 0.0005;
  if (kind === "treasury") return 0.0002;
  if (kind === "top10" || kind === "cex") return 0.0001;
  if (kind === "unlock") return inUnlockWindow ? 0.02 : 0.0;
  return 0.0005;
}

/** `holder_terms(holders, X_frac, age_days, in_unlock)` -> J (leverage jump), m_ind (largest individual FULL-balance dump), H (expected dump). All fractions in 0..1. */
export function holderTerms(holders: readonly Holder[], xFrac: number, ageDays: number, inUnlock = false): { J: number; mInd: number; H: number } {
  let J = 0;
  let mInd = 0;
  let H = 0;
  for (const h of holders) {
    const s = h.s ?? S_DEFAULT[h.kind];
    const pi = h.pi ?? piDefault(h.kind, ageDays, inUnlock);
    const m = 1 - (xFrac / (xFrac + s * h.frac)) ** 2;
    const w = Math.min(1.0, pi / P_TGT);
    J = Math.max(J, w * m);
    const individual = h.individual ?? true;
    if (individual && h.kind !== "top10" && h.kind !== "early") {
      // H9: the short-side cap sizes the dump from the holder's FULL balance (s = 1).
      const mFull = 1 - (xFrac / (xFrac + h.frac)) ** 2;
      mInd = Math.max(mInd, mFull);
    }
    H += pi * m;
  }
  return { J, mInd, H };
}

// ── holder filtering ─────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Burn address: tokens sent here cannot be sold. */
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

/** A parsed token account of the base mint (from `getMultipleAccountsInfo`). */
export interface TokenAccountView {
  address: string;
  /** The account's owning PROGRAM (token program expected). */
  programOwner: string;
  mint: string;
  /** The wallet / authority that owns the token account (data[32..64]). */
  owner: string;
  amount: bigint;
  /** 0 uninitialized, 1 initialized, 2 frozen. */
  state: number;
}

/** What the owner address of a token account looks like on chain. */
export interface OwnerView {
  /** ed25519 curve point: an ordinary wallet. False = a program-derived address. */
  onCurve: boolean;
  /** The owner address's own owning program, or null when the account does not exist. */
  accountOwner: string | null;
}

export type DropReason =
  | "pool-vault"
  | "wrong-mint"
  | "not-a-token-account"
  | "not-initialized"
  | "empty"
  | "excluded-owner"
  | "owner-program-owned"
  | "owner-off-curve"
  | "owner-unknown";

export interface FilterInput {
  baseMint: string;
  /** Token accounts that must never count as a holder: the pinned pool base and quote vaults. */
  poolVaults: ReadonlySet<string>;
  /** Owners that are known programs / pool authorities / burn address / our own PDAs. */
  excludedOwners: ReadonlySet<string>;
  /** Owner-address facts, by base58. A missing entry drops the account ("owner-unknown"): we never guess a wallet. */
  owners: ReadonlyMap<string, OwnerView>;
}

export interface CandidateHolder {
  /** Token account (what op 3 takes at `[6]`). */
  address: string;
  owner: string;
  amount: bigint;
}

export interface FilterResult {
  kept: CandidateHolder[];
  dropped: Array<{ address: string; reason: DropReason }>;
}

/** The owners to exclude by identity: the pool's program and authority, the wrapper / stake programs, system / token programs, the burn address. */
export function knownExcludedOwners(extra: Iterable<string>): Set<string> {
  return new Set<string>([SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, INCINERATOR, ...extra]);
}

export function filterHolders(accounts: readonly TokenAccountView[], f: FilterInput): FilterResult {
  const kept: CandidateHolder[] = [];
  const dropped: FilterResult["dropped"] = [];
  for (const a of accounts) {
    const drop = (reason: DropReason): void => void dropped.push({ address: a.address, reason });
    if (f.poolVaults.has(a.address)) drop("pool-vault");
    else if (a.programOwner !== TOKEN_PROGRAM && a.programOwner !== TOKEN_2022_PROGRAM) drop("not-a-token-account");
    else if (a.mint !== f.baseMint) drop("wrong-mint");
    else if (a.state !== 1) drop("not-initialized"); // op 3 refuses a non-initialized holder account (134)
    else if (a.amount <= 0n) drop("empty");
    else if (f.excludedOwners.has(a.owner)) drop("excluded-owner");
    else {
      const o = f.owners.get(a.owner);
      if (!o) drop("owner-unknown");
      else if (o.accountOwner !== null && o.accountOwner !== SYSTEM_PROGRAM) drop("owner-program-owned");
      else if (!o.onCurve) drop("owner-off-curve");
      else kept.push({ address: a.address, owner: a.owner, amount: a.amount });
    }
  }
  return { kept, dropped };
}

/** The holder whose single token account has the largest dump (= the largest balance: the dump is monotone in q). Ties: lower address. */
export function largestHolder(kept: readonly CandidateHolder[]): CandidateHolder | null {
  let best: CandidateHolder | null = null;
  for (const c of kept) {
    if (!best || c.amount > best.amount || (c.amount === best.amount && c.address < best.address)) best = c;
  }
  return best;
}

/** Candidates sorted for op 3 attempts: largest balance first (so a refused first pick falls to the next largest). */
export function holderAttemptOrder(kept: readonly CandidateHolder[]): CandidateHolder[] {
  return [...kept].sort((x, y) => (x.amount === y.amount ? (x.address < y.address ? -1 : 1) : x.amount > y.amount ? -1 : 1));
}

/** One owner's FULL balance across every kept account of that owner (H9: an owner may split a position over several token accounts). */
export function totalsByOwner(kept: readonly CandidateHolder[]): Array<{ owner: string; total: bigint }> {
  const m = new Map<string, bigint>();
  for (const c of kept) m.set(c.owner, (m.get(c.owner) ?? 0n) + c.amount);
  return [...m].map(([owner, total]) => ({ owner, total }));
}

// ── the REPORT ────────────────────────────────────────────────────────────────────────────────

export interface ReportFields {
  jDumpBps: number;
  mIndBps: number;
  lCapX100: number;
  nMultBps: number;
}

/** Integer in [0, 10000]; fractions round UP (a report can only tighten); NaN / +-Infinity -> null (the caller sends no report). */
export function clampBps(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const v = Math.ceil(x - 1e-9);
  return Math.min(BPS_MAX, Math.max(0, v));
}

/**
 * The hourly report. `m_ind` = the largest individual FULL-balance dump among `ownerTotals` (integer CPMM against the pool's base
 * reserve `reserve`); `j_dump` = the holder-model J with every holder treated as kind "whale". No cap, no size multiplier.
 * Returns null when any figure is not finite (no report is better than a wrong one) or `supply` is not positive.
 */
export function buildReport(p: {
  reserve: bigint;
  supply: bigint;
  ownerTotals: ReadonlyArray<{ owner: string; total: bigint }>;
  ageDays: number;
}): ReportFields | null {
  if (p.supply <= 0n || p.reserve < 0n) return null;
  let mInd = 0;
  for (const o of p.ownerTotals) mInd = Math.max(mInd, cpmmDumpBps(p.reserve, o.total));
  const xFrac = Number(p.reserve) / Number(p.supply);
  const holders: Holder[] = p.ownerTotals.map((o) => ({ kind: "whale", frac: Number(o.total) / Number(p.supply) }));
  const { J } = holderTerms(holders, xFrac, p.ageDays);
  const j = clampBps(J * BPS_MAX);
  const m = clampBps(mInd);
  const l = Math.min(0xffff, Math.max(0, L_CAP_NONE_X100));
  const n = clampBps(N_MULT_NONE_BPS);
  if (j === null || m === null || n === null) return null;
  return { jDumpBps: j, mIndBps: m, lCapX100: l, nMultBps: n };
}
