/**
 * GH#181 — eight crank alert kinds could not fire for any v2.2 market.
 *
 * A v2.2-owned market (`v2.2-b` layout + a sweep delegate installed) returns from the cranker
 * before `observed` is ever assigned — the v2.2 layer owns its sweep. So `st.obs` stays null,
 * `crankSample` returns null, `reportCrankHealth` does `continue`, and `evaluateCrankHealth` —
 * which has exactly one call site — never runs for that market.
 *
 * The v2.2 layer publishes a full `CrankRefreshHealth` record instead (it even back-fills the ADL
 * state for exactly this reason; see the K-9 note in `v22/loop.ts`). Nothing evaluated it. The
 * state showed on `/health` and alerted nobody. One of the lost alerts is `slot-lag`, which is the
 * condition of incident #133 ("every market frozen, ~82k slots behind").
 *
 * These tests drive the real `reportCrankHealth`. They do not reimplement the adapter.
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/gh181-v22-crank-alerts.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AlertSink, DEFAULT_THRESHOLDS, freshStreaks } from "./alerting.ts";
import { reportCrankHealth, v22CrankSample, V22_HEALTH_MAX_AGE_MS } from "./recovery-cranker.ts";
import { setCrankRefreshHealth, type CrankRefreshHealth } from "./refresh-coordination.ts";

const T = DEFAULT_THRESHOLDS;
const MKT = "FRVP35ujCY5bX4k5e5BWwpsJsiGaBeLZ6K3VckJNemEz";
// The production wiring in `reportCrankHealth` reads the real clock to age the record, so the
// fixture's `updatedAt` has to be on that same clock -- a pinned timestamp reads as stale and
// every record is skipped. (That mistake is why the first run of this suite failed with the fix
// correctly in place.)
const NOW = Date.now();

/** A v2.2-owned market as the cranker leaves it: no observation of its own, ever. */
const v22OwnedState = () => ({
  obs: null,
  totalCranks: 0,
  totalReverts: 0,
  consecutiveReverts: 0,
  lastRevertCode: null,
  streaks: freshStreaks(),
});

/**
 * The record the v2.2 layer publishes. Defaults are a HEALTHY market, so each test turns on
 * exactly the one condition it is about — otherwise a passing assertion proves nothing about
 * which input caused it.
 */
function record(over: Partial<CrankRefreshHealth> = {}): CrankRefreshHealth {
  return {
    staleLong: 0,
    staleShort: 0,
    postStaleLong: 0,
    postStaleShort: 0,
    positioned: 2,
    overflow: 0,
    overflowRefreshed: 0,
    overflowError: null,
    lossStaleCycles: 0,
    status: "ok",
    layout: { id: "v2.2-b", problem: null, kind: "ok", accountLen: 4059, provisional: false, hasPositions: true },
    updatedAt: NOW,
    chainSlot: 513_609_773n,
    engineSlot: 513_609_773n,
    ...over,
  };
}

const run = async (rec: CrankRefreshHealth | null, nowMs = NOW) => {
  const lines: string[] = [];
  const sink = new AlertSink({ thresholds: T, log: (l) => lines.push(l), logError: (l) => lines.push(l), now: () => nowMs });
  if (rec) setCrankRefreshHealth(MKT, rec);
  const states = new Map([[MKT, v22OwnedState()]]);
  const active = await reportCrankHealth({ markets: [{ label: "FRVP", marketAddress: MKT }] } as never, states as never, 3, sink);
  return { active, kinds: active.map((a) => a.kind).sort(), lines };
};

describe("GH#181: a v2.2 market's published health record is evaluated, so its alerts can fire", () => {
  beforeEach(() => {
    // The record store is module-level; clear this market between tests so one test's record
    // cannot satisfy the next one's assertion.
    setCrankRefreshHealth(MKT, record({ updatedAt: 0 }));
  });

  it("slot-lag fires — the #133 condition — from the slot pair in the record", async () => {
    const { kinds, active } = await run(record({ engineSlot: 513_609_773n - 82_000n }));
    assert.ok(kinds.includes("slot-lag"), `expected slot-lag; got ${JSON.stringify(kinds)}`);
    const lag = active.find((a) => a.kind === "slot-lag");
    assert.equal(lag?.severity, "critical", "82,000 slots is past slotLagCritical (450)");
  });

  it("loss-stale fires once the record's streak reaches the threshold", async () => {
    const { kinds } = await run(record({ lossStaleCycles: T.lossStaleCycles, staleLong: 2, status: "loss-stale" }));
    assert.ok(kinds.includes("loss-stale"), `expected loss-stale; got ${JSON.stringify(kinds)}`);
  });

  it("market-layout fires when the record reports an unreadable layout", async () => {
    const { kinds } = await run(
      record({ layout: { id: "unknown", problem: "no layout row matches", kind: "unknown", accountLen: 4059, provisional: false, hasPositions: null } }),
    );
    assert.ok(kinds.includes("market-layout"), `expected market-layout; got ${JSON.stringify(kinds)}`);
  });

  it("adl-reduce-only fires from the ADL state the v2.2 layer back-fills", async () => {
    const { kinds } = await run(
      record({ adl: { reduceOnly: true, aLong: "1000000000000000", aShort: "861700000000000", oiEffLong: "27500000", oiEffShort: "27500000" } }),
    );
    assert.ok(kinds.includes("adl-reduce-only"), `expected adl-reduce-only; got ${JSON.stringify(kinds)}`);
  });

  it("a healthy record produces no alerts at all", async () => {
    const { kinds } = await run(record());
    assert.deepEqual(kinds, []);
  });

  it("the three alerts the record cannot support stay silent rather than guessing", async () => {
    // crank-reverts / lapsed-bucket / bankrupt-unliquidated need counters the v2.2 round does not
    // publish. The adapter fills them with values that cannot trigger them. Pinned so a future
    // change that invents those numbers has to confront this test.
    const { kinds } = await run(record({ lossStaleCycles: T.lossStaleCycles, status: "loss-stale" }));
    for (const k of ["crank-reverts", "lapsed-bucket", "bankrupt-unliquidated"] as const) {
      assert.ok(!kinds.includes(k), `${k} must not fire from a record that carries no such data; got ${JSON.stringify(kinds)}`);
    }
  });

  it("a stale record is not evaluated — frozen numbers must not alert", async () => {
    const stale = record({ lossStaleCycles: 99, engineSlot: 1n, updatedAt: NOW - V22_HEALTH_MAX_AGE_MS - 1 });
    const { kinds } = await run(stale);
    assert.deepEqual(kinds, [], "a record older than V22_HEALTH_MAX_AGE_MS must yield no sample");
  });
});

describe("GH#181: v22CrankSample, directly", () => {
  it("returns null for a missing record and for a stale one", () => {
    assert.equal(v22CrankSample("L", MKT, undefined, NOW), null);
    assert.equal(v22CrankSample("L", MKT, record({ updatedAt: NOW - V22_HEALTH_MAX_AGE_MS - 1 }), NOW), null);
  });

  it("yields no slot-lag verdict for a record written before the slot pair existed", () => {
    const old = record();
    delete old.chainSlot;
    delete old.engineSlot;
    const s = v22CrankSample("L", MKT, old, NOW);
    assert.ok(s, "a record without the slot pair is still worth evaluating for its other fields");
    assert.equal(s.engineSlot, null, "engineSlot null means slotLag() returns null: no verdict, never a wrong one");
  });

  it("fills the unsupported counters with values that cannot trigger their alerts", () => {
    const s = v22CrankSample("L", MKT, record(), NOW);
    assert.ok(s);
    assert.deepEqual(
      { reverts: s.consecutiveReverts, lapsed: s.lapsedBuckets, found: s.bankruptFound, liq: s.bankruptLiquidated },
      { reverts: 0, lapsed: 0, found: 0, liq: 0 },
    );
  });

  it("converts the ADL strings to the bigints the evaluator expects", () => {
    const s = v22CrankSample("L", MKT, record({ adl: { reduceOnly: true, aLong: "12", aShort: "34", oiEffLong: "56", oiEffShort: "78" } }), NOW);
    assert.deepEqual(s?.adl, { reduceOnly: true, aLong: 12n, aShort: 34n, oiEffLong: 56n, oiEffShort: 78n });
  });
});
