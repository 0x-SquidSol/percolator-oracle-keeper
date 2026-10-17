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
 * SECRETS: endpoint URLs carry API keys (query string or path token). Nothing here logs or exposes a raw URL;
 * everything goes through `redactUrl` / `redactText`.
 */

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
  /** Assumed slot rate used to project a stale observation forward. Deliberately conservative. Default 2/s. */
  slotsPerSecond?: number;
  log?: (line: string) => void;
}

type EpState = "ok" | "down" | "refused";

interface Endpoint {
  idx: number;
  url: string;
  label: string; // redacted
  verified: boolean; // genesis checked since last outage
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
      slotsPerSecond: opts.slotsPerSecond ?? 2,
    };
    this.log = opts.log ?? ((l) => console.error(l));
    this.eps = opts.urls.map((url, idx) => ({
      idx,
      url,
      label: redactUrl(url),
      // EVERY endpoint (primary included) is vetted (genesis + slot) before first use.
      verified: false,
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

  private async rpc(ep: Endpoint, method: string): Promise<{ status: number; result?: unknown; err?: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.probeTimeoutMs);
    try {
      const res = await this.base(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.rpcId++, method, params: method === "getSlot" ? [{ commitment: "confirmed" }] : [] }),
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

  private async doVet(ep: Endpoint): Promise<boolean> {
    if (!ep.verified) {
      const g = await this.rpc(ep, "getGenesisHash");
      if (g.err !== undefined || typeof g.result !== "string") {
        this.markDown(ep, g.err ?? "genesis probe returned no hash");
        return false;
      }
      if (g.result !== this.expectedGenesis) {
        ep.refused = true;
        ep.lastError = `cluster mismatch: genesis ${g.result.slice(0, 8)}... != expected ${this.expectedGenesis.slice(0, 8)}...`;
        this.logLine(`endpoint #${ep.idx} ${ep.label} REFUSED (${ep.lastError}); it will never be used`);
        return false;
      }
    }
    const s = await this.rpc(ep, "getSlot");
    if (s.err !== undefined || typeof s.result !== "number") {
      this.markDown(ep, s.err ?? "slot probe returned no slot");
      return false;
    }
    const t = this.now();
    ep.slot = s.result;
    ep.slotAt = t;
    ep.lastVetAt = t;
    const best = this.bestOtherSlot(ep);
    if (best !== null && best - s.result > this.cfg.maxSlotLag) {
      this.markDown(ep, `lagging: slot ${s.result} is ${best - s.result} behind best ${best} (max ${this.cfg.maxSlotLag})`);
      return false;
    }
    ep.verified = true;
    this.markGood(ep);
    return true;
  }

  private async usable(ep: Endpoint): Promise<boolean> {
    if (ep.refused) return false;
    const t = this.now();
    if (t < ep.downUntil) return false;
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
    const order = [this.eps[this.active], ...this.eps.filter((e) => e.idx !== this.active)];
    let lastRes: Response | null = null;
    let lastErr: unknown = null;
    for (const ep of order) {
      if (!(await this.usable(ep))) continue;
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
      if (res.status === 402 || res.status === 403) {
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
      if (res.status >= 502 && res.status <= 504) {
        lastRes = res;
        if (++ep.consecutiveFailures >= this.cfg.networkErrorThreshold) this.markDown(ep, `HTTP ${res.status}`);
        continue;
      }
      ep.consecutiveFailures = 0;
      this.setActive(ep, ep.idx === 0 ? "primary serving" : `failover from #${this.active}`);
      return res;
    }
    // Nothing answered: fail loudly but rate-limited, never crash.
    const t = this.now();
    if (t - this.allDownLoggedAt > 30_000) {
      this.allDownLoggedAt = t;
      this.logLine(`ALL ENDPOINTS DOWN (${this.eps.map((e) => `#${e.idx} ${e.refused ? "refused" : t < e.downUntil ? `cooldown ${Math.round((e.downUntil - t) / 1000)}s` : "failing"}`).join(", ")}); backing off`);
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
  });
  registerRpcFailover(cluster, f);
  console.log(`[rpc-failover:${cluster}] ordered endpoints: ${[primaryUrl, ...fallbacks].map(redactUrl).join(" > ")}`);
  return f;
}

/** True for an error that says the RPC is unavailable (quota, overload, network), not that the data is wrong. */
export function isTransientRpcError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /\b(401|402|403|429|5\d\d)\b|too many requests|max usage|rate limit|fetch failed|rpc-degraded|endpoints are down|econn|etimedout|enotfound|socket hang up|network|timed? ?out|unavailable/.test(m);
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
