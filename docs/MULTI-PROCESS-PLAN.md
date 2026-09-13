# Running the API as several processes — plan

Why: every load measurement so far says the constraint is one JavaScript
thread on an eight-core host. At 400 users Postgres ran 279 commits/s with at
most two backends waiting; during the 500-user collapse it ran **49** with
2.4 active and ~50 connections idle. The database was never the limit — it
went quiet because the API stopped feeding it. See
[`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md) and
[`POSTGRES-TUNING.md`](POSTGRES-TUNING.md).

Status: **all six steps done** (2026-09-13). Deployed at `APP_INSTANCES=3`
and measured by two ladders; the results are in
[`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md) and summarised in step 6.

| Decision                  | Answer                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A — cluster or containers | **Neither is baked in.** Coordination is external, so the same code runs under bare containers, pm2 or Kubernetes |
| B — mutex or atomic       | **Atomic** (`EVAL`/Lua) for counters; locks only where a procedure must run once                                  |
| C — live run vs dead run  | **`ownerId` + a Valkey heartbeat**, which doubles as a liveness signal for monitoring                             |

A was chosen against the `cluster` recommendation, and for a better reason
than the one weighed here: `cluster` bakes in a unique parent process, which
does not exist under an orchestrator, so the code would have to be reopened
on the way to Kubernetes. The consequences are recorded in the sections
below rather than edited out — the cron now needs a lock it would not have
needed, and the instance count has to come from configuration because no
process can derive it alone.

## 1. What actually breaks, verified in the source

| Thing              | Where                                               | State today                   | Breaks how                                                                                        |
| ------------------ | --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Rate-limit buckets | `src/app/rate-limit/rate-limit.store.ts`            | **fixed** — Valkey, atomic    | N processes = N independent budgets, so the effective limit is N× what is configured              |
| Login ladder       | `src/domain/auth/services/auth-throttle.service.ts` | **fixed** — one script call   | it was `GET` then `SET` — two concurrent failures each read the same state and one count was lost |
| Sync orphan sweep  | `src/domain/store/sync-orchestrator.service.ts`     | **fixed** — owner + heartbeat | a restarting process closed a live sibling's run **and released its lock** — data integrity       |
| Sync cron          | `src/domain/store/sync-cron.service.ts`             | **fixed** — one tick claim    | N processes armed N schedules; the currency cron had the same defect                              |
| Cache boot bump    | `src/lib/cache/versioned-cache.service.ts`          | one bump per boot             | N bumps; idempotent, harmless, noise only                                                         |
| Connection pool    | `src/config/parts/db.config.ts:52`                  | `DB_POOL_SIZE` per process    | N × 50 against `max_connections` 100 — processes 3 and 4 fail to connect                          |
| Push digest        | `PushRepository.claimDrops`                         | atomic DB claim               | **already safe** — concurrent dispatches split the work                                           |

Everything else found by grepping for mutable process state is request-scoped
or a static lookup table.

The sweep is the one that is not merely a limit being wrong. It is
`UPDATE sync_log SET success = false WHERE success IS NULL`, unconditional,
and closing the row is what releases the concurrency lock — so a routine
restart of one process could let a second sync of the same store start while
the first is still writing.

## 2. Decision A — cluster, or separate containers? → **neither, by design**

The recommendation below was `cluster`, and it was **rejected for a sound
reason**: it is a dead end on the way to an orchestrator. Its whole advantage
is a unique primary process, which is exactly what does not exist when each
instance is a pod. Building on it would mean reopening the cron and the
sweep later.

What is built instead is coordination that does not care what starts the
processes: Valkey holds the shared state and the liveness keys, so bare
containers, pm2 and Kubernetes all behave the same. The cost is the cron
lock and an explicit instance count, both noted below.

The original reasoning, kept because it explains what the alternative buys:

The deployment today blocks replicas in three places: `container_name:
whisky-be` (compose refuses a fixed name with more than one replica), a single
published host port, and nginx's `proxy_pass` to one address with no
`upstream` block. Replicas mean solving all three plus a port-assignment
scheme.

`cluster` needs none of it. Workers share one listening socket, so the
container, the published port, nginx and `deploy.sh` are all untouched. And
it answers two of the four problems **by construction rather than by
protocol**: the primary process is unique, so the cron and the orphan sweep
simply run there and nowhere else — no Valkey lock, no TTL, no leader
election, no split brain.

It also makes the pool arithmetic exact (below), because the primary knows
the worker count at fork time; nothing has to be told twice.

What it gives up against separate containers: independent restarts and
rolling deploys. A crashed worker is re-forked by the primary in
milliseconds, which is strictly better than today's container restart, but
the whole container still goes down together on a deploy — exactly as now.

Choose replicas instead if per-instance rolling deploys matter more than the
simplicity; then the cron and the sweep need real leader locks.

## 3. Decision B — mutex, or atomic operation?

You asked for `acquireLock`/`releaseLock` on the shared counters. I would
split it, and the reason is the hot path.

| Shared thing       | Recommended                | Why                                                                                                                                                      |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate-limit buckets | one Valkey `EVAL` (Lua)    | The limiter runs on **every request, before the handler**. Lock+read+write+unlock is four round trips; a Lua script is one, and it is atomic server-side |
| Login ladder       | one Valkey `EVAL` (Lua)    | Same shape, and it fixes the lost-update race that already exists today                                                                                  |
| Orphan sweep, cron | `acquireLock`, if replicas | These are mutual exclusion of a _procedure_ that must run once — exactly what a lock is for. Not needed at all under `cluster`                           |

A mutex around a counter also has a failure mode an atomic operation does not:
a process that dies holding the lock blocks everyone until the TTL expires.
For a counter consulted on every request that is a bad trade.

The cost to keep in mind either way: the limiter moves from an in-memory map
(nanoseconds) to a network round trip. One `EVAL` is acceptable; four are not,
on the path we are trying to relieve.

## 4. Decision C — how the sweep tells a live run from a dead one

A lock does **not** fix this. Even a single sweeper cannot tell its sibling's
live run from a dead process's leftover. Two ways:

- **Age-based (no migration).** Every run is bounded by
  `SYNC_STORE_TIMEOUT_MS` / `SYNC_BROWSER_STORE_TIMEOUT_MS`, so an open row
  untouched for longer than the larger of those plus a margin is provably
  orphaned. Cheap and needs no schema change. Cost: a genuinely dead
  process's lock is held for ~45 minutes instead of being cleared at once.
- **Owner + liveness (one migration).** `sync_log.ownerId` records the
  process, and each process keeps a Valkey key with a TTL it refreshes. A run
  whose owner's key is gone is orphaned and swept immediately. Correct in
  both directions; costs a column and a heartbeat.

Under `cluster` the age-based rule is enough, because the primary is the only
sweeper and it restarts only when the whole container does — the same
situation as today.

## 5. `DB_POOL_SIZE` → `DB_POOL_SIZE_TOTAL`

Agreed, and for the reason you gave: what is fixed is the database's capacity,
so the number that should be configured once is the total. Per-instance size
is then derived at startup.

```
DB_POOL_SIZE_TOTAL = 50          # across every worker; sized against max_connections
poolSize           = max(2, floor(TOTAL / workers))
```

Under `cluster` the worker count is known inside the process, so the division
cannot drift. Under replicas it must come from an env var that **also** sets
the replica count, so one number drives both and they cannot disagree.

Guard rails worth having: refuse to boot if `TOTAL` is below the worker count
(a pool of zero), and log the resolved per-worker size at startup so the
arithmetic is visible rather than inferred.

## 6. Order of work, once the three decisions are made

1. ~~`DB_POOL_SIZE_TOTAL` + derived per-instance size, with the boot log
   line.~~ **Done.** `DbConfig` reads `DB_POOL_SIZE_TOTAL` (default 50) and
   `APP_INSTANCES` (default 1) and divides, rounding down so the instances
   can never sum past the total. Both failure modes fail the boot with a
   message naming the fix: a leftover `DB_POOL_SIZE`, which would otherwise
   be ignored while the operator believed it applied, and a total smaller
   than the instance count, which would leave a pool of zero and surface
   later as a connection timeout on every request. `main.ts` logs the
   resolved share. Pinned by `test/db-pool-size.spec.ts`.
2. ~~Rate-limit buckets to Valkey, atomically.~~ **Done.** One `EVAL`
   (`rate-limit-consume.script.ts`) charges every bucket a request owes,
   refilling from the **server's** clock so instances whose clocks disagree
   cannot refill one another's buckets at different rates; it stops at the
   first refusal, so a request the global rule turns away spends nothing
   from the route's own allowance. The keys live on the session instance
   (the coordination one: no eviction, no multi-megabyte payloads ahead of
   them in a single-threaded server) and expire when they would next hold
   their full burst, which replaced `RATE_LIMIT_MAX_KEYS` /
   `RATE_LIMIT_SWEEP_MS` with a tighter bound. Failure is fail-open, bounded
   by `RATE_LIMIT_TIMEOUT_MS` (250 ms). Pinned by
   `test/integration/rate-limit.integration.spec.ts` against a live Valkey —
   including 60 charges arriving at once letting exactly `burst` through,
   which is the lost update the move exists to prevent.

   **Measured, as the hot path demanded**: the in-process map cost 0.48 µs
   of CPU per request (two buckets); the Valkey charge costs ~10 µs of
   event-loop CPU plus one round trip — 154 µs on the laptop, where a bare
   `PING` is 153.6 µs, so ~17 µs of it is the script. Against the ~8.5 ms of
   CPU a cached report page spends, that is ~0.1%. The store alone sustains
   ~98k charges/s at 200 in flight, against an API ceiling of 139 req/s.
3. ~~Login ladder to the same atomic primitive, closing the existing race.~~
   **Done.** Two scripts (`auth-throttle.script.ts`): the attempt decides and
   stamps in one step, the failure increments and imposes the rung in one
   step. Deciding and stamping cannot be split, so the rule moved into the
   Lua; the rungs stay in `~constants` and travel as arguments. The state is
   now a hash under a **new** key root (`auth:throttle:ladder:`) — a leftover
   string key under the old name would have answered `WRONGTYPE`, which fails
   open, disabling the ladder for that caller for up to its two-hour
   retention. Pinned by `test/integration/auth-throttle.integration.spec.ts`
   (14 cases, live Valkey): twenty simultaneous failures produce exactly four
   penalties and ten simultaneous attempts let exactly one through — the two
   lost updates — plus every rung, seeded rather than waited out. Verified
   end to end over HTTP as well: five failed logins answer 401, the sixth
   answers 429 with `retry-after: 4` off the 5-second rung, and the stored
   hash reads `failures 0, stage 1, blockedUntil = lastAttemptAt + 5000`.
4. ~~Orphan sweep per decision C.~~ **Done.** `sync_log.ownerId` (migration
   `sync-log-owner`) records the instance that took the lock, written in the
   same insert; `InstanceService` (`~lib/instance`) keeps a Valkey key per
   process — `instance:<host>:<pid>:<rand>`, 30 s, beaten every 10 — and the
   sweep closes only the runs whose owner's key is gone. No lock: that
   predicate is true whoever evaluates it. Two things were added to the plan
   as written. A **null** liveness answer is not "nobody is alive", so when
   Valkey cannot answer nothing is swept on that ground and the **age floor**
   (option 1 of decision C) still applies — a row untouched past the largest
   store timeout plus a margin cannot be live. And the id carries a random
   suffix, so a restart that reuses a process id cannot read its own
   predecessor's leftover key and call a dead run alive; a clean shutdown
   deletes the key, so a redeploy sweeps at once rather than after the TTL.
   Pinned by `test/integration/sync-orphan.integration.spec.ts` (9 cases, live
   Postgres) and `test/instance.service.spec.ts`, and **verified with three
   real processes**: a second instance booting beside a live one left its open
   run alone, the first's key vanished on `SIGTERM`, and a third instance then
   closed that run.
5. ~~Cron and sweep confined to the primary (or lock-guarded under
   replicas).~~ **Done** — the sweep was step 4, this is the cron. Every
   instance still arms the schedule; `CronLockService` (`~lib/cron-lock`)
   claims the tick with one `SET NX EX` under `cron:<job>` and the losers
   no-op. The key holds the winner's instance id, so the log and
   `valkey-cli` both say which container ran it. **`CurrencyRateCronService`
   had the same defect and is fixed with it** — it ships _enabled_, so N
   instances meant N fetches a day from the NBU, where the sync cron ships
   disabled. Two decisions: the 300 s TTL is the duplicate window, valid
   because both jobs are daily, and a claim that cannot be made at all runs
   the job anyway — the lock keeps the fleet tidy, the `sync_log` lock and
   the rates' upserts are what make the jobs safe to run twice. Pinned by
   `test/cron-lock.service.spec.ts`,
   `test/integration/cron-lock.integration.spec.ts` (eight instances race,
   one wins) and two cases in the sync-cron spec; **verified with two real
   processes**: on the same tick one logged the sync and the other logged
   `Skipping the currency-rate-sync tick: instance mac.local:71234:70d900
   claimed it`.
6. ~~Turn on N instances; re-run the ladder and compare against the 139
   requests/s and ~350-user ceiling on record.~~ **Done** — deployed at
   `APP_INSTANCES=3` and measured twice (`loadtest/out/20260913-1719/` and
   `.../20260913-1835/`). Throughput plateau **139 → 216 requests/s**; the
   collapse that ended the single-instance ladder at 650 users with 29 % of
   requests failing is gone, and the ladder now reaches 1 000; **both
   response-time limits are met at 400 users**, where one instance met
   neither. Zero 429s in both runs, and HAProxy spread the load across the
   three replicas to within 0.7 %.

Step 6 was the only one that proves anything, and it settled the question
`POSTGRES-TUNING.md` left open. The database's own ceiling **has** now been
seen: commits per second flatten at ~350 and stay there while the offered
load doubles. It is not made of connections — halving `DB_POOL_SIZE_TOTAL`
from 50 to 24 raised the plateau to ~360 rather than lowering it, because
48 backends is six times the host's core count and the host also runs three
Node replicas, two Valkeys and HAProxy. What remains is the eight cores
themselves, and `pg_stat_statements` (installed for that ladder) says where
they go: 24 % to `/currency/rate/latest`, one call per page load, which a
lateral rewrite measures at 0.338 ms against 52.200 ms.

## 7. How N instances are actually deployed (2026-09-13)

`APP_INSTANCES` in the host `.env` is the only number. Compose reads it as the
app service's `scale` (verified: interpolation type-casts into that field) and
the app reads it as the divisor of `DB_POOL_SIZE_TOTAL`, so the two cannot
disagree. The app publishes no host port; the `lb` service publishes exactly
the address the host nginx already proxies to, and `haproxy.cfg` finds the
replicas through Docker's embedded DNS. **Nothing outside `.env` changes when
the count changes** — not nginx, not the proxy config.

### Why HAProxy and not Traefik

Traefik was wanted for the dashboard, the metrics and ACME, and was rejected
on one fact: it discovers replicas **only** through the Docker socket, which
is root on the host handed to the process that terminates public traffic.
`:ro` restricts the file node, not the API, and the canonical mitigation — a
socket proxy — is itself HAProxy, so hardening Traefik means running both.
Without the socket Traefik keeps none of what it was wanted for: the file
provider cannot enumerate replicas.

The security record decided it rather than taste. HAProxy: 27 CVEs since 2012,
maximum CVSS 7.5, **zero criticals**. Traefik: two CVSS 10.0 criticals in 2026
alone, plus an authentication bypass via path traversal in `ReplacePathRegex`
and a port-authorization bypass in `ForwardAuth` — exactly the class that must
not sit next to a mounted socket.

The monitoring argument dissolved on inspection: the proxy is one exporter of
six (host, containers, Postgres, two Valkeys, the app itself), HAProxy ships a
native Prometheus endpoint and a live stats page, and Prometheus finds the
replicas by DNS (`dns_sd_configs`, `type: A`) with no socket either. The
ACME argument is real but only pays off if Traefik replaces the host nginx
outright, which is a separate project; swapping HAProxy out for it then costs
one container.

### Verified against a live stack

A throwaway compose project — the real `haproxy.cfg` with only its nameserver
retargeted at podman's resolver, and nginx replicas answering 401 — proved the
mechanism end to end:

- 3 replicas → 3 servers UP, 60 requests spread 22/25/13 across them.
- `APP_INSTANCES=5` + `up -d` → HAProxy picked the two new replicas up within
  ~20 s and spread 50 requests across all five, **with the config untouched**.
- The health check works as intended. It now calls `GET /health` (200), a
  real liveness route added for it: a check pinned to `/meta` answering **401**
  held only for as long as `/meta` stayed authenticated, which is a poor thing
  to hang a fleet's rotation on.
- `/metrics` answers 1279 HAProxy series, including `haproxy_server_status`
  per replica.
- Scale-down 5 → 2 under a 400-request stream: one request failed, with and
  without `option redispatch`, against a control of 400/400 clean with nothing
  changing. The failure is a response already under way when its replica was
  killed — no proxy setting covers that, and the harness's nginx dies harder
  on `SIGTERM` than the app does (Nest closes gracefully, and the container
  has `stop_grace_period: 60s`). `option redispatch` stays because it covers
  the other case: a connection refused by a replica that is already gone.

### The probe had to come out of the rate limiter

Measured on the live app once `/health` existed: twelve probes back to back
answered nine 200s and **three 429s**. The balancer probes every replica from
its single address, and since the buckets moved into Valkey they are shared by
the whole fleet — so at enough replicas or a short enough interval the limiter
refuses probes, a refused probe reads as an unhealthy replica, and HAProxy
drains all of them at once. The limiter would have been the outage.

`@NoRateLimit()` (`~decorators/http`) exempts exactly that route; forty probes
back to back then answered forty 200s, while `/auth/login` still refuses after
its burst. The rule attached to the decorator is that it may only go on a
route which costs nothing to serve.

### What a failed cron claim costs, since fail-open stays

Decided to keep (2026-09-13). `CronLockService.claim` answers "yes" when it
cannot reach Valkey, so every instance enters `runFullSync`. **No store is
synced twice** — `tryStart`'s partial unique index in Postgres is the real
guard — but the instances that lose a store's lock lose it instantly and race
ahead to the next chunk of tracks, so the stores end up distributed across the
fleet and the host runs up to `instances × SYNC_MAX_PARALLEL_TRACKS` scrapes at
once instead of `SYNC_MAX_PARALLEL_TRACKS`. Each shop is still scraped once, at
its own politeness delay; the extra load is ours, not theirs.

The alternative considered and rejected was skipping the tick for the sync
cron alone (keeping fail-open for the rates job, which is one small idempotent
request): a daily scrape that a cache outage can silently cancel was judged
the worse failure, especially as during such an outage the API is unusable
anyway — sessions live in that same Valkey — so the sync is the only thing
still working.
