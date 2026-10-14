/**
 * Tag 78 (LpVaultCrankFees) on a BOUND vault, P2b ext tail (#526): once the registry ext flag
 * (byte 161) is set the program REQUIRES [7] vault_lp_ext (w) and [8] vault LP (w), fail closed.
 *
 * Also the strict no-op proof for today's registries (flag 0): the transaction is
 * byte-identical to the pre-P2b construction and the RPC pattern is unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_LP_VAULT_CRANK_FEES,
  buildAccountMetas,
  deriveLpBackingLedger,
  deriveVaultLpExtP2b,
  encodeLpVaultCrankFees,
} from "@percolatorct/sdk";
import { buildCrankFeesIx, crankLpFeesOnce } from "./lp-fee-cranker.ts";
import { lpVaultRegistryExtFlag } from "./registry-flags.ts";
import { deriveBondTrancheV22 } from "@percolatorct/sdk";
import { DEFAULT_P2B_GATE_CONFIG, P2bFeatureGate, setP2bGate } from "./p2b-feature.ts";
import { KEEPER, PROGRAM, deriveLpVaultRegistry, deriveVaultLpState, fx, registryBytes, vaultLpStateBytes } from "./p2b-test-helpers.ts";

const MARKET = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const REG_KEY = deriveLpVaultRegistry(PROGRAM, MARKET)[0];
const STATE_KEY = deriveVaultLpState(PROGRAM, MARKET);
const EXT_KEY = deriveVaultLpExtP2b(PROGRAM, MARKET)[0];
const LP = Keypair.generate().publicKey;
const G = 592;

function flatResolved(): Buffer {
  const b = Buffer.from(fx("sol-market-v18-fees"));
  b[G + 626] = 1;
  b.writeBigUInt64LE(0n, G + 517);
  b.writeBigUInt64LE(0n, G + 317);
  b.writeBigUInt64LE(0n, G + 325);
  return b;
}

interface Script {
  /** Registry bytes returned by each successive registry read (the last repeats). */
  registries: Uint8Array[];
  market?: Buffer | null;
  state?: Uint8Array | null;
  /** Throw from sendRawTransaction when this returns an error for the decoded tx. */
  sendError?: (tx: Transaction) => Error | null;
  /** simulateTransaction error by the tag-78 instruction's account count (the resolved-harvest gate simulates first). */
  simError?: (nKeys: number) => unknown;
}

function rig(s: Script) {
  const sent: Transaction[] = [];
  const attempts: Transaction[] = [];
  const reads: string[] = [];
  let regReads = 0;
  const LEDGER = Buffer.alloc(240, 7);
  const nextReg = () => Buffer.from(s.registries[Math.min(regReads++, s.registries.length - 1)]);
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      reads.push(keys.map((k) => (k.equals(REG_KEY) ? "registry" : k.equals(STATE_KEY) ? "state" : k.equals(MARKET) ? "market" : "other")).join("+"));
      if (keys.length === 2 && keys[0].equals(REG_KEY) && keys[1].equals(MARKET)) return [{ data: nextReg() }, s.market === undefined || s.market === null ? null : { data: s.market }];
      if (keys.length === 1 && keys[0].equals(STATE_KEY)) return [s.state ? { data: Buffer.from(s.state) } : null];
      if (keys.length === 1 && keys[0].equals(REG_KEY)) return [{ data: nextReg() }];
      if (keys.length === 2 && keys[0].equals(MARKET)) return [{ data: s.market }, { data: LEDGER }];
      return keys.map(() => null);
    },
    async simulateTransaction(vtx: { message: { compiledInstructions: Array<{ accountKeyIndexes: number[] }> } }) {
      const err = s.simError?.(vtx.message.compiledInstructions[1].accountKeyIndexes.length);
      if (err) return { value: { err, logs: [], accounts: null } };
      // resolved harvest gate: post-state differs -> "changes"
      return { value: { err: null, logs: [], accounts: [{ data: [Buffer.alloc(8, 1).toString("base64"), "base64"] }, { data: [Buffer.alloc(240, 9).toString("base64"), "base64"] }] } };
    },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }; },
    async sendRawTransaction(raw: Buffer) {
      const tx = Transaction.from(raw);
      attempts.push(tx);
      const e = s.sendError?.(tx);
      if (e) throw e;
      sent.push(tx);
      return "sig";
    },
    async confirmTransaction() { return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [null] }; },
  };
  return { conn, sent, attempts, reads };
}

const crankIx = (t: Transaction) => t.instructions.find((ix) => ix.programId.equals(PROGRAM))!;

/** The tag-78 instruction EXACTLY as the pre-P2b keeper built it (copied construction, independent of buildCrankFeesIx). */
function legacyIx(bound: boolean, domain = 0): TransactionInstruction {
  const [ledger] = deriveLpBackingLedger(PROGRAM, MARKET, domain);
  const [sibling] = deriveLpBackingLedger(PROGRAM, MARKET, domain ^ 1);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: buildAccountMetas(ACCOUNTS_LP_VAULT_CRANK_FEES, {
      cranker: KEEPER.publicKey, market: MARKET, registry: REG_KEY, ledger, siblingLedger: sibling, systemProgram: SystemProgram.programId,
    }).concat(bound ? [{ pubkey: STATE_KEY, isSigner: false, isWritable: true }] : []),
    data: Buffer.from(encodeLpVaultCrankFees({ domain })),
  });
}
const same = (a: TransactionInstruction, b: TransactionInstruction): void => {
  assert.equal(a.programId.toBase58(), b.programId.toBase58());
  assert.deepEqual(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  assert.deepEqual([...a.data], [...b.data]);
};

describe("registry ext flag (byte 161)", () => {
  it("reads 0/1; a short account or a stray byte reads as no-ext (never throws)", () => {
    assert.equal(lpVaultRegistryExtFlag(registryBytes({ bound: true, ext: true })), true);
    assert.equal(lpVaultRegistryExtFlag(registryBytes({ bound: true, ext: false })), false);
    assert.equal(lpVaultRegistryExtFlag(new Uint8Array(100)), false);
    const b = Buffer.from(registryBytes({ bound: true }));
    b[161] = 7;
    assert.equal(lpVaultRegistryExtFlag(new Uint8Array(b)), false);
  });
  it("is 0 on the real v18 SOLCAT registry (today's programs)", () => {
    assert.equal(fx("solcat-lp-vault-registry-v18")[161], 0);
  });
});

describe("tag 78 bound: account list with / without the ext", () => {
  it("flag 0 (today's programs): 7 accounts, byte-identical to the legacy construction; ONE registry+market read", async () => {
    setP2bGate(null);
    const r = rig({ registries: [registryBytes({ bound: true })] });
    assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    assert.equal(r.sent.length, 1);
    same(crankIx(r.sent[0]), legacyIx(true));
    assert.equal(crankIx(r.sent[0]).keys.length, 7);
    assert.deepEqual(r.reads, ["registry+market"], "no extra reads when the ext flag is 0");
  });

  it("unbound vault: the 6 base accounts, byte-identical to legacy, even with stray ext byte set", async () => {
    const r = rig({ registries: [registryBytes({ bound: false, ext: true })] });
    assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    same(crankIx(r.sent[0]), legacyIx(false));
    assert.equal(crankIx(r.sent[0]).keys.length, 6);
    assert.deepEqual(r.reads, ["registry+market"]);
  });

  it("flag 1 + bound: [6] state, [7] ext PDA (w), [8] vault LP (w); one extra read of vault_lp_state", async () => {
    const r = rig({ registries: [registryBytes({ bound: true, ext: true })], state: vaultLpStateBytes({ lp: LP }) });
    assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    const ix = crankIx(r.sent[0]);
    assert.equal(ix.keys.length, 9);
    assert.deepEqual(ix.keys.slice(0, 7).map((k) => k.pubkey.toBase58()), legacyIx(true).keys.map((k) => k.pubkey.toBase58()), "[0..6] unchanged");
    assert.ok(ix.keys[7].pubkey.equals(EXT_KEY), "[7] = [\"vault_lp_ext\", market]");
    assert.ok(ix.keys[8].pubkey.equals(LP), "[8] = the vault LP portfolio");
    assert.deepEqual([ix.keys[7].isSigner, ix.keys[7].isWritable], [false, true]);
    assert.deepEqual([ix.keys[8].isSigner, ix.keys[8].isWritable], [false, true]);
    assert.equal(ix.data[0], 78);
    assert.deepEqual(r.reads, ["registry+market", "state"]);
  });

  it("flag 1 but the vault_lp_state cannot be read: reported, NEVER sent without the tail", async () => {
    const r = rig({ registries: [registryBytes({ bound: true, ext: true })], state: null });
    const out = await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false);
    assert.ok(typeof out === "object" && /vault_lp_state unreadable/.test(out.error), JSON.stringify(out));
    assert.equal(r.attempts.length, 0);
  });

  it("buildCrankFeesIx with the tail uses the SDK helper's exact shape", () => {
    const ix = buildCrankFeesIx({
      keeper: KEEPER.publicKey, market: MARKET, registry: REG_KEY,
      ledger: deriveLpBackingLedger(PROGRAM, MARKET, 0)[0], siblingLedger: deriveLpBackingLedger(PROGRAM, MARKET, 1)[0],
      domainIdx: 0, bound: true, tail: { vaultLpExt: EXT_KEY, lpPortfolio: LP },
    });
    assert.deepEqual(ix.keys.slice(6).map((k) => k.pubkey.toBase58()), [STATE_KEY.toBase58(), EXT_KEY.toBase58(), LP.toBase58()]);
  });

  it("Resolved terminal-flat harvest (bound) also carries the ext tail once the flag is set", async () => {
    const r = rig({ registries: [registryBytes({ bound: true, ext: true })], state: vaultLpStateBytes({ lp: LP }), market: flatResolved() });
    assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    const ix = crankIx(r.sent[0]);
    assert.equal(ix.keys.length, 9);
    assert.ok(ix.keys[7].pubkey.equals(EXT_KEY));
  });

  it("Resolved terminal-flat harvest with flag 0 stays the 7-account legacy shape", async () => {
    const r = rig({ registries: [registryBytes({ bound: true })], market: flatResolved() });
    assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    same(crankIx(r.sent[0]), legacyIx(true));
  });
});

describe("race: a tag 103 creates the ext between our registry read and our send", () => {
  const refuseOld = (tx: Transaction): Error | null => (crankIx(tx).keys.length < 9 ? new Error("Transaction simulation failed: insufficient account keys for instruction") : null);

  it("P2b program known (gate on): the old-shape send fails, the registry is re-read fresh, ONE retry carries the tail and lands", async () => {
    setP2bGate(new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported"));
    try {
      const r = rig({
        // read 1 (start of the crank): flag 0; every later read: flag 1
        registries: [registryBytes({ bound: true, ext: false }), registryBytes({ bound: true, ext: true })],
        state: vaultLpStateBytes({ lp: LP }),
        sendError: refuseOld,
      });
      assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
      assert.equal(r.attempts.length, 2, "one failed attempt without the tail, one retry");
      assert.equal(crankIx(r.attempts[0]).keys.length, 7);
      assert.equal(crankIx(r.attempts[1]).keys.length, 9);
      assert.equal(r.sent.length, 1);
      assert.deepEqual(r.reads, ["registry+market", "registry", "state"], "fresh registry re-read, then the state read for [8]");
    } finally {
      setP2bGate(null);
    }
  });

  it("gate on but the flag is STILL 0 on the re-read: the first error is returned, no retry", async () => {
    setP2bGate(new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported"));
    try {
      const r = rig({ registries: [registryBytes({ bound: true })], sendError: () => new Error("some other revert") });
      const out = await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false);
      assert.ok(typeof out === "object" && /some other revert/.test(out.error));
      assert.equal(r.attempts.length, 1);
    } finally {
      setP2bGate(null);
    }
  });

  it("gate OFF (today's programs): a failure is returned as before, with NO re-read and NO retry", async () => {
    setP2bGate(null);
    const r = rig({ registries: [registryBytes({ bound: true, ext: false }), registryBytes({ bound: true, ext: true })], state: vaultLpStateBytes({ lp: LP }), sendError: refuseOld });
    const out = await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false);
    assert.ok(typeof out === "object" && /insufficient account keys/.test(out.error));
    assert.equal(r.attempts.length, 1);
    assert.deepEqual(r.reads, ["registry+market"], "the RPC pattern is exactly the legacy one");
  });

  it("the Resolved terminal-flat path races the same way: the harvest simulation refuses the old shape, one retry carries the tail", async () => {
    setP2bGate(new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported"));
    try {
      const r = rig({
        registries: [registryBytes({ bound: true, ext: false }), registryBytes({ bound: true, ext: true })],
        state: vaultLpStateBytes({ lp: LP }),
        market: flatResolved(),
        simError: (n) => (n < 9 ? { InstructionError: [1, "NotEnoughAccountKeys"] } : null),
      });
      assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
      assert.equal(r.attempts.length, 1, "nothing was sent with the old shape (the simulation gate refused it)");
      assert.equal(crankIx(r.attempts[0]).keys.length, 9);
    } finally {
      setP2bGate(null);
    }
  });

  it("an unbound market never retries", async () => {
    setP2bGate(new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "on" }, async () => "supported"));
    try {
      const r = rig({ registries: [registryBytes({ bound: false })], sendError: () => new Error("revert") });
      await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false);
      assert.equal(r.attempts.length, 1);
    } finally {
      setP2bGate(null);
    }
  });
});

describe("tag 78 on a BOND market with the ext (SDK table: bond tranche at [9], writable)", () => {
  const TRANCHE = deriveBondTrancheV22(PROGRAM, MARKET)[0];

  it("buildCrankFeesIx without a bond tranche: exactly 9 accounts (state, ext, LP)", () => {
    const ix = buildCrankFeesIx({
      keeper: KEEPER.publicKey, market: MARKET, registry: REG_KEY,
      ledger: deriveLpBackingLedger(PROGRAM, MARKET, 0)[0], siblingLedger: deriveLpBackingLedger(PROGRAM, MARKET, 1)[0],
      domainIdx: 0, bound: true, tail: { vaultLpExt: EXT_KEY, lpPortfolio: LP },
    });
    assert.equal(ix.keys.length, 9);
  });

  it("buildCrankFeesIx with the bond tranche: 10 accounts, [8] LP writable, [9] the ['bond_tranche', market] PDA writable", () => {
    const ix = buildCrankFeesIx({
      keeper: KEEPER.publicKey, market: MARKET, registry: REG_KEY,
      ledger: deriveLpBackingLedger(PROGRAM, MARKET, 0)[0], siblingLedger: deriveLpBackingLedger(PROGRAM, MARKET, 1)[0],
      domainIdx: 0, bound: true, tail: { vaultLpExt: EXT_KEY, lpPortfolio: LP, bondTranche: TRANCHE },
    });
    assert.deepEqual(ix.keys.slice(6).map((k) => k.pubkey.toBase58()), [STATE_KEY.toBase58(), EXT_KEY.toBase58(), LP.toBase58(), TRANCHE.toBase58()]);
    assert.equal(ix.keys[8].isWritable, true);
    assert.equal(ix.keys[9].isWritable, true);
  });

  it("crankLpFeesOnce: registry bond byte 162 set -> the sent tx carries the tranche; clear -> 9 accounts", async () => {
    const bondReg = registryBytes({ bound: true, ext: true, bond: true });
    const r = rig({ registries: [bondReg], state: vaultLpStateBytes({ lp: LP }) });
    assert.equal(await crankLpFeesOnce(r.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    const ix = crankIx(r.sent[0]);
    assert.equal(ix.keys.length, 10);
    assert.ok(ix.keys[9].pubkey.equals(TRANCHE));
    const r2 = rig({ registries: [registryBytes({ bound: true, ext: true })], state: vaultLpStateBytes({ lp: LP }) });
    assert.equal(await crankLpFeesOnce(r2.conn as never, KEEPER, MARKET.toBase58(), false), "cranked");
    assert.equal(crankIx(r2.sent[0]).keys.length, 9);
  });
});
