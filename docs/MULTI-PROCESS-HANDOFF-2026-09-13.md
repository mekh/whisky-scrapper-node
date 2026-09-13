# Handoff — running the API as several instances (2026-09-13)

Written to continue this work in a fresh session. Everything here was
verified against the repository and the running production host at the time
of writing; anything stated as "not done" was checked, not assumed.

Supersedes `LOAD-TEST-HANDOFF-2026-09-13.md`, whose work is finished — that
file can be deleted.

Read with: [`MULTI-PROCESS-PLAN.md`](MULTI-PROCESS-PLAN.md) (the plan and the
three decisions), [`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md) (four
ladders and what they measured), [`POSTGRES-TUNING.md`](POSTGRES-TUNING.md)
(why the database is not the constraint) and
[`../loadtest/README.md`](../loadtest/README.md) (how to run a ladder).

## 1. Where things stand, in one paragraph

The API's ceiling is **one JavaScript thread on an eight-core host**: about
139 requests/s and roughly 350 concurrent users. That was established over
four ladders and is not in doubt — at the ceiling the database ran 279
commits/s with at most two backends waiting, and during the collapse past it
the database went _quiet_ (49 commits/s, 2.4 active, ~50 connections idle)
because the API stopped feeding it. The remedy is several instances. Steps 1
to 5 of six are done and uncommitted, and step 6's deployment half with them
(HAProxy in front of N replicas, `APP_INSTANCES` the only number). What is
left is the ladder itself, against production.

## 2. Decisions already taken — do not relitigate

| # | Question                           | Answer                                                                                                                     |
| - | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A | Node `cluster` or many instances   | **Neither is baked in.** Coordination is external (Valkey), so the same code runs under bare containers, pm2 or Kubernetes |
| B | Mutex or atomic operation          | **Atomic** — one Valkey `EVAL` (Lua) for counters. Locks only where a _procedure_ must run once                            |
| C | Telling a live run from a dead one | **`ownerId` + a Valkey heartbeat key**, which doubles as a liveness signal for monitoring                                  |

A was chosen against the original recommendation of `cluster`, for a better
reason than the ones weighed in the plan: `cluster` depends on a unique
parent process, which does not exist under an orchestrator, so the code would
have to be reopened on the way to Kubernetes. Two consequences follow and are
already accounted for below — the cron needs a lock it would not otherwise
have needed, and the instance count must come from configuration because no
process can derive it alone.

B was approved with the trade named: the Lua lives in the repository as a
second language and is only meaningfully testable against a live Valkey. The
owner's position, which is right, is that an integration test is the only
thing that can answer whether atomicity actually holds.

## 3. What is in the repository right now

Pushed this session (`main`, working tree otherwise clean):

- `0dca23d` — second ladder, after the page-addressable cache deploy
- `f9391b7` — cache slow-command warnings aggregated to one line a minute
- `ff1cbdb` — process guards: an orphaned rejection no longer kills the API
- `c4d67cb` — third ladder: 139 requests/s, ~350 users
- `0394376` — Postgres tuning, measured rather than calculated

**Uncommitted — steps 1 and 2 of this work**, complete and verified (`tsc`,
`eslint`, `dprint` clean; 1174 unit tests, 90 suites, plus 15 integration
cases against a live Valkey):

```
step 1
 M src/config/parts/db.config.ts      DB_POOL_SIZE_TOTAL / APP_INSTANCES, divided
 M src/main.ts                        boot line naming the resolved share
 M docker-compose.yaml                forwards both, drops DB_POOL_SIZE
 M .env.example                       same, with the reasoning
 M docs/POSTGRES-TUNING.md            stale DB_POOL_SIZE reference
 M src/domain/collection/dto/collection-purchases-patch.dto.ts   same
?? test/db-pool-size.spec.ts          8 cases pinning the arithmetic

step 6 (deployment half)
?? haproxy.cfg                       the balancer, beside the compose file
?? src/domain/health/*               GET /health, the liveness probe it calls
?? src/constants/health.constants.ts, src/interfaces/health.interfaces.ts
?? src/decorators/http/no-rate-limit.decorator.ts   the probe's exemption
?? test/health.controller.spec.ts
 M src/app/rate-limit/user-rate-limit.guard.ts      honours the exemption
 M src/app/app.module.ts, src/constants/*, src/decorators/http/index.ts
 M docker-compose.yaml               app scaled + unpublished, `lb` added
 M .env.example, .dockerignore, scripts/deploy.sh, CLAUDE.md

step 5
?? src/lib/cron-lock/*               the per-tick claim
?? src/constants/cron.constants.ts
?? test/cron-lock.service.spec.ts
?? test/integration/cron-lock.integration.spec.ts
 M src/domain/store/sync-cron.service.ts       claims before running
 M src/domain/currency/services/currency-rate-cron.service.ts  the same
 M src/domain/currency/domain-currency-cron.module.ts
 M test/store/sync-cron.service.spec.ts

step 4
?? migrations/1789296000000-sync-log-owner.ts  the ownerId column
?? src/lib/instance/*                the instance id and its heartbeat
?? src/constants/instance.constants.ts
?? test/integration/sync-orphan.integration.spec.ts  9 cases, live Postgres
?? test/instance.service.spec.ts
 M src/core/sync-log/*               ownerId written, liveness-aware sweep
 M src/domain/store/sync-orchestrator.service.ts  asks who is alive first
 M src/domain/store/domain-store.module.ts
 M src/interfaces/entity.interfaces.ts, src/constants/whisky.constants.ts
 M test/store/sync-orchestrator.service.spec.ts

step 3
?? src/domain/auth/services/auth-throttle.script.ts  the two ladder scripts
?? test/integration/auth-throttle.integration.spec.ts  14 cases, live Valkey
 M src/domain/auth/services/auth-throttle.service.ts  two script calls, new key
 M src/interfaces/auth-throttle.interfaces.ts  the state is the stored hash now
 M test/auth-throttle.service.spec.ts  what stays in TypeScript
 M CLAUDE.md

step 2
?? src/app/rate-limit/rate-limit-consume.script.ts  the Lua charge script
?? src/lib/valkey/valkey-script.ts    defineCommand wrapper (EVALSHA + NOSCRIPT)
?? src/utils/deadline.util.ts         the deadline race, lifted out of the cache
?? src/constants/rate-limit.constants.ts   key root, failure-log window
?? test/integration/rate-limit.integration.spec.ts  15 cases, live Valkey
 M src/app/rate-limit/*               store over Valkey, guard now async
 M src/config/parts/rate-limit.config.ts    -MAX_KEYS/-SWEEP_MS, +TIMEOUT_MS
 M src/lib/cache/versioned-cache.service.ts uses DeadlineUtils
 M src/interfaces/rate-limit.interfaces.ts  RateLimitBucket -> RateLimitCharge
 M .env.example, docker-compose.yaml, CLAUDE.md
 D test/rate-limit.store.spec.ts      its arithmetic is the integration spec now
?? docs/MULTI-PROCESS-PLAN.md         the plan
```

**Commit policy, decided 2026-09-13: accumulate.** Nothing is committed until
steps 2-6 are done; do not ask again.

## 4. What step 1 did, so it is not re-derived

`DB_POOL_SIZE` is gone; `DB_POOL_SIZE_TOTAL` (default 50) is the pool across
**every** instance and is divided by `APP_INSTANCES` (default 1) at startup,
rounding **down** so the instances can never sum past the total.

Both ways of getting it wrong fail the boot with a message naming the fix: a
leftover `DB_POOL_SIZE`, which would otherwise be ignored while the operator
believed it applied, and a total smaller than the instance count, which would
leave a pool of zero and surface later as a connection timeout on every
request. The first is read with `nonEmpty`, not `??`, because compose
forwards an omitted variable as an empty string.

## 5. Steps remaining

2. ~~**Rate-limit buckets to Valkey, atomically.**~~ **Done.** One script
   call charges every bucket a request owes, from the server's own clock,
   stopping at the first refusal. Keys are on the session instance and expire
   when they would next be full, which replaced the in-process cap and sweep.
   Fail-open, bounded by `RATE_LIMIT_TIMEOUT_MS` (250 ms).
   **Measured, as required**: 0.48 µs of CPU per request before, ~10 µs plus
   one round trip after (154 µs on the laptop, where `PING` is 153.6 µs) —
   ~0.1% of the ~8.5 ms a cached report page spends. Details in
   `MULTI-PROCESS-PLAN.md` and `CLAUDE.md` -> "Rate limiting".
3. ~~**Login ladder to the same primitive.**~~ **Done.** Two scripts replace
   the `GET`-then-`SET`: the attempt decides and stamps atomically, the
   failure increments and imposes the rung atomically. State moved from a
   JSON string to a hash under a **new** key root (`auth:throttle:ladder:`),
   since a leftover string key would have answered `WRONGTYPE` — which fails
   open — for up to its two-hour retention. 14 integration cases against a
   live Valkey, plus an end-to-end HTTP check of the first rung.
4. ~~**Orphan sweep.**~~ **Done.** `sync_log.ownerId` (migration
   `sync-log-owner`) plus `InstanceService`'s Valkey heartbeat; the sweep
   closes only runs whose owner's key is gone, with the age floor as the
   fallback when liveness cannot be established. Verified with three real
   processes against one database and one Valkey.
5. ~~**Cron.**~~ **Done.** `CronLockService` (`~lib/cron-lock`) claims each
   tick with one `SET NX EX` under `cron:<job>`; the losers no-op and the key
   holds the winner's instance id. **`CurrencyRateCronService` had the same
   defect and is fixed with it** — and it ships enabled, unlike the sync
   cron. A claim that cannot be made runs the job anyway (fail-open), since
   the `sync_log` lock and the rates' upserts are what make the jobs safe to
   run twice. Verified with two real processes on one tick.
6. **Turn on N instances and re-run the ladder.** Compare against 139
   requests/s and the ~350-user ceiling on record. The deployment is built and
   verified against a throwaway stack — `haproxy.cfg` beside the compose file,
   the app scaled by `APP_INSTANCES`, the `lb` service publishing the address
   nginx already proxies to — so what remains is the deploy and the run. Both
   need the owner: a deploy, a window with no sync in flight, and re-seeded
   load-test users.

Also unaddressed and harmless: the cache boot bump fires once per instance
(idempotent, noise only). `PushRepository.claimDrops` is already safe — an
atomic database claim that concurrent dispatches split rather than duplicate.

## 6. The measured facts this rests on

Do not re-derive these; they cost four ladders.

| Fact                                     | Value                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Throughput plateau                       | ~139 requests/s (was ~40 before the cache work, ~95 after it)            |
| Ceiling by the response-time limits      | between 300 and 400 users; zero failures through 400                     |
| Database at the ceiling (400 users)      | 279 commits/s, 15.4 active backends, **≤2 waiting**                      |
| Database during the collapse (500 users) | **49 commits/s, 2.4 active, ~50 idle** — it went quiet, it did not choke |
| Highest database throughput observed     | 328 commits/s, **still climbing** when the API fell over                 |

The last row is the honest limit of what is known: the database's own ceiling
is **not measured**, because nothing has ever managed to saturate it. So the
expected gain from several instances is real but unquantified, and step 6 is
what settles it.

## 7. Traps, each of which has already cost something

- **Never run k6 on the host under test.** Laptop only, over the VPN.
- **Never run a ladder while production is syncing.** Ask first.
- **Seeded refresh tokens rotate on use**, so a ladder burns the tokens of
  every user it touches. Re-seed before each run (`--cleanup`, then
  `--users 1000 --prefs`), which also matches the first run's conditions
  (fresh access tokens, no refresh at start).
- **Those 1000 `loadtest-*` users are in production and in the latest
  backup.** Not harmful, but the next backup is clean only if they are
  removed first. The database was verified undamaged after the runs: real
  users, their preferences and the whole catalogue intact, no orphan rows, no
  open `sync_log` rows.
- **`BaseConfig` schedules its validation with `setImmediate` from the
  constructor**, before subclass field initializers run — so a field that
  throws leaves a validation queued against a half-built object and a second,
  meaningless error arrives a tick later. Masked in production by
  `process.exit(1)`; `test/db-pool-size.spec.ts` works around it with fake
  timers. Worth fixing on its own, out of scope here.
- **A ladder cannot measure a database setting.** A cached request runs none
  of the queries the database compiles, and that column is what sets the
  ceiling — see `POSTGRES-TUNING.md`, where this nearly produced a wrong
  conclusion.

## 8. The system under test

| Thing          | Where                        | Note                                                    |
| -------------- | ---------------------------- | ------------------------------------------------------- |
| API            | `http://192.168.180.1:10001` | the container's own published port, beside nginx        |
| Postgres       | `192.168.180.1:10432`        | tuning deployed and verified (`source = command line`)  |
| Session Valkey | `192.168.180.1:10379`        | sessions, login ladder                                  |
| Cache Valkey   | `192.168.180.1:10380`        | catalogue cache, ~976 MB cap, evicting dead generations |
| Credentials    | `be/.env.loadtest`           | git-ignored, present on the laptop                      |

Deploys run through `scripts/deploy.sh`; a change to the `db` service's
`command:` needs `docker compose up -d db` instead. `postgresql.auto.conf`
was reset on 2026-09-13, so compose is the single source of the Postgres
settings — keep it that way.
