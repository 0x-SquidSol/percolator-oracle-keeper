/**
 * GH#165 — numeric env vars must fail loudly, not silently.
 *
 * `??` only fires on null/undefined, so a variable defined as "" skips the
 * default and goes straight into the parser. `parseInt("")` is NaN and
 * `Number("")` is 0, and both of those disabled a guard or collapsed an interval
 * to 1 ms rather than failing. Worse, `parseInt("10s")` is 10 — finite, positive,
 * and therefore invisible to any downstream numeric sanity check.
 *
 * `cross-cluster.ts` cannot be imported (module-scope side effects), so this
 * covers the three places the behaviour now lives: the shared parser, the
 * watchdog constructor that previously trusted the value it was handed, and a
 * source check binding the conversion itself.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { parsePositiveNumberEnv } from "../env-utils.js";
import { createCrankLiveness } from "./crank-liveness.js";

const VAR = "GH165_TEST_VAR";
const RAW_ENV_READ = /(parseInt|Number)\s*\(\s*process\.env\./;

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
}

describe("GH#165 numeric env validation", () => {
  it("unset and empty take the fallback (the only two that should be silent)", () => {
    for (const v of [undefined, "", "   "]) {
      withEnv(v, () => assert.equal(parsePositiveNumberEnv(VAR, 7000), 7000));
    }
  });

  it("throws on every malformed form that parseInt would have accepted or mangled", () => {
    // "10s" and "10 000" are the dangerous ones: parseInt yields 10, which is
    // finite and positive, so nothing downstream would have caught it.
    for (const v of ["abc", "10s", "10 000", "1e999", "Infinity", "NaN"]) {
      withEnv(v, () =>
        assert.throws(() => parsePositiveNumberEnv(VAR, 7000), new RegExp(VAR)),
      );
    }
  });

  it("throws on zero and negative — the values that disable an interval or guard", () => {
    for (const v of ["0", "-1", "-5000"]) {
      withEnv(v, () => assert.throws(() => parsePositiveNumberEnv(VAR, 7000), new RegExp(VAR)));
    }
  });

  it("accepts a good value unchanged", () => {
    withEnv("20000", () => assert.equal(parsePositiveNumberEnv(VAR, 7000), 20000));
  });

  /**
   * The four tests above pass before AND after this change, because
   * `parsePositiveNumberEnv` was always correct — the defect was that
   * `cross-cluster.ts` did not use it. Since that module cannot be imported,
   * bind the conversion by reading its source instead.
   */
  it("no numeric env var in cross-cluster.ts is read with a raw parseInt/Number", () => {
    const src = readFileSync(new URL("../cross-cluster.ts", import.meta.url), "utf8");
    const offenders: string[] = [];
    src.split("\n").forEach((line, i) => {
      if (RAW_ENV_READ.test(line)) offenders.push(`:${i + 1} ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], `must use parsePositiveNumberEnv:\n${offenders.join("\n")}`);
  });

  it("createCrankLiveness REFUSES an intervalMs that would disable the watchdog", () => {
    // The half that matters most: a NaN or 0 made `enabled` false, so limitMs()
    // was null and check() returned early forever — the watchdog silently
    // turning itself off, which is the exact failure it exists to catch.
    for (const bad of [NaN, 0, -1, Infinity]) {
      assert.throws(
        () => createCrankLiveness({ intervalMs: bad }),
        /intervalMs must be a finite positive number/,
        `intervalMs=${String(bad)} must be refused, not accepted-and-disabled`,
      );
    }
  });

  it("createCrankLiveness still arms normally on a good intervalMs", () => {
    const live = createCrankLiveness({ intervalMs: 20_000 });
    assert.equal(typeof live.limitMs(), "number");
    assert.ok((live.limitMs() ?? 0) > 0, "a valid interval must produce a real limit");
    assert.equal(live.check(), false, "a fresh watchdog has not stalled");
  });
});
