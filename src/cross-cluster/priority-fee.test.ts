/**
 * S3-A2 (audit 2026-10-18): optional keeper priority fee. OFF by default (byte-identical txs), env-configured, capped,
 * appended LAST so instruction-index error mapping is unchanged.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import {
  addKeeperPriorityFee,
  KEEPER_PRIORITY_FEE_ENV,
  keeperPriorityFeeIxs,
  keeperPriorityFeeMicroLamports,
  MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS,
  parseKeeperPriorityFee,
  resetKeeperPriorityFeeCache,
} from "./priority-fee.ts";
import { simulateAndSend } from "./v22/exec.ts";
import { serializedTxSize } from "./v22/liquidation.ts";
import { execCtx, fakeExecConn } from "./v22/test-helpers.ts";

const PROG = new PublicKey("11111111111111111111111111111112");
const ix = (tag: number) => new TransactionInstruction({ programId: PROG, keys: [], data: Buffer.from([tag]) });
const CB = ComputeBudgetProgram.programId;

function priceOf(t: { instructions: TransactionInstruction[] }): number | null {
  const p = t.instructions.find((i) => i.programId.equals(CB) && i.data[0] === 3);
  return p ? Number(Buffer.from(p.data).readBigUInt64LE(1)) : null;
}

afterEach(() => {
  delete process.env[KEEPER_PRIORITY_FEE_ENV];
  resetKeeperPriorityFeeCache();
});

describe("S3-A2 parseKeeperPriorityFee", () => {
  it("unset / empty / 0 = OFF", () => {
    assert.equal(parseKeeperPriorityFee(undefined).microLamports, 0);
    assert.equal(parseKeeperPriorityFee("").microLamports, 0);
    assert.equal(parseKeeperPriorityFee("  ").microLamports, 0);
    assert.equal(parseKeeperPriorityFee("0").microLamports, 0);
  });
  it("a typo is OFF, never a fee", () => {
    for (const bad of ["-5", "1e6", "0x10", "12.5", "abc", "5000 ", "Infinity"]) {
      const r = parseKeeperPriorityFee(bad);
      if (bad === "5000 ") assert.equal(r.microLamports, 5000); // surrounding whitespace is trimmed
      else assert.equal(r.microLamports, 0, bad);
    }
  });
  it("a value inside the cap is used as-is; above it is clamped to the cap", () => {
    assert.equal(parseKeeperPriorityFee("5000").microLamports, 5000);
    assert.equal(parseKeeperPriorityFee(String(MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS)).microLamports, MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS);
    const big = parseKeeperPriorityFee("999999999999999999999");
    assert.equal(big.microLamports, MAX_KEEPER_PRIORITY_FEE_MICROLAMPORTS);
    assert.match(big.note ?? "", /clamped/);
  });
});

describe("S3-A2 addKeeperPriorityFee", () => {
  it("OFF by default: the transaction is byte-identical to one built without it", () => {
    assert.equal(keeperPriorityFeeMicroLamports(), 0);
    assert.deepEqual(keeperPriorityFeeIxs(), []);
    const kp = Keypair.generate();
    const mk = () => {
      const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: "11111111111111111111111111111111" });
      t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix(7), ix(8));
      return t;
    };
    const a = mk();
    const b = addKeeperPriorityFee(mk());
    a.sign(kp);
    b.sign(kp);
    assert.deepEqual(b.serialize(), a.serialize());
  });

  it("configured: appended LAST, so every program instruction keeps its index", () => {
    process.env[KEEPER_PRIORITY_FEE_ENV] = "2500";
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix(7), ix(8));
    addKeeperPriorityFee(t);
    assert.equal(t.instructions.length, 4);
    assert.equal(t.instructions[1].data[0], 7);
    assert.equal(t.instructions[2].data[0], 8);
    assert.ok(t.instructions[3].programId.equals(CB));
    assert.equal(priceOf(t), 2500);
  });

  it("never adds a second SetComputeUnitPrice (DuplicateInstruction would fail the whole tx)", () => {
    const t = new Transaction();
    t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7 }), ix(7));
    addKeeperPriorityFee(t, 2500);
    addKeeperPriorityFee(t, 2500);
    assert.equal(t.instructions.filter((i) => i.programId.equals(CB) && i.data[0] === 3).length, 1);
    assert.equal(priceOf(t), 7);
  });

  it("v22 executor: env price rides on the simulated tx, last; the refusal index still points at the right ix", async () => {
    process.env[KEEPER_PRIORITY_FEE_ENV] = "1234";
    const f = fakeExecConn({ simErr: () => ({ InstructionError: [3, { Custom: 44 }] }) }); // prelude 2 + ix index 1
    const seen: number[] = [];
    const orig = f.conn.simulateTransaction.bind(f.conn);
    (f.conn as { simulateTransaction: unknown }).simulateTransaction = async (tx: VersionedTransaction, cfg?: unknown) => {
      const ixs = tx.message.compiledInstructions;
      const last = ixs[ixs.length - 1];
      const keys = tx.message.staticAccountKeys;
      if (keys[last.programIdIndex].equals(CB) && last.data[0] === 3) seen.push(Number(Buffer.from(last.data).readBigUInt64LE(1)));
      return orig(tx as never, cfg as never);
    };
    const out = await simulateAndSend(execCtx(f.conn), [ix(7), ix(8)], { job: "t", label: "t", units: 200_000, program: "stake", expected: new Set([44]) });
    assert.deepEqual(seen, [1234]);
    assert.equal(out.kind, "refused");
    assert.equal(out.kind === "refused" ? out.index : -1, 1);
  });

  it("OFF: the size probes never throw (web3.js Transaction.add() with no instructions throws 'No instructions')", () => {
    assert.equal(keeperPriorityFeeMicroLamports(), 0);
    const kp = Keypair.generate();
    const t = new Transaction();
    t.add(ix(7));
    assert.doesNotThrow(() => addKeeperPriorityFee(t));
    assert.equal(t.instructions.length, 1);
    assert.ok(Number.isFinite(serializedTxSize(kp.publicKey, [ix(7), ix(8)])));
  });

  it("ON: the size probe counts the price instruction's bytes", () => {
    const kp = Keypair.generate();
    const off = serializedTxSize(kp.publicKey, [ix(7), ix(8)]);
    process.env[KEEPER_PRIORITY_FEE_ENV] = "5000";
    resetKeeperPriorityFeeCache();
    const on = serializedTxSize(kp.publicKey, [ix(7), ix(8)]);
    assert.ok(on > off, `${on} > ${off}`);
  });
});
