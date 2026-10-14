/**
 * Tag 103 allocation cranks (p2b-allocate.ts): pacing, local eligibility, simulate-first,
 * "never send on a failed simulation", classification of refusals, wallet / dry-run guards.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { deriveBondTrancheV22, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { DEFAULT_ALLOCATE_CONFIG, VaultLpAllocator, allocateConfigFromEnv } from "./p2b-allocate.ts";
import type { AllocateConfig } from "./p2b-allocate.ts";
import { KEEPER, PROGRAM, fakeConn, patchedMarket, registryBytes, snapshot, vaultLpStateBytes } from "./p2b-test-helpers.ts";

const ie = (detail: unknown) => ({ InstructionError: [1, detail] });
const CFG: AllocateConfig = { ...DEFAULT_ALLOCATE_CONFIG, intervalMs: 60_000, jitter: 0.25 };

function boundSnap(o: { outstanding?: bigint; bond?: boolean; registry?: Uint8Array | null; market?: Uint8Array | null; label?: string } = {}) {
  const lp = Keypair.generate().publicKey;
  return snapshot({
    label: o.label ?? "SOL",
    registryData: o.registry === undefined ? registryBytes({ bound: true, bond: o.bond }) : o.registry,
    marketData: o.market === undefined ? patchedMarket() : o.market,
    vaultLpData: vaultLpStateBytes({ lp, outstanding: o.outstanding ?? 0n }),
  });
}

function rig(opts: { cfg?: Partial<AllocateConfig>; sims?: Array<{ err: unknown; logs?: string[] }>; walletLow?: boolean; rand?: () => number; confirmErr?: unknown } = {}) {
  let now = 1_000_000;
  const c = fakeConn({ sims: opts.sims, confirmErr: opts.confirmErr });
  const logs: string[] = [];
  let unsupported = 0;
  const a = new VaultLpAllocator({ ...CFG, ...opts.cfg }, {
    programId: PROGRAM,
    conn: c.conn as never,
    keeper: KEEPER,
    walletLow: () => opts.walletLow ?? false,
    onUnsupported: () => { unsupported++; },
    now: () => now,
    rand: opts.rand ?? (() => 0.5),
    log: (l) => logs.push(l),
    confirm: { statusRetries: 0, statusRetryDelayMs: 1 },
  });
  return { a, c, logs, advance: (ms: number) => { now += ms; }, now: () => now, unsupported: () => unsupported };
}

/** First sight staggers; then wait until due. */
async function firstDue(r: ReturnType<typeof rig>, s: ReturnType<typeof boundSnap>) {
  assert.equal(await r.a.runMarket(s), "not-due", "first sight is staggered, never a burst");
  r.advance(CFG.intervalMs + 1);
}

describe("tag 103: pacing", () => {
  it("a market first seen is staggered across one interval, then paced at interval +-25%", async () => {
    const r = rig({ sims: [{ err: ie({ Custom: 100 }) }], rand: () => 0.5 });
    const s = boundSnap();
    assert.equal(await r.a.runMarket(s), "not-due");
    assert.equal(r.c.count("simulateTransaction"), 0, "no RPC while not due");
    r.advance(30_000); // rand 0.5 * 60_000 = 30_000
    assert.equal(await r.a.runMarket(s), "no-room");
    assert.equal(r.c.count("simulateTransaction"), 1);
    // next attempt: interval * (1 + 0.25 * (0.5*2-1)) = 60_000 exactly with rand 0.5
    r.advance(59_999);
    assert.equal(await r.a.runMarket(s), "not-due");
    r.advance(2);
    assert.equal(await r.a.runMarket(s), "no-room");
  });

  it("jitter spans +-25% of the interval (rand 0 -> 45 s, rand 1 -> 75 s)", async () => {
    for (const [rand, expectMs] of [[0, 45_000], [0.999999, 74_999]] as const) {
      let calls = 0;
      const r = rig({ sims: [{ err: ie({ Custom: 100 }) }], rand: () => (calls++ === 0 ? 0 : rand) });
      const s = boundSnap();
      await r.a.runMarket(s); // staggered with rand 0 -> due immediately
      assert.equal(await r.a.runMarket(s), "no-room");
      r.advance(expectMs - 2);
      assert.equal(await r.a.runMarket(s), "not-due");
      r.advance(4);
      assert.notEqual(await r.a.runMarket(s), "not-due");
    }
  });
});

describe("tag 103: local eligibility costs no RPC", () => {
  const cases: Array<[string, () => ReturnType<typeof boundSnap>]> = [
    ["unbound market", () => boundSnap({ registry: registryBytes({ bound: false }) })],
    ["no registry", () => boundSnap({ registry: null })],
    ["Resolved market", () => boundSnap({ market: patchedMarket({ mode: 1 }) })],
    ["Recovery-mode market", () => boundSnap({ market: patchedMarket({ mode: 2 }) })],
    ["senior draw outstanding", () => boundSnap({ outstanding: 1n })],
  ];
  for (const [name, mk] of cases) {
    it(`${name}: ineligible, no simulation, no send`, async () => {
      const r = rig();
      const s = mk();
      await firstDue(r, s);
      assert.equal(await r.a.runMarket(s), "ineligible");
      assert.equal(r.c.calls.length, 0);
      assert.equal(r.a.stats.ineligible, 1);
    });
  }
});

describe("tag 103: simulate first, send only on a clean simulation", () => {
  it("clean simulation -> sends ONE tx: [compute budget, tag 103 with u128::MAX and 9 accounts]", async () => {
    const r = rig({ sims: [{ err: null }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "sent");
    assert.equal(r.c.sent.length, 1);
    const ix = r.c.sent[0].instructions[1];
    assert.equal(ix.data[0], 103);
    assert.ok(ix.data.subarray(1).every((b) => b === 0xff));
    assert.equal(ix.keys.length, 9);
    assert.ok(ix.keys[1].pubkey.equals(s.market));
    assert.ok(ix.keys[4].pubkey.equals(s.vaultLp!.lpPortfolio), "[4] = the vault LP portfolio");
    assert.equal(r.c.count("simulateTransaction"), 1, "simulated exactly once, before the send");
    assert.deepEqual(r.c.calls.map((c) => c.fn).filter((f) => f === "simulateTransaction" || f === "sendRawTransaction"), ["simulateTransaction", "sendRawTransaction"]);
    assert.equal(r.a.stats.landed, 1);
  });

  it("Custom(100) (no room) in the simulation: counted, NEVER sent, not a failure", async () => {
    const r = rig({ sims: [{ err: ie({ Custom: 100 }) }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "no-room");
    assert.equal(r.c.sent.length, 0);
    assert.equal(r.c.count("sendRawTransaction"), 0);
    assert.equal(r.a.stats.noRoom, 1);
    assert.equal(r.a.stats.failed, 0);
    assert.deepEqual(r.a.activeAlerts(1), [], "no-room never pages");
  });

  it("another program error: counted by code, logged once, never sent", async () => {
    const r = rig({ sims: [{ err: ie({ Custom: 21 }) }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "refused");
    r.advance(CFG.intervalMs * 2);
    assert.equal(await r.a.runMarket(s), "refused");
    assert.equal(r.c.sent.length, 0);
    assert.deepEqual(r.a.stats.refusedCodes, { "21": 2 });
    assert.equal(r.logs.filter((l) => /Custom\(21\)/.test(l)).length, 1, "logged once per (market, code)");
  });

  it("InvalidInstructionData: never sent, and the feature gate is told", async () => {
    const r = rig({ sims: [{ err: ie("InvalidInstructionData") }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "unsupported");
    assert.equal(r.c.sent.length, 0);
    assert.equal(r.unsupported(), 1);
  });

  it("compute exhaustion in the simulation: failed, never sent, says how to fix it", async () => {
    const r = rig({ sims: [{ err: ie("ProgramFailedToComplete"), logs: ["Program ... exceeded CUs meter at BPF instruction"] }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "failed");
    assert.equal(r.c.sent.length, 0);
    assert.ok(r.logs.some((l) => /P2B_ALLOCATE_CU/.test(l)));
  });

  it("an RPC exception during the attempt: failed, never throws, never sends", async () => {
    const r = rig();
    const s = boundSnap();
    r.c.conn.simulateTransaction = async () => { throw new Error("socket hang up"); };
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "failed");
    assert.equal(r.c.sent.length, 0);
  });

  it("a send that lands as Custom(100) (state moved after the sim) is the same benign no-room", async () => {
    const r = rig({ sims: [{ err: null }], confirmErr: ie({ Custom: 100 }) });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "no-room");
    assert.equal(r.c.sent.length, 1);
    assert.equal(r.a.stats.failed, 0);
  });

  it("dry-run simulates but never sends", async () => {
    const r = rig({ cfg: { dryRun: true }, sims: [{ err: null }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "dry-run");
    assert.equal(r.c.sent.length, 0);
    assert.equal(r.c.count("simulateTransaction"), 1);
  });

  it("wallet low: no RPC, no send", async () => {
    const r = rig({ walletLow: true, sims: [{ err: null }] });
    const s = boundSnap();
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "wallet-low");
    assert.equal(r.c.calls.length, 0);
    assert.equal(r.a.stats.walletLow, 1);
  });
});

describe("tag 103: hard failures back off and alert; success clears", () => {
  it("3 consecutive hard failures -> a fee-job-failed warn alert; backoff doubles; a success clears it", async () => {
    const r = rig({ sims: [{ err: ie("InvalidAccountData") }, { err: ie("InvalidAccountData") }, { err: ie("InvalidAccountData") }, { err: null }] });
    const s = boundSnap({ label: "JUP" });
    await firstDue(r, s);
    for (let i = 0; i < 3; i++) {
      assert.equal(await r.a.runMarket(s), "failed");
      r.advance(CFG.intervalMs * 20); // past any backoff (ceiling 10 min)
    }
    const alerts = r.a.activeAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, "fee-job-failed");
    assert.equal(alerts[0].subject, "JUP");
    assert.equal(await r.a.runMarket(s), "sent");
    assert.deepEqual(r.a.activeAlerts(), []);
  });

  it("the backoff ceiling is respected", async () => {
    const r = rig({ sims: [{ err: ie("InvalidAccountData") }], rand: () => 0.5 });
    const s = boundSnap();
    await firstDue(r, s);
    for (let i = 0; i < 8; i++) {
      assert.equal(await r.a.runMarket(s), "failed");
      r.advance(DEFAULT_ALLOCATE_CONFIG.maxBackoffMs + 1);
    }
    assert.equal(await r.a.runMarket(s), "failed", "still retried within the ceiling");
  });
});

describe("allocateConfigFromEnv", () => {
  it("defaults: 60 s, 25% jitter, 600k CU", () => {
    const c = allocateConfigFromEnv({}, false);
    assert.equal(c.intervalMs, 60_000);
    assert.equal(c.jitter, 0.25);
    assert.equal(c.computeUnits, 600_000);
  });
  it("overrides and rejects garbage", () => {
    const c = allocateConfigFromEnv({ P2B_ALLOCATE_INTERVAL_MS: "90000", P2B_ALLOCATE_JITTER_PCT: "10", P2B_ALLOCATE_CU: "700000" }, true);
    assert.deepEqual([c.intervalMs, c.jitter, c.computeUnits, c.dryRun], [90_000, 0.1, 700_000, true]);
    assert.throws(() => allocateConfigFromEnv({ P2B_ALLOCATE_INTERVAL_MS: "5" }, false), /P2B_ALLOCATE_INTERVAL_MS/);
    assert.throws(() => allocateConfigFromEnv({ P2B_ALLOCATE_JITTER_PCT: "95" }, false), /P2B_ALLOCATE_JITTER_PCT/);
  });
});

describe("tag 103: bond tranche account (EARN-10)", () => {
  it("market WITHOUT a bond tranche: exactly the 9 accounts, no tranche", async () => {
    const r = rig({ sims: [{ err: null }] });
    const s = boundSnap({ bond: false });
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "sent");
    const ix = r.c.sent[0].instructions[1];
    assert.equal(ix.keys.length, 9);
    assert.ok(!ix.keys.some((k) => k.pubkey.equals(deriveBondTrancheV22(PROGRAM, s.market)[0])));
  });

  it("market WITH a bond tranche (registry byte 162): 10 accounts, ['bond_tranche', market] read-only at [9]; first 9 unchanged", async () => {
    const rPlain = rig({ sims: [{ err: null }] });
    const plain = boundSnap({ bond: false });
    await firstDue(rPlain, plain);
    await rPlain.a.runMarket(plain);
    const r = rig({ sims: [{ err: null }] });
    const s = boundSnap({ bond: true });
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "sent");
    const ix = r.c.sent[0].instructions[1];
    assert.equal(ix.keys.length, 10);
    const tranche = ix.keys[9];
    assert.ok(tranche.pubkey.equals(deriveBondTrancheV22(PROGRAM, s.market)[0]));
    assert.equal(tranche.isWritable, false);
    assert.equal(tranche.isSigner, false);
    assert.ok(ix.keys[2].pubkey.equals(deriveLpVaultRegistry(PROGRAM, s.market)[0]));
    assert.ok(ix.keys[1].pubkey.equals(s.market));
    assert.ok(ix.keys[4].pubkey.equals(s.vaultLp!.lpPortfolio));
    assert.equal(ix.data.length, 17);
    assert.equal(ix.data[0], 103);
  });

  it("the simulation carries the tranche too (simulate-first sees the same account list)", async () => {
    const r = rig({ sims: [{ err: ie({ Custom: 100 }) }] });
    const s = boundSnap({ bond: true });
    await firstDue(r, s);
    assert.equal(await r.a.runMarket(s), "no-room");
    assert.equal(r.c.count("simulateTransaction"), 1);
  });
});
