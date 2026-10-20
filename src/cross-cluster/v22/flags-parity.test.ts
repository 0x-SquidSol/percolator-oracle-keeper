import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { V22FlagError, describeV22Flags, pairingActive, v22FlagsFromEnv } from "./flags.ts";
import { bondFeeDelegated, getSweepDelegate, loneLpCrankSuppressedFor, setBondFeeDelegated, setLoneLpCrankSuppressor, setSweepDelegate } from "./delegation.ts";
import { setV22HealthProvider, v22HealthFields } from "./health.ts";
import { V22Loop } from "./loop.ts";
import { VaultLpCranker } from "../vault-lp-crank.ts";
import { layoutProblemFields } from "../keeper-loop.ts";
import { resetRefreshCoordination } from "../refresh-coordination.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";

const reset = () => {
  setSweepDelegate(null);
  setBondFeeDelegated(false);
  setLoneLpCrankSuppressor(null);
  setV22HealthProvider(null);
  resetRefreshCoordination();
};
beforeEach(reset);
afterEach(reset);

describe("flags OFF: no behaviour change", () => {
  it("every v2.2 flag defaults OFF (G9 dry-run defaults ON, the lone LP crank defaults ON = today)", () => {
    const f = v22FlagsFromEnv({});
    assert.equal(f.enabled, false);
    for (const k of ["dryRun", "feeCrankBond", "sweep", "holdingRent", "dustSweep", "g9", "g9AllowAnyOracleMode", "stakeSync", "stakeCommitTarget", "earnExit"] as const) assert.equal(f[k], false, k);
    assert.equal(f.g9DryRun, true);
    assert.equal(f.loneLpCrank, true);
    assert.equal(f.pairing, "prefer");
    assert.equal(pairingActive(f), false, "pairing only acts when the layer AND the sweep are on");
    assert.equal(describeV22Flags(f).enabled, false);
  });

  it("flag parsing: on/off words; G9 real sends need an explicit off", () => {
    const f = v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "1", KEEPER_V22_SETTLE_PAIRING: "strict", KEEPER_V22_G9: "true", KEEPER_V22_G9_DRY_RUN: "off", VAULT_LP_LONE_CRANK: "0", KEEPER_V22_RENT_CADENCE_SLOTS: "123" });
    assert.equal(f.enabled && f.sweep && f.g9, true);
    assert.equal(f.pairing, "strict");
    assert.equal(f.g9DryRun, false);
    assert.equal(f.loneLpCrank, false, "VAULT_LP_LONE_CRANK=0 suppresses (same parser with or without KEEPER_V22)");
    assert.equal(f.rentCadenceSlots, 123);
    assert.equal(pairingActive(f), true);
    for (const w of ["off", "OFF", "0", "false", "no"]) assert.equal(v22FlagsFromEnv({ VAULT_LP_LONE_CRANK: w }).loneLpCrank, false, w);
    for (const w of ["on", "1", "true", "yes", ""]) assert.equal(v22FlagsFromEnv({ VAULT_LP_LONE_CRANK: w }).loneLpCrank, true, w);
  });

  it("STRICT parsing: every unrecognised v2.2 value is a STARTUP ERROR, never a silent default (negative control: the old parser fell back)", () => {
    const bad: Array<Record<string, string>> = [
      { KEEPER_V22_DRY_RUN: "enabled" },
      { KEEPER_V22_DRY_RUN: "dry" },
      { VAULT_LP_LONE_CRANK: "of" },
      { VAULT_LP_LONE_CRANK: "disable" },
      { KEEPER_V22_SETTLE_PAIRING: "strct" },
      { KEEPER_V22_G9_DRAW_CAP_ATOMS: "12x" },
      { KEEPER_V22_G9_DRAW_CAP_ATOMS: "0" },
      { KEEPER_V22_G9_DRAW_CAP_ATOMS: "18446744073709551616" },
      { KEEPER_V22: "yess" },
      { KEEPER_V22_SWEEP: "maybe" },
      { KEEPER_V22_G9_DRY_RUN: "maybe" },
      { KEEPER_V22_TICK_MS: "abc" },
      { KEEPER_V22_RENT_CADENCE_SLOTS: "-5" },
      { KEEPER_V22_STAKE_SYNC_INTERVAL_MS: "1.5" },
    ];
    // KEEPER_V22_* values are validated when the layer is ON; the two always-validated variables throw either way
    for (const env of bad) assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "on", ...env }), (e: unknown) => e instanceof V22FlagError && /Refusing to start/.test((e as Error).message), JSON.stringify(env));
    // N-6: with KEEPER_V22 unset a malformed KEEPER_V22_* value is NOT read (a flags-off live keeper must still boot) ...
    for (const env of bad.filter((e) => !("KEEPER_V22" in e) && !("VAULT_LP_LONE_CRANK" in e))) assert.doesNotThrow(() => v22FlagsFromEnv(env), JSON.stringify(env));
    assert.deepEqual(v22FlagsFromEnv({ KEEPER_V22_SWEEP: "maybe", KEEPER_V22_DRY_RUN: "enabled" }), v22FlagsFromEnv({}), "and they change nothing");
    // ... while the master switch and VAULT_LP_LONE_CRANK are validated regardless
    assert.throws(() => v22FlagsFromEnv({ VAULT_LP_LONE_CRANK: "of" }), V22FlagError);
    assert.throws(() => v22FlagsFromEnv({ KEEPER_V22: "yess" }), V22FlagError);
    // valid values still parse
    assert.doesNotThrow(() => v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_G9_DRAW_CAP_ATOMS: "18446744073709551615", KEEPER_V22_SETTLE_PAIRING: " Strict " }));
    assert.equal(v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SETTLE_PAIRING: " Strict " }).pairing, "strict");
  });

  it("nothing is installed into the legacy paths unless a v2.2 flag installs it", () => {
    assert.equal(getSweepDelegate(), null);
    assert.equal(bondFeeDelegated(), false);
    assert.equal(loneLpCrankSuppressedFor("anyMarket"), false);
    assert.deepEqual(v22HealthFields(), {});
    assert.deepEqual(layoutProblemFields([]), {}, "/health gains no layout key when nothing was refused");
  });

  it("VaultLpCranker.onPushLanded with nothing installed behaves as before (reaches the vault-LP lookup, never 'suppressed')", async () => {
    let lookups = 0;
    const conn = {
      getMultipleAccountsInfo: async () => {
        lookups++;
        return [null];
      },
      getLatestBlockhash: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => "sig",
      getSlot: async () => 1,
    };
    const c = new VaultLpCranker(conn as never, Keypair.generate(), { fire: async () => {} } as never, { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 1000, settleMs: 0 });
    const market = Keypair.generate().publicKey.toBase58();
    assert.equal(await c.onPushLanded(market, 100n), "not-bound");
    assert.equal(lookups, 1);
    assert.equal(c.stats.suppressed, 0);
  });

  it("with the suppressor installed (pairing / VAULT_LP_LONE_CRANK=off) the lone crank returns 'suppressed' and makes NO RPC call", async () => {
    let calls = 0;
    const conn = new Proxy({}, { get: () => async () => { calls++; return [null]; } });
    const c = new VaultLpCranker(conn as never, Keypair.generate(), { fire: async () => {} } as never, { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 1000, settleMs: 0 });
    setLoneLpCrankSuppressor(() => true);
    assert.equal(await c.onPushLanded("m", 100n), "suppressed");
    assert.equal(calls, 0);
    assert.equal(c.stats.suppressed, 1);
    setLoneLpCrankSuppressor((m) => m === "v22market");
    calls = 0;
    assert.equal(await c.onPushLanded(Keypair.generate().publicKey.toBase58(), 101n), "not-bound", "a non-v2.2 market still reaches the normal path");
    assert.ok(calls > 0);
    assert.equal(await c.onPushLanded("v22market", 102n), "suppressed");
  });

  it("V22Loop.install wires only what the flags ask for", () => {
    const base = { conn: {} as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [], dryRun: false, log: () => {} };
    new V22Loop({ ...base, flags: v22FlagsFromEnv({ KEEPER_V22: "on" }) }).install();
    assert.equal(getSweepDelegate(), null, "sweep flag off: no sweep delegate");
    assert.equal(bondFeeDelegated(), false, "bond-fee flag off: the legacy fee job keeps bond markets");
    assert.equal(loneLpCrankSuppressedFor("m"), false, "pairing not active: lone crank stays");
    reset();
    new V22Loop({ ...base, flags: v22FlagsFromEnv({ KEEPER_V22: "on", KEEPER_V22_SWEEP: "on", KEEPER_V22_FEE_CRANK_BOND: "on" }) }).install();
    assert.notEqual(getSweepDelegate(), null);
    assert.equal(bondFeeDelegated(), true);
    assert.deepEqual(Object.keys(v22HealthFields()), ["v22"]);
  });
});
