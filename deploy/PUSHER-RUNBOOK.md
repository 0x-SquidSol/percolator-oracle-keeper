# Second independent pusher (F2) runbook

Purpose: one keeper outage must not leave every v2.2 market stale (permissionlessly resolvable after 18,000 slots, ~72 min).
This service only pushes marks (and attested/on-chain depth when the same flags are on). It does nothing else.

## Behaviour
- Reads the same mainnet pools as the keeper and keeps its mark smoother warm, but sends nothing while
  `cluster_slot - last_good_oracle_slot < PUSHER_TAKEOVER_SLOTS` (default 60 slots, ~24 s): the primary is alive.
- Once a market's on-chain price is older than that, it pushes (a takeover) and logs `[pusher][TAKEOVER]`; an `[ALERT]`
  `pusher-takeover` (critical) is raised through the usual webhook/Telegram sink and resolves itself when the primary is back.
- Unknown on-chain state (RPC failing) = it pushes (fail open; a duplicate is harmless).
- Duplicate pushes are harmless: both sides propose `watermark + 1`; the loser reverts with Custom(19) in preflight, re-reads the
  nonce and retries once, with no quarantine strike. Neither can corrupt the other.
- `/health` shows `role: "pusher"` and per market `standby`, `gapSlots`, `takeoverPushes`, `lastTakeoverAgoMs`.

## Create the Railway service (do NOT point it at the primary's project/key)
1. New service from this repo, branch of your choice; Config-as-code file `railway.pusher.toml`; volume `/data`.
2. Variables (secrets in Railway, not in git):
   - `KEEPER_ROLE=pusher`
   - `DEVNET_RPC_URL`  its OWN endpoint/key (not the primary's); `PUSHER_PRIMARY_DEVNET_RPC_URL` = the primary's endpoint (boot refuses if equal)
   - `MAINNET_RPC_URL`, `KEEPER_KEYPAIR` (the market oracle authority key), `WRAPPER_PROGRAM_ID` and the v2.2 program-id set as for the keeper
   - `REGISTRY_PATH=/data/registry.v22.json`, `REGISTRY_SEED_JSON=<contents of the v2.2 registry>` (written once)
   - `CC_INTERVAL_MS=3000`, `CC_MARK_WINDOW_MS=17000` (same cadence pair as the keeper), optional `KEEPER_PUSH_DEPTH=on`
   - optional `PUSHER_TAKEOVER_SLOTS`, `KEEPER_ALERT_WEBHOOK_URL` / Telegram vars
3. Deploy; check `/health` (`role=pusher`, every market `standby: true` while the primary is up) and the boot line.
4. Rehearse: stop the primary for a few minutes on devnet; expect `[pusher][TAKEOVER]` lines and the alert; restart it; expect RESOLVED.

## Registry
The pusher reads a registry file only (no Supabase / register-poll) and hot-reloads it. After a re-seed, update the file on its volume.
