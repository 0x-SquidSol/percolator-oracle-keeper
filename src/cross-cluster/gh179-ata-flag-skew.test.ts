/**
 * GH#179 — `ataExists` was indexed by POSITION while `pfs` is sorted in place.
 *
 * `resolved-portfolio-cleanup.ts` builds a parallel array of "does this owner have a collateral
 * token account?" flags, then sorts `pfs` in place so the vault LP settles last, then reads the
 * flags back by the POST-sort index. Every portfolio from the LP's original slot onward therefore
 * read its predecessor's flag.
 *
 * Only one direction of that error does damage. A false POSITIVE is harmless, because
 * `buildCreateAtaIdempotentIx` is idempotent. A false NEGATIVE emits no create, so `CloseResolved`
 * names a token account that does not exist — and all three attempt paths in the cleanup loop reuse
 * the same `pre` array, so the portfolio fails every one of them, every cycle. The market's
 * `materialized_portfolio_count` never reaches 0 and tag 41 keeps answering Custom(21), stranding
 * the stakers' terminal insurance.
 *
 * WHY NO EXISTING TEST CAUGHT THIS: this is the K-10 harness with ONE change. K-10's fake RPC
 * returns null from `getMultipleAccountsInfo` for anything that is not one of its three portfolios,
 * so every ATA flag is `false`, every portfolio gets a create, and a misalignment between two
 * uniformly-false arrays is invisible. Here the flags are NOT uniform: the vault LP's owner has a
 * token account and the next portfolio's owner does not.
 *
 * The real CODEC fixtures already have the vault LP at scan index 0, which is exactly the vulnerable
 * shape — no fixture surgery is needed to produce it.
 *
 *   pre-sort  [LP, B, C]   flags [exists(LP), MISSING(B), exists(C)]
 *   post-sort [B, C, LP]   (the LP must settle last)
 *
 * Reading flags by position then pairs B (index 0) with the LP's flag, `exists` — so no create is
 * emitted for the one owner that actually needs it.
 *
 * This test calls the real `cleanupResolvedPortfolios`; it does not reimplement the mapping. A test
 * that replicated the logic would keep passing if the production code were deleted.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/gh179-ata-flag-skew.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { parsePortfolioV17, parseWrapperConfigV17 } from "@percolatorct/sdk";
import { CleanupState, cleanupResolvedPortfolios, ownerAta, pdaOwnerKind } from "./resolved-portfolio-cleanup.ts";
import type { CleanupConfig } from "./resolved-portfolio-cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const NFT = new PublicKey("27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CODEC = new PublicKey("DJM81s8hi5KnozZrgL5MzdJ8sN1mnxBzAY17VBTVkxwU");
const MARKET = fx("v22-codec-market-v19-resolved");
const PFS = [
  { pubkey: new PublicKey("5sx1tsw1uBRh743GtFr1UeeAfAxHUR3mECGGe9dWronA"), data: fx("v22-codec-pf-5sx1tsw1") }, // vault LP, scan index 0
  { pubkey: new PublicKey("5vYAD3RKNjMm8GsV6rLQowDaJZnjt1z5z4tLYLtYowSV"), data: fx("v22-codec-pf-5vYAD3RK") },
  { pubkey: new PublicKey("6UW2ecEZiVR9iVNx8f2gMXrT9QcNP5WhVYto39pFZiaK"), data: fx("v22-codec-pf-6UW2ecEZ") },
];
const CFG: CleanupConfig = { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: 216_000n, probeTtlMs: 3_600_000 };

const MINT = parseWrapperConfigV17(new Uint8Array(MARKET)).collateralMint;
/** Owners, in scan order, derived exactly as production derives them. */
const OWNERS = PFS.map((p) => parsePortfolioV17(new Uint8Array(p.data)).owner);

type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string; encoding?: string } };

/**
 * The K-10 fake RPC, with one change: `getMultipleAccountsInfo` answers the ATA probes
 * NON-uniformly. `missing` names the owners whose token account does not exist; every other
 * owner's does. `ataIxOwners` records the owner of every create-ATA instruction simulated.
 */
function conn(missing: PublicKey[]) {
  const ataIxOwners: string[] = [];
  const missingAtas = missing.map((o) => ownerAta(o, MINT));
  const c = {
    async getAccountInfo(k: PublicKey) {
      if (k.equals(CODEC)) return { data: MARKET, owner: WRAPPER, lamports: 1, executable: false };
      const pf = PFS.find((p) => p.pubkey.equals(k));
      return pf ? { data: pf.data, owner: WRAPPER, lamports: 74_687_760, executable: false } : null;
    },
    async getProgramAccounts(program: PublicKey, o: { filters: Filter[] }) {
      if (!program.equals(WRAPPER)) return [];
      const size = o.filters.find((f) => f.dataSize !== undefined)?.dataSize;
      const mkt = o.filters.find((f) => f.memcmp?.offset === 16)?.memcmp?.bytes;
      return PFS.filter((p) => (size === undefined || p.data.length === size) && (!mkt || new PublicKey(p.data.subarray(16, 48)).toBase58() === mkt)).map((p) => ({
        pubkey: p.pubkey,
        account: { data: p.data, owner: WRAPPER, lamports: 74_687_760, executable: false },
      }));
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => {
        const pf = PFS.find((p) => p.pubkey.equals(k));
        if (pf) return { data: pf.data, owner: WRAPPER, lamports: 74_687_760, executable: false };
        // THE POINT: an owner ATA is present unless it is in `missing`. K-10 returned null here
        // for every key, which is what made the positional skew invisible to it.
        if (missingAtas.some((a) => a.equals(k))) return null;
        if (OWNERS.some((o) => ownerAta(o, MINT).equals(k))) return { data: Buffer.alloc(165), owner: WRAPPER, lamports: 2_039_280, executable: false };
        return null;
      });
    },
    async getLatestBlockhash() { return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      // The ATA program's CreateIdempotent account list is (payer, ata, owner, mint, ...), so the
      // owner is account index 2.
      for (const ix of tx.message.compiledInstructions) {
        if (!tx.message.staticAccountKeys[ix.programIdIndex].equals(ATA_PROGRAM)) continue;
        ataIxOwners.push(tx.message.staticAccountKeys[ix.accountKeyIndexes[2]].toBase58());
      }
      return { context: { slot: 1 }, value: { err: null, logs: [], accounts: null } };
    },
    async sendRawTransaction() { throw new Error("dry-run must not send"); },
    async confirmTransaction() { return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [] }; },
  };
  return { c, ataIxOwners };
}

const run = async (missing: PublicKey[]) => {
  const { c, ataIxOwners } = conn(missing);
  const out = await cleanupResolvedPortfolios(c as never, Keypair.generate(), CODEC, MINT, true, CFG, new CleanupState(), {
    nowSlot: 510_114_691n,
    resolvedSlot: 509_455_455n,
  });
  return { out, ataIxOwners };
};

describe("GH#179: the ATA-presence flags survive the in-place sort", () => {
  it("the fixture is the vulnerable shape: the vault LP is at scan index 0, so the sort moves it", () => {
    assert.equal(pdaOwnerKind(OWNERS[0], CODEC, CFG), "lp-registry", "portfolio 0 must be the vault LP");
    assert.equal(pdaOwnerKind(OWNERS[1], CODEC, CFG), null, "portfolio 1 must be an ordinary trader");
    assert.equal(pdaOwnerKind(OWNERS[2], CODEC, CFG), null, "portfolio 2 must be an ordinary trader");
    assert.equal(new Set(OWNERS.map((o) => o.toBase58())).size, 3, "the three owners must be distinct");
  });

  it("emits a create for the owner with no token account, even though the vault LP sorts past it", async () => {
    // The one owner with no ATA is the portfolio immediately after the LP in scan order — the slot
    // the positional read mis-paired with the LP's own flag.
    const missing = OWNERS[1];
    const { ataIxOwners } = await run([missing]);
    assert.ok(
      ataIxOwners.includes(missing.toBase58()),
      `a CreateIdempotent must be emitted for ${missing.toBase58()}, which has no token account; creates were emitted for ${JSON.stringify(ataIxOwners)}`,
    );
  });

  it("emits no create for owners that already have one (the harmless direction, pinned)", async () => {
    const { ataIxOwners } = await run([OWNERS[1]]);
    for (const present of [OWNERS[0], OWNERS[2]]) {
      assert.ok(
        !ataIxOwners.includes(present.toBase58()),
        `no create should be emitted for ${present.toBase58()}, which already has a token account; got ${JSON.stringify(ataIxOwners)}`,
      );
    }
  });

  it("every TRADER missing an account gets exactly one create, and nobody else does", async () => {
    const { out, ataIxOwners } = await run(OWNERS);
    // The vault LP is deliberately NOT in this list. `pdaOwnerKind(...) === "lp-registry"` takes
    // its own branch and `continue`s before the generic path ever reads `ataExists`
    // (resolved-portfolio-cleanup.ts:710), and the ATA that branch creates is for
    // `vaultLp.state.juniorOwner`, not for the registry PDA. With no vault-LP state bound in this
    // fake it stops even earlier — asserted below so the exclusion is pinned, not assumed.
    assert.deepEqual([...ataIxOwners].sort(), [OWNERS[1], OWNERS[2]].map((o) => o.toBase58()).sort());
    assert.ok(
      out.remaining.some((r) => r.portfolio === PFS[0].pubkey.toBase58() && r.reason.includes("no bound vault-LP state")),
      `the vault LP should stop at the tag-101 precondition, which is why it never reaches the ataExists read; got ${JSON.stringify(out.remaining)}`,
    );
  });

  it("no owner missing an account means no creates at all", async () => {
    const { ataIxOwners } = await run([]);
    assert.deepEqual(ataIxOwners, []);
  });
});
