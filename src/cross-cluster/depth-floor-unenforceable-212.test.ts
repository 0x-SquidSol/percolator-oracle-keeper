/**
 * #212 — a configured liquidity floor that cannot apply to a market must not be silent.
 *
 * The floor has one implementation, `pumpswapQuoteDepthUsdE6`, and `parseDexPool` exposes
 * vault reserves for pumpswap ONLY. So a raydium-clmm or meteora-dlmm market is priced with
 * no depth gate however MIN_POOL_LIQUIDITY_USD is set. That is a maintainer decision to fix
 * properly (drop those markets, or teach the SDK to read their reserves); what is not
 * defensible is that it happens without saying so.
 *
 * MIN_POOL_LIQUIDITY_USD_E6 is read at module load, so every case imports the module fresh
 * with the env already in place.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

async function loadWithFloor(value: string | undefined) {
  const prev = process.env.MIN_POOL_LIQUIDITY_USD;
  if (value === undefined) delete process.env.MIN_POOL_LIQUIDITY_USD;
  else process.env.MIN_POOL_LIQUIDITY_USD = value;
  const mod = await import(`./price-reader.ts?floor=${encodeURIComponent(String(value))}`);
  if (prev === undefined) delete process.env.MIN_POOL_LIQUIDITY_USD;
  else process.env.MIN_POOL_LIQUIDITY_USD = prev;
  return mod as typeof import("./price-reader.ts");
}

const dlmm = { dexType: "meteora-dlmm", poolAddress: "PoolDLMM1111", label: "SOL/USDC — meteora-dlmm" };
const clmm = { dexType: "raydium-clmm", poolAddress: "PoolCLMM2222", label: "LINK/USDC — raydium-clmm" };
const pump = { dexType: "pumpswap", poolAddress: "PoolPUMP3333", label: "FRANK/USDC — pumpswap" };

describe("#212 unenforceable depth floor", () => {
  it("warns for a DLMM market when a floor is configured, naming the market and the floor", async () => {
    const { warnDepthFloorUnenforceable } = await loadWithFloor("1000");
    const lines: string[] = [];
    assert.equal(warnDepthFloorUnenforceable(dlmm, new Set(), (l) => lines.push(l)), true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /NOT ENFORCEABLE/);
    assert.match(lines[0], /meteora-dlmm/);
    assert.match(lines[0], /\$1000\.00/);
    assert.match(lines[0], /#212/);
  });

  it("warns for raydium-clmm too — the gap is not DLMM-specific", async () => {
    const { warnDepthFloorUnenforceable } = await loadWithFloor("1000");
    assert.equal(warnDepthFloorUnenforceable(clmm, new Set(), () => {}), true);
  });

  it("is silent for pumpswap, where the floor genuinely applies", async () => {
    const { warnDepthFloorUnenforceable } = await loadWithFloor("1000");
    const lines: string[] = [];
    assert.equal(warnDepthFloorUnenforceable(pump, new Set(), (l) => lines.push(l)), false);
    assert.equal(lines.length, 0);
  });

  it("is silent when no floor is configured — there is nothing to be unenforceable", async () => {
    const { warnDepthFloorUnenforceable } = await loadWithFloor(undefined);
    const lines: string[] = [];
    assert.equal(warnDepthFloorUnenforceable(dlmm, new Set(), (l) => lines.push(l)), false);
    assert.equal(lines.length, 0);
  });

  it("warns ONCE per pool, so it cannot flood a 1.5 s loop", async () => {
    const { warnDepthFloorUnenforceable } = await loadWithFloor("1000");
    const warned = new Set<string>();
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) warnDepthFloorUnenforceable(dlmm, warned, (l) => lines.push(l));
    assert.equal(lines.length, 1);
  });

  it("still warns separately for each distinct market", async () => {
    const { warnDepthFloorUnenforceable } = await loadWithFloor("1000");
    const warned = new Set<string>();
    const lines: string[] = [];
    warnDepthFloorUnenforceable(dlmm, warned, (l) => lines.push(l));
    warnDepthFloorUnenforceable(clmm, warned, (l) => lines.push(l));
    assert.equal(lines.length, 2);
  });
});
