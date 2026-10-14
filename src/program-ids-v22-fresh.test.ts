import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { resolveProgramIds } from "./program-ids.ts";

const FRESH = {
  WRAPPER_PROGRAM_ID: "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM",
  STAKE_PROGRAM_ID: "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V",
  MATCHER_PROGRAM_ID: "AsHvEJ8zNctKmdeS57H5E4w6nkTLi3bPVpd6ZCLc2ayN",
  KEEPER_NFT_PROGRAM_ID: "27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1",
};

describe("v2.2 fresh-ID program set via env (+ KEEPER_NFT_PROGRAM_ID alias)", () => {
  it("resolves all four ids when the override flag is set", () => {
    const ids = resolveProgramIds({ ...FRESH, KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1" });
    assert.equal(ids.wrapper.toBase58(), FRESH.WRAPPER_PROGRAM_ID);
    assert.equal(ids.stake.toBase58(), FRESH.STAKE_PROGRAM_ID);
    assert.equal(ids.matcher.toBase58(), FRESH.MATCHER_PROGRAM_ID);
    assert.equal(ids.nft.toBase58(), FRESH.KEEPER_NFT_PROGRAM_ID);
    assert.equal(ids.source.nft, "env KEEPER_NFT_PROGRAM_ID");
  });
  it("refuses unknown ids without the override flag", () => {
    // The v2.2 fresh set is in the SDK tables since the 343882a repin (it needs no flag any more, see program-ids.ts),
    // so the refusal is asserted with ids the SDK does not know.
    const unknown = { ...FRESH, WRAPPER_PROGRAM_ID: Keypair.generate().publicKey.toBase58() };
    assert.throws(() => resolveProgramIds(unknown), /KEEPER_ALLOW_PROGRAM_ID_OVERRIDE/);
    const known = resolveProgramIds({ ...FRESH });
    assert.equal(known.wrapper.toBase58(), FRESH.WRAPPER_PROGRAM_ID);
  });
  it("refuses a disagreeing NFT_PROGRAM_ID + alias", () => {
    assert.throws(
      () => resolveProgramIds({ ...FRESH, NFT_PROGRAM_ID: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs", KEEPER_ALLOW_PROGRAM_ID_OVERRIDE: "1" }),
      /disagree/,
    );
  });
});
