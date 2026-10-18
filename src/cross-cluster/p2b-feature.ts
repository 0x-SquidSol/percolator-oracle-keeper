/**
 * cross-cluster/p2b-feature.ts
 *
 * Feature detection for the v2.1 ("P2b") wrapper program, so every v2.1 keeper behaviour is a
 * strict NO-OP against today's programs.
 *
 * There is no on-chain version byte, so detection combines two signals:
 *
 *   (a) an operator switch, `P2B_FEATURES` = "auto" (default) | "on" | "off";
 *   (b) in "auto", a cached per-program-id PROBE: `simulateTransaction` of a tag-103
 *       (VaultLpAllocate) on one BOUND market of the registry, never sent.
 *
 * Probe classification (the instruction decoder runs before any account check, so the first
 * answer is decisive):
 *
 *   simulation ok                              -> supported (and there was room)
 *   Custom(n) of any n (100 = no room, etc.)   -> supported: the program DECODED tag 103
 *   InvalidInstructionData (not a Custom)      -> unsupported: the program predates P2b
 *   anything else (RPC error, blockhash, a non-Custom instruction error, no bound market)
 *                                              -> unknown: treated as unsupported, retried soon
 *
 * Caching: "unsupported" is remembered for a long TTL (default 6 h; programs do not upgrade
 * often) and logged ONCE; "supported" is re-verified rarely (default 1 h); "unknown" is retried
 * after a short delay. On today's programs this is the ONLY RPC the whole v2.1 layer makes:
 * one registry/state read plus one simulation per TTL.
 *
 * "on" skips the probe and assumes support (the individual cranks still simulate before they
 * send, so a wrong "on" costs simulations, not transactions); "off" disables the layer entirely.
 *
 * The unrelated, on-chain-flag-driven change (the tag-78 ext tail) does NOT use this gate: it
 * follows the registry's own ext flag byte, which is 0 on every pre-P2b program.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { RECOMMENDED_CU_P3, buildVaultLpAllocateIxP2b, deriveLpVaultRegistry } from "@percolatorct/sdk";
import type { MarketEntry } from "./registry.ts";
import { lpVaultRegistryBound } from "./registry-flags.ts";
import { decodeVaultLpState, deriveVaultLpState } from "./resolved-portfolio-cleanup.ts";
import { parseInstructionError } from "./positioned-refresh.ts";
import { parseLpVaultRegistry } from "@percolatorct/sdk";
import { addKeeperPriorityFee } from "./priority-fee.ts";

export type P2bMode = "auto" | "on" | "off";
export type P2bProbeResult = "supported" | "unsupported" | "unknown" | "no-candidate";

export interface P2bGateConfig {
  mode: P2bMode;
  /** Re-verify a "supported" answer this often. */
  supportedTtlMs: number;
  /** Remember an "unsupported" answer this long. */
  unsupportedTtlMs: number;
  /** Retry an "unknown" / "no-candidate" answer after this long. */
  unknownRetryMs: number;
}

export const DEFAULT_P2B_GATE_CONFIG: P2bGateConfig = {
  mode: "auto",
  supportedTtlMs: 60 * 60_000,
  unsupportedTtlMs: 6 * 60 * 60_000,
  unknownRetryMs: 60_000,
};

type Env = Readonly<Record<string, string | undefined>>;

function envPosInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new Error(`${name}="${raw}" must be a positive integer`);
  return n;
}

/** Gate config from env (P2B_FEATURES, P2B_PROBE_*). Throws on garbage so a typo fails boot, not a loop. */
export function p2bGateConfigFromEnv(env: Env): P2bGateConfig {
  const raw = (env.P2B_FEATURES ?? "auto").trim().toLowerCase();
  if (raw !== "auto" && raw !== "on" && raw !== "off") throw new Error(`P2B_FEATURES="${env.P2B_FEATURES}" must be auto|on|off`);
  return {
    mode: raw,
    supportedTtlMs: envPosInt(env, "P2B_PROBE_SUPPORTED_TTL_MS", DEFAULT_P2B_GATE_CONFIG.supportedTtlMs),
    unsupportedTtlMs: envPosInt(env, "P2B_PROBE_UNSUPPORTED_TTL_MS", DEFAULT_P2B_GATE_CONFIG.unsupportedTtlMs),
    unknownRetryMs: envPosInt(env, "P2B_PROBE_RETRY_MS", DEFAULT_P2B_GATE_CONFIG.unknownRetryMs),
  };
}

/**
 * Classify the `err` of a simulated tag 103. Pure.
 * `{"InstructionError":[i,"InvalidInstructionData"]}` -> unsupported; `{Custom:n}` or null -> supported.
 */
export function classifyProbeError(err: unknown): "supported" | "unsupported" | "unknown" {
  if (err === null || err === undefined) return "supported";
  if (typeof err === "object" && "InstructionError" in err) {
    const ie = (err as { InstructionError: unknown }).InstructionError;
    if (Array.isArray(ie)) {
      const detail = ie[1];
      if (detail === "InvalidInstructionData") return "unsupported";
      if (detail && typeof detail === "object" && "Custom" in detail && typeof (detail as { Custom: unknown }).Custom === "number") return "supported";
    }
  }
  return "unknown";
}

export interface P2bGateSnapshot {
  mode: P2bMode;
  /** null = not determined yet. */
  supported: boolean | null;
  lastProbe: P2bProbeResult | null;
  lastProbeAt: number | null;
  probes: number;
}

/**
 * The gate. `probe` is injected so tests (and a future registry-flag source) can replace it.
 * `ensure()` is cheap when the cached answer is fresh and never throws.
 */
export class P2bFeatureGate {
  private supported: boolean | null = null;
  private lastProbe: P2bProbeResult | null = null;
  private lastProbeAt: number | null = null;
  private probes = 0;
  private inflight: Promise<boolean> | null = null;
  private loggedUnsupported = false;

  constructor(
    private readonly cfg: P2bGateConfig,
    private readonly probe: () => Promise<P2bProbeResult>,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  /** Last known answer, synchronous. false until determined. */
  isSupported(): boolean {
    if (this.cfg.mode === "off") return false;
    if (this.cfg.mode === "on") return true;
    return this.supported === true;
  }

  snapshot(): P2bGateSnapshot {
    return { mode: this.cfg.mode, supported: this.cfg.mode === "auto" ? this.supported : this.cfg.mode === "on", lastProbe: this.lastProbe, lastProbeAt: this.lastProbeAt, probes: this.probes };
  }

  /** Refresh the cached answer when its TTL elapsed. Returns the (new) answer. Never throws. */
  async ensure(): Promise<boolean> {
    if (this.cfg.mode !== "auto") return this.isSupported();
    const now = this.now();
    if (this.lastProbeAt !== null) {
      const ttl =
        this.lastProbe === "supported" ? this.cfg.supportedTtlMs : this.lastProbe === "unsupported" ? this.cfg.unsupportedTtlMs : this.cfg.unknownRetryMs;
      if (now - this.lastProbeAt < ttl) return this.isSupported();
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      let r: P2bProbeResult;
      try {
        r = await this.probe();
      } catch {
        r = "unknown";
      }
      this.probes++;
      this.lastProbe = r;
      this.lastProbeAt = this.now();
      const before = this.supported;
      if (r === "supported") this.supported = true;
      else if (r === "unsupported") this.supported = false;
      // unknown / no-candidate: keep the previous answer if any (a transient RPC error must not flip a known state)
      if (this.supported === null) this.supported = false;
      if (r === "unsupported" && !this.loggedUnsupported) {
        this.loggedUnsupported = true;
        this.log("[p2b] wrapper predates P2b (tag 103 -> InvalidInstructionData): v2.1 keeper features stay OFF (re-probed every long TTL)");
      } else if (r === "supported" && before !== true) {
        this.log("[p2b] wrapper supports P2b (tag 103 decoded): v2.1 keeper features ON");
      }
      return this.isSupported();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** A send hit InvalidInstructionData for a P2b tag: the program does not support it (after "on"/a stale "supported"). */
  reportUnsupported(): void {
    if (this.cfg.mode !== "auto") return;
    this.supported = false;
    this.lastProbe = "unsupported";
    this.lastProbeAt = this.now();
  }
}

// ── The probe ────────────────────────────────────────────────────────────────

export type ProbeConnection = Pick<Connection, "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction">;

/**
 * Build the tag-103 probe over the registry's markets: find the first BOUND vault-LP market
 * (registry bound flag + a decodable vault_lp_state), simulate a tag 103 on it. One batched read
 * and one simulation. Never sends.
 */
export function makeTag103Probe(deps: {
  conn: ProbeConnection;
  keeper: Keypair;
  programId: PublicKey;
  markets: () => ReadonlyArray<Pick<MarketEntry, "marketAddress">>;
}): () => Promise<P2bProbeResult> {
  return async () => {
    const markets = deps.markets();
    if (markets.length === 0) return "no-candidate";
    const keys: PublicKey[] = [];
    const pubs: PublicKey[] = [];
    for (const m of markets) {
      const market = new PublicKey(m.marketAddress);
      pubs.push(market);
      keys.push(deriveLpVaultRegistry(deps.programId, market)[0], deriveVaultLpState(deps.programId, market));
    }
    const infos: Array<{ data: Buffer } | null> = [];
    for (let i = 0; i < keys.length; i += 100) {
      infos.push(...((await deps.conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")) as Array<{ data: Buffer } | null>));
    }
    for (let i = 0; i < pubs.length; i++) {
      const reg = infos[2 * i];
      const st = infos[2 * i + 1];
      if (!reg || !st) continue;
      let bound = false;
      let domain = 0;
      try {
        bound = lpVaultRegistryBound(new Uint8Array(reg.data));
        domain = Number(parseLpVaultRegistry(new Uint8Array(reg.data)).domain);
      } catch {
        continue;
      }
      const state = decodeVaultLpState(new Uint8Array(st.data));
      if (!bound || !state) continue;
      const ix = buildVaultLpAllocateIxP2b(
        { programId: deps.programId, market: pubs[i], registryDomain: domain, lpPortfolio: state.lpPortfolio },
        deps.keeper.publicKey,
      );
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: RECOMMENDED_CU_P3.tradeCpi }));
      tx.add(ix);
      const { blockhash } = await deps.conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = deps.keeper.publicKey;
      addKeeperPriorityFee(tx); // S3-A2: optional CU price, appended last (OFF by default)
      tx.sign(deps.keeper);
      const sim = await deps.conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
      // instruction index 1 (0 is the compute-budget ix); a failure at index 0 would be a runtime problem, not an answer
      const ie = parseInstructionError(sim.value.err);
      if (ie && ie.index === 0) return "unknown";
      return classifyProbeError(sim.value.err);
    }
    return "no-candidate";
  };
}

// ── Process-wide gate ────────────────────────────────────────────────────────

const OFF_GATE = new P2bFeatureGate({ ...DEFAULT_P2B_GATE_CONFIG, mode: "off" }, async () => "unknown");
let sharedGate: P2bFeatureGate = OFF_GATE;

/** Install the process-wide gate (cross-cluster.ts at boot; tests). */
export function setP2bGate(g: P2bFeatureGate | null): void {
  sharedGate = g ?? OFF_GATE;
}

/** The process-wide gate. Before boot installs one it is permanently OFF, so unit tests of old paths see today's behaviour. */
export function getP2bGate(): P2bFeatureGate {
  return sharedGate;
}

/** Synchronous "are the v2.1 behaviours on": the shared gate's last known answer. */
export function isP2bSupported(): boolean {
  return sharedGate.isSupported();
}
