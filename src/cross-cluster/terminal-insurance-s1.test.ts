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
  buildCreateCreatorAtaIx,
  buildRecoverTerminalInsuranceIx,
  creatorCollateralAta,
  CREATOR_ATA_MAX_ATTEMPTS,
  isCreatorTokenAccount,
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
  b.writeBigUInt64LE(0n, 592 + 517); // every portfolio closed: 31 = done (A6-1: not done while any is materialized)
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
function tokenAcct(owner: PublicKey, mint: PublicKey = MINT): Buffer {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b[108] = 1;
  return b;
}

function stubV5(riskMode: number, opts: { ata?: boolean; deployedIsUpgraded: boolean; err46?: boolean; createOnSend?: boolean; needCreator?: boolean; closeAfterCreate?: boolean; ataOwner?: PublicKey; ataMint?: PublicKey }) {
  const ata = creatorCollateralAta(ADMIN, MINT);
  const sims: string[][] = [];
  let sends = 0;
  let ataExists = opts.ata !== false;
  let created = 0;
  const conn = {
    async getMultipleAccountsInfo() {
      return [
        { data: market(), owner: WRAPPER, lamports: 1, executable: false },
        { data: pool(riskMode), owner: STAKE, lamports: 1, executable: false },
      ];
    },
    async getAccountInfo(key: PublicKey) {
      if (key.equals(ata) && ataExists) return { data: tokenAcct(opts.ataOwner ?? ADMIN, opts.ataMint ?? MINT), owner: TOKEN, lamports: 1, executable: false };
      return null;
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      const m = tx.message;
      const ix = m.compiledInstructions[1];
      const keys = ix.accountKeyIndexes.map((i) => m.staticAccountKeys[i].toBase58());
      sims.push(keys);
      let err: unknown = null;
      if (opts.needCreator && keys.length <= 9 && !ataExists) err = riskMode === 1 ? { InstructionError: [1, "NotEnoughAccountKeys"] } : { InstructionError: [1, { Custom: 46 }] };
      else if (keys.length > 9 && !opts.deployedIsUpgraded) err = { InstructionError: [1, { Custom: 16 }] };
      else if (opts.err46 && keys.length <= 9) err = { InstructionError: [1, { Custom: 46 }] };
      else err = { InstructionError: [1, { Custom: 31 }] }; // NothingToRecover
      return { context: { slot: 1 }, value: { err, logs: [] } };
    },
    async sendRawTransaction() { sends++; if (opts.createOnSend && !ataExists) { ataExists = true; created++; if (opts.closeAfterCreate) setTimeout(() => {}, 0); } return "5ig111111111111111111111111111111111111111111111111111111111111"; },
    async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
    async getTokenAccountsByOwner() { return { context: { slot: 1 }, value: [] }; },
  };
  return { conn: conn as unknown as TerminalConnection, sims, sends: () => sends, created: () => created, ata, closeAta: () => { ataExists = false; } };
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

  it("creator ATA missing + dry run: nothing is sent or created; legacy probe only", async () => {
    const s = stubV5(1, { deployedIsUpgraded: true, ata: false });
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), true, CFG, new TerminalInsuranceState());
    assert.equal(s.sends(), 0);
    assert.ok(s.sims.every((k) => k.length === 9));
  });

  it("creator ATA missing (live): NOT created pre-emptively; created only after the program refuses for want of it, then the v5 shape is used", async () => {
    for (const mode of [1, 2]) {
      const s = stubV5(mode, { deployedIsUpgraded: true, ata: false, createOnSend: true, needCreator: true });
      const st = new TerminalInsuranceState();
      const r1 = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
      assert.equal(s.created(), 0, "no create before a refusal");
      assert.equal(s.sends(), 0);
      assert.equal(r1.outcome.kind, "skipped");
      assert.ok(st.creatorAtaNeeded.has(TEXTIT.toBase58()));
      const r2 = await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
      assert.equal(s.created(), 1, "exactly one ATA create tx");
      assert.equal(r2.outcome.kind, "nothing");
      const last = s.sims[s.sims.length - 1];
      assert.deepEqual(last.slice(9), mode === 1 ? [unitsKey, s.ata.toBase58()] : [s.ata.toBase58()]);
    }
  });

  it("a v5 pool whose creator ATA exists is never touched (no create, no refusal needed)", async () => {
    const s = stubV5(1, { deployedIsUpgraded: true, needCreator: true });
    await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, new TerminalInsuranceState());
    assert.equal(s.sends(), 0);
  });

  it("rent-drain griefing: an admin that closes its ATA every cycle gets at most CREATOR_ATA_MAX_ATTEMPTS creates, with backoff", async () => {
    const s = stubV5(1, { deployedIsUpgraded: true, ata: false, createOnSend: true, needCreator: true });
    const st = new TerminalInsuranceState();
    let t = 0;
    const cfg = { ...CFG, now: () => t };
    const originalLog = console.log;
    console.log = () => {};
    try {
      for (let cycle = 0; cycle < 9; cycle++) {
        await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, cfg, st);
        s.closeAta(); // hostile admin closes the 0-balance ATA again
        st.done.clear(); // the wind-down is re-attempted each cycle
        t += 60_000; // one minute per cycle
      }
      assert.equal(s.created(), 1, "9 one-minute cycles sit inside the 10-minute first backoff: one create");
      t += 100 * 3_600_000;
      for (let cycle = 0; cycle < 40; cycle++) {
        await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, cfg, st);
        s.closeAta();
        st.done.clear();
        t += 3_600_000 * 24;
      }
    } finally {
      console.log = originalLog;
    }
    assert.equal(s.created(), CREATOR_ATA_MAX_ATTEMPTS, "capped per market");
  });

  it("ready() checks mint and owner: a reassigned or wrong-mint ATA is not used and not 'created over'", async () => {
    for (const o of [{ ataOwner: k() }, { ataMint: k() }]) {
      const s = stubV5(1, { deployedIsUpgraded: true, needCreator: true, createOnSend: true, ...o });
      const st = new TerminalInsuranceState();
      st.creatorAtaNeeded.add(TEXTIT.toBase58());
      await windDownOnce(s.conn, KEEPER, TEXTIT.toBase58(), false, CFG, st);
      assert.equal(s.created(), 0);
      assert.ok(s.sims.every((x) => x.length === 9), "legacy shape only; the doomed v5 shape is never sent");
    }
  });

  it("isCreatorTokenAccount: initialized, classic token, mint and owner", () => {
    const admin = k(), mint = k();
    const good = { owner: TOKEN, data: tokenAcct(admin, mint) };
    assert.equal(isCreatorTokenAccount(good, mint, admin), true);
    assert.equal(isCreatorTokenAccount({ ...good, data: tokenAcct(k(), mint) }, mint, admin), false);
    assert.equal(isCreatorTokenAccount({ ...good, data: tokenAcct(admin, k()) }, mint, admin), false);
    const uninit = Buffer.from(good.data); uninit[108] = 0;
    assert.equal(isCreatorTokenAccount({ ...good, data: uninit }, mint, admin), false);
    assert.equal(isCreatorTokenAccount({ ...good, owner: k() }, mint, admin), false);
    assert.equal(isCreatorTokenAccount(null, mint, admin), false);
  });

  it("buildCreateCreatorAtaIx: payer signs, ATA of pool.admin for the pool mint, CreateIdempotent", () => {
    const admin = k(), mint = k(), payer = k();
    const ix = buildCreateCreatorAtaIx(payer, admin, mint);
    assert.equal(ix.programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    assert.deepEqual([...ix.data], [1]);
    assert.ok(ix.keys[0].isSigner && ix.keys[0].isWritable && ix.keys[0].pubkey.equals(payer));
    assert.ok(ix.keys[1].pubkey.equals(creatorCollateralAta(admin, mint)) && ix.keys[1].isWritable);
    assert.ok(ix.keys[2].pubkey.equals(admin) && ix.keys[3].pubkey.equals(mint));
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
