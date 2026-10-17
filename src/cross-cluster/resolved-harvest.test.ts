/**
 * P3 07a1d0eb: tag 78 on a BOUND vault also runs on a Resolved market once
 * TERMINAL-FLAT (materialized_portfolio_count == 0 && c_tot == 0; fees go to the
 * seniors — Earn redeem-lock fix). The keeper's B13 skip makes exactly that
 * exception; the wind-down harvests before stake tag 29. Accounts are unchanged
 * vs b2b2559e (6 base + [6] vault_lp_state w; diffed at 07a1d0eb).
 *
 * Real bytes: SOL / TEXTIT markets (mode @1218, materialized @group+517,
 * c_tot @group+317 patched), the live SOLCAT LP-vault registry (bound flag @160).
 */
import "./test-env-v18-wrapper.ts"; // fixtures are v18 bytes: pin the wrapper the builders target to GnwdeQr (see the module)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, deriveStakePool } from "@percolatorct/sdk";
import { crankLpFeesOnce } from "./lp-fee-cranker.ts";
import { decodeTerminalState, isTerminalFlat, TerminalInsuranceState, windDownOnce } from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";
import { deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const NFT = new PublicKey("CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3");
const KEEPER = Keypair.generate();
const G = 592;

function market(name: string, o: { mode?: number; materialized?: bigint; cTot?: bigint; kind?: number } = {}): Buffer {
  const b = Buffer.from(fx(`${name}-market-v18-fees`));
  if (o.mode !== undefined) b[G + 626] = o.mode;
  if (o.materialized !== undefined) b.writeBigUInt64LE(o.materialized, G + 517);
  if (o.cTot !== undefined) { b.writeBigUInt64LE(o.cTot & 0xffff_ffff_ffff_ffffn, G + 317); b.writeBigUInt64LE(o.cTot >> 64n, G + 325); }
  if (o.kind !== undefined) b[10] = o.kind;
  return b;
}
const flat = (name = "sol") => market(name, { mode: 1, materialized: 0n, cTot: 0n });
const registry = (boundFlag: number): Buffer => { const b = Buffer.from(fx("solcat-lp-vault-registry-v18")); b[160] = boundFlag; return b; };

/** sim: "changes" (post-state differs), "same" (a no-op: post == pre), or an error object. */
function lpConn(reg: Buffer, mkt: Buffer, sendError?: Error, sim: "changes" | "same" | { err: unknown } = "changes") {
  const sent: Transaction[] = [];
  const LEDGER_PRE = Buffer.alloc(240, 7);
  let sims = 0;
  return {
    sent,
    sims: () => sims,
    conn: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        // [registry, market] for the first read; [market, ledger] for the harvest gate
        if (keys.length === 2 && keys[0].toBase58() === SOL) return [{ data: mkt }, { data: LEDGER_PRE }];
        return [{ data: reg }, { data: mkt }];
      },
      async simulateTransaction() {
        sims++;
        if (typeof sim === "object") return { value: { err: sim.err, accounts: null } };
        const ledgerPost = sim === "same" ? LEDGER_PRE : Buffer.alloc(240, 9);
        return { value: { err: null, accounts: [{ data: [mkt.toString("base64"), "base64"] }, { data: [ledgerPost.toString("base64"), "base64"] }] } };
      },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
      async sendRawTransaction(raw: Buffer) { if (sendError) throw sendError; sent.push(Transaction.from(raw)); return "sig"; },
      async confirmTransaction() { return { value: { err: null } }; },
      async getSignatureStatuses() { return { value: [null] }; },
    },
  };
}
const SOL = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

describe("decode: terminal-flat", () => {
  it("c_tot @ group+317 and materialized @ group+517 on real SOL bytes", () => {
    const live = decodeTerminalState(new Uint8Array(fx("sol-market-v18-fees")));
    assert.equal(live?.kind, "live");
    const r = decodeTerminalState(new Uint8Array(market("sol", { mode: 1 })));
    assert.equal(r?.kind, "resolved");
    assert.equal((r as { materializedPortfolios: bigint }).materializedPortfolios, 8n, "SOL's 8 portfolios");
    assert.equal(isTerminalFlat(r), false);
    assert.equal(isTerminalFlat(decodeTerminalState(new Uint8Array(flat()))), true);
    assert.equal(isTerminalFlat(decodeTerminalState(new Uint8Array(market("sol", { mode: 1, materialized: 0n, cTot: 5n })))), false, "c_tot != 0 is not flat");
  });
});

describe("B13 exception: tag 78 on a Resolved market", () => {
  it("bound + terminal-flat: cranked, with the [6] vault_lp_state tail", async () => {
    const c = lpConn(registry(1), flat());
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "cranked");
    const ix = c.sent[0].instructions.find((i) => i.programId.equals(WRAPPER))!;
    assert.equal(ix.keys.length, 7);
    assert.ok(ix.keys[6].pubkey.equals(deriveVaultLpState(WRAPPER, new PublicKey(SOL))));
  });
  it("bound but portfolios remain: skipped, nothing sent", async () => {
    const c = lpConn(registry(1), market("sol", { mode: 1, materialized: 1n, cTot: 0n }));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("bound but c_tot != 0: skipped", async () => {
    const c = lpConn(registry(1), market("sol", { mode: 1, materialized: 0n, cTot: 1n }));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("terminal-flat but UNBOUND (all v18.2 / 6377376a markets): skipped", async () => {
    const c = lpConn(registry(0), flat());
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("version gate: a pre-07a1d0eb wrapper answers 21 in the simulation -> skipped, nothing sent", async () => {
    const c = lpConn(registry(1), flat(), undefined, { err: { InstructionError: [1, { Custom: 21 }] } });
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("P3 FINAL: a terminal harvest that would change nothing (no-op success) is NOT sent", async () => {
    const c = lpConn(registry(1), flat(), undefined, "same");
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "no-fees");
    assert.equal(c.sims(), 1);
    assert.equal(c.sent.length, 0, "no tx every cycle forever");
  });
  it("P3 FINAL: a terminal harvest with seniors all redeemed (0 shares) still runs — 78 can absorb the residual for the junior", async () => {
    const zero = registry(1); zero.fill(0, 16 + 64, 16 + 80);
    const c = lpConn(zero, flat(), undefined, "changes");
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "cranked");
  });
  it("0 shares on a LIVE market: UNBOUND is still skipped (control)", async () => {
    const zero = registry(0); zero.fill(0, 16 + 64, 16 + 80);
    const c = lpConn(zero, fx("sol-market-v18-fees"));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("0 shares on a LIVE market: BOUND is sent (d119eebd: 78 books a pending senior draw; P3-L1 junior is the claimant)", async () => {
    const zero = registry(1); zero.fill(0, 16 + 64, 16 + 80);
    const c = lpConn(zero, fx("sol-market-v18-fees"));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "cranked");
    assert.equal(c.sent.length, 1);
  });
  it("Recovery (mode 2, e.g. after the expired-close valve): skipped, nothing sent", async () => {
    const c = lpConn(registry(1), market("sol", { mode: 2 }));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
    assert.equal(c.sent.length, 0);
  });
  it("a 21 on a LIVE market is still a real failure (the gate is Resolved-only)", async () => {
    const c = lpConn(registry(1), fx("sol-market-v18-fees"), new Error("custom program error: 0x15"));
    const r = await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false);
    assert.ok(typeof r === "object" && "error" in r);
  });
  it("tombstone: skipped", async () => {
    const c = lpConn(registry(1), market("sol", { kind: 8 }));
    assert.equal(await crankLpFeesOnce(c.conn as never, KEEPER, SOL, false), "skipped");
  });
});

describe("wind-down on a bound market: cleanup -> 101 -> tag 8 (vault LP) -> tag 78 -> stake tag 29", () => {
  const TEXTIT = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
  const REG = deriveLpVaultRegistry(WRAPPER, TEXTIT)[0];
  const WALLET = Keypair.generate().publicKey;
  const LP_PF = Keypair.generate().publicKey;
  const WALLET_PF = Keypair.generate().publicKey;
  const pf = (owner: PublicKey) => { const b = Buffer.from(fx("sol-trader-portfolio-v18")); owner.toBuffer().copy(b, 80); owner.toBuffer().copy(b, 116); return b; };
  const vaultLpState = (() => {
    const b = Buffer.alloc(16 + 256);
    b.writeBigUInt64LE(0x5045_5243_5631_3600n, 0); b.writeUInt16LE(18, 8); b[10] = 9;
    TEXTIT.toBuffer().copy(b, 16); REG.toBuffer().copy(b, 48); LP_PF.toBuffer().copy(b, 80); WALLET.toBuffer().copy(b, 112);
    b[16 + 214] = 1;
    return b;
  })();
  const CFG: TerminalInsuranceConfig = {
    wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000, now: () => 0,
    confirm: { statusRetries: 1, statusRetryDelayMs: 0 },
    cleanup: { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: 216_000n, probeTtlMs: 3_600_000, now: () => 0 },
  };

  function conn(opts: { preO7a1?: boolean } = {}) {
    const order: string[] = [];
    let cleaned = false;
    const mkt = () => (cleaned ? market("textit", { mode: 1, materialized: 0n, cTot: 0n }) : market("textit", { mode: 1, materialized: 2n, cTot: 0n }));
    const label = (pid: string, data: Uint8Array): string =>
      pid === STAKE.toBase58() ? `stake29(${Buffer.from(data).readBigUInt64LE(1) === 0n ? "0" : "budget"})`
        : pid === WRAPPER.toBase58() ? (data[0] === 101 ? `101(${data[1]})` : `w${data[0]}`)
          : pid.startsWith("ATok") ? "ata" : pid.startsWith("Compute") ? "" : "?";
    const tags = (tx: VersionedTransaction) => tx.message.compiledInstructions.map((ix) => label(tx.message.staticAccountKeys[ix.programIdIndex].toBase58(), ix.data)).filter(Boolean);
    let n = 0;
    const c = {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        return keys.map((k) => {
          if (k.equals(TEXTIT)) return { data: mkt(), owner: WRAPPER, lamports: 1, executable: false };
          if (k.equals(deriveStakePool(TEXTIT, STAKE)[0])) return { data: fx("textit-stake-pool-v18"), owner: STAKE, lamports: 1, executable: false };
          if (k.equals(deriveVaultLpState(WRAPPER, TEXTIT))) return { data: vaultLpState, owner: WRAPPER, lamports: 1, executable: false };
          if (k.equals(REG)) return { data: registry(1), owner: WRAPPER, lamports: 1, executable: false };
          return { data: Buffer.alloc(165), owner: WRAPPER, lamports: 1, executable: false };
        });
      },
      async getAccountInfo() { return { data: registry(1), owner: WRAPPER, lamports: 1, executable: false }; },
      async getProgramAccounts(prog: PublicKey) {
        if (prog.equals(NFT)) return [];
        return [ // vault LP listed FIRST on purpose: the cleanup must still process it last
          { pubkey: LP_PF, account: { data: pf(REG), owner: WRAPPER, lamports: 67_000_000, executable: false } },
          { pubkey: WALLET_PF, account: { data: pf(WALLET), owner: WRAPPER, lamports: 67_000_000, executable: false } },
        ];
      },
      async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: [] }; },
      async getSlot() { return 600_000_000; },
      async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
      async simulateTransaction(tx: VersionedTransaction, o?: { accounts?: { addresses: string[] } }) {
        const t = tags(tx);
        // chunk calls (101(0) / lone CloseResolved): one chunk of progress, then unchanged
        if (o?.accounts && (t.includes("101(0)") || (t.includes("w30") && !t.includes("w8")))) {
          const sent101 = order.filter((x) => x.includes("101(0)")).length;
          return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: [Buffer.alloc(64, sent101 === 0 ? 1 : 1).toString("base64"), "base64"] }] } };
        }
        if (n++ === 0) return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 61 }] }, logs: [] } }; // cleanup probe (P3)
        if (t[0] === "stake29(0)" && !order.some((o) => o.startsWith("stake29"))) {
          order.push("probe29");
          return { context: { slot: 1 }, value: { err: { InstructionError: [1, { Custom: 30 }] }, logs: [] } };
        }
        return { context: { slot: 1 }, value: { err: null, logs: [] } };
      },
      async sendRawTransaction(raw: Buffer) {
        let t: string[];
        try { t = tags(VersionedTransaction.deserialize(raw)); } catch { const lt = Transaction.from(raw); t = lt.instructions.map((ix) => label(ix.programId.toBase58(), ix.data)).filter(Boolean); }
        if (opts.preO7a1 && t.includes("w78")) throw new Error("custom program error: 0x15");
        order.push(t.join("+"));
        if (t.includes("w8") && order.filter((o) => o.includes("w8")).length >= 2) cleaned = true; // both portfolios closed
        return "5ig1111111111111111111111111111111111111111111111111111111111111";
      },
      async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
      async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    };
    return { conn: c as unknown as TerminalConnection, order };
  }

  it("P3 07a1d0eb: exact send order, and done", async () => {
    const w = conn();
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    const sent = w.order.filter((o) => o !== "probe29");
    assert.deepEqual(sent, ["w30+w8", "ata+101(0)", "101(1)", "w8", "w78", "stake29(budget)", "stake29(0)"], sent.join(" | "));
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
    assert.match((r.outcome as { detail: string }).detail, /Tag 78 harvested the LP fee leg into the seniors/);
  });
  it("pre-07a1d0eb wrapper: the harvest is a quiet no-op (21 in preflight) and tag 29 still runs", async () => {
    const w = conn({ preO7a1: true });
    const r = await windDownOnce(w.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.ok(!w.order.includes("w78"));
    assert.ok(w.order.includes("stake29(budget)"));
    assert.equal(r.outcome.kind, "done");
    assert.doesNotMatch((r.outcome as { detail: string }).detail, /harvest failed/);
  });
});
