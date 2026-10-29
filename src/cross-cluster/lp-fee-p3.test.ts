/**
 * Tag 78 on P3 (vault-owned-LP) markets: the bound-vault tail [6] vault_lp_state (w).
 * Ported from rehearsal/p0a-feeloop-sdk8@5b5d14a; account list checked against
 * b2b2559e handle_lp_vault_crank_fees -> load_bound_vault_lp_tail(idx 6, need_lp=false).
 *
 * Real bytes: the live SOLCAT LP-vault registry (5,000,000,000 shares, domain 0,
 * bound byte 0) captured 2026-09-30. The P3-bound form is the same account with
 * `_reserved[0]` (abs 160) = 1 — the registry layout is identical on v18.2 and P3.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { parseLpVaultRegistry } from "@percolatorct/sdk";
import { crankLpFeesOnce, LP_VAULT_REGISTRY_BOUND_FLAG_OFF, lpVaultRegistryBound } from "./lp-fee-cranker.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REG = Buffer.from(readFileSync(join(here, "__fixtures__", "solcat-lp-vault-registry-v18.b64"), "utf8").trim(), "base64");
// The wrapper the keeper builders actually target (env override, else the pinned default) - never a stale literal.
const WRAPPER = WRAPPER_PROGRAM_ID;
const SOLCAT = "7mgX3bkzEivRrCffCJ7XzqfAp3gpjm63RNinwDhr7b41";
const KEEPER = Keypair.generate();
const bound = (flag: number): Buffer => { const b = Buffer.from(REG); b[LP_VAULT_REGISTRY_BOUND_FLAG_OFF] = flag; return b; };
const VAULT_LP_STATE = PublicKey.findProgramAddressSync([Buffer.from("vault_lp"), new PublicKey(SOLCAT).toBuffer()], WRAPPER)[0];

function conn(registry: Buffer) {
  const sent: Transaction[] = [];
  return {
    sent,
    conn: {
      async getMultipleAccountsInfo() { return [{ data: registry }, null]; },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async sendRawTransaction(raw: Buffer) { sent.push(Transaction.from(raw)); return "sig"; },
      async getSignatureStatuses() { return { value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    },
  };
}
const crankIx = (t: Transaction) => t.instructions.find((ix) => ix.programId.equals(WRAPPER))!;

describe("tag 78 on P3 markets (bound-vault tail)", () => {
  it("fixture sanity: the real SOLCAT registry parses; its bound byte (abs 160) is 0 on v18.2", () => {
    const p = parseLpVaultRegistry(new Uint8Array(REG));
    assert.equal(p.totalLpSharesOutstanding, 5_000_000_000n);
    assert.equal(REG[160], 0);
    assert.equal(LP_VAULT_REGISTRY_BOUND_FLAG_OFF, 160);
    assert.equal(lpVaultRegistryBound(new Uint8Array(REG)), false);
    assert.equal(lpVaultRegistryBound(new Uint8Array(bound(1))), true);
  });

  it("unbound (v18.2 / unbound P3): the 6 base accounts, unchanged", async () => {
    const c = conn(REG);
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOLCAT, false), "cranked");
    const ix = crankIx(c.sent[0]);
    assert.equal(ix.keys.length, 6);
    assert.ok(!ix.keys.some((k) => k.pubkey.equals(VAULT_LP_STATE)));
  });

  it("P3-bound: appends [6] = [\"vault_lp\", market] PDA, writable, not a signer", async () => {
    const c = conn(bound(1));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOLCAT, false), "cranked");
    const ix = crankIx(c.sent[0]);
    assert.equal(ix.keys.length, 7);
    assert.ok(ix.keys[6].pubkey.equals(VAULT_LP_STATE), "tail is the vault-LP state PDA");
    assert.deepEqual([ix.keys[6].isSigner, ix.keys[6].isWritable], [false, true]);
    // base accounts untouched: cranker s,w / market w / registry w / ledgers w / system
    assert.deepEqual(ix.keys.slice(0, 6).map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, true], [false, true], [false, true], [false, true], [false, false]]);
  });

  it("an invalid bound byte (the program would refuse InvalidAccountData) is reported, never sent", async () => {
    const c = conn(bound(2));
    const r = await crankLpFeesOnce(c.conn as never, KEEPER, SOLCAT, false);
    assert.ok(typeof r === "object" && /bound flag is 2/.test(r.error));
    assert.equal(c.sent.length, 0);
  });
});
