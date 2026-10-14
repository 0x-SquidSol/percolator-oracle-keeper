#!/bin/bash
# Railway launcher — the container twin of start-keeper-relaunch.sh.
# Config comes from Railway service variables (no .env file). The keypair comes
# from the KEEPER_KEYPAIR secret (inline JSON u8 array, read directly by
# cross-cluster.ts — never written to disk). The registry lives on the /data
# volume so wizard-registered markets survive restarts; first boot seeds it
# from deploy/registry.relaunch.seed.json.
set -euo pipefail
cd "$(dirname "$0")/.."
export TSX_DISABLE_CACHE=1

: "${MAINNET_RPC_URL:?[fatal] MAINNET_RPC_URL missing}"
: "${DEVNET_RPC_URL:?[fatal] DEVNET_RPC_URL missing}"
: "${WRAPPER_PROGRAM_ID:?[fatal] WRAPPER_PROGRAM_ID missing}"
: "${KEEPER_KEYPAIR:?[fatal] KEEPER_KEYPAIR secret missing}"

# F2: the SECOND, INDEPENDENT pusher is the same image with KEEPER_ROLE=pusher (see deploy/PUSHER-RUNBOOK.md). It has no
# cranks / jobs / Supabase; it reads a registry file (REGISTRY_PATH, or REGISTRY_SEED_JSON written once to the volume).
if [[ "${KEEPER_ROLE:-}" == "pusher" ]]; then
  : "${REGISTRY_PATH:?[fatal] pusher: REGISTRY_PATH missing (e.g. /data/registry.v22.json)}"
  if [[ ! -f "$REGISTRY_PATH" ]]; then
    : "${REGISTRY_SEED_JSON:?[fatal] pusher: $REGISTRY_PATH does not exist and REGISTRY_SEED_JSON is unset}"
    mkdir -p "$(dirname "$REGISTRY_PATH")"
    printf '%s' "$REGISTRY_SEED_JSON" > "$REGISTRY_PATH"
    echo "[railway-start] pusher: seeded $REGISTRY_PATH from REGISTRY_SEED_JSON"
  fi
  : "${PUSHER_PRIMARY_DEVNET_RPC_URL:?[fatal] pusher: set PUSHER_PRIMARY_DEVNET_RPC_URL (the primary's endpoint) so the boot can refuse a shared endpoint}"
  export CC_HEALTH_PORT="${PORT:-${CC_HEALTH_PORT:-18796}}"
  echo "[railway-start] $(date -u +%Y-%m-%dT%H:%M:%SZ) ROLE=pusher BUILDTAG=${RAILWAY_GIT_COMMIT_SHA:0:7} wrapper=${WRAPPER_PROGRAM_ID} health=${CC_HEALTH_PORT} registry=${REGISTRY_PATH}"
  exec node_modules/.bin/tsx src/pusher.ts
fi

# Devnet v2.1 fresh-ID cutover: the SAME image runs two services.
#   - relaunch keeper (v1 / ETDLAdi, close-only markets): KEEPER_DEVNET_V21 unset -> unchanged below.
#   - v2.1 keeper (second service, its own /data volume): KEEPER_DEVNET_V21=1 -> registry.v21.json,
#     seeded from deploy/registry.v21.seed.json (programSet "v21"; TO-FILL from the Phase 3 seed output).
if [[ "${KEEPER_DEVNET_V21:-}" == "1" ]]; then
  REGISTRY_SEED=deploy/registry.v21.seed.json
  export REGISTRY_PATH="${REGISTRY_PATH:-/data/registry.v21.json}"
else
  REGISTRY_SEED=deploy/registry.relaunch.seed.json
  export REGISTRY_PATH="${REGISTRY_PATH:-/data/registry.relaunch.json}"
fi
if [[ ! -f "$REGISTRY_PATH" ]]; then
  mkdir -p "$(dirname "$REGISTRY_PATH")"
  cp "$REGISTRY_SEED" "$REGISTRY_PATH"
  echo "[railway-start] seeded $REGISTRY_PATH from $REGISTRY_SEED"
fi

# Railway routes and health-checks $PORT; the keeper's health server must be on it.
export CC_HEALTH_PORT="${PORT:-${CC_HEALTH_PORT:-18795}}"

SDK_VER=$(node -p 'require("./node_modules/@percolatorct/sdk/package.json").version' 2>/dev/null || echo unknown)
MODE=LIVE
if [[ "${KEEPER_DRY_RUN:-}" == "1" || "${KEEPER_DRY_RUN:-}" == "true" || "${DRY_RUN:-}" == "true" ]]; then MODE=DRY-RUN; fi
echo "[railway-start] $(date -u +%Y-%m-%dT%H:%M:%SZ) BUILDTAG=${RAILWAY_GIT_COMMIT_SHA:0:7} branch=${RAILWAY_GIT_BRANCH:-?} node=$(node -v) sdk=${SDK_VER} wrapper=${WRAPPER_PROGRAM_ID} v21=${KEEPER_DEVNET_V21:-off} health=${CC_HEALTH_PORT} registry=${REGISTRY_PATH} mode=${MODE}"
exec node_modules/.bin/tsx src/cross-cluster.ts
