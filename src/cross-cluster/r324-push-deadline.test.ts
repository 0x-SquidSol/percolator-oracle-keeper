/**
 * R3.24 (2026-10-15): swordcat / swordcat-c4 "0 pushes / mark smoother re-priming / critical band pin", and 2xhs asset 2
 * (cbBTC) re-priming forever.
 *
 * Fixtures are the REAL v2.2 bytes read (read-only) on 2026-10-15 ~21:56Z:
 *   swordcat-c4-resolved-v22  68Jqwvd7… Resolved (mode 1, recovery_reason 8 BandPinExpired, resolved_slot 511363489),
 *                             band_pin_since_slot 511175960, band_max_pin_slots 9000, stale window 18000.
 *   swordcat-t-live-v22       7fU9teqR… Live, flat book, not pinned.
 * The "boot" fixture is c4 with ONLY its terminal bytes rolled back (mode/reason/resolved_slot = 0) and
 * last_good_oracle_slot set back to its pre-outage value, i.e. the account as the keeper found it at 13:24:39Z.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectLayout, engineSlotBase } from "./market-layout.ts";
import { V22_ASSET_BAND_OFF } from "./v22/market.ts";
import { bandHealthFor, terminalKindOf } from "./v22/band.ts";
import type { V22MarketCtx } from "./v22/market.ts";
import { createMarkSmoother } from "./mark-smoother.ts";
import {
  DEADLINE_FRESH_MS,
  getPushDeadline,
  isKnownTerminal,
  markTerminal,
  pushDeadlineOf,
  recordPushDeadline,
  refreshPushDeadlines,
  resetPushDeadlines,
} from "./push-deadline.ts";
import { DEFAULT_THRESHOLDS, evaluateBandPinExpiry } from "./alerting.ts";
import type { BandPinSample } from "./alerting.ts";
import {
  PUSH_HELD_MSG,
  bandPinSampleFor,
  deadlineBypass,
  deadlineReadsNeeded,
  isTerminalForPush,
  makeHealthHandler,
  newMarketStat,
  primingMessage,
  samplePoolsForCycle,
  terminalHealthStatus,
} from "./keeper-loop.ts";
import { createWalletBalanceState } from "./wallet-balance-guard.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Uint8Array => new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64"));

const C4 = "68Jqwvd7o5gvsgG9y5d1W4WR141KkhmNNAkhsB5LGkPu";
const SWT = "7fU9teqRPQauqEykmQ9vszXvqu3GMcPXtCsM72LfEwoh";
const POOL = "8ewuF2o8ACro7fqWepZ3tKhkbBjndZU4Ldk9scRPw83d";
const G = 592; // VERSION-19 market group header
const MODE = G + 674;
const REASON = G + 673;
const RESOLVED_SLOT = G + 675;
const LAST_GOOD = 16 + 152;
const PIN_SINCE_C4 = 511_175_960n;
const SLOT_LAST_C4 = 511_176_335n; // the pre-outage engine clock (and, near enough, the last pre-outage push)
const BOOT_SLOT = 511_363_300n; // 13:24:5xZ, the keeper's first cycles after the reboot
const MAX_PIN = 9_000n;

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

/** c4 as the keeper found it at boot: Live, pin and clocks exactly as on chain. */
function c4AtBoot(lastGood: bigint = SLOT_LAST_C4): Uint8Array {
  const d = fx("swordcat-c4-resolved-v22");
  d[MODE] = 0;
  d[REASON] = 0;
  dv(d).setBigUint64(RESOLVED_SLOT, 0n, true);
  dv(d).setBigUint64(LAST_GOOD, lastGood, true);
  return d;
}

function setPin(d: Uint8Array, since: bigint): Uint8Array {
  const det = detectLayout(d);
  assert.ok(det.known);
  dv(d).setBigUint64(engineSlotBase(det.layout, 0) + V22_ASSET_BAND_OFF.pinSinceSlot, since, true);
  return d;
}

afterEach(() => resetPushDeadlines());

describe("R3.24 root cause, from the real bytes", () => {
  it("c4 today: Resolved (BandPinExpired) and decoded as terminal", () => {
    const d = fx("swordcat-c4-resolved-v22");
    assert.equal(d[MODE], 1);
    assert.equal(d[REASON], 8);
    assert.equal(dv(d).getBigUint64(RESOLVED_SLOT, true), 511_363_489n);
    const dl = pushDeadlineOf(d, 511_491_675n);
    assert.ok(dl);
    assert.equal(dl.terminal, "resolved");
    assert.equal(dl.urgent, false);
    assert.equal(terminalKindOf(d), "resolved");
  });

  it("at boot the pin had ALREADY expired ~178k slots earlier: no push timing could have saved it", () => {
    const dl = pushDeadlineOf(c4AtBoot(), BOOT_SLOT);
    assert.ok(dl && dl.pin && dl.stale);
    assert.equal(dl.terminal, null);
    assert.equal(dl.pin.sinceSlot, PIN_SINCE_C4);
    assert.equal(dl.pin.maxPinSlots, MAX_PIN);
    assert.equal(dl.pin.expired, true);
    // expiry slot = since + max_pin + 1; the keeper came back 178k slots after that
    assert.ok(BOOT_SLOT - (PIN_SINCE_C4 + MAX_PIN + 1n) > 170_000n);
    // the stale-resolve window had matured too (cranks refused with OracleStale(27) until a push landed)
    assert.equal(dl.stale.matured, true);
    assert.equal(dl.urgent, true);
    assert.match(dl.urgentReason ?? "", /band pin EXPIRED/);
    assert.match(dl.urgentReason ?? "", /stale-resolve window MATURED/);
  });
});

describe("R3.24 (a) push-deadline urgency", () => {
  it("a pin with <= half its budget left is urgent even with a fresh oracle", () => {
    const read = PIN_SINCE_C4 + 5_000n; // 4,000 of 9,000 left
    const dl = pushDeadlineOf(c4AtBoot(read - 10n), read);
    assert.ok(dl && dl.pin);
    assert.equal(dl.pin.remaining, 4_000n);
    assert.equal(dl.urgent, true);
    assert.match(dl.urgentReason ?? "", /band pin on asset 0 4000\/9000/);
  });

  it("a young pin and a fresh oracle are NOT urgent (the priming gate keeps its anti-manipulation job)", () => {
    const read = PIN_SINCE_C4 + 1_000n;
    const dl = pushDeadlineOf(c4AtBoot(read - 10n), read);
    assert.ok(dl);
    assert.equal(dl.urgent, false);
    assert.equal(dl.urgentReason, null);
  });

  it("an unpinned market becomes urgent only on the stale window (half gone)", () => {
    const fresh = setPin(c4AtBoot(), 0n);
    assert.equal(pushDeadlineOf(fresh, SLOT_LAST_C4 + 8_999n)?.urgent, false);
    assert.equal(pushDeadlineOf(fresh, SLOT_LAST_C4 + 9_000n)?.urgent, true);
    assert.equal(pushDeadlineOf(fresh, SLOT_LAST_C4 + 9_000n)?.pin, null);
  });

  it("swordcat-T (the re-seed) is live, unpinned and not urgent now; after a long outage its stale window makes it urgent", () => {
    const d = fx("swordcat-t-live-v22");
    const lastGood = dv(d).getBigUint64(LAST_GOOD, true);
    const now = pushDeadlineOf(d, lastGood + 100n);
    assert.ok(now);
    assert.equal(now.terminal, null);
    assert.equal(now.pin, null);
    assert.equal(now.urgent, false);
    const afterOutage = pushDeadlineOf(d, lastGood + 187_000n);
    assert.equal(afterOutage?.urgent, true);
  });
});

describe("R3.24 (a) mark smoother: peek / status", () => {
  it("peek returns the median of what the window holds without adding a sample; status says what priming waits for", () => {
    const s = createMarkSmoother({ windowMs: 15_000 });
    assert.equal(s.peek("P"), null);
    assert.equal(s.smooth("P", 2_546n, 0), null);
    assert.equal(s.peek("P"), null); // S3-B6: one read is never a bypass price
    assert.deepEqual(s.status("P"), { samples: 1, spanMs: 0, minSamples: 3, minSpanMs: 12_500 });
    assert.equal(s.smooth("P", 2_550n, 3_000), null);
    assert.equal(s.peek("P"), null); // S3-B6: nor are two
    assert.equal(s.status("P").samples, 2);
    assert.match(primingMessage(s.status("P")), /^mark smoother re-priming — withholding push until minSamples \(window holds 2 sample\(s\) over 3\.0 s; needs 3 over 12\.5 s\)$/);
    assert.equal(s.smooth("P", 2_560n, 6_000), null); // span 6 s < 12.5 s: smooth() still withholds
    assert.equal(s.peek("P"), 2_555n); // 3 reads (minSamples): odd count drops the oldest, average of 2_550 and 2_560
  });

  it("deadlineBypass: only for a Live, urgent market with a window price", () => {
    const urgent = pushDeadlineOf(c4AtBoot(), BOOT_SLOT)!;
    const calm = pushDeadlineOf(c4AtBoot(PIN_SINCE_C4 + 990n), PIN_SINCE_C4 + 1_000n)!;
    assert.deepEqual(deadlineBypass(urgent, 2_546n)?.priceE6, 2_546n);
    assert.equal(deadlineBypass(calm, 2_546n), null);
    assert.equal(deadlineBypass(undefined, 2_546n), null);
    assert.equal(deadlineBypass(urgent, null), null);
    assert.equal(deadlineBypass(pushDeadlineOf(fx("swordcat-c4-resolved-v22"), BOOT_SLOT)!, 2_546n), null);
  });
});

describe("R3.24 (a) replay: boot near/after pin expiry -> a push once minSamples reads are in (S3-B6)", () => {
  // The runCycle decision chain, in runCycle's order, with the real bytes:
  //   cranker boot crank read -> recordPushDeadline; deadlineReadsNeeded; samplePoolsForCycle; smoother withholds;
  //   deadlineBypass(getPushDeadline(…, DEADLINE_FRESH_MS), peek) -> the price that goes into the batch.
  // `reads` = how many cycles' pool reads the window holds when the deadline decision is made (the last one at t0).
  // S3-B6: one read (cycle 0 right after a restart) must never be published, even with the deadline urgent.
  function cycle0(data: Uint8Array, readSlot: bigint, viaPushLoopRead: boolean, reads = 1): Promise<bigint | null> {
    return (async () => {
      const t0 = 1_792_000_000_000;
      const units = [{ key: C4, marketAddress: C4, poolAddress: POOL, source: "pool" as const }];
      if (!viaPushLoopRead) recordPushDeadline(C4, data, readSlot, t0); // the cranker's boot crank got there first
      const need = deadlineReadsNeeded(units, new Set(), new Set(), t0);
      assert.deepEqual(need, viaPushLoopRead ? [C4] : []);
      const conn = {
        async getMultipleAccountsInfoAndContext() {
          return { context: { slot: Number(readSlot) }, value: [{ data: Buffer.from(data) }] };
        },
      };
      await refreshPushDeadlines(conn as never, need, t0);
      const e6 = createMarkSmoother({ windowMs: 15_000 });
      const e12 = createMarkSmoother({ windowMs: 15_000 });
      const smoothed = new Map<string, bigint | null>();
      const smoothedE12 = new Map<string, bigint | null>();
      for (let i = reads - 1; i >= 0; i--) {
        smoothed.clear();
        smoothedE12.clear();
        samplePoolsForCycle(units, () => false, new Map([[POOL, 2_546n]]), new Map(), { e6, e12 }, t0 - i * 5_000, smoothed, smoothedE12, new Set());
      }
      assert.equal(smoothed.get(POOL), null, "the smoother is still priming (span gate)");
      const b = deadlineBypass(getPushDeadline(C4, t0, DEADLINE_FRESH_MS), e6.peek(POOL));
      return b ? b.priceE6 : null;
    })();
  }

  it("S3-B6: deadline known from the cranker's boot read, ONE read: cycle 0 withholds", async () => {
    assert.equal(await cycle0(c4AtBoot(), BOOT_SLOT, false, 1), null);
    assert.equal(await cycle0(c4AtBoot(), BOOT_SLOT, false, 2), null);
  });

  it("deadline known from the cranker's boot read: publishes the pool price once minSamples reads are in", async () => {
    assert.equal(await cycle0(c4AtBoot(), BOOT_SLOT, false, 3), 2_546n);
  });

  it("S3-B6: deadline unknown at cycle 0, the push loop reads it itself, ONE read: withholds", async () => {
    assert.equal(await cycle0(c4AtBoot(), BOOT_SLOT, true, 1), null);
  });

  it("deadline unknown: the push loop reads it itself and publishes once minSamples reads are in", async () => {
    assert.equal(await cycle0(c4AtBoot(), BOOT_SLOT, true, 3), 2_546n);
  });

  it("pin 4,000 slots from expiry (the case a push CAN still help): publishes on the third read, not the first", async () => {
    const read = PIN_SINCE_C4 + 5_000n;
    assert.equal(await cycle0(c4AtBoot(read - 10n), read, false, 1), null);
    assert.equal(await cycle0(c4AtBoot(read - 10n), read, false, 3), 2_546n);
  });

  it("no deadline close: still withholds while priming (unchanged behaviour)", async () => {
    const read = PIN_SINCE_C4 + 1_000n;
    assert.equal(await cycle0(c4AtBoot(read - 10n), read, false, 1), null);
    assert.equal(await cycle0(c4AtBoot(read - 10n), read, false, 3), null);
  });
});

describe("R3.24 cbBTC: a pool whose only market is push-held most cycles still primes", () => {
  it("samplePoolsForCycle feeds the smoother every cycle, whatever the per-unit skips", () => {
    const e6 = createMarkSmoother({ windowMs: 15_000 });
    const e12 = createMarkSmoother({ windowMs: 15_000 });
    const units = [{ marketAddress: "2xhs", poolAddress: "7ubS", source: "pool" as const }];
    const primed = new Set<string>();
    let published = 0;
    for (let c = 0; c < 174; c++) {
      const smoothed = new Map<string, bigint | null>();
      samplePoolsForCycle(units, () => false, new Map([["7ubS", 100_000_000_000n]]), new Map(), { e6, e12 }, c * 3_000, smoothed, new Map(), primed);
      const held = c % 7 !== 0; // live: 25 unheld cycles of 174
      if (!held && smoothed.get("7ubS") !== null) published++;
    }
    assert.ok(primed.has("7ubS"));
    assert.ok(published >= 23, `published on ${published} unheld cycles`);
  });

  it("the OLD order (sample only when the unit is not held) never primes: the failure this fixes", () => {
    const s = createMarkSmoother({ windowMs: 15_000 });
    let published = 0;
    for (let c = 0; c < 174; c++) if (c % 7 === 0 && s.smooth("7ubS", 100_000_000_000n, c * 3_000) !== null) published++;
    assert.equal(published, 0);
  });

  it("a terminal market's pool is not sampled for it; a held market says so on /health", () => {
    const e6 = createMarkSmoother({ windowMs: 15_000 });
    const smoothed = new Map<string, bigint | null>();
    samplePoolsForCycle([{ marketAddress: C4, poolAddress: POOL, source: "pool" }], () => true, new Map([[POOL, 2_546n]]), new Map(), { e6, e12: createMarkSmoother() }, 0, smoothed, new Map(), new Set());
    assert.equal(smoothed.has(POOL), false);
    assert.equal(e6.peek(POOL), null);
    assert.match(PUSH_HELD_MSG, /^push held: /);
  });
});

describe("R3.24 (b) terminal markets", () => {
  it("terminal is sticky and comes from either the pusher (state set) or a market read (cache)", () => {
    const state = { terminalMarkets: new Set<string>() };
    assert.equal(isTerminalForPush(state, C4), false);
    recordPushDeadline(C4, fx("swordcat-c4-resolved-v22"), 511_491_675n);
    assert.equal(isTerminalForPush(state, C4), true);
    assert.ok(state.terminalMarkets.has(C4));
    // a later Live-looking read never un-terminals it (resolution is one-way)
    recordPushDeadline(C4, c4AtBoot(), BOOT_SLOT);
    assert.equal(isKnownTerminal(C4), true);
    assert.equal(terminalHealthStatus(state, C4), "resolved");
    // pusher-only knowledge (B20) before any read
    markTerminal(SWT);
    assert.equal(isTerminalForPush({ terminalMarkets: new Set() }, SWT), true);
    assert.equal(terminalHealthStatus({ terminalMarkets: new Set(["X"]) }, "X"), "terminal");
    // terminal markets need no deadline read
    assert.deepEqual(deadlineReadsNeeded([{ marketAddress: C4, poolAddress: POOL, source: "pool" }], new Set(), new Set(), 0), []);
  });

  it("/health: a Resolved market reads status 'resolved', no lastError, not no-push, keeper not degraded by it", () => {
    recordPushDeadline(C4, fx("swordcat-c4-resolved-v22"), 511_491_675n);
    const row = { marketAddress: C4, label: "swordcat-c4/USDC — pumpswap", poolAddress: POOL, dexType: "pumpswap", assetIndex: 0, symbol: "swordcat-c4" };
    const live = { marketAddress: SWT, label: "swordcat-T/USDC — pumpswap", poolAddress: POOL, dexType: "pumpswap", assetIndex: 0, symbol: "swordcat-T" };
    const sC4 = newMarketStat(row as never);
    sC4.noPushCycles = 500;
    sC4.totalErrors = 5;
    sC4.lastErrorMsg = "mark smoother re-priming — withholding push until minSamples";
    const sT = newMarketStat(live as never);
    sT.lastPushAt = Date.now();
    const state = {
      startedAt: Date.now(),
      lastCycleAt: null,
      cycleCount: 600,
      timeoutCount: 0,
      stats: new Map([[C4, sC4], [SWT, sT]]),
      lastSuccessfulPushAt: Date.now(),
      consecutiveBatchReadFailures: 0,
      lastBatchReadError: null,
      wallet: createWalletBalanceState(),
      cycleAttempted: 0,
      cyclePushed: 0,
      zeroPushStreak: 0,
      terminalMarkets: new Set<string>(),
      landedThisCycle: new Set<string>(),
      tickPublisher: { counters: () => ({ published: 0 }) },
    };
    let body = "";
    const handler = makeHealthHandler(state as never, { intervalMs: 3000, healthPort: 0, healthBind: "127.0.0.1", dryRun: false, minKeeperBalanceLamports: 1, balanceCheckIntervalMs: 1 } as never, { markets: [row, live] } as never);
    handler({ url: "/health" } as never, { writeHead() {}, end(b: string) { body = b; } } as never);
    const p = JSON.parse(body) as { status: string; noPushMarkets: string[]; lossStaleMarkets: string[]; markets: Record<string, { status: string; terminal?: boolean; lastError: string | null }> };
    assert.equal(p.markets[C4].status, "resolved");
    assert.equal(p.markets[C4].terminal, true);
    assert.equal(p.markets[C4].lastError, null);
    assert.deepEqual(p.noPushMarkets, []);
    assert.equal(p.markets[SWT].status, "ok");
    assert.equal(p.status, "ok");
  });

  it("v22 band health: a Resolved market is not pinned and never 'critical'", () => {
    const d = fx("swordcat-c4-resolved-v22");
    const ctx = {
      data: d,
      isBand: true,
      pinDurationSlots: 188_237n,
      band: { pinSinceSlot: PIN_SINCE_C4, maxPinSlots: MAX_PIN, uncertifiedLong: 1n, uncertifiedShort: 0n, liqPendingLong: 0n, liqPendingShort: 0n, maxPositionsPerSide: 256n },
    } as unknown as V22MarketCtx;
    const h = bandHealthFor(ctx);
    assert.equal(h.pinned, false);
    assert.equal(h.pinLevel, "none");
    assert.equal(h.terminal, "resolved");
    // the same bytes Live (boot state): still critical, as before
    const live = bandHealthFor({ ...ctx, data: c4AtBoot() } as V22MarketCtx);
    assert.equal(live.pinLevel, "critical");
    assert.equal(live.terminal, undefined);
  });
});

describe("R3.24 (c) band-pin-expiring alert", () => {
  const pin = (remaining: bigint, expired = false): BandPinSample["pin"] => ({ assetIndex: 0, sinceSlot: PIN_SINCE_C4, durationSlots: MAX_PIN - remaining, maxPinSlots: MAX_PIN, remaining, expired });
  const sample = (p: BandPinSample["pin"], noPushCycles: number, lastPushAt: number | null, terminal = false): BandPinSample => ({ label: "swordcat-c4", market: C4, terminal, pin: p, noPushCycles, lastPushAt });

  it("fires CRITICAL within N slots of expiry when no push has landed", () => {
    const a = evaluateBandPinExpiry(sample(pin(4_000n), 12, null), DEFAULT_THRESHOLDS);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "band-pin-expiring");
    assert.equal(a[0].severity, "critical");
    assert.match(a[0].message, /NO push has landed/);
    assert.match(a[0].message, /A push does not clear a pin/);
  });

  it("WARN when pushes are landing; nothing outside the window; CRITICAL once expired", () => {
    assert.equal(evaluateBandPinExpiry(sample(pin(4_000n), 0, Date.now()), DEFAULT_THRESHOLDS)[0].severity, "warn");
    assert.deepEqual(evaluateBandPinExpiry(sample(pin(4_501n), 50, null), DEFAULT_THRESHOLDS), []);
    assert.deepEqual(evaluateBandPinExpiry(sample(null, 50, null), DEFAULT_THRESHOLDS), []);
    const e = evaluateBandPinExpiry(sample(pin(0n, true), 0, Date.now()), DEFAULT_THRESHOLDS);
    assert.equal(e[0].severity, "critical");
    assert.match(e[0].message, /EXPIRED/);
  });

  it("never for a terminal market, and the sample builder wires the cache + streaks", () => {
    assert.deepEqual(evaluateBandPinExpiry(sample(pin(10n), 500, null, true), DEFAULT_THRESHOLDS), []);
    const read = PIN_SINCE_C4 + 5_000n;
    const now = Date.now();
    recordPushDeadline(C4, c4AtBoot(read - 10n), read, now);
    const row = { marketAddress: C4, label: "swordcat-c4", poolAddress: POOL, dexType: "pumpswap", assetIndex: 0 };
    const st = newMarketStat(row as never);
    st.noPushCycles = 7;
    const s = bandPinSampleFor({ stats: new Map([[C4, st]]), terminalMarkets: new Set() }, { markets: [row as never] }, C4, "swordcat-c4", now);
    assert.equal(s.terminal, false);
    assert.equal(s.pin?.remaining, 4_000n);
    assert.equal(evaluateBandPinExpiry(s, DEFAULT_THRESHOLDS)[0].severity, "critical");
    // once Resolved: no alert
    recordPushDeadline(C4, fx("swordcat-c4-resolved-v22"), 511_491_675n, now);
    const t = bandPinSampleFor({ stats: new Map([[C4, st]]), terminalMarkets: new Set() }, { markets: [row as never] }, C4, "swordcat-c4", now);
    assert.equal(t.terminal, true);
    assert.deepEqual(evaluateBandPinExpiry(t, DEFAULT_THRESHOLDS), []);
  });

  it("threshold is env-tunable (ALERT_BAND_PIN_EXPIRY_SLOTS)", async () => {
    const { thresholdsFromEnv } = await import("./alerting.ts");
    assert.equal(thresholdsFromEnv({}).bandPinExpirySlots, 4_500);
    assert.equal(thresholdsFromEnv({ ALERT_BAND_PIN_EXPIRY_SLOTS: "6000" }).bandPinExpirySlots, 6_000);
  });
});
