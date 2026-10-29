/**
 * #174: the sticky depth cap decays to zero and nothing alerted. Fixtures are the shape the issue read from chain: DEPTH_EVER set, keeper-attested
 * source (0x85), last good reading $1,839.74 (1,839,741,426 e6) at slot 512,014,516, nothing pushed since.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASSET_GROWTH_LEN, DEPTH_EVER, DEPTH_PREV_REAL, DEPTH_SOURCE, decodeAssetGrowthRecordV19 } from "@percolatorct/sdk";
import type { AssetGrowthV19 } from "@percolatorct/sdk";
import { Keypair } from "@solana/web3.js";
import { LAYOUT_V22 } from "@percolatorct/sdk";
import { AlertSink, DEFAULT_THRESHOLDS } from "../alerting.ts";
import { layoutById } from "../market-layout.ts";
import { WRAPPER_PROGRAM_ID } from "../../program-ids.ts";
import { V22Loop } from "./loop.ts";
import { v22FlagsFromEnv } from "./flags.ts";
import { V22_CONFIG_OFF } from "./market.ts";
import { key, portfolioBytes, registryBytes, v22MarketBytes, vaultLpStateBytes } from "./test-helpers.ts";
import { DEFAULT_DEPTH_CAPACITY_THRESHOLDS as T, assessDepthCapacity, depthCapacityAlert, depthCapacityThresholdsFromEnv } from "./depth-capacity.ts";

const BAND = 1_000;
const LAST_GOOD_SLOT = 512_014_516n;
const EPOCH = 9_000n;

function recordBytes(o: { lastGoodE6?: bigint; lastGoodSlot?: bigint; depthE6?: bigint; depthSlot?: bigint; source?: number; ever?: boolean; clamp?: boolean } = {}): Uint8Array {
  const b = new Uint8Array(ASSET_GROWTH_LEN);
  const v = new DataView(b.buffer);
  b[39] = 0x03;
  v.setUint32(16, 30_000, true);
  v.setUint16(20, 500, true);
  v.setUint16(22, 2_000, true);
  v.setUint16(24, 500, true);
  v.setUint16(28, o.clamp === false ? 0 : 3_445, true); // r_gap = G(band 1000): clamp enforced
  b[38] = 1;
  b[44] = (o.source ?? DEPTH_SOURCE.Attested) | (o.ever === false ? 0 : DEPTH_EVER) | DEPTH_PREV_REAL;
  v.setBigUint64(56, o.depthE6 ?? 0n, true);
  v.setBigUint64(64, o.depthSlot ?? 0n, true);
  v.setBigUint64(72, o.depthE6 ?? 0n, true);
  v.setBigUint64(80, o.lastGoodE6 ?? 1_839_741_426n, true);
  v.setBigUint64(88, o.lastGoodSlot ?? LAST_GOOD_SLOT, true);
  b[46] = 7;
  return b;
}
const record = (o: Parameters<typeof recordBytes>[0] = {}): AssetGrowthV19 => decodeAssetGrowthRecordV19(recordBytes(o))!;
const at = (epochs: bigint, extra = 0n) => LAST_GOOD_SLOT + epochs * EPOCH + extra;

describe("#174 assessDepthCapacity", () => {
  it("the issue's shape: ~131 epochs after the last good reading the cap is 0 and the asset is CLOSED", () => {
    const d = assessDepthCapacity(record(), 0, BAND, at(131n));
    assert.equal(d.status, "closed");
    assert.equal(d.capDepthE6, 0n);
    assert.equal(d.stickyEpochs, 131);
  });

  it("the cap really reaches 0 after bitlength(last_good) = 31 epochs, not 64", () => {
    assert.equal(assessDepthCapacity(record(), 0, BAND, at(30n)).capDepthE6, 1n);
    assert.equal(assessDepthCapacity(record(), 0, BAND, at(31n)).capDepthE6, 0n);
    assert.equal(assessDepthCapacity(record(), 0, BAND, at(31n)).status, "closed");
  });

  it("warns BEFORE it closes: decaying with the epochs-to-zero counted down, critical within criticalEpochs", () => {
    const early = assessDepthCapacity(record(), 0, BAND, at(3n));
    assert.deepEqual([early.status, early.stickyEpochs, early.epochsToZero], ["decaying", 3, 28]);
    const a = depthCapacityAlert("M", "mk", early, T, { venue: "meteora-dlmm", keeperAttestsVenue: false });
    assert.equal(a?.severity, "warn");
    assert.match(a?.message ?? "", /does NOT attest depth for this venue/);
    const late = assessDepthCapacity(record(), 0, BAND, at(26n));
    assert.equal(late.epochsToZero, 5);
    assert.equal(depthCapacityAlert("M", "mk", late, T, { keeperAttestsVenue: true })?.severity, "critical");
  });

  it("closed is a critical depth-cap-zero alert that says opens are closed and names the venue class", () => {
    const d = assessDepthCapacity(record(), 0, BAND, at(131n));
    const a = depthCapacityAlert("56pWj8zY", "56pW", d, T, { venue: "pumpswap", keeperAttestsVenue: true });
    assert.deepEqual([a?.kind, a?.severity, a?.subject], ["depth-cap-zero", "critical", "56pWj8zY#0"]);
    assert.match(a?.message ?? "", /OPENS ARE CLOSED/);
    assert.match(a?.message ?? "", /Closes still work/);
  });

  it("no alert: a fresh reading, a market that never had depth, a non-clamp asset, and a young stale cap", () => {
    const fresh = assessDepthCapacity(record({ depthE6: 5_000_000_000n, depthSlot: at(200n) - 10n }), 0, BAND, at(200n));
    assert.equal(fresh.status, "fresh");
    assert.equal(depthCapacityAlert("M", "m", fresh, T, { keeperAttestsVenue: true }), null);
    const never = assessDepthCapacity(record({ ever: false, lastGoodE6: 0n, lastGoodSlot: 0n, source: 0 }), 0, BAND, at(500n));
    assert.deepEqual([never.status, never.capDepthE6], ["uncapped", null]);
    assert.equal(depthCapacityAlert("M", "m", never, T, { keeperAttestsVenue: true }), null);
    assert.equal(assessDepthCapacity(record({ clamp: false }), 0, BAND, at(500n)).status, "no-clamp");
    const young = assessDepthCapacity(record(), 0, BAND, at(1n));
    assert.equal(young.status, "stale");
    assert.equal(depthCapacityAlert("M", "m", young, T, { keeperAttestsVenue: true }), null);
  });

  it("a real fresh zero reading also closes (cap 0 at once)", () => {
    const d = assessDepthCapacity(record({ depthE6: 0n, depthSlot: at(1n) - 5n }), 0, BAND, at(1n));
    assert.deepEqual([d.status, d.capDepthE6], ["closed", 0n]);
  });

  it("thresholds from env: defaults, overrides, garbage throws", () => {
    assert.deepEqual(depthCapacityThresholdsFromEnv({}), T);
    assert.deepEqual(depthCapacityThresholdsFromEnv({ ALERT_DEPTH_STALE_WARN_EPOCHS: "4", ALERT_DEPTH_ZERO_CRITICAL_EPOCHS: "10" }), { staleWarnEpochs: 4, criticalEpochs: 10 });
    assert.throws(() => depthCapacityThresholdsFromEnv({ ALERT_DEPTH_STALE_WARN_EPOCHS: "0" }));
    assert.throws(() => depthCapacityThresholdsFromEnv({ ALERT_DEPTH_ZERO_CRITICAL_EPOCHS: "x" }));
  });

  it("the sink pages the closed alert (critical) and resolves it when depth returns", async () => {
    const sent: string[] = [];
    const sink = new AlertSink({ thresholds: DEFAULT_THRESHOLDS, now: () => 1_000, log: (l) => sent.push(l), logError: (l) => sent.push(l) });
    const d = assessDepthCapacity(record(), 0, BAND, at(131n));
    const a = depthCapacityAlert("M", "m", d, T, { keeperAttestsVenue: true });
    assert.ok(a);
    await sink.reconcile("v22-depth-capacity:critical", [a]);
    assert.equal(sent.some((l) => l.includes("depth-cap-zero") && l.toUpperCase().includes("CRITICAL")), true, sent.join("\n"));
    await sink.reconcile("v22-depth-capacity:critical", []);
    assert.equal(sent.some((l) => l.startsWith("[ALERT-RESOLVED]") && l.includes("depth-cap-zero")), true);
  });
});

// ── V22Loop wiring ───────────────────────────────────────────────────────────

const L = layoutById("v2.2-b");
const MARKET = key(7);
const LP = key(8);

/** A live band market (band 1000 bps; the growth record's r_gap = G(1000) enforces the clamp) carrying the given growth record at asset 0. */
function marketWithGrowth(currentSlot: bigint, rec: Uint8Array): Uint8Array {
  const b = Buffer.from(v22MarketBytes({ band: true, currentSlot }));
  const off = L.groupOff + L.headerLen + LAYOUT_V22.wrapperSlot.growth;
  Buffer.from(rec).copy(b, off);
  b.writeBigUInt64LE(BigInt(BAND), L.groupOff + V22_CONFIG_OFF.bandBps); // r_gap in the fixture record is G(band 1000): clamp enforced
  return new Uint8Array(b);
}

function chain(init: { market: Uint8Array; slot: number }) {
  const st = { ...init };
  const acct = (d: Uint8Array | null) => (d ? { data: Buffer.from(d), owner: key(1), lamports: 1, executable: false } : null);
  const lp = portfolioBytes({ owner: key(9), capital: 1_000_000n, pnl: 0n, legs: [] });
  const conn = {
    async getMultipleAccountsInfoAndContext() {
      return { context: { slot: st.slot }, value: [acct(st.market), acct(registryBytes({ bound: true, ext: true, bond: false })), acct(vaultLpStateBytes(LP, 0n))] };
    },
    async getAccountInfo(pk: { toBase58(): string }) {
      return pk.toBase58() === LP.toBase58() ? acct(lp) : null;
    },
    async getSlot() {
      return st.slot;
    },
  };
  return { st, conn };
}

describe("#174 V22Loop: the closed market pages, the decaying one warns first, a healthy one is silent", () => {
  function loopOn(c: ReturnType<typeof chain>, now: { t: number }, dexType: "pumpswap" | "meteora-dlmm" = "pumpswap") {
    const lines: string[] = [];
    const errs: string[] = [];
    const sink = new AlertSink({ thresholds: { ...DEFAULT_THRESHOLDS }, now: () => now.t, log: (l) => lines.push(l), logError: (l) => errs.push(l) });
    const loop = new V22Loop({
      conn: c.conn as never,
      keeper: Keypair.generate(),
      programId: WRAPPER_PROGRAM_ID,
      markets: () => [{ marketAddress: MARKET.toBase58(), label: "FUND/USDC", dexType }],
      flags: v22FlagsFromEnv({ KEEPER_V22: "on" }),
      dryRun: true,
      alertSink: sink,
      now: () => now.t,
      log: () => {},
    });
    const alerts = () => errs.filter((l) => l.startsWith("[ALERT]") && l.includes("depth-cap-zero"));
    const resolved = () => lines.filter((l) => l.startsWith("[ALERT-RESOLVED]") && l.includes("depth-cap-zero"));
    return { loop, alerts, resolved };
  }

  it("warn while decaying, critical + health once closed, RESOLVED when a fresh depth is pushed", async () => {
    const now = { t: 1_000_000 };
    const rec = recordBytes();
    const c = chain({ market: marketWithGrowth(at(3n), rec), slot: Number(at(3n)) });
    const h = loopOn(c, now);
    await h.loop.tick();
    assert.equal(h.alerts().length, 1, "3 halvings with no fresh reading: warn");
    assert.match(h.alerts()[0], /"severity":"warn"/);

    c.st.slot = Number(at(131n));
    c.st.market = marketWithGrowth(at(131n), rec);
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.alerts().length, 2, "closed: the escalation pages at once");
    assert.match(h.alerts()[1], /"severity":"critical"/);
    assert.match(h.alerts()[1], /OPENS ARE CLOSED/);
    const health = h.loop.healthFields() as { markets: Record<string, { depthCapacity?: Array<{ status: string; capDepthE6: string; stickyEpochs: number }> }> };
    const dc = health.markets[MARKET.toBase58()].depthCapacity;
    assert.deepEqual([dc?.[0].status, dc?.[0].capDepthE6, dc?.[0].stickyEpochs], ["closed", "0", 131]);

    // a fresh depth push lands: reading at the current slot
    const fresh = recordBytes({ depthE6: 5_000_000_000n, depthSlot: at(140n) - 5n, lastGoodE6: 5_000_000_000n, lastGoodSlot: at(140n) - 5n });
    c.st.slot = Number(at(140n));
    c.st.market = marketWithGrowth(at(140n), fresh);
    now.t += 20_000;
    await h.loop.tick();
    assert.equal(h.resolved().length >= 1, true, "alert resolves once depth is fresh");
  });

  it("NEGATIVE CONTROL: a fresh, a never-had-depth and a non-clamp market never alert", async () => {
    for (const rec of [
      recordBytes({ depthE6: 5_000_000_000n, depthSlot: at(200n) - 5n, lastGoodE6: 5_000_000_000n, lastGoodSlot: at(200n) - 5n }),
      recordBytes({ ever: false, lastGoodE6: 0n, lastGoodSlot: 0n, source: 0 }),
      recordBytes({ clamp: false }),
    ]) {
      const now = { t: 1_000_000 };
      const c = chain({ market: marketWithGrowth(at(200n), rec), slot: Number(at(200n)) });
      const h = loopOn(c, now);
      await h.loop.tick();
      assert.equal(h.alerts().length, 0);
    }
  });

  it("a non-CPMM venue's alert says the keeper cannot attest it", async () => {
    const now = { t: 1_000_000 };
    const c = chain({ market: marketWithGrowth(at(131n), recordBytes()), slot: Number(at(131n)) });
    const h = loopOn(c, now, "meteora-dlmm");
    await h.loop.tick();
    assert.match(h.alerts()[0], /does NOT attest depth for this venue/);
    assert.match(h.alerts()[0], /meteora-dlmm/);
  });
});
