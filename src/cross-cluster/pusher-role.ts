/**
 * F2 (LP audit 4.6): the SECOND, INDEPENDENT price pusher.
 *
 * One keeper outage must not let every v2.2 market go stale and become permissionlessly resolvable (18,000 slots). This role
 * is the keeper's push loop and nothing else: no cranks, no liquidations, no Earn / fee / stake jobs (src/pusher.ts). It runs on
 * its own process, host and RPC endpoint, and BACKS OFF while the primary is healthy.
 *
 * Back-off: a market is on STANDBY while `estimatedClusterSlot - last_good_oracle_slot < takeoverSlots` (the primary, or anyone, pushed
 * recently). Only once the on-chain price is older than `takeoverSlots` does this pusher push (a TAKEOVER). A takeover push moves
 * last_good_oracle_slot, so against a dead primary it pushes about once per `takeoverSlots`, which is all the safety goal needs
 * (the resolve window is 18,000 slots); against a live primary it never pushes. Unknown or stale state = push (fail OPEN: the
 * point of this process is liveness, and a duplicate is harmless).
 *
 * Duplicate pushes are harmless: PushAuthMark's observation_sequence is a strictly-increasing nonce (`proposed <= current` ->
 * Custom(19) EngineStale, a plain revert that changes nothing). Both pushers read the on-chain watermark and propose
 * watermark + 1, so when they race, one lands and the other reverts in PREFLIGHT; the pusher's push path answers 19 by re-reading
 * the nonce and retrying once (no quarantine strike), and the primary does the same. Neither can corrupt the other's state.
 */
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { Alert } from "./alerting.ts";

const SLOT_MS = 400;
const LAST_GOOD_SLOT_OFF = 16 + 152; // WrapperConfigV16 @ header 16; last_good_oracle_slot @ +152
const SLICE_LEN = LAST_GOOD_SLOT_OFF + 8;

export interface PusherConfig {
  /** Push only when the on-chain price is at least this many slots old. */
  takeoverSlots: bigint;
  /** How often the on-chain state is re-read. */
  refreshMs: number;
  /** State older than this is treated as unknown (-> push). */
  staleStateMs: number;
  /** A takeover alert stays active this long after the last takeover push. */
  alertHoldMs: number;
}

export const DEFAULT_PUSHER_CONFIG: PusherConfig = { takeoverSlots: 60n, refreshMs: 2_000, staleStateMs: 30_000, alertHoldMs: 120_000 };

type Env = Readonly<Record<string, string | undefined>>;
function envPosInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}="${raw}" must be a positive integer`);
  return n;
}

/** PUSHER_TAKEOVER_SLOTS (60), PUSHER_REFRESH_MS (2000), PUSHER_STALE_STATE_MS (30000), PUSHER_ALERT_HOLD_MS (120000). Throws on garbage. */
export function pusherConfigFromEnv(env: Env): PusherConfig {
  return {
    takeoverSlots: BigInt(envPosInt(env, "PUSHER_TAKEOVER_SLOTS", Number(DEFAULT_PUSHER_CONFIG.takeoverSlots))),
    refreshMs: envPosInt(env, "PUSHER_REFRESH_MS", DEFAULT_PUSHER_CONFIG.refreshMs),
    staleStateMs: envPosInt(env, "PUSHER_STALE_STATE_MS", DEFAULT_PUSHER_CONFIG.staleStateMs),
    alertHoldMs: envPosInt(env, "PUSHER_ALERT_HOLD_MS", DEFAULT_PUSHER_CONFIG.alertHoldMs),
  };
}

/**
 * The pusher must not share the primary's RPC endpoint (a shared provider outage would take both down). `primary` is the
 * primary keeper's devnet endpoint, supplied as PUSHER_PRIMARY_DEVNET_RPC_URL. Returns a fatal message, or null when fine.
 * Compared on host + api-key query so two keys on the same host count as different endpoints, a copied URL does not.
 */
export function rpcEndpointProblem(own: string | undefined, primary: string | undefined): string | null {
  if (!own) return "DEVNET_RPC_URL is required";
  if (!primary) return null;
  const norm = (u: string): string => {
    try {
      const x = new URL(u);
      return `${x.host}${x.pathname}?${x.searchParams.get("api-key") ?? ""}`;
    } catch {
      return u.trim();
    }
  };
  return norm(own) === norm(primary)
    ? "DEVNET_RPC_URL equals PUSHER_PRIMARY_DEVNET_RPC_URL: the second pusher must use its OWN RPC endpoint"
    : null;
}

interface MarketState {
  lastGood: bigint;
  clusterSlot: bigint;
  at: number;
}

export interface TakeoverView {
  standby: boolean;
  gapSlots: string | null;
  lastGoodSlot: string | null;
  takeoverPushes: number;
  lastTakeoverAgoMs: number | null;
}

export class TakeoverGate {
  private readonly state = new Map<string, MarketState>();
  private readonly takeoverAt = new Map<string, number>();
  private readonly takeoverCount = new Map<string, number>();
  private readonly labels = new Map<string, string>();

  constructor(private readonly cfg: PusherConfig, private readonly now: () => number = Date.now) {}

  update(market: string, lastGood: bigint, clusterSlot: bigint, atMs = this.now()): void {
    this.state.set(market, { lastGood, clusterSlot, at: atMs });
  }
  setLabel(market: string, label: string): void {
    this.labels.set(market, label);
  }

  /** Slots since the on-chain price was last good, or null when unknown / stale. */
  gapSlots(market: string, nowMs = this.now()): bigint | null {
    const s = this.state.get(market);
    if (!s || nowMs - s.at > this.cfg.staleStateMs) return null;
    const est = s.clusterSlot + BigInt(Math.max(0, Math.floor((nowMs - s.at) / SLOT_MS)));
    return est > s.lastGood ? est - s.lastGood : 0n;
  }

  /** True while the primary is healthy for this market: do NOT push. Unknown = false (push). */
  isStandby(market: string, nowMs = this.now()): boolean {
    const g = this.gapSlots(market, nowMs);
    return g !== null && g < this.cfg.takeoverSlots;
  }

  /** A push landed from this role. It is a takeover push when the gate was open (always, since standby markets never push). */
  recordPush(market: string, nowMs = this.now()): void {
    this.takeoverAt.set(market, nowMs);
    this.takeoverCount.set(market, (this.takeoverCount.get(market) ?? 0) + 1);
  }

  /** Active "this pusher is keeping the market alive" alerts (the paging hook). */
  activeAlerts(nowMs = this.now()): Alert[] {
    const out: Alert[] = [];
    for (const [market, at] of this.takeoverAt) {
      if (nowMs - at > this.cfg.alertHoldMs) continue;
      const label = this.labels.get(market) ?? market;
      out.push({
        kind: "pusher-takeover",
        severity: "critical",
        subject: label,
        message:
          `the second pusher is the one keeping ${label} alive: the on-chain price was older than ${this.cfg.takeoverSlots} slots, ` +
          `so the primary keeper is NOT pushing this market (${this.takeoverCount.get(market) ?? 0} takeover push(es) since boot). Check the primary keeper.`,
        data: { market, takeoverPushes: this.takeoverCount.get(market) ?? 0 },
      });
    }
    return out;
  }

  health(markets: readonly string[], nowMs = this.now()): Record<string, TakeoverView> {
    const out: Record<string, TakeoverView> = {};
    for (const m of markets) {
      const s = this.state.get(m);
      const g = this.gapSlots(m, nowMs);
      const at = this.takeoverAt.get(m);
      out[m] = {
        standby: this.isStandby(m, nowMs),
        gapSlots: g === null ? null : g.toString(),
        lastGoodSlot: s ? s.lastGood.toString() : null,
        takeoverPushes: this.takeoverCount.get(m) ?? 0,
        lastTakeoverAgoMs: at === undefined ? null : nowMs - at,
      };
    }
    return out;
  }
}

/**
 * Read cluster slot + each market's `last_good_oracle_slot` (a 176-byte slice per market: header + config up to the field) into the
 * gate. A market whose header does not look like a wrapper market, or whose read fails, is left without fresh state (-> push).
 * Never throws.
 */
export async function refreshTakeoverGate(
  conn: Pick<Connection, "getSlot" | "getMultipleAccountsInfo">,
  gate: TakeoverGate,
  markets: readonly string[],
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    if (markets.length === 0) return;
    const keys = markets.map((m) => new PublicKey(m));
    const [slot, infos] = await Promise.all([
      conn.getSlot("confirmed"),
      // dataSlice keeps this to ~176 bytes per market instead of the whole account
      (conn.getMultipleAccountsInfo as unknown as (k: PublicKey[], c: unknown) => Promise<Array<{ data: Buffer } | null>>)(keys, {
        commitment: "confirmed",
        dataSlice: { offset: 0, length: SLICE_LEN },
      }),
    ]);
    infos.forEach((info, i) => {
      if (!info || info.data.length < SLICE_LEN) return;
      const d = info.data;
      const lastGood = d.readBigUInt64LE(LAST_GOOD_SLOT_OFF);
      gate.update(markets[i], lastGood, BigInt(slot), nowMs);
    });
  } catch {
    // leave the old state to age out -> fail open
  }
}
