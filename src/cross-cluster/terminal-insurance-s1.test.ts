/**
 * Stake S1 account shapes for tag 29 (RecoverTerminalInsurance) and their gating against the deployed program.
 * Run with: node --import tsx/esm --test src/cross-cluster/terminal-insurance-s1.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveInsuranceUnitsV22, deriveStakePool } from "@percolatorct/sdk";
import {
  buildRecoverTerminalInsuranceIx,
  creatorCollateralAta,
  isLegacyShapeRefusal,
  TerminalInsuranceState,
  windDownOnce,
} from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const TEXTIT = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const KEEPER = Keypair.generate();
const k = () => Keypair.generate().publicKey;
const CFG: TerminalInsuranceConfig = {
  wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 }, now: () => 0,
};

describe("buildRecoverTerminalInsuranceIx account shapes (mirrors SDK recoverTerminalInsuranceAccounts)", () => {
  const base = { stakeProgramId: STAKE, wrapperProgramId: WRAPPER, caller: k(), market: k(), pool: k(), poolVault: k(), collateralMint: k(), amount: 0n };
  const units = k(), creator = k(), stray = k();
  const tail = (ix: { keys: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> }) => ix.keys.slice(9);

  it("no v5: today's shape, 9 accounts (+stray) — unchanged", () => {
    assert.equal(buildRecoverTerminalInsuranceIx(base).keys.length, 9);
    const t = tail(buildRecoverTerminalInsuranceIx({ ...base, stray }));
    assert.deepEqual(t.map((x) => x.pubkey.toBase58()), [stray.toBase58()]);
  });
  it("FIRST_LOSS: [9] units, [10] creator, [11] stray?, all writable non-signers", () => {
    const a = tail(buildRecoverTerminalInsuranceIx({ ...base, v5: { insuranceUnits: units, creatorToken: creator } }));
    assert.deepEqual(a.map((x) => x.pubkey.toBase58()), [units.toBase58(), creator.toBase58()]);
    const b = tail(buildRecoverTerminalInsuranceIx({ ...base, stray, v5: { insuranceUnits: units, creatorToken: creator } }));
    assert.deepEqual(b.map((x) => x.pubkey.toBase58()), [units.toBase58(), creator.toBase58(), stray.toBase58()]);
    for (const x of b) assert.ok(x.isWritable && !x.isSigner);
  });
  it("FEE_ONLY: [stray?, creator]", () => {
    assert.deepEqual(tail(buildRecoverTerminalInsuranceIx({ ...base, v5: { creatorToken: creator } })).map((x) => x.pubkey.toBase58()), [creator.toBase58()]);
    assert.deepEqual(tail(buildRecoverTerminalInsuranceIx({ ...base, stray, v5: { creatorToken: creator } })).map((x) => x.pubkey.toBase58()), [stray.toBase58(), creator.toBase58()]);
  });
  it("creator ATA is the classic-token ATA of pool.admin", () => {
    const admin = k(), mint = k();
    const want = PublicKey.findProgramAddressSync([admin.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
    assert.ok(creatorCollateralAta(admin, mint).equals(want));
  });
});

describe("isLegacyShapeRefusal", () => {
  it("only Custom(16) / NotEnoughAccountKeys at the stake ix", () => {
    assert.equal(isLegacyShapeRefusal({ InstructionError: [1, { Custom: 16 }] }), true);
    assert.equal(isLegacyShapeRefusal({ InstructionError: [1, "NotEnoughAccountKeys"] }), true);
    assert.equal(isLegacyShapeRefusal({ InstructionError: [1, { Custom: 31 }] }), false);
    assert.equal(isLegacyShapeRefusal({ InstructionError: [1, { Custom: 46 }] }), false);
    assert.equal(isLegacyShapeRefusal({ InstructionError: [0, { Custom: 16 }] }), false);
    assert.equal(isLegacyShapeRefusal(null), false);
  });
});

// ── windDownOnce on a v5 pool: TEXTIT market + the v2.2 pool fixture re-pointed at it ────────────
const MODE_ABS = 592 + 626;
const BUDGET_ABS = 592 + 461;
function market(): Buffer {
  const b = Buffer.from(fx("textit-market-v18-fees"));
  b[MODE_ABS] = 1; // Resolved
  b.writeBigUInt64LE(0n, BUDGET_ABS); // no budget: only the amount-0 step runs
  b.writeBigUInt64LE(0n, BUDGET_ABS + 8);
  return b;
}
const ADMIN = k();
const MINT = k();
const VAULT = k();
function pool(riskMode: number): Buffer {
  const b = Buffer.from(fx("v22-sol-stake-pool-v5"));
  TEXTIT.toBuffer().copy(b, 8);
  MINT.toBuffer().copy(b, 72);
  VAULT.toBuffer().copy(b, 136);
  WRAPPER.toBuffer().copy(b, 224);
  ADMIN.toBuffer().copy(b, 40);
  b[280] = 0;
  b[408] = riskMode;
  return b;
}
function tokenAcct(owner: PublicKey): Buffer {
  const b = Buffer.alloc(165);
  owner.toBuffer().copy(b, 32);
  b[108] = 1;
  return b;
}

function stubV5(riskMode: number, opts: { ata?: boolean; deployedIsUpgraded: boolean; err46?: boolean }) {
  const ata = creatorCollateralAta(ADMIN, MINT);
  const sims: string[][] = [];
  let sends = 0;
  const conn = {
    async getMultipleAccountsInfo() {
      return [
        { data: market(), owner: WRAPPER, lamports: 1, executable: false },
        { data: pool(riskMode), owner: STAKE, lamports: 1, executable: false },
      ];
    },
    async getAccountInfo(key: PublicKey) {
      if (key.equals(ata) && opts.ata !== false) return { data: tokenAcct(ADMIN), owner: TOKEN, lamports: 1, executable: false };
      return null;
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      const m = tx.message;
      const ix = m.compiledInstructions[1];
      const keys = ix.accountKeyIndexes.map((i) => m.staticAccountKeys[i].toBase58());
      sims.push(keys);
      let err: unknown = null;
      if (keys.length > 9 && !opts.deployedIsUpgraded) err = { InstructionError: [1, { Custom: 16 }] };
      else if (opts.err46 && keys.length <= 9) err = { InstructionError: [1, { Custom: 46 }] };
      else err = { InstructionError: [1, { Custom: 31 }] }; // NothingToRecover
      return { context: { slot: 1 }, value: { err, logs: [] } };
    },
    async sendRawTransaction() { sends++; return "5ig111111111111111111111111111111111111111111111111111111111111"; },
    async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: [] }; },
  };
  return { conn: conn as unknown as TerminalConnection, sims, sends: () => sends, ata };
}

describe("windDownOnce account shape gating (v5 pool)", () => {
  const unitsKey = deriveInsuranceUnitsV22(WRAPPER, TEXTIT)[0].toBase58();

  it("upgraded stake + FIRST_LOSS: sends units + creator ATA", async () => {
    const s = stubV5(1, { deployedIsUpgraded: true });
    const st = new TerminalInsuranceState();
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(r.outcome.kind, "nothing");
    const last = s.sims[s.sims.length - 1];
    assert.deepEqual(last.slice(9), [unitsKey, s.ata.toBase58()]);
    assert.equal(st.shape?.value, "v5");
  });

  it("upgraded stake + FEE_ONLY: creator ATA only", async () => {
    const s = stubV5(2, { deployedIsUpgraded: true });
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.deepEqual(s.sims[s.sims.length - 1].slice(9), [s.ata.toBase58()]);
  });

  it("DEPLOYED (pre-S1) stake: the v5 probe is refused with 16 -> legacy 9-account shape, cached", async () => {
    const s = stubV5(2, { deployedIsUpgraded: false });
    const st = new TerminalInsuranceState();
    const r = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    assert.equal(r.outcome.kind, "nothing");
    assert.equal(s.sims[s.sims.length - 1].length, 9);
    assert.equal(st.shape?.value, "legacy");
    const before = s.sims.length;
    st.done.clear();
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
    // second pass: no shape re-probe (cached) -> one tag-29 probe + one call, all legacy
    assert.ok(s.sims.slice(before).every((k) => k.length === 9));
  });

  it("creator ATA not created: legacy shape, never the v5 shape", async () => {
    const s = stubV5(1, { deployedIsUpgraded: true, ata: false });
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.ok(s.sims.every((k) => k.length === 9));
  });

  it("error 46 is a retryable skip, logged once per market, not a failure", async () => {
    const s = stubV5(2, { deployedIsUpgraded: false, err46: true });
    const st = new TerminalInsuranceState();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      const r1 = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
      const r2 = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
      assert.equal(r1.outcome.kind, "skipped");
      assert.equal(r2.outcome.kind, "skipped");
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.filter((w) => w.includes("Custom(46)")).length, 1);
    assert.equal(s.sends(), 0);
  });
});
