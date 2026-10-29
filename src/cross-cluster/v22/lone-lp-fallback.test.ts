/**
 * LF (finding #7): a cycle the v2.2 layer declines must never make the legacy cranker settle the vault LP ALONE while the
 * lone LP crank is suppressed (pairing on, or VAULT_LP_LONE_CRANK=off), and the engine clock must still move (F-5).
 * Drives the REAL recovery-cranker `crankOneMarket` with the REAL V22Loop sweep delegate installed; every send is tagged
 * by who sent it (v2.2 layer vs legacy fallback) and decoded (observation crank vs refresh crank, and its target).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { getSweepDelegate, setBondFeeDelegated, setLoneLpCrankSuppressor, setProtectiveTrigger, setSweepDelegate } from "./delegation.ts";
import { setV22HealthProvider } from "./health.ts";
import { resetKnownV22Markets } from "./settle-pairing.ts";
import { pairingStats, resetPairingStats } from "./sweep.ts";
import { resetJobCounters } from "./exec.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { fakeLoopConn, key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";
import { crankOneMarket, freshCrankMarketState } from "../recovery-cranker.ts";
import { buildObservationCrankIx, catchupCrankCount, decodeMarketRefreshState, planCrankTx } from "../positioned-refresh.ts";
import { resetRefreshCoordination } from "../refresh-coordination.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIDE_MODE_RESET_PENDING, livenessOffsetsFor } from "../liveness-repair.ts";
import { detectLayout } from "../market-layout.ts";

const MARKET = key(900);
const LP = key(901);
const ANCHOR = key(902);
const PREFER = { KEEPER_V22: "on", KEEPER_V22_SWEEP: "on", KEEPER_V22_LIQUIDATE: "on", KEEPER_V22_SETTLE_PAIRING: "prefer" };
const OBS_LEN = buildObservationCrankIx(key(1), MARKET, LP).data.length;
const MAX_DT = 150n; // v22MarketBytes

beforeEach(() => {
  resetPairingStats();
  resetJobCounters();
  resetRefreshCoordination();
});
afterEach(() => {
  setSweepDelegate(null);
  setLoneLpCrankSuppressor(null);
  setBondFeeDelegated(false);
  setProtectiveTrigger(null);
  setV22HealthProvider(null);
  resetKnownV22Markets();
});

type Sent = { from: "v22" | "legacy"; ixs: string[] };

function harness(o: { env?: Record<string, string>; cps?: number; anchor?: boolean; noVaultLp?: boolean; marketOpts?: Parameters<typeof v22MarketBytes>[0] } = {}) {
  const mOpts = { oracleMode: 0, legs: 0, currentSlot: 5000n, ...(o.marketOpts ?? {}) };
  const keeper = Keypair.generate();
  const name: Record<string, string> = { [LP.toBase58()]: "LP", [ANCHOR.toBase58()]: "anchor" };
  const cps = Array.from({ length: o.cps ?? 3 }, (_, i) => {
    const pk = key(1000 + i);
    name[pk.toBase58()] = `cp${i}`;
    return { pubkey: pk, data: portfolioBytes({ owner: key(2000 + i), capital: 1_000_000n, legs: [{ side: (i % 2) as 0 | 1, basis: 1_000_000n }] }) };
  });
  const lpData = portfolioBytes({ owner: key(8), capital: 1_000_000n, legs: [{ side: 0, basis: 3_000_000n }], matcher: true });
  const anchor = o.anchor ? [{ pubkey: ANCHOR, data: portfolioBytes({ owner: keeper.publicKey }) }] : [];
  const opts: Record<string, unknown> = {
    market: v22MarketBytes(mOpts),
    registry: registryBytes({ bound: true, ext: true, bond: false }),
    vaultLpState: o.noVaultLp ? null : vaultLpStateBytes(LP),
    portfolios: [...cps, ...anchor, { pubkey: LP, data: lpData }],
    lpAccount: lpData,
  };
  let chainSlot = 6000;
  let bump = 0;
  opts.slot = () => chainSlot + bump; // the sweep's gap check
  opts.landedSlot = () => chainSlot;
  const f = fakeLoopConn(opts as never);
  let who: "v22" | "legacy" = "v22";
  const log: Sent[] = [];
  const realSend = f.conn.sendRawTransaction.bind(f.conn);
  Object.assign(f.conn, {
    async sendRawTransaction(raw: Uint8Array) {
      const t = Transaction.from(Buffer.from(raw));
      const ixs = t.instructions
        .filter((i) => i.programId.equals(WRAPPER_PROGRAM_ID))
        .map((i) => {
          const tgt = i.keys[2]?.pubkey.toBase58() ?? "?";
          const form = i.data[0] === 5 ? (i.data.length === OBS_LEN ? "OBS" : "REF") : `tag${i.data[0]}`;
          return `${form}(${name[tgt] ?? tgt.slice(0, 6)})`;
        });
      log.push({ from: who, ixs });
      return realSend(raw);
    },
  });
  // noVaultLp: no vault_lp_state and no registry hint; the cranker discovers the LP portfolio by scan, the v2.2 layer knows none
  const entry = { marketAddress: MARKET.toBase58(), label: "T/V22", ...(o.noVaultLp ? {} : { lpPortfolio: LP.toBase58() }) };
  const loop = new V22Loop({ conn: f.conn as never, keeper, programId: WRAPPER_PROGRAM_ID, markets: () => [entry], flags: v22FlagsFromEnv(o.env ?? PREFER), dryRun: false, log: () => {} });
  loop.install();
  const real = getSweepDelegate()!;
  const results: Array<boolean | "clock-only"> = [];
  setSweepDelegate(async (a) => {
    who = "v22";
    const r = await real(a);
    results.push(r);
    who = "legacy";
    return r;
  });
  const st = freshCrankMarketState();
  let cycleSlot = Number(mOpts.currentSlot) - 40;
  /** One crank cycle 50 slots after the last. `cranker` = the bytes the cranker's own read sees (default: the v2.2 read's). */
  const cycle = async (cranker?: Uint8Array) => {
    cycleSlot += 50;
    chainSlot = cycleSlot;
    // the market was accrued around the last cycle: keep it inside one window unless the test pinned slotLast
    const fresh = () => v22MarketBytes({ ...mOpts, currentSlot: BigInt(cycleSlot - 10), slotLast: BigInt(cycleSlot - 10) });
    if (o.marketOpts?.slotLast === undefined && opts.market) opts.market = fresh();
    opts.readSlot = cycleSlot;
    const n0 = log.length;
    const r0 = results.length;
    const data = cranker ? (o.marketOpts?.slotLast === undefined ? fresh() : cranker) : (opts.market as Uint8Array);
    await crankOneMarket(f.conn as never, keeper, entry, st, false, { value: { data: Buffer.from(data), owner: key(1), lamports: 1, executable: false, rentEpoch: 0 }, context: { slot: cycleSlot } } as never);
    who = "v22";
    return { delegate: results[r0], sends: log.slice(n0) };
  };
  return { opts, f, loop, cycle, st, setBump: (b: number) => (bump = b) };
}

const fmt = (s: Sent[]) => s.map((x) => `${x.from}:[${x.ixs.join(",")}]`).join(" ");
/** Any send that settles or cranks the LP outside a tx that also carries a counterparty. */
const loneLp = (s: Sent[]) => s.filter((x) => x.ixs.some((i) => i.includes("(LP)")) && !x.ixs.some((i) => /\(cp\d+\)/.test(i)));
const legacy = (s: Sent[]) => s.filter((x) => x.from === "legacy");

describe("LF: a declined v2.2 cycle never settles the vault LP alone while pairing suppresses the lone crank", () => {
  it("control: a good round is handled by the v2.2 layer, the LP settles WITH its counterparties", async () => {
    const h = harness();
    const c = await h.cycle();
    assert.equal(c.delegate, true);
    assert.equal(legacy(c.sends).length, 0);
    assert.equal(loneLp(c.sends).length, 0, fmt(c.sends));
    assert.ok(c.sends.some((x) => x.ixs.includes("OBS(LP)") && x.ixs.some((i) => /\(cp\d+\)/.test(i))));
  });

  const declines: Array<[string, (h: ReturnType<typeof harness>) => Uint8Array | undefined, Parameters<typeof harness>[0]?]> = [
    ["market + registry read throws", (h) => ((h.opts.throwOnRead = true), undefined)],
    ["market not found at the v2.2 read", (h) => ((h.opts.market = null), v22MarketBytes())],
    ["positioned set unreadable (getProgramAccounts 429)", (h) => (Object.assign(h.f.conn, { async getProgramAccounts() { throw new Error("429 Too Many Requests"); } }), undefined)],
    ["no vault LP known to the v2.2 layer (the cranker discovered one)", () => undefined, { noVaultLp: true }],
    ...[0, 1, 4, 5].map((lc) => [`asset 0 lifecycle ${lc} (not Active / DrainOnly)`, () => undefined, { marketOpts: { lifecycle: lc } }] as [string, () => undefined, Parameters<typeof harness>[0]]),
  ];
  for (const [what, breakIt, o] of declines) {
    it(`${what}: "clock-only", the legacy fallback sends nothing inside one window (no lone LP accrual), counted`, async () => {
      const h = harness(o);
      if (!o) await h.cycle(); // a good cycle first: the market is known v2.2
      const cranker = breakIt(h);
      const c = await h.cycle(cranker);
      assert.equal(c.delegate, "clock-only");
      assert.equal(loneLp(c.sends).length, 0, `lone LP crank sent: ${fmt(c.sends)}`);
      assert.equal(legacy(c.sends).length, 0, fmt(c.sends));
      assert.equal(pairingStats.declinedClockOnly, 1);
      assert.equal(pairingStats.unpairedLpSettles, 0);
    });
  }

  it("cold start: the first ever cycle declines (read fails) before the v2.2 layer saw the market: still clock-only", async () => {
    const h = harness();
    h.opts.throwOnRead = true;
    const c = await h.cycle();
    assert.equal(c.delegate, "clock-only");
    assert.equal(loneLp(c.sends).length, 0, fmt(c.sends));
  });

  it("strict pairing: same as prefer", async () => {
    const h = harness({ env: { ...PREFER, KEEPER_V22_SETTLE_PAIRING: "strict" } });
    h.opts.throwOnRead = true;
    const c = await h.cycle();
    assert.equal(c.delegate, "clock-only");
    assert.equal(loneLp(c.sends).length, 0, fmt(c.sends));
  });

  it("the clock still moves on a persistent decline: a window behind, the fallback sends exactly the catch-up cranks (no accrual crank)", async () => {
    for (const windows of [2n, 5n]) {
      const slotLast = 100_000n - MAX_DT * windows - 20n;
      const h = harness({ marketOpts: { currentSlot: 100_000n, slotLast } });
      h.opts.throwOnRead = true;
      const c = await h.cycle(h.opts.market as Uint8Array);
      const want = catchupCrankCount(BigInt(100_000 - 40 + 50) - slotLast, MAX_DT);
      assert.equal(c.delegate, "clock-only");
      assert.equal(legacy(c.sends).length, 1, fmt(c.sends));
      assert.deepEqual(legacy(c.sends)[0].ixs, Array.from({ length: want }, () => "OBS(LP)"), `${windows} windows: catch-up only (${want}), no accrual crank`);
      // and pairing off keeps today's shape: the same catch-up PLUS the accrual crank
      const off = harness({ env: { ...PREFER, KEEPER_V22_SETTLE_PAIRING: "off" }, marketOpts: { currentSlot: 100_000n, slotLast } });
      off.opts.throwOnRead = true;
      const d = await off.cycle(off.opts.market as Uint8Array);
      assert.equal(d.delegate, false);
      assert.equal(legacy(d.sends)[0].ixs.length, want + 1);
    }
  });

  it("planCrankTx accrue:false = repairs + catch-up only (and nothing at all when not behind)", () => {
    const base = { owner: key(1), market: MARKET, lpPortfolio: LP, refreshTargets: [] };
    assert.deepEqual(planCrankTx({ ...base, catchup: 2, accrue: false }).cranks.map((c) => c.kind), ["catchup", "catchup"]);
    assert.deepEqual(planCrankTx({ ...base, catchup: 0, accrue: false }).cranks, []);
    assert.deepEqual(planCrankTx({ ...base, catchup: 2 }).cranks.map((c) => c.kind), ["catchup", "catchup", "accrue"], "default unchanged");
  });

  for (const anchor of [false, true]) {
    it(`gap backoff (positioned set in hand${anchor ? ", keeper anchor" : ""}): the v2.2 layer accrues through ${anchor ? "the anchor" : "a counterparty"}, never the LP; the round resumes after`, async () => {
      const h = harness({ cps: 12, anchor });
      h.setBump(20); // phase 1 lands, the gap check reads 20 slots later: round abandoned
      const r1 = await h.cycle();
      assert.equal(r1.delegate, true);
      const r2 = await h.cycle(); // backoff level 1
      const r3 = await h.cycle(); // round again, gap again
      const r4 = await h.cycle(); // backoff level 2
      const r5 = await h.cycle();
      for (const [i, r] of [r2, r4, r5].entries()) {
        assert.equal(r.delegate, true, `backoff cycle ${i}`);
        assert.equal(legacy(r.sends).length, 0, fmt(r.sends));
        assert.equal(r.sends.length, 1, fmt(r.sends));
        assert.equal(r.sends[0].ixs.length, 1);
        assert.match(r.sends[0].ixs[0], anchor ? /^OBS\(anchor\)$/ : /^OBS\(cp\d+\)$/);
      }
      assert.equal(r3.delegate, true);
      h.setBump(0);
      const r6 = await h.cycle();
      assert.ok(r6.sends.some((x) => x.ixs.includes("OBS(LP)") && x.ixs.some((i) => /\(cp\d+\)/.test(i))), `paired round: ${fmt(r6.sends)}`);
      for (const r of [r1, r2, r3, r4, r5, r6]) assert.equal(loneLp(r.sends).length, 0, fmt(r.sends));
      assert.equal(pairingStats.gapBackoffRounds, 3);
      assert.equal(pairingStats.declinedClockOnly, 0);
    });
  }

  it("pairing off, lone crank on (control): a decline still sends the legacy LP accrual crank (today's shape)", async () => {
    const h = harness({ env: { ...PREFER, KEEPER_V22_SETTLE_PAIRING: "off" } });
    await h.cycle();
    h.opts.throwOnRead = true;
    const c = await h.cycle();
    assert.equal(c.delegate, false);
    assert.deepEqual(legacy(c.sends).map((x) => x.ixs), [["OBS(LP)"]]);
    assert.equal(pairingStats.unpairedLpSettles, 0); // (green on 842f090 too: the shape is unchanged)
  });

  it("pairing off, VAULT_LP_LONE_CRANK=off: the lone crank is suppressed, so a decline is clock-only", async () => {
    const h = harness({ env: { ...PREFER, KEEPER_V22_SETTLE_PAIRING: "off", VAULT_LP_LONE_CRANK: "off" } });
    h.opts.throwOnRead = true;
    const c = await h.cycle();
    assert.equal(c.delegate, "clock-only");
    assert.equal(legacy(c.sends).length, 0, fmt(c.sends));
  });
});

describe("LF: declined-cycle edge cases", () => {
  it("asset 0 in Recovery with its clock frozen: clock-only, the fallback sends the catch-up cranks only (no accrual crank)", async () => {
    // A non-Active asset never accrues, so its slot_last stays behind. The wrapper skips such a hint without accruing it, so
    // these catch-up cranks reach the LP (a Recovery forfeit / refresh from committed state until the LP is current, then
    // Custom(22) in simulation). The asset's price cannot move, so nothing is stranded; the accrual crank stays out.
    const slotLast = 100_000n - MAX_DT * 2n - 20n;
    const h = harness({ marketOpts: { currentSlot: 100_000n, slotLast, lifecycle: 5 } });
    const c = await h.cycle(h.opts.market as Uint8Array);
    const want = catchupCrankCount(BigInt(100_000 - 40 + 50) - slotLast, MAX_DT);
    assert.equal(c.delegate, "clock-only");
    assert.deepEqual(legacy(c.sends).map((x) => x.ixs), [Array.from({ length: want }, () => "OBS(LP)")]);
  });

  it("a refused liveness repair empties a clock-only plan: nothing is sent and the revert streak is kept", async () => {
    const JUP = new Uint8Array(Buffer.from(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "v22-jup2-market-v19.b64"), "utf8").trim(), "base64"));
    const stuck = new Uint8Array(JUP);
    const O = livenessOffsetsFor((detectLayout(JUP) as unknown as { layout: never }).layout)!;
    stuck[O.engineBase + O.modeShort] = SIDE_MODE_RESET_PENDING; // one repair planned, no catch-up due
    const now = Number(decodeMarketRefreshState(stuck).slotLast) + 5;
    let sent = 0;
    const conn = {
      async getProgramAccounts() { return []; },
      async getSlot() { return now; },
      async getLatestBlockhash() { return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }; },
      // refuse the repair while it is in the tx (instruction 1, after the compute-budget one)
      async simulateTransaction(vtx: { message: { compiledInstructions: unknown[] } }) {
        return { context: { slot: now }, value: { err: vtx.message.compiledInstructions.length > 1 ? { InstructionError: [1, { Custom: 6 }] } : null, logs: [], accounts: null } };
      },
      async sendRawTransaction() { sent++; return "sig"; },
    };
    setLoneLpCrankSuppressor(() => true);
    setSweepDelegate(async () => "clock-only");
    const st = freshCrankMarketState();
    st.consecutiveReverts = 3;
    await crankOneMarket(conn as never, Keypair.generate(), { marketAddress: "GtUe5hYy8scuMsp2cmXt7WfCfqKVgTJ8RjuTyvz3MB8B", label: "JUP", lpPortfolio: PublicKey.unique().toBase58() } as never, st, false,
      { value: { data: Buffer.from(stuck), owner: PublicKey.default, lamports: 1, executable: false }, context: { slot: now } } as never);
    assert.equal(sent, 0, "a compute-budget-only tx was sent");
    assert.equal(st.totalCranks, 0);
    assert.equal(st.consecutiveReverts, 3);
  });
});
