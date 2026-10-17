/**
 * cross-cluster/rpc-failover.ts — ordered RPC fallback for the keeper's `Connection`s.
 *
 * WHY: on 2026-10-17 the v2.2 keeper's single Helius key hit "max usage reached" (HTTP 429). Every call failed,
 * the launcher's preflight exited 1, and launchd crash-looped ~486 times. One exhausted endpoint must degrade
 * the keeper, not kill it.
 *
 * HOW: web3.js funnels every request (reads, simulate, sendRawTransaction, confirmation polling) through the
 * `fetch` given to `new Connection(url, { fetch })`. `createRpcFailover(...).fetch` is such a fetch: it rewrites
 * the request URL to the currently active endpoint and fails over down an ordered list on 429 / "max usage
 * reached" / 502-504 / repeated network errors. Because it sits at that seam it covers reads AND sends, and any
 * Connection built with it (the keeper's, the pusher's, the preflight's).
 *
 * SAFETY, per endpoint, before it is ever used (and again after each outage):
 *  - cluster: `getGenesisHash` must equal the expected genesis for the cluster. A mismatching endpoint is
 *    REFUSED for the life of the process (a devnet keeper must never push through a mainnet fallback).
 *  - freshness: `getSlot` is compared with the best recently seen slot across endpoints (projected forward by
 *    elapsed time). An endpoint lagging more than `maxSlotLag` (default 50) is treated as down. Re-checked
 *    every `slotCheckIntervalMs` while in use.
 *
 * RECOVERY: the primary is re-probed in the background (exponential cooldown, `primaryRetryMs` floor) and
 * becomes active again as soon as it passes the same checks.
 *
 * ALL DOWN: calls fail fast (no hammering) while each endpoint sits in a capped exponential cooldown; state is
 * logged loudly on transitions and `/health` reports `rpc-degraded` with the active endpoint.
 *
 * WEBSOCKETS: only `fetch` is wrapped. web3.js derives its websocket endpoint from the primary URL, so signature
 * subscriptions (confirmTransaction's default path) do not fail over. The keeper never subscribes (confirmation is
 * getSignatureStatuses polling through this seam, pinned to the sending endpoint); a new subscription user must poll.
 *
 * SECRETS: endpoint URLs carry API keys (query string or path token). Nothing here logs or exposes a raw URL;
 * everything goes through `redactUrl` / `redactText`.
 */

import { createHash } from "node:crypto";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Public devnet. Rate limited, but always up and free: a degraded keeper beats a dead one. */
export const DEFAULT_DEVNET_FALLBACKS: readonly string[] = ["https://api.devnet.solana.com"];


/**
 * DEVNET_RPC_FALLBACK_URLS: comma-separated https URLs (http only for localhost). Unset = the public devnet
 * endpoint; `off` / `none` = no fallback (the old behaviour). Throws on a malformed entry so a typo fails
 * at boot, not during an outage.
 */
export function parseFallbackUrls(raw: string | undefined, dflt: readonly string[] = DEFAULT_DEVNET_FALLBACKS): string[] {
  const v = raw?.trim();
  if (v === undefined || v === "") return [...dflt];
  if (v === "off" || v === "none") return [];
  const out: string[] = [];
  for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error("RPC fallback URL list contains an entry that is not a URL (value withheld: it may carry a key)");
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
      throw new Error("RPC fallback URLs must be https (http only for localhost)");
    }
    out.push(part);
  }
  return out;
}


export const GENESIS_HASH = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;
export type FailoverCluster = keyof typeof GENESIS_HASH;

// ── secret redaction ─────────────────────────────────────────────────────────

const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_\-.~%]{16,}$/;

/** `https://host/path?api-key=SECRET` -> `https://host/path?***`; long path tokens become `***`. Never throws. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const p = u.pathname
      .split("/")
      .map((seg) => (TOKEN_SEGMENT_RE.test(seg) ? "***" : seg))
      .join("/");
    return `${u.protocol}//${u.host}${p === "/" ? "" : p}${u.search ? "?***" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

/** Scrub free text (error messages): every known endpoint URL/secret, any URL, any `api-key=`-style param. */
export function redactText(text: string, knownUrls: readonly string[] = []): string {
  let out = text;
  for (const raw of knownUrls) {
    out = out.split(raw).join(redactUrl(raw));
    try {
      const u = new URL(raw);
      for (const v of u.searchParams.values()) if (v.length >= 6) out = out.split(v).join("***");
      for (const seg of u.pathname.split("/")) if (TOKEN_SEGMENT_RE.test(seg)) out = out.split(seg).join("***");
    } catch {
      /* not a URL: nothing further to scrub */
    }
  }
  out = out.replace(/https?:\/\/[^\s"'<>)]+/gi, (m) => redactUrl(m));
  out = out.replace(/((?:api[-_]?key|apikey|token|secret|key)=)[^&\s"']+/gi, "$1***");
  return out;
}

// ── failover core ────────────────────────────────────────────────────────────

export interface RpcFailoverOptions {
  cluster: FailoverCluster;
  /** Ordered: [0] is the primary. */
  urls: readonly string[];
  /** The real transport (default global fetch). Wrap with countingFetch so every attempt is counted. */
  base?: FetchLike;
  now?: () => number;
  /** Override for tests / other clusters; defaults to GENESIS_HASH[cluster]. */
  expectedGenesis?: string;
  maxSlotLag?: number; // default 50
  slotCheckIntervalMs?: number; // default 10_000
  primaryRetryMs?: number; // default 30_000
  backoffBaseMs?: number; // default 2_000
  backoffMaxMs?: number; // default 300_000
  /** Consecutive network errors / 5xx before an endpoint is marked down. Default 3. */
  networkErrorThreshold?: number;
  probeTimeoutMs?: number; // default 5_000
  /** Slot rate used to project a recent (<60 s) observation forward. Devnet/mainnet run ~2.5/s. Default 2.5. */
  slotsPerSecond?: number;
  /** How long after a send the sending endpoint is preferred for status/confirmation polls (F4). Default 60_000. */
  pinMs?: number;
  /** If every endpoint has been rejected (lagging or suspect-ahead) for this long and they agree with each other, re-seed the floor. Default 300_000. */
  floorReseedMs?: number;
  /** Log an [ALERT] once all endpoints have been down this long (and every 5 min after). Default 120_000. */
  allDownAlertMs?: number;
  log?: (line: string) => void;
}

type EpState = "ok" | "down" | "refused";

interface Endpoint {
  idx: number;
  url: string;
  label: string; // redacted
  verified: boolean; // genesis checked since last outage
  /** Freshness established against a baseline (floor slot / other endpoint / block time). Writes need it (F1). */
  confirmed: boolean;
  /** Genesis matched the expected cluster. Permanent. No slot from an endpoint reaches the floor before this. */
  genesisOk: boolean;
  /** Last vet reported a slot implausibly far ahead of the floor. */
  suspectAhead: boolean;
  /** Since when this endpoint has been consecutively rejected as lagging (null otherwise). */
  laggingSince: number | null;
  /** Last raw reply of a genesis-verified endpoint, kept OUT of every comparison except the escape hatch. */
  rawSlot: number | null;
  rawAt: number;
  refused: boolean; // wrong cluster, permanent
  consecutiveFailures: number;
  backoffExp: number;
  downUntil: number;
  lastError: string | null;
  slot: number | null;
  slotAt: number;
  lastVetAt: number;
  vetting: Promise<boolean> | null;
}

export interface RpcFailoverSnapshot {
  cluster: FailoverCluster;
  status: "ok" | "rpc-degraded";
  reason: "primary-active" | "on-fallback" | "all-endpoints-down";
  active: string; // redacted
  activeIndex: number;
  endpoints: Array<{
    index: number;
    url: string; // redacted
    suspectAhead: boolean;
    confirmed: boolean; // freshness established; unconfirmed endpoints serve reads only
    state: EpState;
    consecutiveFailures: number;
    downForMs: number;
    lastError: string | null;
    slot: number | null;
    slotLag: number | null;
  }>;
  switches: number;
  lastSwitchAt: string | null;
}

export class RpcFailover {
  private readonly eps: Endpoint[];
  private readonly base: FetchLike;
  private readonly now: () => number;
  private readonly cfg: Required<
    Pick<
      RpcFailoverOptions,
      | "maxSlotLag"
      | "slotCheckIntervalMs"
      | "primaryRetryMs"
      | "backoffBaseMs"
      | "backoffMaxMs"
      | "networkErrorThreshold"
      | "probeTimeoutMs"
      | "slotsPerSecond"
      | "pinMs"
      | "floorReseedMs"
      | "allDownAlertMs"
    >
  >;
  private readonly expectedGenesis: string;
  private readonly cluster: FailoverCluster;
  private readonly log: (line: string) => void;
  private readonly urls: readonly string[];
  private active = 0;
  private switches = 0;
  private lastSwitchAt: number | null = null;
  private lastPrimaryProbeAt = 0;
  private allDownLoggedAt = 0;
  private rpcId = 1;
  /** Highest slot ever observed on any endpoint. Never expires, never projected: the chain only moves forward. */
  private floorSlot: number | null = null;
  private floorAt = 0;
  private allDownSince: number | null = null;
  private allDownAlertedAt = 0;
  private pin: { idx: number; until: number } | null = null;

  constructor(opts: RpcFailoverOptions) {
    if (opts.urls.length === 0) throw new Error("RpcFailover: at least one endpoint URL is required");
    this.cluster = opts.cluster;
    this.urls = [...opts.urls];
    this.base = opts.base ?? ((i, init) => fetch(i, init));
    this.now = opts.now ?? Date.now;
    this.expectedGenesis = opts.expectedGenesis ?? GENESIS_HASH[opts.cluster];
    this.cfg = {
      maxSlotLag: opts.maxSlotLag ?? 50,
      slotCheckIntervalMs: opts.slotCheckIntervalMs ?? 10_000,
      primaryRetryMs: opts.primaryRetryMs ?? 30_000,
      backoffBaseMs: opts.backoffBaseMs ?? 2_000,
      backoffMaxMs: opts.backoffMaxMs ?? 300_000,
      networkErrorThreshold: opts.networkErrorThreshold ?? 3,
      probeTimeoutMs: opts.probeTimeoutMs ?? 5_000,
      slotsPerSecond: opts.slotsPerSecond ?? 2.5,
      pinMs: opts.pinMs ?? 60_000,
      floorReseedMs: opts.floorReseedMs ?? 300_000,
      allDownAlertMs: opts.allDownAlertMs ?? 120_000,
    };
    this.log = opts.log ?? ((l) => console.error(l));
    this.eps = opts.urls.map((url, idx) => ({
      idx,
      url,
      label: redactUrl(url),
      // EVERY endpoint (primary included) is vetted (genesis + slot) before first use.
      verified: false,
      confirmed: false,
      genesisOk: false,
      suspectAhead: false,
      laggingSince: null,
      rawSlot: null,
      rawAt: 0,
      refused: false,
      consecutiveFailures: 0,
      backoffExp: 0,
      downUntil: 0,
      lastError: null,
      slot: null,
      slotAt: 0,
      lastVetAt: 0,
      vetting: null,
    }));
  }

  /** Pass as `new Connection(primaryUrl, { fetch: failover.fetch })`. */
  readonly fetch: FetchLike = (input, init) => this.doFetch(input, init);

  // ── helpers ───────────────────────────────────────────────────────────────

  private scrub(msg: string): string {
    return redactText(msg, this.urls);
  }

  private logLine(msg: string): void {
    this.log(`[rpc-failover:${this.cluster}] ${this.scrub(msg)}`);
  }

  private cooldown(ep: Endpoint): number {
    return Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** ep.backoffExp);
  }

  private markDown(ep: Endpoint, reason: string): void {
    const t = this.now();
    const wait = this.cooldown(ep);
    ep.backoffExp = Math.min(ep.backoffExp + 1, 30);
    ep.downUntil = t + wait;
    ep.verified = false; // re-vet (genesis + slot) before reuse
    ep.lastError = this.scrub(reason);
    this.logLine(`endpoint #${ep.idx} ${ep.label} DOWN (${ep.lastError}); retry in ${Math.round(wait / 1000)}s`);
  }

  private markGood(ep: Endpoint): void {
    ep.consecutiveFailures = 0;
    ep.backoffExp = 0;
    ep.downUntil = 0;
    ep.lastError = null;
  }

  private setActive(ep: Endpoint, why: string): void {
    if (this.active === ep.idx) return;
    const from = this.eps[this.active];
    this.active = ep.idx;
    this.switches++;
    this.lastSwitchAt = this.now();
    this.logLine(`ACTIVE ENDPOINT ${from.label} -> #${ep.idx} ${ep.label} (${why})`);
  }

  /** Best slot seen on any endpoint (other than `except`), projected forward by elapsed time. */
  private bestOtherSlot(except: Endpoint): number | null {
    const t = this.now();
    let best: number | null = null;
    for (const o of this.eps) {
      if (o === except || o.slot === null || o.refused) continue;
      const age = t - o.slotAt;
      if (age > 60_000) continue;
      const proj = o.slot + Math.floor((age / 1000) * this.cfg.slotsPerSecond);
      if (best === null || proj > best) best = proj;
    }
    return best;
  }

  private async rpc(ep: Endpoint, method: string, params?: unknown[]): Promise<{ status: number; result?: unknown; err?: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.probeTimeoutMs);
    try {
      const res = await this.base(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.rpcId++, method, params: params ?? (method === "getSlot" ? [{ commitment: "confirmed" }] : []) }),
        signal: ctl.signal,
      });
      if (res.status !== 200) {
        let body = "";
        try {
          body = (await res.text()).slice(0, 120);
        } catch {
          /* ignore */
        }
        return { status: res.status, err: `HTTP ${res.status} ${body}`.trim() };
      }
      const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) return { status: 200, err: `rpc error: ${j.error.message ?? "unknown"}` };
      return { status: 200, result: j.result };
    } catch (e) {
      return { status: 0, err: `network: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Genesis (once per outage) + slot-freshness check. Resolves true when the endpoint may carry traffic. */
  private vet(ep: Endpoint): Promise<boolean> {
    if (ep.vetting) return ep.vetting;
    ep.vetting = this.doVet(ep).finally(() => {
      ep.vetting = null;
    });
    return ep.vetting;
  }

  /** Record an ACCEPTED slot (genesis-verified, plausible). Only here may the floor move. */
  private accept(ep: Endpoint, slot: number): void {
    const t = this.now();
    ep.slot = slot;
    ep.slotAt = t;
    if (this.floorSlot === null || slot > this.floorSlot) {
      this.floorSlot = slot;
      this.floorAt = t;
    }
  }

  /** Highest slot the floor may reach from a reply now: the chain's real speed with 50% headroom, plus 2x the lag bound. */
  private floorCeiling(): number | null {
    if (this.floorSlot === null) return null;
    return this.floorSlot + ((this.now() - this.floorAt) / 1000) * this.cfg.slotsPerSecond * 1.5 + 2 * this.cfg.maxSlotLag;
  }

  /**
   * Quiet probes of the other endpoints for a first baseline. Each peer is GENESIS-checked first (a wrong-cluster
   * peer is refused and contributes nothing); slots are returned, not stored, so nothing here can touch the floor.
   */
  private async peerSlots(except: Endpoint): Promise<number[]> {
    const t = this.now();
    const out: number[] = [];
    await Promise.all(
      this.eps
        .filter((o) => o !== except && !o.refused && t >= o.downUntil)
        .map(async (o) => {
          if (!o.genesisOk) {
            const g = await this.rpc(o, "getGenesisHash");
            if (g.err !== undefined || typeof g.result !== "string") return;
            if (g.result !== this.expectedGenesis) {
              this.refuse(o, g.result);
              return;
            }
            o.genesisOk = true;
          }
          const r = await this.rpc(o, "getSlot");
          if (r.err === undefined && typeof r.result === "number") out.push(r.result);
        }),
    );
    return out;
  }

  private refuse(ep: Endpoint, genesis: string): void {
    ep.refused = true;
    ep.lastError = `cluster mismatch: genesis ${genesis.slice(0, 8)}... != expected ${this.expectedGenesis.slice(0, 8)}...`;
    this.logLine(`endpoint #${ep.idx} ${ep.label} REFUSED (${ep.lastError}); it will never be used`);
  }

  /** Escape hatch: every endpoint rejected as lagging for floorReseedMs yet they agree -> the floor was wrong, re-seed. */
  private maybeReseedFloor(): void {
    const t = this.now();
    const live = this.eps.filter((e) => !e.refused);
    if (live.length < 2 || live.some((e) => e.laggingSince === null || t - e.laggingSince < this.cfg.floorReseedMs || e.rawSlot === null)) return;
    const raws = live.map((e) => e.rawSlot as number).sort((x, y) => x - y);
    const ats = live.map((e) => e.rawAt);
    // replies were taken at different moments; allow the chain's own movement between them on top of maxSlotLag
    const tolerance = this.cfg.maxSlotLag + 1.5 * this.cfg.slotsPerSecond * ((Math.max(...ats) - Math.min(...ats)) / 1000);
    if (raws[raws.length - 1] - raws[0] > tolerance) return;
    const proj = raws;
    const median = raws[Math.floor(raws.length / 2)]; // unprojected: a floor slightly low is safe, one too high is the bug being repaired
    this.logLine(`[ALERT] every endpoint has been rejected as lagging for >= ${Math.round(this.cfg.floorReseedMs / 1000)}s but they agree with each other (slots ${proj.join(",")}); the slot floor ${this.floorSlot} was wrong, re-seeding it to ${median}`);
    this.floorSlot = median;
    this.floorAt = t;
    for (const e of live) {
      e.laggingSince = null;
      e.downUntil = 0;
    }
  }

  private isAuthFailure(err: string): boolean {
    return /\bHTTP (401|403)\b/.test(err) && !/max usage reached|rate limit|quota/i.test(err);
  }

  /** F7: 401/403 is a revoked or wrong key, not a blip. Loud, parked at the maximum cooldown, and we fall back. */
  private authFail(ep: Endpoint, err: string): void {
    ep.backoffExp = 30;
    this.logLine(`[ALERT] endpoint #${ep.idx} ${ep.label} AUTH FAILURE (${err.slice(0, 80)}): key revoked or wrong? falling back; fix the key`);
    this.markDown(ep, `auth failure: ${err}`);
  }

  private async doVet(ep: Endpoint): Promise<boolean> {
    if (!ep.genesisOk) {
      const g = await this.rpc(ep, "getGenesisHash");
      if (g.err !== undefined || typeof g.result !== "string") {
        const err = g.err ?? "genesis probe returned no hash";
        if (this.isAuthFailure(err)) this.authFail(ep, err);
        else this.markDown(ep, err);
        return false;
      }
      if (g.result !== this.expectedGenesis) {
        this.refuse(ep, g.result);
        return false;
      }
      ep.genesisOk = true;
    }
    const s = await this.rpc(ep, "getSlot");
    if (s.err !== undefined || typeof s.result !== "number") {
      const err = s.err ?? "slot probe returned no slot";
      if (this.isAuthFailure(err)) this.authFail(ep, err);
      else this.markDown(ep, err);
      return false;
    }
    const slot = s.result;
    ep.lastVetAt = this.now();
    ep.rawSlot = slot;
    ep.rawAt = this.now();
    let confirmed = false;

    if (this.floorSlot === null) {
      // First baseline: this endpoint's slot must be corroborated by another GENESIS-VERIFIED endpoint within
      // maxSlotLag, or by a fresh block time. A lone (possibly bogus) reply never sets the floor.
      const peers = await this.peerSlots(ep);
      const agree = peers.filter((p) => Math.abs(p - slot) <= this.cfg.maxSlotLag);
      if (agree.length > 0) {
        this.accept(ep, slot);
        const hi = Math.max(slot, ...agree);
        if (hi > (this.floorSlot ?? 0)) this.floorSlot = hi; // corroborated by a second genesis-verified endpoint
        confirmed = true;
      } else {
        const fresh = await this.blockTimeFresh(ep, slot);
        if (fresh === "stale") return false;
        if (fresh === "fresh") {
          this.accept(ep, slot);
          confirmed = true;
        } else {
          // Nothing to corroborate with. The operator's primary is trusted as before (no floor is set from an
          // unverified lone reply); an uncorroborated fallback may be read from, never sent through.
          ep.slot = slot;
          ep.slotAt = this.now();
          confirmed = ep.idx === 0;
        }
      }
    } else {
      // (a) plausibility: a reply far above what the chain could have reached since the floor was set is
      //     suspect-ahead. It is treated as down, logged, and NEVER raises the floor.
      const ceil = this.floorCeiling() as number;
      if (slot > ceil) {
        ep.suspectAhead = true;
        if (ep.laggingSince === null) ep.laggingSince = this.now();
        this.markDown(ep, `suspect-ahead: slot ${slot} exceeds what the chain can have reached (${Math.floor(ceil)}); floor ${this.floorSlot} unchanged`);
        this.maybeReseedFloor();
        return false;
      }
      ep.suspectAhead = false;
      // (b) lower bound: never more than maxSlotLag below the highest accepted slot (no expiry).
      const floor = this.floorSlot;
      if (floor - slot > this.cfg.maxSlotLag) {
        ep.slot = slot;
        ep.slotAt = this.now();
        if (ep.laggingSince === null) ep.laggingSince = this.now();
        this.markDown(ep, `lagging: slot ${slot} is ${floor - slot} behind the highest slot seen ${floor} (max ${this.cfg.maxSlotLag})`);
        this.maybeReseedFloor();
        return false;
      }
      // (c) projected bound against a RECENT (<60 s) observation of another endpoint.
      const best = this.bestOtherSlot(ep);
      if (best !== null && best - slot > this.cfg.maxSlotLag) {
        ep.slot = slot;
        ep.slotAt = this.now();
        this.markDown(ep, `lagging: slot ${slot} is ${best - slot} behind best ${best} (max ${this.cfg.maxSlotLag})`);
        return false;
      }
      this.accept(ep, slot);
      confirmed = best !== null;
      if (!confirmed) {
        const fresh = await this.blockTimeFresh(ep, slot);
        if (fresh === "stale") return false;
        confirmed = fresh === "fresh" ? true : ep.idx === 0;
      }
    }
    ep.laggingSince = null;
    ep.confirmed = confirmed;
    ep.verified = true;
    this.markGood(ep);
    return true;
  }

  /** Wall-clock anchor: the block time of a recent slot must be close to now. */
  private async blockTimeFresh(ep: Endpoint, slot: number): Promise<"fresh" | "stale" | "unknown"> {
    const bt = await this.rpc(ep, "getBlockTime", [Math.max(0, slot - 20)]);
    if (bt.err !== undefined || typeof bt.result !== "number") return "unknown";
    const ageSec = this.now() / 1000 - bt.result;
    const maxAge = this.cfg.maxSlotLag * 0.4 + 8 + 10; // lag bound + the 20-slot offset + clock skew allowance
    if (ageSec > maxAge) {
      this.markDown(ep, `stale: block time of slot ${slot - 20} is ${Math.round(ageSec)}s old (max ${Math.round(maxAge)}s)`);
      return "stale";
    }
    return "fresh";
  }

  private async usable(ep: Endpoint): Promise<boolean> {
    if (ep.refused) return false;
    const t = this.now();
    if (t < ep.downUntil) return false;
    // F2: the slot probe runs at most once per slotCheckIntervalMs, not once per request.
    if (ep.verified && t - ep.lastVetAt < this.cfg.slotCheckIntervalMs) return true;
    return this.vet(ep);
  }

  private maybeProbePrimary(): void {
    if (this.active === 0) return;
    const p = this.eps[0];
    const t = this.now();
    if (p.refused || t < p.downUntil || t - this.lastPrimaryProbeAt < this.cfg.primaryRetryMs) return;
    this.lastPrimaryProbeAt = t;
    p.verified = false; // full vet: genesis + slot
    void this.vet(p).then((ok) => {
      if (ok) this.setActive(p, "primary recovered");
    });
  }

  private static isQuota(status: number, body: string): boolean {
    if (status === 429) return true;
    return (status === 402 || status === 403) && /max usage reached|rate limit|quota/i.test(body);
  }

  private async doFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.maybeProbePrimary();
    const body0 = typeof init?.body === "string" ? init.body : "";
    const isWrite = /"method"\s*:\s*"(sendTransaction|requestAirdrop)"/.test(body0);
    const isStatusPoll = /"method"\s*:\s*"(getSignatureStatuses|getSignatureStatus|getTransaction|isBlockhashValid|getBlockHeight)"/.test(body0);
    const t0 = this.now();
    // F4: confirmation/status polls follow the endpoint that took the send (a different node may not know the signature yet).
    const first = isStatusPoll && this.pin && t0 < this.pin.until ? this.pin.idx : this.active;
    const order = [this.eps[first], ...this.eps.filter((e) => e.idx !== first)];
    let skippedUnconfirmed = false;
    const activeAtStart = this.active;
    let lastRes: Response | null = null;
    let lastErr: unknown = null;
    for (const ep of order) {
      if (!(await this.usable(ep))) continue;
      if (isWrite && !ep.confirmed) {
        skippedUnconfirmed = true; // F1: never send through an endpoint whose freshness could not be established
        continue;
      }
      let res: Response;
      try {
        res = await this.base(ep.url, init);
      } catch (e) {
        lastErr = e;
        if (++ep.consecutiveFailures >= this.cfg.networkErrorThreshold) {
          this.markDown(ep, `${ep.consecutiveFailures} consecutive network errors: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      let body = "";
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        try {
          body = await res.clone().text();
        } catch {
          /* ignore */
        }
      }
      if (RpcFailover.isQuota(res.status, body)) {
        lastRes = res;
        this.markDown(ep, `HTTP ${res.status} quota/rate limit (max usage reached)`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        lastRes = res;
        this.authFail(ep, `HTTP ${res.status}`);
        continue;
      }
      if (res.status >= 502 && res.status <= 504) {
        lastRes = res;
        if (++ep.consecutiveFailures >= this.cfg.networkErrorThreshold) this.markDown(ep, `HTTP ${res.status}`);
        continue;
      }
      ep.consecutiveFailures = 0;
      this.allDownSince = null;
      if (isWrite) this.pin = { idx: ep.idx, until: this.now() + this.cfg.pinMs };
      const pinnedServe = isStatusPoll && ep.idx === first && first !== this.active;
      // Only the request that saw the current active endpoint fail may move it (a concurrent primary recovery wins).
      if (!pinnedServe && this.active === activeAtStart) this.setActive(ep, ep.idx === 0 ? "primary serving" : `failover from #${this.active}`);
      return res;
    }
    // Nothing answered: fail loudly but rate-limited, never crash.
    const t = this.now();
    this.maybeReseedFloor();
    if (this.allDownSince === null) this.allDownSince = t;
    if (t - this.allDownSince >= this.cfg.allDownAlertMs && t - this.allDownAlertedAt >= 300_000) {
      this.allDownAlertedAt = t;
      this.logLine(`[ALERT] keeper is alive but USELESS: no usable ${this.cluster} RPC endpoint for ${Math.round((t - this.allDownSince) / 1000)}s (no reads, no pushes); fix the RPC key/quota or fallbacks`);
    }
    if (t - this.allDownLoggedAt > 30_000) {
      this.allDownLoggedAt = t;
      this.logLine(`ALL ENDPOINTS DOWN (${this.eps.map((e) => `#${e.idx} ${e.refused ? "refused" : t < e.downUntil ? `cooldown ${Math.round((e.downUntil - t) / 1000)}s` : "failing"}`).join(", ")}); backing off`);
    }
    if (skippedUnconfirmed && !lastRes) {
      throw new Error(`rpc-degraded: no slot-confirmed ${this.cluster} RPC endpoint available for a write (reads still served)`);
    }
    if (lastRes) return lastRes; // let web3.js apply its own 429 retry; our cooldown makes repeats fail fast
    throw new Error(`rpc-degraded: all ${this.cluster} RPC endpoints are down${lastErr ? ` (last: ${this.scrub(lastErr instanceof Error ? lastErr.message : String(lastErr))})` : ""}`);
  }

  // ── observability ─────────────────────────────────────────────────────────

  isAllDown(): boolean {
    const t = this.now();
    return this.eps.every((e) => e.refused || t < e.downUntil);
  }

  snapshot(): RpcFailoverSnapshot {
    const t = this.now();
    const allDown = this.isAllDown();
    const bestAll = Math.max(-1, ...this.eps.filter((e) => e.slot !== null && !e.refused).map((e) => (e.slot as number) + Math.floor(((t - e.slotAt) / 1000) * this.cfg.slotsPerSecond)));
    return {
      cluster: this.cluster,
      status: allDown || this.active !== 0 ? "rpc-degraded" : "ok",
      reason: allDown ? "all-endpoints-down" : this.active !== 0 ? "on-fallback" : "primary-active",
      active: this.eps[this.active].label,
      activeIndex: this.active,
      endpoints: this.eps.map((e) => ({
        index: e.idx,
        url: e.label,
        confirmed: e.confirmed,
        suspectAhead: e.suspectAhead,
        state: e.refused ? "refused" : t < e.downUntil ? "down" : "ok",
        consecutiveFailures: e.consecutiveFailures,
        downForMs: Math.max(0, e.downUntil - t),
        lastError: e.lastError,
        slot: e.slot,
        slotLag: e.slot !== null && bestAll >= 0 ? Math.max(0, bestAll - (e.slot + Math.floor(((t - e.slotAt) / 1000) * this.cfg.slotsPerSecond))) : null,
      })),
      switches: this.switches,
      lastSwitchAt: this.lastSwitchAt === null ? null : new Date(this.lastSwitchAt).toISOString(),
    };
  }
}

// ── process-wide registry (feeds /health) ────────────────────────────────────

const registered = new Map<string, RpcFailover>();

export function registerRpcFailover(label: string, f: RpcFailover): void {
  registered.set(label, f);
}

/** Additive /health fields. `{}` when no failover is registered. `degraded` is true on a fallback or all-down. */
export function rpcFailoverHealth(): { degraded: boolean; fields: Record<string, unknown> } {
  if (registered.size === 0) return { degraded: false, fields: {} };
  const snaps: Record<string, RpcFailoverSnapshot> = {};
  let degraded = false;
  for (const [label, f] of registered) {
    const s = f.snapshot();
    snaps[label] = s;
    if (s.status === "rpc-degraded") degraded = true;
  }
  return { degraded, fields: { rpcFailover: snaps } };
}

/** Positive finite number from an env string, else the default. */
export function envNumber(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Wire-up helper. `fallbacks` is the already-parsed ordered list (see parseFallbackUrls). Returns null when empty, so
 * a deployment that opts out (`off`) keeps plain web3.js behaviour on the single endpoint.
 */
export function failoverFromEnv(
  cluster: FailoverCluster,
  primaryUrl: string,
  fallbackList: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  base: FetchLike,
): RpcFailover | null {
  const fallbacks = fallbackList.filter((u) => u !== primaryUrl);
  if (fallbacks.length === 0) return null;
  const f = new RpcFailover({
    cluster,
    urls: [primaryUrl, ...fallbacks],
    base,
    maxSlotLag: envNumber(env.RPC_MAX_SLOT_LAG, 50),
    slotCheckIntervalMs: envNumber(env.RPC_SLOT_CHECK_MS, 10_000),
    primaryRetryMs: envNumber(env.RPC_PRIMARY_RETRY_MS, 30_000),
    backoffBaseMs: envNumber(env.RPC_BACKOFF_BASE_MS, 2_000),
    backoffMaxMs: envNumber(env.RPC_BACKOFF_MAX_MS, 300_000),
    floorReseedMs: envNumber(env.RPC_FLOOR_RESEED_MS, 300_000),
    allDownAlertMs: envNumber(env.RPC_ALL_DOWN_ALERT_MS, 120_000),
  });
  registerRpcFailover(cluster, f);
  console.log(`[rpc-failover:${cluster}] ordered endpoints: ${[primaryUrl, ...fallbacks].map(redactUrl).join(" > ")}`);
  return f;
}

/** True for an error that says the RPC is unavailable (quota, overload, network), not that the data is wrong. */
export function isTransientRpcError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /\b(429|5\d\d)\b|too many requests|max usage|rate limit|fetch failed|rpc-degraded|endpoints are down|econn|etimedout|enotfound|socket hang up|network|timed? ?out|unavailable/.test(m);
}

/**
 * Preflight rule when the ownership check cannot run because no RPC answered.
 * - "proceed": the registry is byte-identical to one that already passed the ownership check (stamp matches), so
 *   starting changes nothing the check protects. The keeper then degrades (retries, fails over) instead of
 *   crash-looping and leaving every market to age past the stale-resolve window.
 * - "refuse": the registry is new or changed and cannot be verified; refusing is the safe answer.
 */
export function preflightOutageDecision(registrySha: string, stampSha: string | undefined): "proceed" | "refuse" {
  return stampSha !== undefined && stampSha.trim() === registrySha ? "proceed" : "refuse";
}

/**
 * F3: what a preflight stamp attests to. The ownership check is "these markets are owned by THIS wrapper on THIS
 * cluster", so the stamp binds the registry bytes AND the wrapper program id AND the cluster genesis. A re-deploy to
 * new program ids with an unchanged registry therefore never reuses an old stamp.
 */
export function preflightStampSha(registryBytes: Uint8Array, wrapperProgramId: string, genesisHash: string): string {
  return createHash("sha256").update(registryBytes).update("\n").update(wrapperProgramId).update("\n").update(genesisHash).digest("hex");
}
