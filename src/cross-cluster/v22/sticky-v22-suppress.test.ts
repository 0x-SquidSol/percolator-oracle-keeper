/**
 * The lone vault-LP crank stays suppressed on a v2.2 market across a failed market read. Drives the real V22Loop (both
 * noteLoad callers: the sweep delegate and tick) and the real VaultLpCranker.onPushLanded with the devnet launcher flags.
 * Before the fix, one failed read set layoutNote = "unreadable", isV22 turned false and the next landed push sent a lone
 * LP crank (and the protective round was switched off) until the next good read.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { getSweepDelegate, loneLpCrankSuppressedFor, setBondFeeDelegated, setLoneLpCrankSuppressor, setProtectiveTrigger, setSweepDelegate } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { resetKnownV22Markets } from "./settle-pairing.ts";
import { VaultLpCranker } from "../vault-lp-crank.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { fakeLoopConn, key, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";

const MARKET = key(900);
const M = MARKET.toBase58();
const LP = key(901);
// run-v22fresh.sh; VAULT_LP_LONE_CRANK left at its default (on)
const ENV = { KEEPER_V22: "on", KEEPER_V22_SWEEP: "on", KEEPER_V22_LIQUIDATE: "on", KEEPER_V22_SETTLE_PAIRING: "prefer", KEEPER_V22_FEE_CRANK_BOND: "on", KEEPER_V22_STAKE_SYNC: "on", KEEPER_V22_PUSH_DEPTH: "on" };

afterEach(() => {
  setSweepDelegate(null);
  setLoneLpCrankSuppressor(null);
  setBondFeeDelegated(false);
  setProtectiveTrigger(null);
  setV22HealthProvider(null);
  resetKnownV22Markets();
});

function harness() {
  const o: Record<string, unknown> = { market: v22MarketBytes(), registry: registryBytes({ bound: true, ext: true }), vaultLpState: vaultLpStateBytes(LP) };
  const f = fakeLoopConn(o as never);
  // the cranker's own vault_lp_state lookup
  Object.assign(f.conn, {
    async getMultipleAccountsInfo() {
      return [{ data: Buffer.from(vaultLpStateBytes(LP)), owner: key(1), lamports: 1, executable: false }];
    },
  });
  const entry = { marketAddress: M, label: "T/V22" };
  const loop = new V22Loop({ conn: f.conn as never, keeper: Keypair.generate(), programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv(ENV), dryRun: false, log: () => {} });
  loop.install();
  let triggers = 0;
  setProtectiveTrigger(() => {
    triggers++;
  });
  const cranker = new VaultLpCranker(f.conn as never, Keypair.generate(), { fire: async () => {} } as never, { wrapperProgramId: WRAPPER_PROGRAM_ID, lookupTtlMs: 60_000, settleMs: 0 });
  const sweep = () => getSweepDelegate()!({ conn: f.conn as never, keeper: Keypair.generate(), entry, marketData: v22MarketBytes(), slot: 5000, dryRun: false });
  const loneLpSends = () => f.sent.filter((s) => s.tags.length === 1 && s.keys[0].includes(LP.toBase58())).length;
  const layout = () => (loop.healthFields().markets as Record<string, { layout: string }>)[M]?.layout;
  return { o, loop, cranker, sweep, loneLpSends, layout, triggers: () => triggers };
}

describe("lone vault-LP crank suppression is sticky across a failed market read", () => {
  for (const caller of ["sweep", "tick"] as const) {
    for (const mode of ["throw", "null-market"] as const) {
      it(`${caller}, ${mode}: a push inside the window stays suppressed and triggers the protective round; /health shows the failure`, async () => {
        const h = harness();
        const read = () => (caller === "sweep" ? h.sweep() : h.loop.tick());
        await read();
        assert.equal(loneLpCrankSuppressedFor(M), true);
        assert.equal(h.layout(), "v2.2-b");

        if (mode === "throw") h.o.throwOnRead = true;
        else h.o.market = null;
        await read();
        assert.equal(h.layout(), "unreadable", "/health still reports the failed read");
        assert.equal(loneLpCrankSuppressedFor(M), true);

        const before = h.loneLpSends();
        assert.equal(await h.cranker.onPushLanded(M, 105n), "suppressed");
        assert.equal(await h.cranker.onPushLanded(M, 110n), "suppressed");
        assert.equal(h.loneLpSends() - before, 0, "no lone LP crank sent");
        assert.equal(h.triggers(), 2, "the paired protective round is offered instead");

        h.o.throwOnRead = false;
        h.o.market = v22MarketBytes();
        await read();
        assert.equal(h.layout(), "v2.2-b");
        assert.equal(loneLpCrankSuppressedFor(M), true);
      });
    }
  }

  it("a market never read as v2.2 is not suppressed (unchanged)", async () => {
    const h = harness();
    assert.equal(loneLpCrankSuppressedFor(M), false);
    h.o.throwOnRead = true;
    await h.loop.tick();
    assert.equal(loneLpCrankSuppressedFor(M), false);
  });
});
