/**
 * S3-I (audit 2026-10-18): neither lockfile may resolve a ws version inside the high advisories
 * (GHSA "Uninitialized memory disclosure" / "Memory exhaustion DoS from tiny fragments": ws 7.0.0-7.5.10, 8.0.0-8.20.1).
 * pnpm-lock.yaml is what the Dockerfile installs; package-lock.json is what `npm ci` would install.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);

function vulnerableWs(v: string): boolean {
  const [maj, min, pat] = v.split(".").map((x) => Number.parseInt(x, 10));
  if (maj === 7) return min < 5 || (min === 5 && pat <= 10);
  if (maj === 8) return min < 20 || (min === 20 && pat <= 1);
  return false;
}

describe("S3-I ws advisories", () => {
  it("pnpm-lock.yaml resolves no vulnerable ws", () => {
    const lock = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");
    const versions = [...lock.matchAll(/^ {2}ws@(\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
    assert.ok(versions.length > 0, "fixture sanity: ws is in the lockfile");
    assert.deepEqual(versions.filter(vulnerableWs), []);
  });

  it("package-lock.json resolves no vulnerable ws", () => {
    const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as { packages: Record<string, { version?: string }> };
    const versions = Object.entries(lock.packages)
      .filter(([k]) => k === "node_modules/ws" || k.endsWith("/node_modules/ws"))
      .map(([, v]) => v.version ?? "");
    assert.ok(versions.length > 0, "fixture sanity: ws is in the lockfile");
    assert.deepEqual(versions.filter(vulnerableWs), []);
  });
});
