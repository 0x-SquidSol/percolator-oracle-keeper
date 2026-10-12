/**
 * ADL reduce-only alert (F-3 / R1–R2, ledger f3-market-freeze-triage-2026-09-30.md).
 *
 * Positive control on REAL bytes: every live v18 market (all 19 read on
 * 2026-09-30) and every v18 fixture decodes a_long = a_short = ADL_ONE
 * exactly. An offset error would not land on 1e15. The reduce-only case is a
 * real fixture with a_short patched to the triage's post-ADL value
 * (0.8617·ADL_ONE), because no live market is reduce-only today.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { V17_MARKET_GROUP_LEN, V17_MARKET_GROUP_OFF } from "@percolatorct/sdk";
import { ADL_ONE, adlFraction, decodeAdlState } from "./adl-state.ts";
import { AlertSink, DEFAULT_THRESHOLDS, crankHealthRecord, evaluateCrankHealth, freshStreaks } from "./alerting.ts";
import type { CrankHealthSample } from "./alerting.ts";
import { observeMarket, reportCrankHealth } from "./recovery-cranker.ts";
import { decodeMarketRefreshState } from "./positioned-refresh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const ENGINE0 = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + 1024;
const TRIAGE_A_SHORT = 861_700_000_000_000n; // 0.8617·ADL_ONE, the F-3 repro end state

function writeU128(b: Buffer, off: number, v: bigint): void {
  b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, off);
  b.writeBigUInt64LE(v >> 64n, off + 8);
}
/** ANSEM (real v18 bytes, OI 16,511,677,058 each side) put into the post-ADL state. */
function reduceOnlyAnsem(): Buffer {
  const b = Buffer.from(fx("ansem-market-v18"));
  writeU128(b, ENGINE0 + 65, TRIAGE_A_SHORT);
  return b;
}

describe("decodeAdlState — v18 real bytes", () => {
  for (const f of ["sol-market-v18-fees", "pengu-market-v18-fees", "textit-market-v18-fees", "ansem-market-v18", "murphy-market-v18-lapsed", "collect-market-v18-lapsed"]) {
    it(`${f}: a_long = a_short = ADL_ONE exactly (positive control for +49/+65)`, () => {
      const s = decodeAdlState(new Uint8Array(fx(f)));
      assert.ok(s, "a v18 market decodes");
      assert.equal(s.aLong, ADL_ONE);
      assert.equal(s.aShort, ADL_ONE);
      assert.equal(s.reduceOnly, false);
    });
  }

  it("ANSEM carries matching OI on both sides (the +289/+305 read)", () => {
    const s = decodeAdlState(new Uint8Array(fx("ansem-market-v18")))!;
    assert.equal(s.oiEffLong, 16_511_677_058n);
    assert.equal(s.oiEffShort, 16_511_677_058n);
  });

  it("post-ADL state (a_short = 0.8617·ADL_ONE) is reduce-only", () => {
    const s = decodeAdlState(new Uint8Array(reduceOnlyAnsem()))!;
    assert.equal(s.reduceOnly, true);
    assert.equal(adlFraction(s.aShort), "0.861700");
    assert.equal(s.aLong, ADL_ONE);
  });

  it("a v17 slab is NEVER decoded (it reads 0/0 there, which would look reduce-only)", () => {
    const b = Buffer.from(fx("sol-market-v18-fees"));
    b.writeUInt16LE(17, 8);
    writeU128(b, ENGINE0 + 49, 0n);
    writeU128(b, ENGINE0 + 65, 0n);
    // K-9 (2026-10-12): an unknown-layout market now THROWS (was null); still never decoded.
    assert.throws(() => decodeAdlState(new Uint8Array(b)), /unknown market layout/);
  });

  it("a non-market account kind or wrong magic is refused (null); a short buffer throws (unknown layout)", () => {
    const k = Buffer.from(fx("sol-market-v18-fees"));
    k[10] = 3;
    assert.equal(decodeAdlState(new Uint8Array(k)), null);
    const m = Buffer.from(fx("sol-market-v18-fees"));
    m[0] ^= 0xff;
    assert.equal(decodeAdlState(new Uint8Array(m)), null);
    assert.throws(() => decodeAdlState(new Uint8Array(fx("sol-market-v18-fees").subarray(0, ENGINE0 + 100))), /unknown market layout/);
  });
});

const T = DEFAULT_THRESHOLDS;
function sample(chainSlot: bigint, adl: CrankHealthSample["adl"]): CrankHealthSample {
  return {
    label: "ANSEM", market: "5bVTTMRc", chainSlot, engineSlot: chainSlot - 20n, crankOk: true, crankReverted: false,
    totalOk: 1, totalReverts: 0, consecutiveReverts: 0, lastRevertCode: null, lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0, adl,
  };
}

describe("evaluateCrankHealth — adl-reduce-only (R2 visibility)", () => {
  const ro = decodeAdlState(new Uint8Array(reduceOnlyAnsem()));
  const ok = decodeAdlState(new Uint8Array(fx("ansem-market-v18")));

  it("fires with both sides' OI, the A factors and the observed duration; escalates to critical", () => {
    const t0 = 1_000_000;
    let r = evaluateCrankHealth(sample(500_000_000n, ro), freshStreaks(), T, t0);
    let a = r.active.find((x) => x.kind === "adl-reduce-only")!;
    assert.equal(a.severity, "warn");
    assert.match(a.message, /a_short=0\.861700/);
    assert.match(a.message, /OI long 16511677058 \/ short 16511677058/);
    assert.match(a.message, /abandoned position keeps the market reduce-only \(R2\)/);
    assert.match(a.message, /since keeper boot/, "first-ever sample: the episode predates the keeper");

    r = evaluateCrankHealth(sample(500_000_000n + BigInt(T.adlReduceOnlyCriticalSlots), ro), r.streaks, T, t0 + 3_600_000);
    a = r.active.find((x) => x.kind === "adl-reduce-only")!;
    assert.equal(a.severity, "critical");
    assert.equal(a.data?.reduceOnlySlots, T.adlReduceOnlyCriticalSlots);
    assert.equal(a.data?.reduceOnlyMinutes, 60);
  });

  it("an undecodable read neither alerts nor ends the episode; a healthy read ends it", () => {
    let r = evaluateCrankHealth(sample(100n, ro), freshStreaks(), T, 0);
    r = evaluateCrankHealth(sample(200n, null), r.streaks, T, 1);
    assert.ok(!r.active.some((x) => x.kind === "adl-reduce-only"));
    assert.equal(r.streaks.reduceOnlySince?.slot, 100n, "episode start kept");
    r = evaluateCrankHealth(sample(300n, ok), r.streaks, T, 2);
    assert.equal(r.streaks.reduceOnlySince, null);
  });

  it("an episode that starts while the keeper is watching is not flagged 'since keeper boot'", () => {
    let r = evaluateCrankHealth(sample(100n, ok), freshStreaks(), T, 0);
    r = evaluateCrankHealth(sample(150n, ro), r.streaks, T, 1);
    assert.doesNotMatch(r.active.find((x) => x.kind === "adl-reduce-only")!.message, /since keeper boot/);
  });

  it("a healthy market never raises it", () => {
    assert.ok(!evaluateCrankHealth(sample(1n, ok), freshStreaks(), T, 0).active.some((x) => x.kind === "adl-reduce-only"));
  });

  it("the [health] record carries ro/aL/aS/oiL/oiS only while reduce-only", () => {
    const rec = crankHealthRecord(sample(1n, ro));
    assert.equal(rec.ro, 1);
    assert.equal(rec.aS, "0.861700");
    assert.equal(rec.oiL, "16511677058");
    assert.equal("ro" in crankHealthRecord(sample(1n, ok)), false);
  });
});

describe("recovery cranker wiring: decoded ADL state reaches the sink", () => {
  it("observeMarket (the cranker's own pre-crank decode) carries the ADL state of real bytes", () => {
    const data = new Uint8Array(reduceOnlyAnsem());
    const pre = decodeMarketRefreshState(data);
    const obs = observeMarket(data, pre.currentSlot + 25n, pre, [{ kind: "expire", domain: 1 }]);
    assert.equal(obs.adl?.reduceOnly, true);
    assert.equal(obs.adl?.aShort, TRIAGE_A_SHORT);
    assert.equal(obs.engineSlot, pre.currentSlot);
    assert.equal(obs.lapsedBuckets, 1);
    assert.equal(observeMarket(new Uint8Array(fx("ansem-market-v18")), 1n, null, []).adl?.reduceOnly, false);
  });

  it("reportCrankHealth emits adl-reduce-only for a reduce-only observation", async () => {
    const lines: string[] = [];
    const sink = new AlertSink({ thresholds: T, log: (l) => lines.push(l), logError: (l) => lines.push(l), now: () => 0 });
    const ro = decodeAdlState(new Uint8Array(reduceOnlyAnsem()));
    const states = new Map([["5bVT", {
      obs: { chainSlot: 1000n, engineSlot: 990n, crankOk: true, crankReverted: false, lapsedBuckets: 0, bankruptFound: 0, bankruptLiquidated: 0, adl: ro },
      totalCranks: 1, totalReverts: 0, consecutiveReverts: 0, lastRevertCode: null, streaks: freshStreaks(),
    }]]);
    const active = await reportCrankHealth({ markets: [{ label: "ANSEM", marketAddress: "5bVT" }] } as never, states as never, 3, sink);
    assert.deepEqual(active.map((a) => a.kind), ["adl-reduce-only"]);
    assert.ok(lines.some((l) => l.startsWith("[ALERT]") && l.includes("adl-reduce-only")));
    assert.ok(lines.some((l) => l.startsWith("[health]") && l.includes('"ro":1')));
  });
});
