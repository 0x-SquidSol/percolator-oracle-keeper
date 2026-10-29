/** A8-4: a malformed registry row is refused at boot and on hot-reload, before a push batch or a crank parses it. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { registryRowProblems } from "./multi-asset.ts";
import { reloadRegistryOnce } from "./registry-reload.ts";
import type { MarketEntry, Registry } from "./registry.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reg-rows-"));
const write = (name: string, markets: unknown[]): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, description: "d", markets }));
  return p;
};
const GOOD = { label: "GOOD", marketAddress: "11111111111111111111111111111112", poolAddress: "11111111111111111111111111111113", dexType: "pumpswap", assetIndex: 0 } as MarketEntry;
const OTHER = { ...GOOD, label: "OTHER", marketAddress: "11111111111111111111111111111114" } as MarketEntry;
const live = (): Registry => ({ version: 1, description: "d", markets: [GOOD] });

describe("registryRowProblems", () => {
  it("accepts a well-formed single-asset row and every registry file in the repo", () => {
    assert.deepEqual(registryRowProblems([GOOD, OTHER]), []);
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
    for (const f of ["registry.json", "registry-additions-v22-multiasset.json", "deploy/registry.relaunch.seed.json", "deploy/registry.v21.seed.json"]) {
      const r = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as Registry;
      assert.deepEqual(registryRowProblems(r.markets), [], f);
    }
  });
  it("names each malformed row", () => {
    const cases: Array<[string, unknown]> = [
      ["unparsable marketAddress", { ...GOOD, marketAddress: "NOT_A_PUBKEY" }],
      ["no marketAddress", { ...GOOD, marketAddress: undefined }],
      ["unparsable poolAddress", { ...GOOD, poolAddress: "nope" }],
      ["no poolAddress", { ...GOOD, poolAddress: undefined }],
      ["unknown dexType", { ...GOOD, dexType: "uniswap" }],
    ];
    for (const [what, row] of cases) assert.equal(registryRowProblems([row as MarketEntry]).length, 1, what);
    assert.match(registryRowProblems([GOOD, { ...GOOD }])[0], /duplicate marketAddress/);
  });
});

describe("hot-reload refuses a malformed file and keeps the running registry", () => {
  for (const [what, markets] of [
    ["an added row with an unparsable marketAddress", [GOOD, { ...OTHER, marketAddress: "NOT_A_PUBKEY" }]],
    ["an added row with no marketAddress (used to throw)", [GOOD, { ...OTHER, marketAddress: undefined }]],
    ["a duplicate row", [GOOD, OTHER, OTHER]],
    ["an empty market list while markets are tracked", []],
  ] as Array<[string, unknown[]]>) {
    it(what, () => {
      const r = live();
      const p = write(`${what.length}.json`, markets);
      assert.doesNotThrow(() => reloadRegistryOnce(r, p));
      assert.deepEqual(reloadRegistryOnce(r, p), { added: 0, removed: 0, updated: 0 });
      assert.deepEqual(r.markets, [GOOD]);
    });
  }
  it("control: a well-formed edit is still applied; an empty list loads into an empty keeper", () => {
    const r = live();
    assert.deepEqual(reloadRegistryOnce(r, write("ok.json", [GOOD, OTHER])), { added: 1, removed: 0, updated: 0 });
    assert.equal(r.markets.length, 2);
    const empty: Registry = { version: 1, description: "d", markets: [] };
    assert.deepEqual(reloadRegistryOnce(empty, write("empty.json", [])), { added: 0, removed: 0, updated: 0 });
  });
});
