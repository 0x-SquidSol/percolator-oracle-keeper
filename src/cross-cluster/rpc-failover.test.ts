import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS_HASH,
  RpcFailover,
  failoverFromEnv,
  parseFallbackUrls,
  redactText,
  redactUrl,
  registerRpcFailover,
  rpcFailoverHealth,
  type FetchLike,
} from "../rpc-failover.ts";

const SECRET = "SUPERSECRETKEY1234567890";
const P = `https://devnet.helius-rpc.com/?api-key=${SECRET}`;
const F1 = "https://api.devnet.solana.com";
const F2 = `https://fallback2.example.com/${SECRET}ab`;

interface Host {
  status?: number; // HTTP status for normal calls
  body?: string;
  throwNet?: boolean;
  throwOnCall?: boolean; // network error on real calls only; probes succeed
  genesis?: string;
  slot?: number;
}

/** Scripted transport keyed by URL. Records every (url, method) it sees. */
function makeNet(hosts: Record<string, Host>) {
  const calls: Array<{ url: string; method: string }> = [];
  const base: FetchLike = async (input, init) => {
    const url = String(input);
    const h = hosts[url];
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    calls.push({ url, method });
    if (!h || h.throwNet) throw new Error(`ECONNRESET ${url}`);
    if (h.throwOnCall && method !== "getGenesisHash" && method !== "getSlot") throw new Error(`ECONNRESET ${url}`);
    if (method === "getGenesisHash" || method === "getSlot") {
      if (h.status && h.status !== 200) return new Response(h.body ?? "x", { status: h.status });
      const result = method === "getGenesisHash" ? (h.genesis ?? GENESIS_HASH.devnet) : (h.slot ?? 1000);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }
    return new Response(h.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, result: `ok:${url}` }), { status: h.status ?? 200 });
  };
  return { base, calls, hosts };
}

function mk(hosts: Record<string, Host>, urls: string[], extra: Partial<ConstructorParameters<typeof RpcFailover>[0]> = {}) {
  const net = makeNet(hosts);
  let t = 1_000_000;
  const logs: string[] = [];
  const f = new RpcFailover({ cluster: "devnet", urls, base: net.base, now: () => t, log: (l) => logs.push(l), ...extra });
  return { f, net, logs, tick: (ms: number) => (t += ms) };
}

const call = (f: RpcFailover, method = "getBalance") =>
  f.fetch(P, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
const who = async (r: Response) => ((await r.json()) as { result: string }).result;

describe("rpc-failover: rotation", () => {
  it("primary healthy: serves from primary, status ok", async () => {
    const { f } = mk({ [P]: {}, [F1]: {} }, [P, F1]);
    assert.equal(await who(await call(f)), `ok:${P}`);
    assert.equal(f.snapshot().status, "ok");
    assert.equal(f.snapshot().activeIndex, 0);
  });

  it("429 on the primary -> request is served by the fallback, health says rpc-degraded + active", async () => {
    const { f, net } = mk({ [P]: { status: 429, body: "max usage reached" }, [F1]: {} }, [P, F1]);
    const r = await call(f);
    assert.equal(r.status, 200);
    assert.equal(await who(r), `ok:${F1}`);
    const s = f.snapshot();
    assert.equal(s.status, "rpc-degraded");
    assert.equal(s.reason, "on-fallback");
    assert.equal(s.activeIndex, 1);
    assert.equal(s.active, "https://api.devnet.solana.com");
    // sends go through the same seam
    const send = await call(f, "sendTransaction");
    assert.equal(await who(send), `ok:${F1}`);
    assert.ok(net.calls.some((c) => c.url === F1 && c.method === "sendTransaction"));
  });

  it("403 'max usage reached' body is also treated as quota", async () => {
    const { f } = mk({ [P]: { status: 403, body: '{"error":"max usage reached"}' }, [F1]: {} }, [P, F1]);
    assert.equal(await who(await call(f)), `ok:${F1}`);
  });

  it("a network error on a real call (probes fine) fails over for that call; status rpc-degraded", async () => {
    const { f } = mk({ [P]: { throwOnCall: true }, [F1]: {} }, [P, F1]);
    assert.equal(await who(await call(f)), `ok:${F1}`);
    assert.equal(f.snapshot().activeIndex, 1);
    assert.equal(f.snapshot().status, "rpc-degraded");
  });

  it("an endpoint that cannot even be probed (network errors) is marked down with a redacted reason", async () => {
    const { f } = mk({ [P]: { throwNet: true }, [F1]: {} }, [P, F1]);
    assert.equal(await who(await call(f)), `ok:${F1}`);
    const e = f.snapshot().endpoints[0];
    assert.equal(e.state, "down");
    assert.match(e.lastError ?? "", /network: ECONNRESET/);
  });

  it("skips a down fallback and uses the next one (ordered)", async () => {
    const { f } = mk({ [P]: { status: 429 }, [F1]: { status: 429 }, [F2]: {} }, [P, F1, F2]);
    assert.equal(await who(await call(f)), `ok:${F2}`);
    assert.equal(f.snapshot().activeIndex, 2);
  });
});

describe("rpc-failover: primary recovery", () => {
  it("re-probes the primary after the cooldown and switches back once it passes", async () => {
    const { f, net, tick } = mk({ [P]: { status: 429 }, [F1]: {} }, [P, F1], { primaryRetryMs: 30_000, backoffBaseMs: 2_000 });
    await call(f);
    assert.equal(f.snapshot().activeIndex, 1);
    net.hosts[P] = {}; // quota restored
    tick(60_000);
    await call(f); // triggers the background probe
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.snapshot().activeIndex, 0);
    assert.equal(f.snapshot().status, "ok");
    assert.equal(await who(await call(f)), `ok:${P}`);
  });

  it("does not hammer a still-broken primary (probe cadence + exponential cooldown)", async () => {
    const { f, net, tick } = mk({ [P]: { status: 429 }, [F1]: {} }, [P, F1], { primaryRetryMs: 30_000 });
    await call(f);
    const probes = () => net.calls.filter((c) => c.url === P && c.method === "getGenesisHash").length;
    for (let i = 0; i < 20; i++) {
      tick(1_000);
      await call(f);
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.ok(probes() <= 2, `primary probed ${probes()} times in 20s`);
  });
});

describe("rpc-failover: all endpoints down", () => {
  it("backs off with a capped exponential cooldown, fails fast, never throws out of band, reports all-endpoints-down", async () => {
    const { f, net, tick, logs } = mk({ [P]: { status: 429 }, [F1]: { status: 429 } }, [P, F1], { backoffBaseMs: 2_000, backoffMaxMs: 20_000 });
    await assert.rejects(call(f), /rpc-degraded/); // probes 429: nothing usable, fail fast (thrown, no retry storm)
    assert.equal(f.snapshot().reason, "all-endpoints-down");
    assert.ok(logs.some((l) => /ALL ENDPOINTS DOWN/.test(l)));
    // inside the cooldown: no network traffic at all, fast failure
    const before = net.calls.length;
    await assert.rejects(call(f), /rpc-degraded: all devnet RPC endpoints are down/);
    assert.equal(net.calls.length, before);
    // cooldowns double and cap at backoffMaxMs
    const downFor: number[] = [];
    for (let i = 0; i < 8; i++) {
      tick(25_000);
      await call(f).catch(() => undefined);
      downFor.push(f.snapshot().endpoints[0].downForMs);
    }
    assert.ok(downFor.every((d) => d <= 20_000), `cap exceeded: ${downFor.join(",")}`);
    assert.equal(Math.max(...downFor), 20_000);
  });

  it("recovers when an endpoint comes back after the cooldown", async () => {
    const { f, net, tick } = mk({ [P]: { status: 429 }, [F1]: { status: 429 } }, [P, F1], { backoffBaseMs: 2_000 });
    await call(f).catch(() => undefined);
    net.hosts[F1] = {};
    tick(10_000);
    assert.equal(await who(await call(f)), `ok:${F1}`);
    assert.equal(f.snapshot().reason, "on-fallback");
  });
});

describe("rpc-failover: cluster check per endpoint", () => {
  it("a fallback on the wrong cluster is refused and never carries traffic", async () => {
    const { f, net, logs } = mk(
      { [P]: { status: 429 }, [F1]: { genesis: GENESIS_HASH.mainnet } }, // F1 is actually mainnet
      [P, F1],
    );
    await assert.rejects(call(f), /rpc-degraded/);
    assert.equal(f.snapshot().endpoints[1].state, "refused");
    assert.ok(logs.some((l) => /REFUSED \(cluster mismatch/.test(l)));
    assert.ok(!net.calls.some((c) => c.url === F1 && c.method !== "getGenesisHash"), "no non-probe traffic to the wrong cluster");
    // permanent: not re-vetted later
    const n = net.calls.filter((c) => c.url === F1).length;
    await call(f).catch(() => undefined);
    assert.equal(net.calls.filter((c) => c.url === F1).length, n);
  });

  it("a wrong-cluster PRIMARY is refused too", async () => {
    const { f } = mk({ [P]: { genesis: GENESIS_HASH.mainnet }, [F1]: {} }, [P, F1]);
    assert.equal(await who(await call(f)), `ok:${F1}`);
    assert.equal(f.snapshot().endpoints[0].state, "refused");
  });
});

describe("rpc-failover: slot freshness", () => {
  it("a fallback lagging more than maxSlotLag behind the best seen slot is treated as down", async () => {
    // primary answers (slot 10_000) so the best slot is known; then quota hits, fallback is 500 slots behind
    const { f, net, tick } = mk({ [P]: { slot: 10_000 }, [F1]: { slot: 9_500 } }, [P, F1], { maxSlotLag: 50, slotCheckIntervalMs: 1 });
    await call(f); // vets primary: records slot 10_000
    net.hosts[P] = { status: 429 };
    tick(1_000);
    await assert.rejects(call(f), /rpc-degraded/, "lagging fallback must not carry the request");
    assert.equal(f.snapshot().endpoints[1].state, "down");
    assert.match(f.snapshot().endpoints[1].lastError ?? "", /lagging: slot 9500 is \d+ behind/);
    assert.ok(!net.calls.some((c) => c.url === F1 && c.method === "getBalance"), "no request ever sent via the lagging endpoint");
  });

  it("a fallback within the bound is used", async () => {
    const { f, net, tick } = mk({ [P]: { slot: 10_000 }, [F1]: { slot: 9_970 } }, [P, F1], { maxSlotLag: 50, slotCheckIntervalMs: 1 });
    await call(f);
    net.hosts[P] = { status: 429 };
    tick(1_000);
    assert.equal(await who(await call(f)), `ok:${F1}`);
  });

  it("the bound is configurable", async () => {
    const { f, net, tick } = mk({ [P]: { slot: 10_000 }, [F1]: { slot: 9_970 } }, [P, F1], { maxSlotLag: 10, slotCheckIntervalMs: 1 });
    await call(f);
    net.hosts[P] = { status: 429 };
    tick(1_000);
    await assert.rejects(call(f), /rpc-degraded/);
  });

  it("a recovering primary that is fresh replaces a fallback; one that is far behind is kept down", async () => {
    const { f, net, tick } = mk({ [P]: { status: 429 }, [F1]: { slot: 10_000 } }, [P, F1], { maxSlotLag: 50, primaryRetryMs: 1_000, backoffBaseMs: 1_000 });
    await call(f);
    assert.equal(f.snapshot().activeIndex, 1);
    net.hosts[P] = { slot: 9_000 }; // back, but 1000+ slots behind the fallback
    tick(30_000);
    await call(f);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.snapshot().activeIndex, 1);
    assert.equal(f.snapshot().endpoints[0].state, "down");
    net.hosts[P] = { slot: 10_000 + 2 * 120 }; // caught up
    tick(120_000);
    await call(f);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.snapshot().activeIndex, 0);
  });
});

describe("rpc-failover: secret redaction", () => {
  it("redactUrl strips query secrets and long path tokens", () => {
    assert.equal(redactUrl(P), "https://devnet.helius-rpc.com?***");
    assert.equal(redactUrl(F1), "https://api.devnet.solana.com");
    assert.ok(!redactUrl(F2).includes(SECRET));
    assert.equal(redactUrl("not a url"), "<invalid-url>");
  });

  it("redactText scrubs known URLs, bare secrets, api-key params and unknown URLs", () => {
    const msg = `failed ${P} and key ${SECRET} and https://other.example.com/x?api-key=zzzzzzzzzz api-key=abcdef123456`;
    const out = redactText(msg, [P, F2]);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(!out.includes("zzzzzzzzzz"), out);
    assert.ok(!out.includes("abcdef123456"), out);
  });

  it("no log line and no /health payload ever contains the key, through failure, refusal and recovery", async () => {
    const { f, logs, net, tick } = mk({ [P]: { status: 429 }, [F1]: { genesis: GENESIS_HASH.mainnet }, [F2]: { throwNet: true } }, [P, F1, F2]);
    await call(f).catch(() => undefined);
    tick(60_000);
    net.hosts[P] = {};
    await call(f).catch(() => undefined);
    registerRpcFailover("devnet", f);
    const health = JSON.stringify(rpcFailoverHealth());
    const all = logs.join("\n") + health;
    assert.ok(all.length > 50);
    assert.ok(!all.includes(SECRET), all);
    assert.ok(!/api-key=/i.test(all), all);
    assert.ok(logs.length > 0);
  });

  it("failoverFromEnv: null without fallbacks (behaviour unchanged); logs only redacted URLs when set", () => {
    assert.equal(failoverFromEnv("devnet", P, parseFallbackUrls("off"), {}, async () => new Response("")), null);
    assert.equal(failoverFromEnv("devnet", P, [P], {}, async () => new Response("")), null, "primary listed as its own fallback is ignored");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      assert.ok(failoverFromEnv("devnet", P, [F1, F2], { RPC_MAX_SLOT_LAG: "7" }, async () => new Response("")));
    } finally {
      console.log = orig;
    }
    assert.ok(lines.length === 1 && !lines[0].includes(SECRET), lines.join("|"));
  });

  it("parseFallbackUrls errors never echo the offending value (it may carry a key)", () => {
    assert.throws(() => parseFallbackUrls(`http://x.example/?api-key=${SECRET}`), (e: Error) => !e.message.includes(SECRET));
    assert.throws(() => parseFallbackUrls(`nope-${SECRET}`), (e: Error) => !e.message.includes(SECRET));
  });
});
