/**
 * cross-cluster/registry-reload.ts
 *
 * G6: registry hot-reload.
 *
 * Without this, the only way for the running keeper to pick up a re-seed
 * (an operator writing a new registry.json after re-running newmarkets.ts /
 * launch-test-market.ts, e.g. to replace a deep-stale market with a fresh
 * one) is to restart the process — and a restart-gap right after a re-seed
 * is exactly the kind of transient boot miss D5 exists to prevent. This
 * lets an operator drop a new registry.json in place and have it picked up
 * within `intervalMs`, live, with zero keeper downtime. Explicitly called
 * out as "Critical for the upcoming re-seed" in the resilience plan.
 *
 * Reconciles the on-disk registry into the SAME in-memory `Registry` object
 * (reassigns `registry.markets` / `registry.description` in place — never
 * replaces the object reference itself). Every consumer (keeper-loop,
 * recovery-cranker, register-poll) holds a reference to that same object and
 * reads `.markets` fresh every cycle (see register-poll.ts's own doc
 * comment), so a hot-reload is visible to all three loops on their very next
 * cycle — exactly like a register-poll addition already is.
 *
 * "Prune dead slabs": any market address present in memory but no longer
 * present on disk is dropped from `registry.markets`. An operator can remove
 * a bad/dead market from registry.json and have the keeper stop
 * cranking/pushing to it without a restart. (Per-market state left behind in
 * the recovery-cranker's internal `states` Map is simply never iterated
 * again once its market is pruned — a harmless, bounded memory footprint,
 * not a correctness issue.)
 *
 * Interval-based (not fs.watch) deliberately: fs.watch is unreliable across
 * platforms/filesystems for atomic-rename-style writes (which is how
 * saveRegistry / most editors / `mv` actually replace a file — the watch can
 * silently miss the swap on some platforms), and a missed watch event would
 * quietly re-introduce the exact restart-gap this exists to close. A cheap
 * poll (one small JSON file read) bounds the worst-case re-seed pickup
 * latency to one interval with no such platform-dependent failure mode.
 */
import fs from "fs";
import { assertRegistryProgramSet, loadRegistry, registryProgramSet } from "./registry.ts";
import type { MarketEntry, Registry } from "./registry.ts";
import { validateMultiAssetEntry } from "./multi-asset.ts";

export interface RegistryReloadConfig {
  /** Path to registry.json to poll. */
  registryPath: string;
  /** Milliseconds between reload checks (default 15_000). */
  intervalMs?: number;
}

const DEFAULT_RELOAD_INTERVAL_MS = 15_000;

/** Cheap structural compare — false negatives just mean an extra (harmless) log line. */
function sameEntry(a: MarketEntry, b: MarketEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reload `registryPath` from disk once and reconcile any differences into
 * `registry` in place. Never throws — a malformed or transiently unreadable
 * file is logged and skipped, leaving the in-memory registry untouched so a
 * bad/partial write can never blank out a healthy running keeper.
 *
 * Returns `{ added, removed, updated }` counts (all zero if nothing changed).
 */
export function reloadRegistryOnce(
  registry: Registry,
  registryPath: string,
): { added: number; removed: number; updated: number } {
  let onDisk: Registry;
  try {
    if (!fs.existsSync(registryPath)) return { added: 0, removed: 0, updated: 0 };
    onDisk = loadRegistry(registryPath);
    if (!Array.isArray(onDisk.markets)) {
      throw new Error("loaded registry has no markets array");
    }
    // v2.1 cutover: never hot-load the other world's registry into a running
    // keeper (an untagged file on both sides = v1 = unchanged behaviour).
    assertRegistryProgramSet(onDisk, registryProgramSet(registry), registryPath);
    // K-6: a malformed multi-asset row is refused like a malformed file (the keeper never guesses a source).
    const problems = onDisk.markets.flatMap((m) => validateMultiAssetEntry(m));
    if (problems.length > 0) throw new Error(`invalid multi-asset row(s): ${problems.join("; ")}`);
  } catch (err) {
    console.warn(
      `[registry-reload] failed to read/parse ${registryPath} — keeping current in-memory registry: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { added: 0, removed: 0, updated: 0 };
  }

  const onDiskByAddr = new Map(onDisk.markets.map((m) => [m.marketAddress, m]));
  const inMemByAddr = new Map(registry.markets.map((m) => [m.marketAddress, m]));

  let added = 0;
  let removed = 0;
  let updated = 0;

  for (const [addr, entry] of onDiskByAddr) {
    const existing = inMemByAddr.get(addr);
    if (!existing) {
      added++;
      console.log(`[registry-reload] + added ${entry.label} (${addr.slice(0, 8)}…)`);
    } else if (!sameEntry(existing, entry)) {
      updated++;
      console.log(`[registry-reload] ~ updated ${entry.label} (${addr.slice(0, 8)}…)`);
    }
  }

  // Prune dead slabs — present in memory but no longer on disk.
  for (const [addr, entry] of inMemByAddr) {
    if (!onDiskByAddr.has(addr)) {
      removed++;
      console.log(`[registry-reload] - pruned ${entry.label} (${addr.slice(0, 8)}…) — no longer in ${registryPath}`);
    }
  }

  if (added === 0 && removed === 0 && updated === 0) {
    return { added: 0, removed: 0, updated: 0 };
  }

  // Mutate the SAME object's contents by reassigning its properties — every
  // loop reads `registry.markets` fresh each cycle, so this is visible
  // everywhere, on the very next tick, with no restart.
  registry.markets = onDisk.markets;
  registry.description = onDisk.description;
  console.log(
    `[registry-reload] registry.json changed: +${added} -${removed} ~${updated} → ${registry.markets.length} market(s) now tracked`,
  );
  return { added, removed, updated };
}

/**
 * Start the registry hot-reload loop. Polls `registryPath` on a fixed
 * interval and reconciles into `registry` in place. Runs indefinitely; call
 * this WITHOUT awaiting it (`void startRegistryReloadLoop(...).catch(...)`),
 * same pattern as the other background loops (recovery-cranker,
 * register-poll).
 */
export async function startRegistryReloadLoop(
  registry: Registry,
  config: RegistryReloadConfig,
): Promise<void> {
  const intervalMs = config.intervalMs ?? DEFAULT_RELOAD_INTERVAL_MS;
  console.log(`[registry-reload] starting: path=${config.registryPath} interval=${intervalMs}ms`);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  while (!stopping) {
    const cycleStart = Date.now();
    try {
      reloadRegistryOnce(registry, config.registryPath);
    } catch (err) {
      // Defense in depth: reloadRegistryOnce already isolates every failure
      // mode internally, but never let an unexpected throw kill this loop.
      console.error(`[registry-reload] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const elapsed = Date.now() - cycleStart;
    const remaining = intervalMs - elapsed;
    if (remaining > 0 && !stopping) {
      await new Promise((r) => setTimeout(r, remaining));
    }
  }
  console.log("[registry-reload] stopped.");
}
