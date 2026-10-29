# percolator-oracle-keeper

Production-grade oracle keeper for [Percolator](https://github.com/dcccrypto/percolator-launch) — pushes price feeds to Percolator devnet markets via `PushOraclePrice` + `KeeperCrank`.

## What It Does

- **Multi-source price failover**: Pyth Hermes → Jupiter → DexScreener → mainnet CA lookup
- **Staleness detection**: alerts if price hasn't updated in configurable threshold (default 30s)
- **Circuit breaker**: rejects price moves > 10% per update (configurable); a sustained move confirms after 3 consecutive trips, and every published mark is rate-limited to ±30% of every mark in force during the trailing hour — sub-threshold steps included (a larger move advances to the band edge, is held there — re-pushed unchanged so the oracle stays fresh — and continues as older marks leave the window)
- **Health endpoint**: `/health` for Railway/monitoring with per-market stats
- **Graceful shutdown** with drain on SIGINT/SIGTERM
- **Supabase auto-discovery**: automatically cranks newly-created markets
- **HYPERP oracle mode**: cranks DEX-pool-based oracle markets (PumpSwap, Raydium, Meteora)
- **Wallet balance guard**: pauses pushes if keeper wallet goes below threshold
- **Oracle authority verification**: skips markets where the keeper isn't the oracle authority

## Requirements

- Node.js 20+
- A Solana keypair with oracle authority over the target markets
- RPC endpoint (Helius recommended for devnet)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your RPC_URL and keypair
npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | ✅ | — | Solana RPC endpoint |
| `ADMIN_KEYPAIR` | ✅* | — | JSON array of 64-byte keypair (for Railway) |
| `ADMIN_KEYPAIR_PATH` | ✅* | `~/.config/solana/percolator-upgrade-authority.json` | Path to keypair file |
| `SUPABASE_URL` | — | — | Enables auto-discovery of new markets |
| `SUPABASE_SERVICE_ROLE_KEY` | — | — | Required if SUPABASE_URL set |
| `DEPLOYMENT_JSON` | — | — | Deployment JSON (alternative to Supabase) |
| `PUSH_INTERVAL_MS` | — | `3000` | How often to push prices (ms) |
| `CC_HEALTH_PORT` | — | `3001` (pusher `3002`) | Health endpoint port |
| `CC_HEALTH_BIND` | — | `0.0.0.0` | Health endpoint bind address |
| `MAX_PRICE_MOVE_PCT` | — | `10` | Circuit breaker threshold (%) |
| `STALE_THRESHOLD_S` | — | `30` | Staleness alert threshold (seconds) |
| `MIN_KEEPER_BALANCE_SOL` | — | `0.05` | Minimum wallet balance before pausing |
| `ORACLE_KEEPER_BLOCKED_MARKETS` | — | — | Comma-separated slab addresses to skip |

*One of `ADMIN_KEYPAIR` or `ADMIN_KEYPAIR_PATH` is required.

## Health Endpoint

```
GET /health
```

Returns JSON with the overall status, the wallet balance and per-market stats (`src/cross-cluster/keeper-loop.ts` `makeHealthHandler`), for example:

```json
{
  "walletLow": false,
  "walletBalanceSol": "1.2346",
  "status": "ok",
  "lastSuccessfulPushAgo": "2s",
  "uptimeSec": 3600,
  "markets": { "<market address>": { "label": "SOL", "...": "..." } }
}
```

`/health` has no authentication, by design: Railway's health check calls it with no header. It is meant to carry no secrets:
the balance of the keeper's fee payer (public on chain), market addresses and prices, push and crank counters, and
error text; RPC URLs are redacted (`rpc-failover.ts` `redactUrl`). The launchers bind it to `127.0.0.1` (`run-v22fresh.sh`) or to
Railway's `$PORT` (`deploy/railway-start.sh`). Do not give a Railway keeper service a public domain.

## Deployment (Railway)

This service is deployed to Railway as `oracle-keeper` (service ID: `8bcc8946`).

Required Railway environment variables:
- `RPC_URL` — Helius devnet RPC
- `ADMIN_KEYPAIR` — JSON keypair array
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — for market auto-discovery

## Devnet v2.1 fresh-ID cutover: two keepers

v2.1 ships as a fresh program-ID set; the ETDLAdi world is not upgraded and its markets become close-only.
The program set is chosen by one explicit switch, `KEEPER_DEVNET_V21` (`src/program-ids.ts`):

| `KEEPER_DEVNET_V21` | wrapper / stake / matcher / nft | default registry (Railway) |
|---|---|---|
| unset / `0` (default) | `ETDLAdi…` / `VmpVUArR…` / `EDKKgRaV…` / `EMYT15LZ…` (pinned literals, independent of the SDK defaults) | `/data/registry.relaunch.json` |
| `1` | `5NGgnU2j…` / `A6DVNubv…` / `DfTxJUT5…` / `DWUNq2iY…` | `/data/registry.v21.json`, seeded from `deploy/registry.v21.seed.json` (TO-FILL from the Phase 3 `newmarkets` output) |

- The existing relaunch service (`relaunch-live`) keeps running unchanged with the switch off, so v1 markets keep
  oracle pushes and cranks and their exits keep working.
- v2.1 runs as a SECOND Railway service from the same image with `KEEPER_DEVNET_V21=1`, its own `/data` volume and
  `WRAPPER_PROGRAM_ID=5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe` (the launcher requires it). One replica per service.
- A v2.1 ID without the switch, or a v1 ID with it, fails boot. A registry is tagged `"programSet": "v21"`; each keeper
  refuses to boot or hot-reload the other world's registry. The register-poll owner filter follows the selected wrapper.

## Architecture

Previously part of `percolator-launch/bots/oracle-keeper/`. Extracted to standalone repo for cleaner architecture. The oracle-keeper is a backend service; the frontend lives in [percolator-launch](https://github.com/dcccrypto/percolator-launch).

## Chart tick publisher (optional)

When `TICK_INGEST_URL` and `TICK_INGEST_KEY` are both set, each cycle's *landed* pushes are POSTed
(`authorization: Bearer <key>`) as wire v1 `{v:1,src:"keeper",sentMs,ticks:[{slab,assetIndex,slot,landedMs,markE6,oracleE6}]}`
(max 200 ticks/request; `markE6` = published AuthMark, `oracleE6` = raw pool price or null). Fire-and-forget with a
single request in flight (extra batches are dropped and counted), `TICK_PUBLISH_TIMEOUT_MS` timeout (default 1500).
Counters appear under `tickPublisher` in `/health`. Unset = no-op; on-chain behaviour is never affected.

## v2.1 (P2b) layer — feature-detected, no-op on today's programs

The keeper carries the client side of the v2.1 wrapper (percolator-prog #524/#525/#526) behind a feature
gate (`src/cross-cluster/p2b-feature.ts`). There is no on-chain version byte, so `P2B_FEATURES=auto`
(default) runs one cached probe: a SIMULATED tag-103 (`VaultLpAllocate`) on a bound market.
`InvalidInstructionData` means the program predates P2b (cached 6 h, logged once, everything below stays
OFF); any `Custom(n)` (including 100 = no room) or success means supported. `on` skips the probe, `off`
never creates the loop.

When supported (tick every `P2B_TICK_MS`, one batched snapshot read per tick):

- **Tag 103 allocation cranks** (`p2b-allocate.ts`): per bound, Live market with no senior draw
  outstanding, paced ~60 s +-25%, simulated first, sent only on a clean simulation (`Custom(100)` = skip).
- **Tag 104 AdlWindDown** (`p2b-wind-down.ts`): for ADL reduce-only assets, one arming call per episode,
  then closes of the reduce-only side's legs once the episode expired or the side is dust; mark-age and
  per-cycle bounds; refusals 21/27/16/22 are classified and counted.
- **Hedged-lockout alert** (`p2b-hedged-lockout.ts`): both sides of a growth asset >= 90% of N_cap while the
  vault LP is within 3% of flat.
- **R3-M1** (`p2b-earn-gap.ts`): `/health` gains `earnVaults[]` (par - E3 gap per non-bound Earn vault,
  bigints as strings) and an alert when the gap exceeds `EARN_GAP_ALERT_BPS` for `EARN_GAP_ALERT_CYCLES`;
  the refresh prune budget no longer caps below the positioned set.

Independent of the gate: tag 78 on a bound vault appends `[7]` ext and `[8]` vault LP once the registry ext
flag (byte 161) is set (it is 0 on every pre-P2b program). See `.env.example` for every knob.

## v2.2 keeper (KEEPER_V22, default OFF)

Entry point is `src/cross-cluster.ts` (the Railway / launchd launcher runs `tsx src/cross-cluster.ts`; `src/index.ts` is not the live entry).
Everything below is flag-gated and default OFF: with no `KEEPER_V22*` variable set the v2.2 layer is never created,
the legacy cranker / fee job / vault-LP cranker take their old paths, and `/health` gains no key.

**SDK pin.** `@percolatorct/sdk` = `github:dcccrypto/percolator-sdk#ecb6215ec634e2a284bcc0f409c4ca5df6cb43a1`
(percolator-sdk#406, branch `feat/v22-sdk`: `LAYOUT_V22` variant B, VERSION-keyed layout guard, v2.2 builders, compute presets).
`@solana/web3.js` is 1.99.0 (the SDK's peer). To move the pin: change the ref in `package.json`, `pnpm install`, `npm install --package-lock-only`.

**Layout.** `market-layout.ts` keeps one table; the variant-B row (`v2.2-b`: group 806, slot 2,661, leg 217, portfolio 10,603, VERSION 19)
is derived from the SDK's `LAYOUT_V22` and refused if the two ever disagree. A VERSION the SDK has no table for, a length that matches no row,
a bad magic or a wrong kind is a loud error: counted (`layout-guard-metrics.ts`), logged once, `/health` `layoutGuard` + `status: degraded-markets`. No silent fallback.

**Position cap 4 (release candidate engine `bfa3d037` / wrapper `c6ee0b6e`).** An account holds at most 4 legs and a refresh or liquidation settles all of them.
Sizing is leg-aware and selected by the layout (`legCostModelFor`: a v2.2 layout gets `V22_LEG_COST`, every v2.1 layout gets none and keeps the single-leg
145k / 250k / seven-per-tx arithmetic byte for byte). Typical refresh 145k / 175k / 210k / 245k for 1 to 4 legs (35k x (3 + legs)); liquidation 250k at one leg up to 729k at four;
worst settle at the cap 1,013,864 CU (liens + ADL, real #287 hook), against the 1.4M transaction. An account with 3 or more legs (`V22_SOLO_MIN_LEGS`, the wrapper's
`WRAPPER_PRE_CRANK_MIN_LEGS`) is planned ALONE in its own transaction (`SOLO_WEIGHT` in the settle-pairing rounds, overflow chunks of one in the legacy cranker,
a batch of one in the drift sweep) and the single-instruction jobs (rent 106, dust 118) request `worst + 200k` for it (1,213,864). The legs counted are ALL the account's
active legs (`activeLegs`), not only those on the asset being cranked. The keeper still cranks asset 0 only: positions on assets 1 and up are not in its positioned set.
The keeper sends none of tags 74, 120, 121 or 122 and reads no G9 allowlist account (a test guards that); the 2,064 B allowlist body and tags 120 / 121 / 122 are in the SDK.

| flag | default | what |
|---|---|---|
| `KEEPER_V22` | off | master switch |
| `KEEPER_V22_DRY_RUN` | off | simulate and log "would send", send nothing (also implied by `DRY_RUN`) |
| `KEEPER_V22_TICK_MS` | 20000 | loop tick |
| `KEEPER_V22_FEE_CRANK_BOND` | off | tag 78 on bond markets: LP crank (tag 5) first, then 78 with ext + writable LP + tranche |
| `KEEPER_V22_SWEEP` | off | positioned-refresh sweep for variant-B markets, leg-weight budget (3 + legs), heaviest first |
| `KEEPER_V22_LIQUIDATE` | off | F1: a liquidation crank (second no-observation crank) in the same sweep tx as the refresh of every account measured at or below maintenance after the simulated refresh. Simulates first; a crank the engine refuses (22 = nothing to liquidate) is dropped and the plain refresh goes out. Needs `KEEPER_V22_SWEEP`. Log lines start `[liq]` |
| `KEEPER_V22_LIQUIDATE_PAD_BPS` | 500 | plan-time pad over maintenance (bps of notional): accounts within it weigh more in the round plan |
| `KEEPER_V22_LIQUIDATE_MAX_PER_TX` | 4 | most liquidation cranks per sweep tx |
| `KEEPER_V22_SETTLE_PAIRING` | prefer | `off` / `prefer` / `strict`; acts only with the sweep on. See `v22/settle-pairing.ts` |
| `KEEPER_V22_ACCRUE_ANCHORS` | none | `market:flatPortfolio,...` accrue-only crank targets (else discovered) |
| `KEEPER_V22_HOLDING_RENT` / `_RENT_CADENCE_SLOTS` | off / 9000 | tag 106 on rent markets |
| `KEEPER_V22_DUST_SWEEP` | off | tag 118 (own flag; keep off on a wrapper without the bilateral fix) |
| `KEEPER_V22_G9` | off | tag 111 propose -> 9,000 slots -> draw, restore |
| `KEEPER_V22_G9_DRY_RUN` | **on** | G9 logs only until set to `off` |
| `KEEPER_V22_G9_ALLOW_ANY_ORACLE_MODE` | off | skip the Hybrid-only gate (devnet testing) |
| `KEEPER_V22_G9_DRAW_CAP_ATOMS` | u64 max | cap passed to draw / restore |
| `KEEPER_V22_MAINNET_BUILD` | off | G9 modes 0/2 pass the allowlist PDA + leg accounts |
| `KEEPER_V22_STAKE_SYNC` / `_INTERVAL_MS` | off / 60000 | stake v5 tag 31 |
| `KEEPER_V22_EARN_EXIT` | off | tag 77 on `keeper_ok` requests, only on a loss-current book |
| `KEEPER_V22_LIFECYCLE` | **on** | read-only dead-market classifier (NEVER-CONNECTED / DEAD-PRICE warn + matured / DEAD-INTEREST), `/health` `v22.lifecycle`, alerts. Sends nothing |
| `KEEPER_V22_STALE_RESOLVE` | **off** | `off` / `dry` / `on` only (`yes`/`true` refused): permissionless stale resolve, wrapper tag 39, IRREVERSIBLE. `dry` runs every guard + the simulation and logs "would resolve". See "Market lifecycle" below |
| `KEEPER_V22_STALE_RESOLVE_MIN_OBS_MS` | 1800000 | continuous healthy observation AND (for markets the keeper can push) source-unavailable time required before a resolve |
| `KEEPER_V22_STALE_RESOLVE_MASS_THRESHOLD` | 3 | more OUTAGE-SHAPED matured markets than this: resolve none, critical alert |
| `KEEPER_V22_STALE_RESOLVE_MAX_PER_CYCLE` / `_RETRY_MS` | 1 / 600000 | resolves per tick; wait after an attempt before retrying that market |
| `KEEPER_V22_STALE_RESOLVE_UNREGISTERED_ALLOW` | none | comma-separated addresses: the ONLY unregistered markets whose oracle authority is this keeper that may be resolved. Otherwise they are HELD with an alert (register or operator decision) |
| `KEEPER_V22_STALE_RESOLVE_SOURCE_LOSS_MAX` / `_PCT` | 3 / 50 | global source-health hold: more than MAX, or more than PCT percent (and >= 2), of the markets the keeper can push lacking a usable source at once = price-reader regression: resolve no pushable market, critical alert |
| `KEEPER_V22_STALE_RESOLVE_GROUP_LOSS_PCT` | 100 | correlation hold: when this percent (and >= 2 markets) of the pushable markets sharing one DEX type lack a usable source at once, resolves of that group are held |
| `KEEPER_V22_LIFECYCLE_MAX_GAP_MS` | 120000 | a gap between two observations longer than this breaks "continuous" |
| `KEEPER_V22_NEVER_CONNECTED_GRACE_SLOTS` | 1500 | price age before a market with no push path is called NEVER-CONNECTED |
| `KEEPER_V22_DEAD_INTEREST_DAYS` | 14 | quiet days (OI 0, no trade-fee accrual observed) before DEAD-INTEREST |
| `KEEPER_V22_LIFECYCLE_DISCOVERY_MS` | 600000 | keys-only gPA for wrapper markets with no registry row (0 = off) |
| `KEEPER_V22_LIFECYCLE_STATE_FILE` | none | absolute path; persists the DEAD-INTEREST quiet clock across restarts |
| `KEEPER_V22_WARN_BAND_FEES` / `_SPACING_MS` / `_MAX_PER_TICK` | **off** / 60000 / 4 | in the DEAD-PRICE warn band (>= 50% of the stale window) force tag 78 and tag 87 + stake 12 every spacing, because both are refused once matured and an uncranked staker leg is forfeited |
| `VAULT_LP_LONE_CRANK` | on | `off` suppresses the lone vault-LP crank after every landed push (works without `KEEPER_V22`) |

**SETTLE_PAIRING.** Engine tag 5 on a portfolio settles only that portfolio, then accrues; a loss is booked at once, counterparties' gains
only when they are settled. The LP settled alone at a peak strands value. Policy: the round tracks which counterparties ACTUALLY settled
(landed refresh, or the program said "already current", Custom(22)). The LP tx is sent only if every positioned counterparty settled, or under
`prefer` when the only misses are portfolios the program REFUSED (band 104/111/112/113, hard refusal; counted in `unpairedLpSettles`);
`strict` holds the LP in that case. A counterparty tx that did not LAND holds the LP in both modes: there is no "force after N rounds".
A multi-tx round sends the counterparty txs first (parallel, pushes held) and the LP tx LAST, only inside `maxGapSlots` (8); a round that
exceeds it backs off 1 then 2 rounds (counted `gapBackoffRounds`) instead of re-sending phase 1 every tick.
A refused refresh is isolated (pruned, the rest re-sent) and the portfolio is quarantined (150 slots for a band state, 1,500 for a hard refusal).
Accrue-only: the no-observation crank does NOT accrue (Custom(22) unless already accrued); an observation crank accrues through whichever portfolio it
targets. The accrue goes through the KEEPER'S OWN flat portfolio when one exists (never a user's; verified by the program: a NoAction crank succeeds iff it accrued),
else through the tx's first counterparty (counted `counterpartyAccrues`). A landed Custom(22) on the accrue (a parallel tx accrued the same slot) means "already accrued": re-sent refresh-only.
The observation crank carries the Hybrid oracle leg accounts (without them the wrapper answers NotEnoughAccountKeys).
Tag 78 runs at the END of a paired round (alone, the LP was just settled), tag 106 rent settles ride the round in place of that portfolio's refresh
(the sweep-off timer paths are the only lone ones, and exist only without pairing). Any LP-alone settle that remains (78 timer path without the sweep, `prefer` overflow) is counted.

LP protection latency. The 1.5 s lone LP crank is suppressed on v2.2 markets while sweep + pairing are on, so the LP's own senior-draw / liquidation protection
waits for the next round: up to one crank cycle (`CRANK_INTERVAL_MS`, default 20 s) plus the round (about 1-5 s). Exception: on every landed push the v2.2 layer checks
the LP (senior draw pending, or equity <= 20% of capital: a coarse heuristic, the program decides) and, if so, runs a full PAIRED round immediately (about one round, 1-5 s). A protective
round may go with phase-1 failures but still puts the LP last in a tx WITH counterparties, never alone. No lone LP crank is reintroduced.

What it cannot guarantee: multi-tx rounds are not atomic (expected gap 1-4 slots, cap 8; funding/rent keep accruing, other writers' pushes can move K); only a single-tx
round is exactly atomic; anyone can still crank the LP alone (tag 5 is permissionless); the positioned set is a read; a portfolio the program keeps refusing can never be settled by
any keeper action (`prefer` counts it, `strict` freezes the LP until it clears, see `quarantinedNow`); beyond `maxTxsPerRound` (16) `prefer` settles the LP with counterparties unvisited
(counted) and `strict` skips the LP that round; the accrue-through-a-counterparty fallback settles that counterparty alone at the new K for the round's duration; the LP's rent is not settled under pairing
(rent is index-based and timing-invariant). Defence in depth: the engine fix is separate.

### Market lifecycle (plan `v22-market-lifecycle-plan-2026-10-25`, option C)

Tag 39 `ResolveStalePermissionless` is the always-on backstop; the keeper fires it at maturity. The admin resolve (deliberate retirements) is NOT done by the keeper. `KEEPER_V22_STALE_RESOLVE` defaults to `off`: merging or deploying changes nothing until it is set.

Classes (`/health` `v22.lifecycle`, per-market `lifecycle`): `never-connected` (no registry row / oracle authority is not this keeper / no accepted push; there is no on-chain creation slot, so this means "never connected as far as this keeper can tell", and needs a price age of at least the grace), `dead-price-warn` (age >= 50% of `permissionless_resolve_stale_slots`), `dead-price-matured` (>= 100%), `dead-interest` (priced, OI 0, no trade-fee accrual observed for N days; there is no on-chain last-trade slot, so the clock is observation-based: OI 0 and unchanged trade-fee accrual counters; it restarts at every boot unless `KEEPER_V22_LIFECYCLE_STATE_FILE` persists it, in which case it spans downtime and the counter comparison on restart catches any trade-fee accrual meanwhile; a trade that paid no fee is invisible), `no-resolve-window` (stale_slots = 0: classified, never attempted). dead-interest is classify + alert only.

Resolve guards (all in `v22/lifecycle-resolve.ts`, each unit-tested with a negative control): mode on; market Live; window enabled; matured; BOTH keeper loops observing continuously for `MIN_OBS_MS` (a keeper that was down, RPC-failing, stalled or just booted never resolves); not outage-shaped (more than `MASS_THRESHOLD` matured markets that the keeper could push and still has a usable source for); a market the keeper can push (registry row and asset-0 oracle authority = this keeper) is resolved only after its source has been unavailable for `MIN_OBS_MS` (if the keeper has a usable price it must push, which re-advances `last_good_oracle_slot`); only a market whose oracle authority is NOT this keeper resolves without source evidence (a usable price is irrelevant when it can never push, and it never counts toward the outage guard); an UNREGISTERED market whose authority IS this keeper (including one a registry hot-reload pruned) is HELD with an alert unless allowlisted, and does not count toward the outage guard unless it was registered earlier in this process and pruned (a shrinking registry is outage-shaped); a global source-health hold stops all pushable resolves when many pushable markets lack a source at once, and a per-DEX-type correlation hold when all (or `GROUP_LOSS_PCT`) of one DEX group lack a source together; one attempt per market per retry window and never again after a landed one; `MAX_PER_CYCLE` per tick. Immediately before the send the account is re-read: wrapper-owned, still Live, still matured at the current slot, `last_good_oracle_slot` unchanged. Multi-asset: tag 39 reads the config `last_good_oracle_slot`, which mirrors asset 0 only.

After a resolve the existing terminal path takes over for REGISTRY markets (terminal-insurance + resolved-portfolio-cleanup on the next fee-loop cycle; the push loop is told the market is terminal). A market with no registry row is not swept by those jobs (they walk the registry).

Env parsing is STRICT (on/1/true/yes, off/0/false/no). Scope: `KEEPER_V22` and `VAULT_LP_LONE_CRANK` are validated on EVERY start; the other `KEEPER_V22_*` variables are read and validated only when `KEEPER_V22` is on. **Operator: audit the live (Railway) env for stray `KEEPER_V22*` / `VAULT_LP_LONE_CRANK` values before deploying this build**: a malformed `VAULT_LP_LONE_CRANK` stops even a flags-off keeper at boot (fail closed).

Rent (tag 106) is NOT substituted for a refresh (106 forces the Refresh action, so a liquidatable counterparty would not be liquidated, and every 106 write-locks the LP, serialising phase 1). It runs after the LP tx of a round, one tx per portfolio, sequentially, only for portfolios the round already refreshed with the plain crank and only when the LP settled. Each 106 accrues and settles ONE counterparty to a K newer than the LP's (the LP tx came first); the LP stays behind until the NEXT round's LP tx (about one cycle). With N per round that mirror window is N sequential txs. `RENT_SETTLES_PER_ROUND` (sweep.ts) is 1 by default: the window is then one portfolio for one cycle. Rent is index-based and timing-invariant, so a slower rent cadence costs nothing (1 per 20 s round still covers 180 portfolios per default 9,000-slot cadence; a bigger book is simply settled less often than the cadence).

Refusal classification: only an error with a program Custom code is a refusal of that portfolio (22 = current, 104/111/112/113 = band state, anything else = hard). An error with no code (compute exhaustion, account in use, blockhash, RPC) shrinks the tx, blames and quarantines nobody, and the cut counterparties HOLD the LP in both modes. Cool-downs start at 150 slots and lengthen (450, 1,500) only when the same portfolio repeats the same code; at most 2 quarantines per round unless each carries a distinct code.

Protective rounds: triggered by the wrapper's own senior-draw signal (a read-only simulation of the LP crank whose logs carry `p3_senior_draw`) or `senior_draw_outstanding > 0`. The signal means "the LP's certified equity is NEGATIVE at this mark and a draw is due (or unfunded)": that is LATE, not "near liquidation" (an LP that is liquidatable with positive equity does not fire it). The earlier case is covered by the time bound below. Cadence: signal at most every 5 s per market; outstanding-only at most every 30 s; after a protective round that did not settle the LP the next waits 10, 20, 40, 80, 120 s (reset on success).

Persistent no-code failures: a portfolio whose refresh fails BY ITSELF without a program code (found by read-only single-refresh probe simulations) is counted per portfolio; after 3 rounds in a row it is treated as program-refused for pairing (quarantine 450 slots, `deferralEscalations`, a `[v22][WARN]` log, `persistentDeferrals` in /health), so `prefer` proceeds; `strict` keeps holding but shows the same alert. A tx that is merely too heavy (no single refresh fails alone) is cut and counts nobody. Time bound: if the keeper has not settled the vault LP for `KEEPER_V22_LP_MAX_UNSETTLED_MS` (default 300000, 5 min) while the market is otherwise healthy, one full paired round with the LP last runs regardless (the protective shape; counted `lpTimeBoundRounds`, retried at most every bound/5).

Booked / draw log parsing (`p3_senior_draw*`) accepts both the v2.1 and the v2.2 wrapper line shapes (fields matched by name; fixtures in `v22/re-review.test.ts`).

Anchor: `node --import tsx/esm src/v22-create-anchor.ts <market>` (operator tool, never run by the keeper) creates the keeper's own flat portfolio at the layout's exact length; it needs `KEEPER_V22_CREATE_ANCHOR=on`, is dry-run unless `KEEPER_V22_CREATE_ANCHOR_DRY_RUN=off`, and refuses (before simulating or sending) unless the market account is owned by the configured wrapper program and has a supported wrapper VERSION. The `KEEPER_V22_ACCRUE_ANCHORS` override must pass the same keeper-owned / flat check as discovery.

Every v2.2 send is simulated first (`v22/exec.ts`); refusals are logged by name (`PriceBandPinned(104)`, `InsuranceReadingsDiverged(44)`); band states 104/111/112/113 are expected, counted, never alerted.

### Leverage guard (wrapper tag 124) — `KEEPER_LEV_*`, all default OFF

Source: `v22/lev-guard.ts`, maths in `v22/lev-guard-math.ts`. Wire spec: ledger `v22-lev-guard-wire-spec-2026-10-28`. Nothing is deployed on chain yet; a market without a guard PDA is a cached no-op (re-checked every 10 min), so every flag is inert on a deployment with no guarded market. These flags do NOT need `KEEPER_V22`. They are parsed strictly (a typo stops the boot, like the v2.2 flags) and honour the global dry-run (`DRY_RUN` / `KEEPER_DRY_RUN` / `KEEPER_V22_DRY_RUN`): the transaction is simulated and logged `[v22][DRY-RUN] ...`, never signed or sent. Every send goes through `v22/exec.ts` (simulate first; refusals named). Jobs are `lev-poke`, `lev-tighten`, `lev-report`, `lev-w1` in `/health` `v22.jobs` (when `KEEPER_V22` is on) and the additive `/health` `levGuard` block (only when a flag is on).

| Env | Default | What |
|---|---|---|
| `KEEPER_LEV_POKE` | **off** | op 4 POKE with NAV sampling (`vault_lp_state` [4] + `vault_lp_ext` [5]) after each landed mark push, and immediately BEFORE a tag-103 Earn -> LP allocation send (after its clean simulation; the allocation tx is then re-signed on a fresh blockhash) |
| `KEEPER_LEV_HOLDER_JOB` | **off** | hourly per guarded market: op 3 TIGHTEN (flags refresh); the base mint's 20 largest token accounts, pool vaults / program- / pool- / PDA-owned dropped, CPMM dump `1-(R/(R+q))^2` vs the pinned pool base vault, op 3 with the single largest holder account (falls to the next on a 134, max 3 tries); with a risk key, op 2 REPORT |
| `KEEPER_LEV_RISK_KEY_PATH` | unset | absolute path of the guard's risk-key keypair JSON (contents never logged; a group- or world-readable file stops the boot, `chmod 600`). Unset = no REPORT. Only used with `KEEPER_LEV_HOLDER_JOB`; the report is skipped when the guard's `risk_key` is a different key |
| `KEEPER_LEV_W1` | **off** | after a landed push: when the guard says the LP stop holds, or a round is open, cut the opposing user portfolios in batches until `round_active` is 0; the opening call already carries the first batch (the program reverts an opening call that cuts nothing; LP side from the vault LP's net position, or `round_lp_long` once a round is open); victims are chosen by effective (net) side; a call with no victim is never sent; error 135 on a call with victims = nothing to do. The LP is never listed |
| `KEEPER_LEV_POKE_MIN_GAP_MS` | 1500 | least gap between two push-triggered pokes of one market (the pre-allocation poke ignores it) |
| `KEEPER_LEV_HOLDER_INTERVAL_MS` | 3600000 | holder job cadence per market (first runs staggered over up to 10 min) |
| `KEEPER_LEV_W1_BATCH` | 4 (max 24) | opposing portfolios per op 5 transaction (24 is the 1,232 B packet ceiling; CU is the real limit, tune from the simulated units in the log) |
| `KEEPER_LEV_W1_MAX_TXS` | 12 | most op 5 transactions of one run; a longer round continues on the next landed push |

Report fields: `m_ind` = largest individual FULL-balance CPMM dump (H9; a holder's token accounts among the top 20 are summed), `j_dump` = the sim `holder_terms` J with every unknown holder as kind `whale`, `l_cap_x100` 0 (no cap), `n_mult_bps` 10000; every bps field is an integer clamped to [0, 10000], rounded up, and no report is sent if any figure is not finite. The program merges reports tighten-only.

Holder filtering errs on dropping: an owner that is off-curve (a PDA, including a Squads vault) or whose own account is program-owned is NOT counted as an individual holder (counting a pool/vault as a holder would over-tighten a market). Known limit: a whale that holds through a PDA wallet is invisible to this job until the owner is on the curve.

SDK: tag-124 comes from the main `@percolatorct/sdk` pin (percolator-sdk `feat/v22-sdk-growth` @ 7aeb7a13). The keeper keeps its own `keyTagOf` (tested equal to the SDK's fixed `levKeyTagV22`).

Guard length: the guard PDA is accepted at 4,456 B or the burst-memory 4,472 B; any other length on a program-owned kind-17 account at the PDA raises a `[lev-guard][ALERT]` log and `levGuard.stats.guardBadLength`. Both lengths decode through the SDK (0a6ac576).
