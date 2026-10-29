/**
 * Late-finalize cleanup (gate-100 finding on wrapper bd4fe5f8).
 *
 * After a late receipt finalize (tag 46 / a repeat CloseResolved on a Resolved bound market) the
 * portfolio stays MATERIALIZED with capital 0, pnl 0 and its receipt finalized. Until it is closed
 * the market is not terminal-flat: the Resolved 78 harvest is skipped and the junior's tag 102 is
 * refused with 21. The wind-down now closes every such receipt-only portfolio with the permissionless
 * tag 8 ([3] = owner) on ANY Resolved market (stake-bound or not), re-reads, then runs 78.
 *
 * Bytes: the textit v18 market fixture (mode @G+626, materialized @G+517, c_tot @G+317), the SOLCAT
 * LP-vault registry (bound flag @160), and the sol trader portfolio fixture truncated after the owner
 * (capital @148 / pnl @164 zeroed) with the receipt flags at 9369+64 / +65.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, RESOLVED_RECEIPT_ACCOUNT_OFF_P3 } from "@percolatorct/sdk";
import { decodeTerminalState, isTerminalFlat, TerminalInsuranceState, terminalInsuranceConfigFromEnv, windDownOnce } from "./terminal-insurance.ts";
import type { TerminalConnection, TerminalInsuranceConfig } from "./terminal-insurance.ts";
import { isFinalizedReceiptOnly, nftEscrowAuthority } from "./resolved-portfolio-cleanup.ts";
import { WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const WRAPPER = WRAPPER_PROGRAM_ID; // the 78 builder uses the process-wide id; keep them equal
const STAKE = new PublicKey("VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w");
const NFT = new PublicKey("EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ");
const KEEPER = Keypair.generate();
const G = 592;
const MARKET = new PublicKey("DnFhDdWzcWkBDxN9JJcmFmtiqqKo56w9JwQEtRKNdjcG");
const REG = deriveLpVaultRegistry(WRAPPER, MARKET)[0];
const RO = RESOLVED_RECEIPT_ACCOUNT_OFF_P3;

function market(materialized: bigint): Buffer {
  const b = Buffer.from(fx("textit-market-v18-fees"));
  b[G + 626] = 1; // Resolved
  b.writeBigUInt64LE(materialized, G + 517);
  b.writeBigUInt64LE(0n, G + 317); b.writeBigUInt64LE(0n, G + 325); // c_tot 0
  return b;
}
const registry = (): Buffer => { const b = Buffer.from(fx("solcat-lp-vault-registry-v18")); b[160] = 1; return b; };
/** A portfolio of MARKET owned by `owner`: empty claim unless `capital`; receipt flags as given. */
function pf(owner: PublicKey, receipt: { present: boolean; finalized: boolean }, capital = 0n): Buffer {
  const src = fx("sol-trader-portfolio-v18");
  const b = Buffer.alloc(src.length);
  src.copy(b, 0, 0, 148);
  MARKET.toBuffer().copy(b, 16);
  owner.toBuffer().copy(b, 80); owner.toBuffer().copy(b, 116);
  if (capital) b.writeBigUInt64LE(capital, 148);
  b[RO + 64] = receipt.present ? 1 : 0;
  b[RO + 65] = receipt.finalized ? 1 : 0;
  return b;
}

const CFG = (receiptCleanup?: boolean): TerminalInsuranceConfig => ({
  wrapperProgramId: WRAPPER, stakeProgramId: STAKE, unbookedAlertCycles: 3, probeTtlMs: 3_600_000, now: () => 0,
  confirm: { statusRetries: 1, statusRetryDelayMs: 0 },
  receiptCleanup,
  cleanup: { wrapperProgramId: WRAPPER, nftProgramId: NFT, maxPerCycle: 8, maxAtaCreatesPerCycle: 4, pdaGraceSlots: 216_000n, probeTtlMs: 3_600_000, now: () => 0 },
});

/** Unbound-stake Resolved market whose materialized count drops by one per landed tag 8. */
function conn(pfs: Array<{ key: PublicKey; data: Buffer }>) {
  const order: string[] = [];
  const closedTo: string[] = [];
  let materialized = BigInt(pfs.length);
  const LEDGER_PRE = Buffer.alloc(240, 7);
  const label = (pid: string, data: Uint8Array): string =>
    pid === WRAPPER.toBase58() ? `w${data[0]}` : pid.startsWith("Compute") ? "" : "?";
  const c = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      // the 78 harvest gate reads [market, ledger]
      if (keys.length === 2 && keys[0].equals(MARKET) && !keys[1].equals(REG)) return [{ data: market(materialized), owner: WRAPPER, lamports: 1, executable: false }, { data: LEDGER_PRE, owner: WRAPPER, lamports: 1, executable: false }];
      return keys.map((k) => {
        if (k.equals(MARKET)) return { data: market(materialized), owner: WRAPPER, lamports: 1, executable: false };
        if (k.equals(REG)) return { data: registry(), owner: WRAPPER, lamports: 1, executable: false };
        return null; // no stake pool: an UNBOUND-stake market
      });
    },
    async getProgramAccounts() {
      return pfs.map((p) => ({ pubkey: p.key, account: { data: p.data, owner: WRAPPER, lamports: 67_000_000, executable: false } }));
    },
    async getSlot() { return 600_000_000; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }; },
    async simulateTransaction(tx: VersionedTransaction, o?: { accounts?: { addresses: string[] } }) {
      // The main cleanup also runs here (A6-1): inside force_close_delay_slots an unsigned CloseResolved is refused
      // (ExpectedSigner 6), and tag 8 deregisters only an EMPTY portfolio (no claim, no open receipt, not the vault LP).
      const keys = tx.message.staticAccountKeys;
      for (const [i, ix] of tx.message.compiledInstructions.entries()) {
        if (!keys[ix.programIdIndex].equals(WRAPPER)) continue;
        const p = pfs.find((q) => q.key.equals(keys[ix.accountKeyIndexes[2]]));
        const empty = !!p && isFinalizedReceiptOnly(p.data) && !REG.equals(new PublicKey(p.data.subarray(80, 112)));
        if (ix.data[0] === 30 || (ix.data[0] === 8 && !empty)) return { context: { slot: 1 }, value: { err: { InstructionError: [i, { Custom: ix.data[0] === 30 ? 6 : 21 }] }, logs: [] } };
      }
      if (o?.accounts) return { context: { slot: 1 }, value: { err: null, logs: [], accounts: [{ data: [market(materialized).toString("base64"), "base64"] }, { data: [Buffer.alloc(240, 9).toString("base64"), "base64"] }] } };
      return { context: { slot: 1 }, value: { err: null, logs: [] } };
    },
    async sendRawTransaction(raw: Buffer) {
      const lt = Transaction.from(raw);
      const t = lt.instructions.map((ix) => label(ix.programId.toBase58(), ix.data)).filter(Boolean);
      order.push(t.join("+"));
      for (const ix of lt.instructions) {
        if (ix.programId.equals(WRAPPER) && ix.data[0] === 8) { materialized -= 1n; closedTo.push(ix.keys[3].pubkey.toBase58()); }
      }
      return "5ig1111111111111111111111111111111111111111111111111111111111111";
    },
    async confirmTransaction() { return { context: { slot: 2 }, value: { err: null } }; },
    async getSignatureStatuses() { return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }] }; },
  };
  return { conn: c as unknown as TerminalConnection, order, closedTo, materialized: () => materialized };
}

describe("late-finalize cleanup: receipt-only portfolios -> tag 8 -> 78 (junior 102 unblocked)", () => {
  const WALLET = Keypair.generate().publicKey;

  it("isFinalizedReceiptOnly: empty claim and no OPEN receipt (finalized, or none)", () => {
    assert.equal(isFinalizedReceiptOnly(pf(WALLET, { present: true, finalized: true })), true);
    assert.equal(isFinalizedReceiptOnly(pf(WALLET, { present: true, finalized: false })), false, "open (partial) receipt: the revisit's job, not this step");
    assert.equal(isFinalizedReceiptOnly(pf(WALLET, { present: false, finalized: false })), true, "no receipt at all (a full CloseResolved) but still materialized: closable too");
    assert.equal(isFinalizedReceiptOnly(pf(WALLET, { present: true, finalized: true }, 5n)), false, "still holds capital");
  });

  it("rehearsal-33 shape: two empty portfolios with NO receipt (full CloseResolved) are closed, then 78", async () => {
    const A = Keypair.generate().publicKey, B = Keypair.generate().publicKey;
    const w = conn([{ key: Keypair.generate().publicKey, data: pf(A, { present: false, finalized: false }) }, { key: Keypair.generate().publicKey, data: pf(B, { present: false, finalized: false }) }]);
    const r = await windDownOnce(w.conn, KEEPER, MARKET.toBase58(), false, CFG(), new TerminalInsuranceState());
    assert.deepEqual(w.order, ["w8", "w8", "w78"], w.order.join(" | "));
    assert.deepEqual(w.closedTo.sort(), [A.toBase58(), B.toBase58()].sort());
    assert.equal(r.outcome.kind, "done");
  });

  it("unbound-stake Resolved market: tag 8 ([3] = owner) then 78, outcome done, market terminal-flat", async () => {
    const w = conn([{ key: Keypair.generate().publicKey, data: pf(WALLET, { present: true, finalized: true }) }]);
    const r = await windDownOnce(w.conn, KEEPER, MARKET.toBase58(), false, CFG(), new TerminalInsuranceState());
    assert.deepEqual(w.order, ["w8", "w78"], w.order.join(" | "));
    assert.deepEqual(w.closedTo, [WALLET.toBase58()], "rent to [3] = the recorded owner");
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
    assert.match((r.outcome as { detail: string }).detail, /junior's 102 is unblocked/);
    assert.equal(isTerminalFlat(decodeTerminalState(market(w.materialized()))), true);
  });

  it("NEGATIVE CONTROL: step disabled -> nothing sent, market stays materialized (102 would be refused with 21)", async () => {
    const w = conn([{ key: Keypair.generate().publicKey, data: pf(WALLET, { present: true, finalized: true }) }]);
    // A6-1: the main cleanup now runs on unbound markets too and would close it (tag 8 alone): turn it off as well.
    const r = await windDownOnce(w.conn, KEEPER, MARKET.toBase58(), false, { ...CFG(false), cleanup: undefined }, new TerminalInsuranceState());
    assert.deepEqual(w.order, []);
    assert.equal(r.outcome.kind, "skipped");
    assert.equal(w.materialized(), 1n);
    assert.equal(isTerminalFlat(decodeTerminalState(market(w.materialized()))), false, "not terminal-flat: 78 skipped, junior 102 = 21");
  });

  it("A6-1: receipt step disabled, main cleanup on -> the main cleanup closes it on the unbound market (tag 8 alone)", async () => {
    const w = conn([{ key: Keypair.generate().publicKey, data: pf(WALLET, { present: true, finalized: true }) }]);
    const r = await windDownOnce(w.conn, KEEPER, MARKET.toBase58(), false, CFG(false), new TerminalInsuranceState());
    assert.deepEqual(w.order, ["w8"], w.order.join(" | "));
    assert.deepEqual(w.closedTo, [WALLET.toBase58()]);
    assert.equal(r.outcome.kind, "done", JSON.stringify(r.outcome));
  });

  it("an NFT-escrowed receipt-only portfolio is closed too (no holder grace; [3] = the escrow PDA)", async () => {
    const escrow = nftEscrowAuthority(NFT);
    const w = conn([{ key: Keypair.generate().publicKey, data: pf(escrow, { present: true, finalized: true }) }]);
    await windDownOnce(w.conn, KEEPER, MARKET.toBase58(), false, CFG(), new TerminalInsuranceState());
    assert.deepEqual(w.closedTo, [escrow.toBase58()]);
    assert.deepEqual(w.order, ["w8", "w78"]);
  });

  it("an OPEN receipt and the vault LP are left alone (revisit / 101 handle them); no 78 while materialized", async () => {
    const w = conn([
      { key: Keypair.generate().publicKey, data: pf(WALLET, { present: true, finalized: false }) },
      { key: Keypair.generate().publicKey, data: pf(REG, { present: true, finalized: true }) },
    ]);
    const r = await windDownOnce(w.conn, KEEPER, MARKET.toBase58(), false, CFG(), new TerminalInsuranceState());
    assert.deepEqual(w.order, []);
    assert.equal(r.outcome.kind, "skipped");
  });

  it("env: TERMINAL_RECEIPT_CLEANUP_ENABLED defaults on; =false disables", () => {
    assert.equal(terminalInsuranceConfigFromEnv({}).receiptCleanup, true);
    assert.equal(terminalInsuranceConfigFromEnv({ TERMINAL_RECEIPT_CLEANUP_ENABLED: "false" }).receiptCleanup, false);
  });
});
