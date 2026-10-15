/**
 * 2026-10-15: a market Resolved while loss-stale (BandPinExpired during a keeper outage) is no longer cranked,
 * so its cached crank health stays "loss-stale". /health must not list terminal markets as loss-stale.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lossStaleMarketLabels } from "./keeper-loop.ts";

describe("lossStaleMarketLabels", () => {
  const stats = new Map([
    ["PENGU", { label: "PENGU/USDC" }],
    ["SWC4", { label: "swordcat-c4/USDC" }],
    ["SOL", { label: "" }],
    ["JUP", { label: "JUP/USDC" }],
  ]);
  const health = new Map([
    ["PENGU", { status: "loss-stale" }],
    ["SWC4", { status: "loss-stale" }],
    ["SOL", { status: "loss-stale" }],
    ["JUP", { status: "ok" }],
  ]);
  const healthOf = (a: string) => health.get(a);

  it("lists live loss-stale markets (label, else address)", () => {
    assert.deepEqual(lossStaleMarketLabels(stats, new Set(), healthOf), ["PENGU/USDC", "swordcat-c4/USDC", "SOL"]);
  });
  it("drops terminal markets even when their cached health says loss-stale", () => {
    assert.deepEqual(lossStaleMarketLabels(stats, new Set(["SWC4"]), healthOf), ["PENGU/USDC", "SOL"]);
  });
  it("no terminal set (before the first push cycle) behaves as before", () => {
    assert.deepEqual(lossStaleMarketLabels(stats, undefined, healthOf), ["PENGU/USDC", "swordcat-c4/USDC", "SOL"]);
  });
});
