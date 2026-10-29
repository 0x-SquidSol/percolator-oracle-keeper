/**
 * A6-1: the Resolved-market cleanup must keep running every cycle until nothing is materialized, whether or not stake
 * tag 29(0) already answered 31 and whether or not a stake pool is bound. Drives the REAL fee-job path
 * (`makeTerminalInsuranceJob` through `runFeeJobSweep`, what `startFeeJobLoop` runs each cycle) against a stateful fake
 * chain, across the force-close delay.
 *
 * Chain model (wrapper 21b8ccfd src/v16_program.rs; stake percolator-stake f5bbd6c `process_recover_terminal_insurance`):
 *   30  CloseResolved, owner unsigned: inside force_close_delay_slots -> ExpectedSigner 6 (:28899-28904); after -> pays the
 *       claim, the portfolio stays materialized with an empty claim.
 *   8   ClosePortfolio, [3] = owner: Resolved permissionless, no delay gate (:20556-20565); refuses a claim or an unsettled
 *       vault LP (engine emptiness, stubbed as 21); else deregisters.
 *   101 topup 0: inside the delay and caller != junior -> Unauthorized 8 (:39927-39933); after -> settles once. 101(1) / 46: 21.
 *   stake 29: amount > 0 CPIs wrapper 41 (needs materialized 0) -> 21 while any remains; amount 0 never reaches 41 -> 31.
 * Bytes: swordcat-c4 (Resolved v2.2), codec / sol-lp v2.2 portfolios, the chillhouse v5 pool + vault-LP state, the solcat
 * registry; the pool and the asset-0 insurance authority are re-pointed at the keeper's configured program ids.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveLpVaultRegistry, deriveStakePool, deriveStakeVaultAuth, parsePortfolioV17 } from "@percolatorct/sdk";
import { asset0InsuranceAuthority, creatorCollateralAta, decodeTerminalState, isTerminalFlat, makeTerminalInsuranceJob, TerminalInsuranceState, terminalInsuranceConfigFromEnv } from "./terminal-insurance.ts";
import { runFeeJobSweep } from "./fee-jobs.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { decodeStakePoolAnyVersion } from "./stake-pool-decode.ts";
import { STAKE_PROGRAM_ID, WRAPPER_PROGRAM_ID } from "../program-ids.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", `${n}.b64`), "utf8").trim(), "base64");
const W = WRAPPER_PROGRAM_ID;
const STAKE = STAKE_PROGRAM_ID;
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const KEEPER = Keypair.generate();
const G = 592, MODE = G + 674, BUDGET = G + 509, MAT = G + 565, RSLOT = G + 675, CTOT = G + 365; // market-state.ts GROUP_V19
const FCD = 216_000n; // swordcat-c4 force_close_delay_slots

const u128w = (b: Buffer, o: number, v: bigint) => { b.writeBigUInt64LE(v & 0xffff_ffff_ffff_ffffn, o); b.writeBigUInt64LE(v >> 64n, o + 8); };
const le128 = (v: bigint) => { const b = Buffer.alloc(16); u128w(b, 0, v); return b; };
function replaceAll(b: Buffer, from: PublicKey, to: PublicKey) {
  for (let i = b.indexOf(from.toBuffer()); i >= 0; i = b.indexOf(from.toBuffer(), i + 32)) to.toBuffer().copy(b, i);
}

type Pf = { key: PublicKey; data: Buffer; owner: PublicKey; claim: boolean; lp: boolean; lpSettled: boolean };
function mkPf(src: string, key: PublicKey, owner: PublicKey, lp = false): Pf {
  const b = Buffer.from(fx(src));
  replaceAll(b, parsePortfolioV17(new Uint8Array(b)).owner, owner);
  const p = parsePortfolioV17(new Uint8Array(b));
  assert.ok(p.owner.equals(owner));
  return { key, data: b, owner, claim: p.capital !== 0n || p.pnl !== 0n || p.legs.some((l) => l.active), lp, lpSettled: false };
}
/** Zero capital / pnl in the bytes, as the chain does on a resolved close. */
function emptyClaim(pf: Pf) {
  const p = parsePortfolioV17(new Uint8Array(pf.data));
  for (const v of [p.capital, BigInt.asUintN(128, p.pnl)]) if (v) { const i = pf.data.indexOf(le128(v)); assert.ok(i >= 0); pf.data.fill(0, i, i + 16); }
  pf.claim = false;
}

class Chain {
  slot: bigint;
  pfs = new Map<string, Pf>();
  results = new Map<string, unknown>();
  sent: string[] = [];
  calls = 0;
  booked = 0n;
  n = 0;
  /** Maintenance fee a CloseResolved credits back into the asset-0 budget (v16_program.rs credit_maintenance_fee_to_active_market_budgets_view). */
  fee = 0n;
  /** Runs once right after the keeper's next [market, pool] read: owners acting between that read and the keeper's sends. */
  afterRead: ((c: Chain) => void) | null = null;
  lpStateKey: PublicKey;
  registryKey: PublicKey;
  constructor(public key: PublicKey, public market: Buffer, public pool: Buffer | null, public lpState: Buffer, public junior: PublicKey) {
    this.slot = this.resolvedSlot();
    this.lpStateKey = deriveVaultLpState(W, key);
    this.registryKey = decodeVaultLpState(new Uint8Array(lpState))!.registry;
  }
  resolvedSlot() { return this.market.readBigUInt64LE(RSLOT); }
  mat() { return this.market.readBigUInt64LE(MAT); }
  sync() {
    this.market.writeBigUInt64LE(BigInt(this.pfs.size), MAT);
    u128w(this.market, CTOT, BigInt([...this.pfs.values()].filter((p) => p.claim).length) * 1_000_000n);
  }
  clone(): Chain {
    const c = Object.create(Chain.prototype) as Chain;
    Object.assign(c, this);
    c.market = Buffer.from(this.market);
    c.pfs = new Map([...this.pfs].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }]));
    return c;
  }
  /** Apply `tx` to `s` (a clone); the first failing instruction's error, or null. */
  static exec(s: Chain, tx: VersionedTransaction): unknown {
    const keys = tx.message.staticAccountKeys;
    let idx = -1;
    for (const ix of tx.message.compiledInstructions) {
      idx++;
      const pid = keys[ix.programIdIndex];
      const acc = (i: number) => keys[ix.accountKeyIndexes[i]];
      const d = Buffer.from(ix.data);
      const fail = (code: number) => ({ InstructionError: [idx, { Custom: code }] });
      const inDelay = s.slot - s.resolvedSlot() < FCD;
      if (pid.equals(ComputeBudgetProgram.programId) || pid.equals(ATA)) continue;
      if (pid.equals(STAKE)) {
        const amount = d.readBigUInt64LE(1);
        if (s.market[MODE] !== 1) return fail(30);
        if (amount === 0n) return fail(31);
        if (s.mat() > 0n) return fail(21);
        s.market.writeBigUInt64LE(s.market.readBigUInt64LE(BUDGET) - amount, BUDGET);
        s.booked += amount;
        continue;
      }
      if (!pid.equals(W)) return fail(99);
      if (d[0] === 30) {
        const pf = s.pfs.get(acc(2).toBase58());
        if (!pf) return fail(14);
        if (inDelay) return fail(6);
        if (!pf.claim) return fail(21);
        emptyClaim(pf); s.market.writeBigUInt64LE(s.market.readBigUInt64LE(BUDGET) + s.fee, BUDGET); s.sync();
      } else if (d[0] === 8) {
        const pf = s.pfs.get(acc(2).toBase58());
        if (!pf) return fail(14);
        if (!acc(3).equals(pf.owner)) return fail(8);
        if (pf.claim || (pf.lp && !pf.lpSettled)) return fail(21);
        s.pfs.delete(pf.key.toBase58()); s.sync();
      } else if (d[0] === 101) {
        const pf = s.pfs.get(acc(4).toBase58());
        if (!pf || !pf.lp) return fail(14);
        if (d[1] === 1) return fail(21);
        if (inDelay && !acc(0).equals(s.junior)) return fail(8);
        if (pf.lpSettled) return fail(21);
        pf.lpSettled = true; emptyClaim(pf); s.sync();
      } else return fail(21); // 46: nothing to top up
    }
    return null;
  }
  conn(): unknown {
    const self = this;
    const acct = (data: Buffer, owner: PublicKey) => ({ data, owner, lamports: 1_000_000, executable: false });
    const [poolKey] = deriveStakePool(self.key, STAKE);
    const view = self.pool ? decodeStakePoolAnyVersion(new Uint8Array(self.pool)) : null;
    const creator = view ? creatorCollateralAta(view.admin, view.collateralMint) : null;
    const lpRegistry = deriveLpVaultRegistry(W, self.key)[0];
    const one = (k: PublicKey) => {
      if (k.equals(self.key)) return acct(self.market, W);
      if (k.equals(poolKey)) return self.pool ? acct(self.pool, STAKE) : null;
      const pf = self.pfs.get(k.toBase58());
      if (pf) return acct(pf.data, W);
      if (k.equals(self.lpStateKey)) return acct(self.lpState, W);
      if (k.equals(self.registryKey)) return acct(fx("solcat-lp-vault-registry-v18"), W);
      if (k.equals(lpRegistry)) return null; // the tag-78 harvest sees no registry: "skipped"
      if (creator && k.equals(creator)) { const b = Buffer.alloc(165); view!.collateralMint.toBuffer().copy(b, 0); view!.admin.toBuffer().copy(b, 32); b[108] = 1; return acct(b, TOKEN); }
      return acct(Buffer.alloc(165), TOKEN); // owner ATAs exist
    };
    const call = <T>(v: T): T => { self.calls++; return v; };
    return {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        const out = keys.map((k) => { const a = one(k); return a && k.equals(self.key) ? { ...a, data: Buffer.from(a.data) } : a; });
        if (keys.length === 2 && self.afterRead) { const f = self.afterRead; self.afterRead = null; f(self); }
        return call(out);
      },
      async getAccountInfo(k: PublicKey) { return call(one(k)); },
      async getProgramAccounts() { return call([...self.pfs.values()].map((p) => ({ pubkey: p.key, account: acct(Buffer.from(p.data), W) }))); },
      async getSlot() { return call(Number(self.slot)); },
      async getLatestBlockhash() { return call({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }); },
      async getBlockHeight() { return call(1); },
      async getTokenAccountsByOwner() { return call({ context: { slot: 1 }, value: [] }); },
      async simulateTransaction(tx: VersionedTransaction, o?: { accounts?: { addresses: string[] } }) {
        const c = self.clone();
        const err = Chain.exec(c, tx);
        const accounts = o?.accounts?.addresses.map((a) => { const p = c.pfs.get(a); return p ? { data: [p.data.toString("base64"), "base64"] } : null; });
        return call({ context: { slot: Number(self.slot) }, value: { err, logs: [], accounts } });
      },
      async sendRawTransaction(raw: Buffer) {
        const c = self.clone();
        const err = Chain.exec(c, VersionedTransaction.deserialize(raw));
        const sig = `5ig${(++self.n).toString().padStart(60, "1")}`;
        self.results.set(sig, err);
        if (!err) { self.market = c.market; self.pfs = c.pfs; self.booked = c.booked; self.sent.push(sig); }
        return call(sig);
      },
      async confirmTransaction(a: { signature: string }) { return call({ context: { slot: 2 }, value: { err: self.results.get(a.signature) ?? null } }); },
      async getSignatureStatuses(sigs: string[]) { return call({ context: { slot: 2 }, value: sigs.map((s) => ({ slot: 2, confirmations: 1, err: self.results.get(s) ?? null, confirmationStatus: "confirmed" })) }); },
    };
  }
}

const MKT = new PublicKey("8LkVb7BuVzQX6qjE4P4XSEqzJmYuoGPEpiQV9u9oAjmH");
/** `bound`: the pool exists for MKT and the asset-0 insurance authority is its vault_auth. "pool-only": the pool exists, the authority is someone else's. */
function chain(o: { budget: bigint; pool: "bound" | "pool-only" | "none"; withPortfolios?: boolean }): Chain {
  const m = Buffer.from(fx("swordcat-c4-resolved-v22"));
  u128w(m, BUDGET, o.budget);
  let pool: Buffer | null = null;
  if (o.pool !== "none") {
    pool = Buffer.from(fx("v22-chillhouse-stake-pool-v5"));
    const v = decodeStakePoolAnyVersion(new Uint8Array(pool));
    replaceAll(pool, v.slab, MKT);
    replaceAll(pool, v.percolatorProgram, W);
  }
  const auth = asset0InsuranceAuthority(new Uint8Array(m))!;
  replaceAll(m, auth, o.pool === "bound" ? deriveStakeVaultAuth(deriveStakePool(MKT, STAKE)[0], STAKE)[0] : Keypair.generate().publicKey);
  const lpState = Buffer.from(fx("v22-chillhouse-vault-lp-state"));
  const st = decodeVaultLpState(new Uint8Array(lpState))!;
  const ch = new Chain(MKT, m, pool, lpState, st.juniorOwner);
  if (o.withPortfolios !== false) {
    for (const p of [
      mkPf("v22-codec-pf-5sx1tsw1", Keypair.generate().publicKey, Keypair.generate().publicKey),
      mkPf("v22-codec-pf-6UW2ecEZ", Keypair.generate().publicKey, Keypair.generate().publicKey),
      mkPf("v22-sol-lp-portfolio-v19", st.lpPortfolio, deriveLpVaultRegistry(W, MKT)[0], true),
    ]) ch.pfs.set(p.key.toBase58(), p);
  }
  ch.sync();
  return ch;
}

const CFG = terminalInsuranceConfigFromEnv({});
CFG.confirm = { statusRetries: 1, statusRetryDelayMs: 0 };

type Row = { kind: string; left: number; flat: boolean; done: boolean; calls: number; sends: number };
/** One fee-job cycle per entry (slots after resolve); `restart` builds a fresh job (fresh per-process state) first. */
async function cycles(ch: Chain, plan: Array<{ elapsed: bigint; restart?: boolean }>): Promise<Row[]> {
  let st = new TerminalInsuranceState();
  let job = makeTerminalInsuranceJob(CFG, st);
  const rows: Row[] = [];
  for (const p of plan) {
    if (p.restart) { st = new TerminalInsuranceState(); job = makeTerminalInsuranceJob(CFG, st); }
    ch.slot = ch.resolvedSlot() + p.elapsed;
    const calls0 = ch.calls, sends0 = ch.sent.length;
    const r = await runFeeJobSweep(job, { conn: ch.conn() as never, keeper: KEEPER, dryRun: false }, [{ marketAddress: MKT.toBase58(), label: "MKT" }]);
    const kind = r.done.length ? "done" : r.blocked.length ? "blocked" : r.skipped.length ? "skipped" : r.failed.length ? `failed: ${r.failed[0].error}` : "nothing";
    rows.push({ kind, left: ch.pfs.size, flat: isTerminalFlat(decodeTerminalState(new Uint8Array(ch.market))), done: st.done.has(MKT.toBase58()), calls: ch.calls - calls0, sends: ch.sent.length - sends0 });
  }
  return rows;
}
const PLAN = [{ elapsed: 10n }, { elapsed: FCD - 1n }, { elapsed: FCD }, { elapsed: FCD + 1n }, { elapsed: FCD + 2n }];

describe("A6-1 resolved cleanup keeps running until nothing is materialized (real fee-job path)", () => {
  it("stake-bound, budget 0: tag 29(0) = 31 inside the delay does NOT latch done; after the delay everything closes, then done, then no RPC", async () => {
    const ch = chain({ budget: 0n, pool: "bound" });
    const rows = await cycles(ch, PLAN);
    assert.equal(rows[0].done, false, "31 with 3 portfolios materialized is not done");
    assert.equal(rows[0].kind, "skipped");
    assert.deepEqual([rows[0].left, rows[1].left], [3, 3], "inside the delay nothing with a claim can close");
    assert.equal(rows[2].left, 0, "first cycle after the delay: traders paid + closed, vault LP 101 + 8");
    assert.ok(rows[2].flat && rows[2].done, "flat, then tag 29(0) = 31 -> done");
    assert.deepEqual([rows[3].calls, rows[4].calls], [0, 0], "a done market costs no RPC");
  });

  it("stake-bound, budget 0: a restart inside the delay changes nothing", async () => {
    const rows = await cycles(chain({ budget: 0n, pool: "bound" }), [{ elapsed: 10n }, { elapsed: 20n, restart: true }, { elapsed: FCD }]);
    assert.deepEqual(rows.map((r) => r.done), [false, false, true]);
    assert.equal(rows[2].left, 0);
  });

  for (const pool of ["none", "pool-only"] as const) {
    it(`not stake-bound (${pool === "none" ? "no stake pool, :420" : "pool exists, authority not its vault_auth, :426"}): the main cleanup runs and closes everything after the delay`, async () => {
      const ch = chain({ budget: 0n, pool });
      const rows = await cycles(ch, PLAN);
      assert.equal(rows[0].kind, "skipped");
      assert.equal(rows[1].left, 3);
      assert.equal(rows[2].kind, "done");
      assert.equal(rows[2].left, 0);
      assert.ok(rows[2].flat);
      assert.equal(ch.booked, 0n, "no tag 29 without a bound pool");
      assert.deepEqual([rows[3].calls, rows[4].calls], [1, 1], "flat and unbound: one market read per cycle, no scan");
    });
  }

  it("control: stake-bound, budget > 0: blocked until the delay, then closes all, books the budget, done", async () => {
    const ch = chain({ budget: 1_000_000n, pool: "bound" });
    const rows = await cycles(ch, PLAN);
    assert.equal(rows[0].kind, "blocked");
    assert.equal(rows[0].done, false);
    assert.equal(rows[2].left, 0);
    assert.ok(rows[2].done);
    assert.equal(ch.booked, 1_000_000n);
    assert.equal(rows[3].calls, 0);
  });

  it("owners close everything (CloseResolved credits a fee) between the keeper's read and its tag 41: no done on that stale view; the fee is booked next cycle", async () => {
    const ch = chain({ budget: 1_000_000n, pool: "bound" });
    ch.fee = 600n;
    ch.afterRead = (c) => {
      for (const p of [...c.pfs.values()]) {
        if (!p.lp) c.market.writeBigUInt64LE(c.market.readBigUInt64LE(BUDGET) + c.fee, BUDGET);
        c.pfs.delete(p.key.toBase58());
      }
      c.sync();
    };
    const rows = await cycles(ch, [{ elapsed: FCD }, { elapsed: FCD + 1n }, { elapsed: FCD + 2n }]);
    assert.equal(rows[0].done, false, "1,000,000 landed, but this cycle's view (3 portfolios, budget 1,000,000) was stale");
    assert.ok(rows[1].done);
    assert.equal(ch.booked, 1_001_200n, "the two credited fees are booked too");
    assert.equal(ch.market.readBigUInt64LE(BUDGET), 0n);
  });

  it("control: stake-bound, already terminal-flat: done on the first cycle, then no RPC", async () => {
    const rows = await cycles(chain({ budget: 0n, pool: "bound", withPortfolios: false }), PLAN.slice(0, 3));
    assert.ok(rows[0].flat && rows[0].done);
    assert.deepEqual([rows[1].calls, rows[2].calls], [0, 0]);
  });
});
