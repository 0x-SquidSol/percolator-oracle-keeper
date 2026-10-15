/**
 * cross-cluster/v22/positioned.ts
 *
 * Positioned-portfolio discovery for a v2.2 market (10,603 B portfolios, parsed by the SDK's VERSION-keyed
 * `parsePortfolioV17`): the positioned set with leg counts (for the 3 + legs weight), the LP, the smallest leg per
 * portfolio (dust candidates), and an optional FLAT anchor portfolio (accrue-only crank target).
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { fetchMarketPortfolios } from "../recovery-cranker.ts";
import { riskSnapOf } from "../positioned-refresh.ts";
import type { PositionedPortfolio } from "../positioned-refresh.ts";
import type { V22MarketCtx } from "./market.ts";
import { observationAssetsFor } from "../multi-asset.ts";

export interface V22Positioned {
  /** Every positioned portfolio of the asset (LP included, flagged `isLp`). */
  all: PositionedPortfolio[];
  /** Non-LP positioned portfolios. */
  counterparties: PositionedPortfolio[];
  lp: PositionedPortfolio | null;
  /** Smallest |basis_pos_q| among a portfolio's active legs on the asset, by base58 key. */
  minLegAbs: Map<string, bigint>;
  /**
   * The keeper's OWN zero-leg portfolio of this market (accrue-only target), or an operator-supplied override, or
   * null. NEVER a user's portfolio: a user can fill or close it and grief the round (security review F-4).
   */
  flatAnchor: PublicKey | null;
  /** An operator override that failed the keeper-ownership / flatness check (and was therefore ignored), with the reason. */
  anchorOverrideRejected: string | null;
  /** Raw bytes of the vault LP portfolio when it was in the scan (protection checks). */
  lpData: Uint8Array | null;
  /** Accounts that did not decode (counted, never guessed). */
  undecodable: number;
}

export function analysePortfolios(
  accounts: ReadonlyArray<{ pubkey: PublicKey; data: Uint8Array }>,
  p: {
    assetIndex?: number;
    /** K-6: every observed asset of a multi-asset market (a leg on ANY of them positions the portfolio). Wins over `assetIndex`. */
    assetIndices?: ReadonlyArray<number>;
    lpPortfolio: PublicKey | null;
    portfolioLen: number;
    keeperOwner?: PublicKey | null;
    anchorOverride?: PublicKey | null;
  },
): V22Positioned {
  const assetIndex = p.assetIndex ?? 0;
  const onAsset: (a: number) => boolean = p.assetIndices && p.assetIndices.length > 0 ? (a) => p.assetIndices!.includes(a) : (a) => a === assetIndex;
  const all: PositionedPortfolio[] = [];
  const minLegAbs = new Map<string, bigint>();
  let flatAnchor: PublicKey | null = null;
  let overrideAnchor: PublicKey | null = null;
  let overrideSeen = false;
  let overrideWhy: string | null = null;
  let lpData: Uint8Array | null = null;
  let undecodable = 0;
  for (const { pubkey, data } of accounts) {
    if (data.length !== p.portfolioLen) continue;
    let parsed;
    try {
      parsed = parsePortfolioV17(data);
    } catch {
      undecodable++;
      continue;
    }
    // The LP is EXACTLY the registry's vault LP key. A matcher-enabled portfolio of any other owner is a counterparty:
    // anyone can enable a matcher on their own portfolio, so `matcherEnabled` is not an identity (review F-4).
    const isLp = p.lpPortfolio !== null && pubkey.equals(p.lpPortfolio);
    if (isLp) lpData = data;
    let longLegs = 0;
    let shortLegs = 0;
    let lossWeight = 0n;
    let kfLong: bigint | null = null;
    let kfShort: bigint | null = null;
    let anyActive = false;
    let activeLegs = 0;
    let minAbs: bigint | null = null;
    for (const leg of parsed.legs) {
      if (!leg.active) continue;
      anyActive = true;
      activeLegs++;
      if (!onAsset(leg.assetIndex)) continue;
      lossWeight += leg.lossWeight;
      const abs = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
      if (minAbs === null || abs < minAbs) minAbs = abs;
      if (leg.side === 0) {
        longLegs++;
        kfLong = kfLong === null || leg.kfEpochSnap < kfLong ? leg.kfEpochSnap : kfLong;
      } else {
        shortLegs++;
        kfShort = kfShort === null || leg.kfEpochSnap < kfShort ? leg.kfEpochSnap : kfShort;
      }
    }
    const keeperFlat = !anyActive && !isLp && !parsed.matcherEnabled && !!p.keeperOwner && parsed.owner.equals(p.keeperOwner);
    if (keeperFlat && flatAnchor === null) flatAnchor = pubkey;
    // An operator override passes the SAME check as a discovered anchor: owned by the keeper, flat, not the LP, not a matcher.
    if (p.anchorOverride && pubkey.equals(p.anchorOverride)) {
      overrideSeen = true;
      if (keeperFlat) overrideAnchor = pubkey;
      else overrideWhy = `override ${pubkey.toBase58()} is ${isLp ? "the vault LP" : anyActive ? "not flat" : parsed.matcherEnabled ? "a matcher portfolio" : "not owned by the keeper"}`;
    }
    if (longLegs + shortLegs === 0) continue;
    all.push({ pubkey, longLegs, shortLegs, isLp, activeLegs, lossWeight, kfEpochSnapLong: kfLong, kfEpochSnapShort: kfShort, risk: riskSnapOf(parsed) });
    if (minAbs !== null) minLegAbs.set(pubkey.toBase58(), minAbs);
  }
  let lp: PositionedPortfolio | null = all.find((x) => x.isLp) ?? null;
  // A flat LP (no legs on the asset) is still the LP: it settles at the end of every round.
  if (!lp && p.lpPortfolio) lp = { pubkey: p.lpPortfolio, longLegs: 0, shortLegs: 0, isLp: true, lossWeight: 0n };
  if (p.anchorOverride && !overrideSeen) overrideWhy = `override ${p.anchorOverride.toBase58()} is not a decodable portfolio of this market`;
  // a passing override wins; a failing one is IGNORED (discovery of the keeper's own flat portfolio stays)
  return { all, counterparties: all.filter((x) => !x.isLp), lp, minLegAbs, flatAnchor: overrideAnchor ?? flatAnchor, lpData, anchorOverrideRejected: overrideWhy, undecodable };
}

/** One read: every portfolio of the market at the layout's length. Never throws (returns null). */
export async function loadV22Positioned(
  conn: Connection,
  ctx: V22MarketCtx,
  anchorOverride: PublicKey | null = null,
  keeperOwner: PublicKey | null = null,
): Promise<V22Positioned | null> {
  try {
    const accts = await fetchMarketPortfolios(conn, ctx.market, ctx.layout.portfolioAccountLen);
    const r = analysePortfolios(
      accts.map((a) => ({ pubkey: a.pubkey, data: a.account.data })),
      { lpPortfolio: ctx.lpPortfolio, portfolioLen: ctx.layout.portfolioAccountLen, keeperOwner, anchorOverride, assetIndices: observationAssetsFor(ctx.marketAddress) },
    );
    if (r.anchorOverrideRejected) console.warn(`[v22] ${ctx.label}: KEEPER_V22_ACCRUE_ANCHORS ignored: ${r.anchorOverrideRejected}`);
    return r;
  } catch (err) {
    console.warn(`[v22] ${ctx.label}: positioned-portfolio discovery failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    return null;
  }
}

/** KEEPER_V22_ACCRUE_ANCHORS="market:portfolio,market:portfolio". Malformed pairs are ignored. */
export function parseAccrueAnchors(raw: string | undefined): Map<string, PublicKey> {
  const out = new Map<string, PublicKey>();
  for (const part of (raw ?? "").split(",")) {
    const [m, a] = part.trim().split(":");
    if (!m || !a) continue;
    try {
      out.set(new PublicKey(m).toBase58(), new PublicKey(a));
    } catch {
      // ignore
    }
  }
  return out;
}
