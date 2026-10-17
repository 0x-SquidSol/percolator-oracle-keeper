/**
 * End-to-end: an env WRAPPER_PROGRAM_ID reaches EVERY instruction builder.
 * node --test runs each file in its own process, so setting env before the
 * dynamic imports below is isolated to this file.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";

const OVERRIDE = "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT"; // any valid key that is NOT the SDK wrapper
const STAKE_OVERRIDE = "CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3";
process.env.WRAPPER_PROGRAM_ID = OVERRIDE;
process.env.STAKE_PROGRAM_ID = STAKE_OVERRIDE;
delete process.env.PROGRAM_ID;
// The override allowlist (fail-closed for unknown ids) is deliberate; this test opts in exactly as run-v22fresh.sh does.
process.env.KEEPER_ALLOW_PROGRAM_ID_OVERRIDE = "1";
process.env.PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE = "1";

describe("WRAPPER_PROGRAM_ID reaches every builder (fresh-ID relaunch = config change)", () => {
  it("auth-mark-pusher, recovery-cranker, positioned-refresh, liveness-repair, stake-fee", async () => {
    const pusher = await import("./cross-cluster/auth-mark-pusher.ts");
    const cranker = await import("./cross-cluster/recovery-cranker.ts");
    const refresh = await import("./cross-cluster/positioned-refresh.ts");
    const repair = await import("./cross-cluster/liveness-repair.ts");
    const stake = await import("./cross-cluster/stake-fee-pusher.ts");
    const k = Keypair.generate().publicKey;
    assert.equal(pusher.WRAPPER_PROGRAM_ID.toBase58(), OVERRIDE);
    assert.equal(cranker.buildCrankIx(k, k, k).programId.toBase58(), OVERRIDE);
    assert.equal(refresh.buildRefreshCrankIx(k, k, k).programId.toBase58(), OVERRIDE);
    assert.equal(repair.buildExpireBackingBucketIx(k, 0).programId.toBase58(), OVERRIDE);
    assert.equal(repair.buildFinalizeResetSideIx(k, 0, 1).programId.toBase58(), OVERRIDE);
    const cfg = stake.stakeFeeConfigFromEnv({});
    assert.equal(cfg.wrapperProgramId.toBase58(), OVERRIDE);
    assert.equal(cfg.stakeProgramId.toBase58(), STAKE_OVERRIDE);
  });
});
