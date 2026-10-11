/**
 * K-8 (fresh v2.2 devnet, 2026-10-12): after an ADL a side is left ResetPending (OI 0) and the engine refuses every
 * risk-increasing trade (120) until tag 45 FinalizeResetSide runs. The keeper's auto-repair read v2.2 markets at v2.1
 * offsets (48 B early) AND was skipped on v2.2 layouts, so JUP GtUe5hYy… had to be repaired by hand (4QeoiYb9…).
 *
 * Fixture: the real JUP GtUe5hYy… VERSION-19 account (4,059 B), read 2026-10-12 after the manual repair (both sides
 * Normal, stored/stale/pending 0). The stuck state is recreated by writing mode_short = ResetPending (2) at the
 * VERSION-19 offset, which is exactly what the engine left before 4QeoiYb9….
 *
 * Run with: node --import tsx/esm --test src/cross-cluster/k8-liveness-repair-v22.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  SIDE_MODE_RESET_PENDING,
  BUCKET_FRESH,
  buildFinalizeResetSideIx,
  decodeLivenessState,
  livenessOffsetsFor,
  livenessOffsetsV21,
  planLivenessRepairs,
} from "./liveness-repair.ts";
import { detectLayout } from "./market-layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const JUP = new Uint8Array(Buffer.from(readFileSync(join(here, "__fixtures__", "v22-jup2-market-v19.b64"), "utf8").trim(), "base64"));
const NOW = 510_200_000n;

const det = detectLayout(JUP);
assert.ok(det.known);
const O22 = livenessOffsetsFor(det.layout)!;

function stuckShort(): Uint8Array {
  const d = new Uint8Array(JUP);
  d[O22.engineBase + O22.modeShort] = SIDE_MODE_RESET_PENDING;
  return d;
}

describe("K-8: liveness repair on a VERSION-19 market", () => {
  it("v2.2 offsets: engine slot at 592 + 806 + 1,024 = 2,422; mode 513/514; barrier 691/699; backing 1,075/1,172", () => {
    assert.equal(det.layout.id, "v2.2-b");
    assert.deepEqual(
      [O22.engineBase, O22.modeLong, O22.modeShort, O22.barrierLong, O22.barrierShort, O22.backingLong, O22.backingShort],
      [2422, 513, 514, 691, 699, 1075, 1172],
    );
    assert.equal(livenessOffsetsV21().engineBase, 2374, "v2.1: 48 B earlier");
  });

  it("the real (repaired) JUP account decodes both sides Normal with 0 stored / stale / pending, and needs no repair", () => {
    const s = decodeLivenessState(JUP);
    for (const side of s.sides) assert.deepEqual([side.mode, side.storedPos, side.stale, side.pendingObligations], [0, 0n, 0n, 0n]);
    assert.deepEqual(planLivenessRepairs(s, NOW), []);
  });

  it("a ResetPending short side (the post-ADL JUP state) is detected and planned as tag 45 [45, 0, 0, 1] on the market", () => {
    const plan = planLivenessRepairs(decodeLivenessState(stuckShort()), NOW);
    assert.deepEqual(plan, [{ kind: "finalize", assetIndex: 0, side: 1 }]);
    const market = new PublicKey("GtUe5hYy8scuMsp2cmXt7WfCfqKVgTJ8RjuTyvz3MB8B");
    const ix = buildFinalizeResetSideIx(market, 0, 1);
    assert.deepEqual([...ix.data], [45, 0, 0, 1]);
    assert.equal(ix.keys.length, 1);
    assert.ok(ix.keys[0].pubkey.equals(market) && ix.keys[0].isWritable && !ix.keys[0].isSigner);
  });

  it("NEGATIVE CONTROL: the old v2.1 offsets read the same stuck bytes as a Normal market (no repair, the K-8 bug)", () => {
    const s = decodeLivenessState(stuckShort(), 0, livenessOffsetsV21());
    assert.deepEqual(planLivenessRepairs(s, NOW), []);
  });

  it("NEGATIVE CONTROL: ResetPending with a stored position left is NOT finalized (the engine gate is mirrored)", () => {
    const d = stuckShort();
    new DataView(d.buffer).setBigUint64(O22.engineBase + O22.storedPosShort, 1n, true);
    assert.deepEqual(planLivenessRepairs(decodeLivenessState(d), NOW), []);
  });

  it("a lapsed Fresh backing bucket on v2.2 is planned as tag 89 (same offsets fix)", () => {
    const d = new Uint8Array(JUP);
    const b = O22.engineBase + O22.backingShort;
    d[b + 96] = BUCKET_FRESH;
    new DataView(d.buffer).setBigUint64(b + 88, NOW - 10n, true);
    assert.deepEqual(planLivenessRepairs(decodeLivenessState(d), NOW), [{ kind: "expire", domain: 1 }]);
  });

  it("NEGATIVE CONTROL: an unknown layout throws instead of decoding at a guessed offset", () => {
    const d = new Uint8Array(JUP);
    new DataView(d.buffer).setUint16(8, 20, true);
    assert.throws(() => decodeLivenessState(d), /unknown market layout|no SDK/);
  });
});

describe("K-8: the cranker sends tag 45 on a v2.2 market (was skipped on v2.2 layouts)", () => {
  // Imported lazily so the decoder tests above do not depend on the cranker module graph.
  it("crankAllOnce on the stuck JUP bytes puts FinalizeResetSide(short) in the crank tx", async () => {
    const { Keypair, Transaction } = await import("@solana/web3.js");
    const { crankAllOnce } = await import("./recovery-cranker.ts");
    const { WRAPPER_PROGRAM_ID } = await import("../program-ids.ts");
    const market = new PublicKey("GtUe5hYy8scuMsp2cmXt7WfCfqKVgTJ8RjuTyvz3MB8B");
    const lp = PublicKey.unique();
    const run = async (bytes: Uint8Array) => {
      const sent: InstanceType<typeof Transaction>[] = [];
      const conn = {
        async getAccountInfoAndContext() { return { context: { slot: Number(NOW) }, value: { data: Buffer.from(bytes) } }; },
        async getMultipleAccountsInfoAndContext() { return { context: { slot: Number(NOW) }, value: [{ data: Buffer.from(bytes) }] }; },
        async getAccountInfo() { return { data: Buffer.from(bytes) }; },
        async getProgramAccounts() { return []; },
        async getSlot() { return Number(NOW); },
        async getLatestBlockhash() { return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }; },
        async simulateTransaction() { return { context: { slot: Number(NOW) }, value: { err: null, logs: [], accounts: null } }; },
        async sendRawTransaction(raw: Buffer) { sent.push(Transaction.from(raw)); return "sig" + sent.length; },
      };
      await crankAllOnce(conn as never, Keypair.generate(), { markets: [{ marketAddress: market.toBase58(), label: "JUP", lpPortfolio: lp.toBase58() }] } as never, false);
      return sent.flatMap((t) => t.instructions.filter((ix) => ix.programId.equals(WRAPPER_PROGRAM_ID)).map((ix) => [...ix.data.subarray(0, 4)]));
    };
    const stuck = await run(stuckShort());
    assert.ok(stuck.some((d) => d[0] === 45 && d[1] === 0 && d[2] === 0 && d[3] === 1), `wrapper ixs: ${JSON.stringify(stuck)}`);
    // NEGATIVE CONTROL: the healthy (repaired) bytes get no tag 45.
    const healthy = await run(JUP);
    assert.ok(!healthy.some((d) => d[0] === 45), `wrapper ixs: ${JSON.stringify(healthy)}`);
  });
});
