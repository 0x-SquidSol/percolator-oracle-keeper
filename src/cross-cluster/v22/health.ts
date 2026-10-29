/**
 * cross-cluster/v22/health.ts
 *
 * /health fields of the v2.2 layer. ADDITIVE ONLY: `v22HealthFields()` returns `{}` unless the layer was started
 * (`setV22HealthProvider`), so with every v2.2 flag off the /health body is byte-identical to before.
 */
export type V22HealthProvider = () => Record<string, unknown> | null;

let provider: V22HealthProvider | null = null;

export function setV22HealthProvider(p: V22HealthProvider | null): void {
  provider = p;
}

export function v22HealthFields(): Record<string, unknown> {
  try {
    const f = provider?.();
    return f ? { v22: f } : {};
  } catch {
    return {};
  }
}

/**
 * /health `levGuard` block of the leverage-guard keeper (lev-guard.ts). Additive: `{}` unless a KEEPER_LEV_* flag created the keeper, so with
 * every one of them off the /health body is byte-identical to before.
 */
let levProvider: V22HealthProvider | null = null;

export function setLevGuardHealthProvider(p: V22HealthProvider | null): void {
  levProvider = p;
}

export function levGuardHealthFields(): Record<string, unknown> {
  try {
    const f = levProvider?.();
    return f ? { levGuard: f } : {};
  } catch {
    return {};
  }
}
