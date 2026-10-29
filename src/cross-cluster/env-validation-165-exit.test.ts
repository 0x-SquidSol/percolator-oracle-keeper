/**
 * Follow-up to #166 / GH#165: a bad CC_* numeric env var must END THE BOOT WITH A NON-ZERO EXIT.
 *
 * cross-cluster.ts installs a process-wide `uncaughtException` handler that logs and stays up, and that handler also
 * swallows a throw at module evaluation: with only the #166 conversion, `CC_INTERVAL_MS=abc` logged the error and the
 * process exited 0 (L4 boot test, 2026-10-22), so the supervisor saw a clean exit. `bootPositiveNumberEnv` logs
 * `[fatal] ...` and exits 1, like the other boot checks in that file.
 *
 * Two layers: the helper with an injected exit (fast, pure) and a REAL boot of cross-cluster.ts in a child process with a
 * scrubbed environment (proves the measured call ran: the child must print the [fatal] line AND exit 1).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { bootPositiveNumberEnv } from "../env-utils.js";

const VAR = "GH165_EXIT_TEST_VAR";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}
const exit = (code: number): never => {
  throw new Exited(code);
};

function withEnv(value: string | undefined, fn: () => void): void {
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

describe("GH#165 follow-up: bootPositiveNumberEnv", () => {
  it("returns the parsed value / the fallback and never exits on good input", () => {
    withEnv("20000", () => assert.equal(bootPositiveNumberEnv(VAR, 7000, undefined, exit), 20000));
    for (const v of [undefined, "", "  "]) withEnv(v, () => assert.equal(bootPositiveNumberEnv(VAR, 7000, undefined, exit), 7000));
  });

  it("logs [fatal] and exits 1 on every bad form (never returns a NaN / zero interval)", () => {
    for (const v of ["abc", "10s", "0", "-1", "Infinity", "NaN"]) {
      const lines: string[] = [];
      withEnv(v, () => {
        assert.throws(
          () => bootPositiveNumberEnv(VAR, 7000, undefined, exit, (l) => lines.push(l)),
          (e: unknown) => e instanceof Exited && e.code === 1,
          `value ${JSON.stringify(v)} must exit 1`,
        );
      });
      assert.equal(lines.length, 1);
      assert.match(lines[0], new RegExp(`^\\[fatal\\] ${VAR} must be a finite positive number`));
    }
  });

  it("cross-cluster.ts reads every CC_* / interval var through the exiting helper", () => {
    const src = readFileSync(join(root, "src", "cross-cluster.ts"), "utf8");
    const bare = src.split("\n").filter((l) => /(?<!boot)parsePositiveNumberEnv\("(CC_|CRANK_|LP_FEE_|REGISTER_|REGISTRY_)/.test(l));
    assert.deepEqual(bare, []);
    for (const n of ["CC_INTERVAL_MS", "CC_MARK_WINDOW_MS", "CC_HEALTH_PORT", "CC_CYCLE_TIMEOUT_MS", "CRANK_INTERVAL_MS", "LP_FEE_CRANK_INTERVAL_MS", "REGISTER_POLL_INTERVAL_MS", "REGISTRY_RELOAD_INTERVAL_MS"]) {
      assert.ok(src.includes(`bootPositiveNumberEnv("${n}"`), `${n} must use bootPositiveNumberEnv`);
    }
  });
});

describe("GH#165 follow-up: a real boot with a bad CC_* value exits 1", () => {
  for (const [name, bad] of [["CC_INTERVAL_MS", "abc"], ["CRANK_INTERVAL_MS", "0"]] as const) {
    it(`${name}=${bad}: [fatal] line on stderr and exit code 1`, () => {
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", join(root, "src", "cross-cluster.ts")], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ALLOW_INSECURE_LOCAL_RPC: "true",
          MAINNET_RPC_URL: "http://127.0.0.1:9",
          DEVNET_RPC_URL: "http://127.0.0.1:9",
          KEEPER_DRY_RUN: "1",
          KEEPER_KEYPAIR: JSON.stringify(Array.from({ length: 64 }, () => 1)),
          REGISTRY_PATH: "/nonexistent/registry.json",
          [name]: bad,
        },
      });
      assert.equal(r.error, undefined, `child must run to completion: ${String(r.error)}`);
      assert.match(r.stderr, new RegExp(`\\[fatal\\] ${name} must be a finite positive number`));
      assert.equal(r.status, 1, `exit code (stderr: ${r.stderr.slice(0, 300)})`);
    });
  }
});
