/**
 * rpc-failover.ts - RPC endpoint failover for the devnet Connection, and the preflight's outage rule.
 *
 * WHY (audit 2026-10-17, S2): the v2.2 keeper had ONE devnet endpoint (the Helius key). When the key's
 * plan was exhausted ("429 Too Many Requests: max usage reached", a quota stop, not a burst limit, so
 * web3.js's own 429 backoff never helps) the launcher's preflight exited 1, launchd's KeepAlive
 * restarted it every ThrottleInterval (486 runs), the keeper never started, no price was pushed, and
 * every market crossed the 18,000-slot stale-resolve window.
 *
 * Failover is at the `fetch` seam handed to `new Connection(url, { fetch })`: a request to the primary
 * that throws, or answers 401/402/403/429/5xx, is replayed (same body, so a sendTransaction is the same
 * signed tx and is idempotent) against each fallback in order. The primary is then skipped for
 * `cooldownMs` so a dead key is not hit twice per call. A fallback answer is returned to web3.js as if
 * it were the primary's, so its 429 retry loop never starts.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Public devnet. Rate limited, but always up and free: a degraded keeper beats a dead one. */
export const DEFAULT_DEVNET_FALLBACKS: readonly string[] = ["https://api.devnet.solana.com"];

/** Statuses that mean "this endpoint cannot serve me right now" (quota, auth, overload), not "your request is bad". */
export function isFailoverStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/**
 * DEVNET_RPC_FALLBACK_URLS: comma-separated https URLs (http only for localhost). Unset = the public devnet
 * endpoint; `off` / `none` = no fallback (the old behaviour). Throws on a malformed entry so a typo fails
 * at boot, not during an outage.
 */
export function parseFallbackUrls(raw: string | undefined): string[] {
  const v = raw?.trim();
  if (v === undefined || v === "") return [...DEFAULT_DEVNET_FALLBACKS];
  if (v === "off" || v === "none") return [];
  const out: string[] = [];
  for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(part);
    } catch {
      throw new Error(`DEVNET_RPC_FALLBACK_URLS entry "${part.slice(0, 40)}" is not a URL`);
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
      throw new Error("DEVNET_RPC_FALLBACK_URLS entries must be https (http only for localhost)");
    }
    out.push(part);
  }
  return out;
}

export interface FailoverOptions {
  cooldownMs?: number;
  now?: () => number;
  /** Called once per failover (never with a URL: the primary carries the API key). */
  onFailover?: (info: { reason: string; fallbackIndex: number }) => void;
}

export function failoverFetch(
  primaryUrl: string,
  fallbacks: readonly string[],
  base: FetchLike = (input, init) => fetch(input, init),
  opts: FailoverOptions = {},
): FetchLike {
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let primaryDownUntil = 0;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== primaryUrl || fallbacks.length === 0) return base(input, init);

    let lastRes: Response | undefined;
    let lastErr: unknown;
    let reason = "primary cooling down";
    if (now() >= primaryDownUntil) {
      try {
        const res = await base(input, init);
        if (!isFailoverStatus(res.status)) return res;
        lastRes = res;
        reason = `primary HTTP ${res.status}`;
      } catch (err) {
        lastErr = err;
        reason = "primary transport error";
      }
      primaryDownUntil = now() + cooldownMs;
    }
    for (let i = 0; i < fallbacks.length; i++) {
      try {
        const res = await base(fallbacks[i], init);
        if (!isFailoverStatus(res.status)) {
          opts.onFailover?.({ reason, fallbackIndex: i });
          return res;
        }
        lastRes = res;
      } catch (err) {
        lastErr = err;
      }
    }
    // Every endpoint failed. If the primary was only skipped for its cooldown, give it one real try.
    if (reason === "primary cooling down") {
      try {
        const res = await base(input, init);
        if (!isFailoverStatus(res.status)) return res;
        lastRes = res;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastRes) return lastRes;
    throw lastErr ?? new Error("all RPC endpoints failed");
  };
}

/** True for an error that says the RPC is unavailable (quota, overload, network), not that the data is wrong. */
export function isTransientRpcError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /\b(401|402|403|429|5\d\d)\b|too many requests|max usage|rate limit|fetch failed|econn|etimedout|enotfound|socket hang up|network|timed? ?out|unavailable/.test(m);
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
