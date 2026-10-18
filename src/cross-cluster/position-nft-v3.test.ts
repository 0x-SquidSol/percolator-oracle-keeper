/**
 * Position NFT layout v3 (S1-2, percolator-nft 95dcece; offsets from percolator-sdk#414 specs/nft-parity.json:
 * position_nft_len 239, portfolio_market_group 199, portfolio_id_at_mint 231, last_holder 167): decode and holder lookup.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { POSITION_NFT_LEN, POSITION_NFT_LEN_LEGACY, decodePositionNft, positionNftFor } from "./resolved-portfolio-cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NFT = new PublicKey("27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1");
const legacyRecord = (): Buffer => Buffer.from(readFileSync(join(here, "__fixtures__", "escrowed-position-nft-record.b64"), "utf8").trim(), "base64");
const GROUP = new PublicKey(new Uint8Array(32).fill(4));
const OTHER_GROUP = new PublicKey(new Uint8Array(32).fill(5));

/** A v3 record: the real legacy record with version 3 and the incarnation appended (parity offsets 199 / 231). */
function v3Record(group: PublicKey, id: bigint, holder?: PublicKey): Buffer {
  const b = Buffer.concat([legacyRecord(), Buffer.alloc(40)]);
  b[8] = 3;
  group.toBuffer().copy(b, 199);
  b.writeBigUInt64LE(id, 231);
  if (holder) holder.toBuffer().copy(b, 167);
  return b;
}
function conn(records: Buffer[]): Pick<Connection, "getProgramAccounts"> {
  return {
    getProgramAccounts: (async (_p: PublicKey, cfg?: { filters?: Array<{ dataSize?: number }> }) => {
      const size = cfg?.filters?.[0]?.dataSize;
      return records.filter((r) => r.length === size).map((r, i) => ({ pubkey: new PublicKey(new Uint8Array(32).fill(60 + i)), account: { data: r, owner: NFT, lamports: 1, executable: false } }));
    }) as unknown as Connection["getProgramAccounts"],
  };
}

describe("PositionNft v3 (239 B)", () => {
  const legacy = decodePositionNft(new Uint8Array(legacyRecord()))!;
  const PF = legacy.portfolio;
  it("lengths and decode: v3 reads the incarnation, legacy has none, other lengths are refused", () => {
    assert.equal(POSITION_NFT_LEN, 239);
    assert.equal(POSITION_NFT_LEN_LEGACY, 199);
    const d = decodePositionNft(new Uint8Array(v3Record(GROUP, 7n)))!;
    assert.ok(d.marketGroup!.equals(GROUP));
    assert.equal(d.portfolioIdAtMint, 7n);
    assert.ok(d.holder.equals(legacy.holder) && d.nftMint.equals(legacy.nftMint) && d.portfolio.equals(PF));
    assert.equal(legacy.marketGroup, null);
    assert.equal(decodePositionNft(new Uint8Array(238)), null);
    assert.equal(decodePositionNft(new Uint8Array(240)), null);
  });
  it("positionNftFor: the v3 record matching the live incarnation is the holder", async () => {
    const holder = new PublicKey(new Uint8Array(32).fill(9));
    const r = await positionNftFor(conn([v3Record(GROUP, 7n, holder)]), NFT, PF, { marketGroup: GROUP, portfolioId: 7n });
    assert.equal(r?.holder, holder.toBase58());
  });
  it("positionNftFor: a stale v3 record (re-created portfolio: other id or group) is not the holder; picks the live one", async () => {
    const live = new PublicKey(new Uint8Array(32).fill(8));
    const stale = new PublicKey(new Uint8Array(32).fill(9));
    const c = conn([v3Record(GROUP, 6n, stale), v3Record(OTHER_GROUP, 7n, stale), v3Record(GROUP, 7n, live)]);
    assert.equal((await positionNftFor(c, NFT, PF, { marketGroup: GROUP, portfolioId: 7n }))?.holder, live.toBase58());
    const onlyStale = conn([v3Record(GROUP, 6n, stale)]);
    assert.equal(await positionNftFor(onlyStale, NFT, PF, { marketGroup: GROUP, portfolioId: 7n }), null, "no live NFT -> holder unknown (escrow owner path only)");
    assert.equal(await positionNftFor(conn([v3Record(GROUP, 0n)]), NFT, PF, { marketGroup: GROUP, portfolioId: 0n }), null, "id 0 never binds");
  });
  it("positionNftFor: a legacy 199 B record is the fallback when no v3 record matches; never throws", async () => {
    const r = await positionNftFor(conn([legacyRecord()]), NFT, PF, { marketGroup: GROUP, portfolioId: 7n });
    assert.equal(r?.holder, legacy.holder.toBase58());
    const boom = { getProgramAccounts: async () => { throw new Error("429"); } } as unknown as Pick<Connection, "getProgramAccounts">;
    assert.equal(await positionNftFor(boom, NFT, PF), null);
  });
  it("positionNftFor queries BOTH dataSizes (239 and 199) with portfolio_account @10", async () => {
    const seen: Array<unknown[]> = [];
    const spy = { getProgramAccounts: (async (_p: PublicKey, cfg: { filters: unknown[] }) => { seen.push(cfg.filters); return []; }) as unknown as Connection["getProgramAccounts"] };
    await positionNftFor(spy, NFT, PF);
    assert.deepEqual(seen.map((f) => (f[0] as { dataSize: number }).dataSize).sort(), [199, 239]);
    for (const f of seen) assert.deepEqual(f[1], { memcmp: { offset: 10, bytes: PF.toBase58() } });
  });
});
