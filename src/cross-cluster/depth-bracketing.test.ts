/**
 * SEC-RC L-3: depth bracketing around keeper pushes. Jitter bounds (injected RNG), min-of-samples, a bracketing
 * simulation with the fix, and negative controls showing the same attack succeeds without it.
 * Run with: node --import tsx/esm --test src/cross-cluster/depth-bracketing.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import {
  DEFAULT_DEPTH_MIN_WINDOW_MS,
  DEFAULT_DEPTH_PUSH_JITTER_PCT,
  DepthSampleWindow,
  SLOT_MS,
  bracketWarningLine,
  conservativeReserves,
  depthMinWindowMs,
  depthPushJitterPct,
  jitteredIntervalMs,
  postPushRereadDelayMs,
  recordPostPushReads,
  type RandomIntFn,
} from "./depth-bracketing.ts";
import { plus2PctDepthE6, resolvePushDepth } from "./push-depth.ts";

/** Deterministic RandomIntFn (LCG) honouring the [min, max) contract. */
function seeded(seed: number): RandomIntFn {
  let x = seed >>> 0;
  return (lo, hi) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return lo + (x % (hi - lo));
  };
}

describe("L-3 jitter bounds", () => {
  it("draws from [interval*(1-pct), interval], inclusive at both ends", () => {
    assert.equal(jitteredIntervalMs(7000, 30, (lo) => lo), 4900);
    assert.equal(jitteredIntervalMs(7000, 30, (_lo, hi) => hi - 1), 7000);
    const seen = new Set<number>();
    const rng = seeded(1);
    for (let i = 0; i < 20_000; i++) {
      const v = jitteredIntervalMs(7000, 30, rng);
      assert.ok(v >= 4900 && v <= 7000, `out of bounds: ${v}`);
      seen.add(v < 5950 ? 0 : 1);
    }
    assert.equal(seen.size, 2, "both halves of the range are reached");
  });

  it("never lengthens the cadence, even with an RNG that breaks its contract", () => {
    assert.equal(jitteredIntervalMs(7000, 30, () => 1_000_000), 7000);
    assert.equal(jitteredIntervalMs(7000, 30, () => -5), 4900);
  });

  it("pct is capped at 50 (push rate at most 2x)", () => {
    assert.equal(jitteredIntervalMs(7000, 99, (lo) => lo), 3500);
  });

  it("pct 0 or a non-positive interval leaves the interval unchanged", () => {
    assert.equal(jitteredIntervalMs(7000, 0, () => 0), 7000);
    assert.equal(jitteredIntervalMs(0, 30, () => 0), 0);
  });

  it("the real CSPRNG (crypto.randomInt) stays in bounds", () => {
    for (let i = 0; i < 5_000; i++) {
      const v = jitteredIntervalMs(7000, 30, randomInt);
      assert.ok(v >= 4900 && v <= 7000);
    }
  });

  it("post-push re-read delay is 1-3 slots", () => {
    assert.equal(postPushRereadDelayMs((lo) => lo), 1 * SLOT_MS);
    assert.equal(postPushRereadDelayMs((_lo, hi) => hi - 1), 3 * SLOT_MS);
    assert.equal(postPushRereadDelayMs(() => 99), 3 * SLOT_MS);
  });

  it("source uses crypto.randomInt, never Math.random", () => {
    const src = readFileSync(new URL("./depth-bracketing.ts", import.meta.url), "utf8");
    assert.ok(src.includes('import { randomInt } from "node:crypto"'));
    assert.ok(!/Math\.random/.test(src));
  });
});

describe("L-3 env defaults", () => {
  it("jitter is 0 with depth pushes off (flag-off cadence unchanged)", () => {
    assert.equal(depthPushJitterPct(false, { KEEPER_DEPTH_PUSH_JITTER_PCT: "40" }), 0);
  });
  it("jitter defaults to 30 with depth pushes on; env overrides; junk falls back to the default", () => {
    assert.equal(depthPushJitterPct(true, {}), DEFAULT_DEPTH_PUSH_JITTER_PCT);
    assert.equal(depthPushJitterPct(true, { KEEPER_DEPTH_PUSH_JITTER_PCT: "10" }), 10);
    assert.equal(depthPushJitterPct(true, { KEEPER_DEPTH_PUSH_JITTER_PCT: "0" }), 0);
    assert.equal(depthPushJitterPct(true, { KEEPER_DEPTH_PUSH_JITTER_PCT: "abc" }), DEFAULT_DEPTH_PUSH_JITTER_PCT);
    assert.equal(depthPushJitterPct(true, { KEEPER_DEPTH_PUSH_JITTER_PCT: "75" }), DEFAULT_DEPTH_PUSH_JITTER_PCT);
  });
  it("min window defaults to 30 s", () => {
    assert.equal(depthMinWindowMs({}), DEFAULT_DEPTH_MIN_WINDOW_MS);
    assert.equal(depthMinWindowMs({ KEEPER_DEPTH_MIN_WINDOW_MS: "60000" }), 60_000);
    assert.equal(depthMinWindowMs({ KEEPER_DEPTH_MIN_WINDOW_MS: "5" }), DEFAULT_DEPTH_MIN_WINDOW_MS);
  });
});

describe("L-3 min of samples", () => {
  it("attests the min of the current read and the window", () => {
    const w = new DepthSampleWindow(30_000);
    w.record("P", 1_000n, "post", 0);
    assert.equal(w.conservative("P", 5_000n, 1_000), 1_000n);
    assert.equal(w.conservative("P", 500n, 1_000), 500n, "a lower current read wins");
  });
  it("samples older than the window expire", () => {
    const w = new DepthSampleWindow(30_000);
    w.record("P", 1_000n, "post", 0);
    assert.equal(w.conservative("P", 5_000n, 30_001), 5_000n);
    assert.equal(w.size("P"), 0);
  });
  it("no current read = no depth (never attest from history alone)", () => {
    const w = new DepthSampleWindow(30_000);
    w.record("P", 1_000n, "pre", 0);
    assert.equal(w.conservative("P", undefined, 1), undefined);
  });
  it("conservativeReserves returns a new map and records the pre samples", () => {
    const w = new DepthSampleWindow(30_000);
    const cur = new Map([["P", 9_000n]]);
    w.record("P", 4_000n, "post", 0);
    const out = conservativeReserves(w, cur, 10);
    assert.equal(out.get("P"), 4_000n);
    assert.equal(cur.get("P"), 9_000n, "caller's reads untouched");
    assert.equal(w.lastPre("P", 10), 9_000n);
  });
  it("detects the bracketing signature at the drop threshold and logs a structured line", () => {
    const w = new DepthSampleWindow(30_000, 20);
    w.record("P", 10_000n, "pre", 0);
    assert.deepEqual(recordPostPushReads(w, new Map([["P", 8_100n]]), ["P"], 1), []);
    w.record("P", 10_000n, "pre", 2);
    const sig = recordPostPushReads(w, new Map([["P", 8_000n]]), ["P"], 3);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].dropPct, 20);
    const line = bracketWarningLine(sig[0], "TEST");
    assert.match(line, /^\[keeper\]\[WARN\] depth-bracketing \{/);
    assert.equal(JSON.parse(line.slice(line.indexOf("{"))).event, "depth_bracketing_suspected");
  });
  it("a pool missing from the re-read adds no sample (a flaky read never zeroes depth)", () => {
    const w = new DepthSampleWindow(30_000);
    w.record("P", 10_000n, "pre", 0);
    assert.deepEqual(recordPostPushReads(w, new Map(), ["P"], 1), []);
    assert.equal(w.size("P"), 1);
  });
});

/**
 * Bracketing simulation. Times in ms. Honest reserve LOW; the attacker adds HIGH - LOW just before the push they
 * predict and pulls it right after the push lands (they see the push tx; the keeper's reads are private RPC reads).
 * The attacker predicts the next pre-push read as `last landing - landing lag + interval` (a fixed cadence).
 */
const LOW = 50_000n * 1_000_000n; // $50k quote reserve
const HIGH = 2_000_000n * 1_000_000n; // $2M while bracketing
const INTERVAL = 7_000;
const LAND_LAG = SLOT_MS; // push lands one slot after the pre-push read
const PULL_AFTER_LAND = 200; // attacker pulls inside the slot after landing
const FOUR_HOURS = 4 * 3600 * 1000;

interface SimOpts {
  jitterPct: number;
  minWindow: boolean;
  /** Attacker holds this long after landing (default: pulls immediately). */
  holdAfterLandMs?: number;
  leadMs?: number;
  seed: number;
}

function simulate(o: SimOpts): { attested: bigint[]; highPushes: number } {
  const rng = seeded(o.seed);
  const w = new DepthSampleWindow(DEFAULT_DEPTH_MIN_WINDOW_MS);
  const hold = o.holdAfterLandMs ?? PULL_AFTER_LAND;
  const lead = o.leadMs ?? SLOT_MS;
  const attested: bigint[] = [];
  let t = 0;
  let addAt = Number.POSITIVE_INFINITY; // attacker's add time for the upcoming push
  let removeAt = Number.NEGATIVE_INFINITY;
  // 10 honest cycles before the attack starts (the market exists before the attacker shows up).
  let honestCycles = 10;
  const reserveAt = (x: number): bigint => (honestCycles <= 0 && x >= addAt && x < removeAt ? HIGH : LOW);
  while (t < FOUR_HOURS) {
    // The attacker keeps the liquidity in until `hold` after the push that lands from this read.
    const land = t + LAND_LAG;
    removeAt = land + hold;
    const pre = reserveAt(t);
    const reserve = o.minWindow ? conservativeReserves(w, new Map([["P", pre]]), t).get("P") : pre;
    const depth = resolvePushDepth(true, reserve);
    assert.ok(depth);
    if (honestCycles <= 0) attested.push(depth.depthE6);
    let end = land;
    if (o.minWindow) {
      const reread = land + postPushRereadDelayMs(rng);
      recordPostPushReads(w, new Map([["P", reserveAt(reread)]]), ["P"], reread);
      end = reread;
    }
    const next = t + Math.max(jitteredIntervalMs(INTERVAL, o.jitterPct, rng), end - t);
    // Attacker: predicts the next read on a fixed cadence and adds `lead` before it.
    addAt = land - LAND_LAG + INTERVAL - lead;
    honestCycles--;
    t = next;
  }
  const highD = plus2PctDepthE6(HIGH);
  return { attested, highPushes: attested.filter((d) => d === highD).length };
}

describe("L-3 bracketing simulation (4 h)", () => {
  const honest = plus2PctDepthE6(LOW);
  const bracketed = plus2PctDepthE6(HIGH);

  it("NEGATIVE CONTROL: without the fix, every push attests the bracketed depth", () => {
    const r = simulate({ jitterPct: 0, minWindow: false, seed: 7 });
    assert.ok(r.attested.length > 2000, `${r.attested.length} pushes`);
    assert.equal(r.highPushes, r.attested.length, "bracketing succeeds on every push");
    assert.ok(r.attested.every((d) => d === bracketed));
  });

  for (const seed of [1, 2, 3, 42, 1017]) {
    it(`WITH THE FIX (seed ${seed}): attested depth stays at the un-bracketed level on every push`, () => {
      const r = simulate({ jitterPct: DEFAULT_DEPTH_PUSH_JITTER_PCT, minWindow: true, seed });
      assert.ok(r.attested.length > 2000);
      assert.equal(r.highPushes, 0);
      assert.ok(r.attested.every((d) => d === honest), "every attested depth = the honest depth");
    });
  }

  it("min-of-samples alone catches the basic attacker (pull right after landing)", () => {
    const r = simulate({ jitterPct: 0, minWindow: true, seed: 5 });
    assert.equal(r.highPushes, 0);
  });

  it("CONTROL: min-of-samples alone is beaten by an attacker who outwaits the re-read (why jitter is needed)", () => {
    const r = simulate({ jitterPct: 0, minWindow: true, holdAfterLandMs: 4 * SLOT_MS, seed: 5 });
    // Once the pre-attack honest samples age out of the 30 s window, every push attests the bracketed depth.
    const warm = Math.ceil(DEFAULT_DEPTH_MIN_WINDOW_MS / INTERVAL) + 1;
    assert.ok(r.attested.slice(warm).every((d) => d === bracketed));
  });

  it("jitter + min-of-samples holds against the outwaiting attacker", () => {
    for (const seed of [1, 2, 3, 42, 1017]) {
      const r = simulate({ jitterPct: DEFAULT_DEPTH_PUSH_JITTER_PCT, minWindow: true, holdAfterLandMs: 4 * SLOT_MS, seed });
      // A high push now needs every pre-read in a 30 s window to land in the attacker's 1-slot lead: rare and never
      // sustained, so the on-chain rate limiter (which needs ~4 h of continuous bracketing) never walks.
      assert.ok(r.highPushes / r.attested.length < 0.01, `seed ${seed}: ${r.highPushes}/${r.attested.length}`);
    }
  });
});

describe("L-3 keeper-loop wiring", () => {
  const loop = readFileSync(new URL("./keeper-loop.ts", import.meta.url), "utf8");
  it("mode-1 depth is resolved from the min-of-samples map, not the raw read", () => {
    assert.match(loop, /resolvePushDepth\(pushDepthOn, attestReservesUsdE6\.get\(entry\.poolAddress\)\)/);
    assert.ok(!/resolvePushDepth\(pushDepthOn, quoteReservesUsdE6/.test(loop));
  });
  it("the inter-cycle sleep is jittered (downward only) and the post-push re-read runs after a landed push", () => {
    assert.match(loop, /jitteredIntervalMs\(config\.intervalMs, depthJitterPct\) - elapsed/);
    assert.match(loop, /await rereadDepthAfterPush\(/);
  });
});
