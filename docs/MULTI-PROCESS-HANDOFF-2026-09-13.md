# Handoff — running the API as several instances (2026-09-13)

Everything here was verified against the repository, a live Valkey, a live
Postgres and three real processes at the time of writing. Anything stated as
"not done" was checked, not assumed.

Read with: [`MULTI-PROCESS-PLAN.md`](MULTI-PROCESS-PLAN.md) (the six steps,
the three decisions, the HAProxy-versus-Traefik comparison and every
measurement taken while building it), [`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md)
(the four ladders), [`POSTGRES-TUNING.md`](POSTGRES-TUNING.md) (why the
database is not the constraint) and [`../loadtest/README.md`](../loadtest/README.md)
(the operating manual for a ladder — it is complete, follow it rather than
this file for the mechanics).

## 1. Where things stand

The code is **done, committed and tagged `v2.0.0`** (`04ead75`, pushed to
`main`). Steps 1-5 of the plan plus step 6's deployment half are in it.

> **Deployed on 2026-09-13**, `APP_INSTANCES=3`, and the ladder has been run
> against it. What remains is writing that result up in
> `LOAD-TEST-2026-09.md` and closing step 6 of the plan.

## 2. What changed, in one table

|                        | Before                          | Now                                       |
| ---------------------- | ------------------------------- | ----------------------------------------- |
| Instances              | one container, `whisky-be`      | `APP_INSTANCES` replicas, `whisky-be-1..N` |
| Who publishes the port | the app                         | the `lb` service (HAProxy), same address  |
| Rate-limit buckets     | in-process `Map`                | Valkey, one Lua charge per request        |
| Login ladder           | `GET` then `SET` (lost updates) | one script call per half                  |
| Sync orphan sweep      | closed every open row           | only runs whose owner's heartbeat is gone |
| Cron ticks             | armed per process               | one `SET NX EX` claims the tick           |
| Pool                   | `DB_POOL_SIZE` per process      | `DB_POOL_SIZE_TOTAL / APP_INSTANCES`      |
| Health                 | none (`/meta`'s 401)            | `GET /health`, outside the rate limiter   |

## 3. Before the deploy — the host `.env`

Three edits:

1. **Remove `DB_POOL_SIZE`.** `DbConfig` refuses to start when it sees one,
   with a message naming the replacement rather than ignoring it while an
   operator believes it applies — but that guard cannot fire in a container
   here, because `docker-compose.yaml` no longer forwards the variable and
   the image carries no `.env` of its own. So a leftover value is inert
   rather than fatal; remove it anyway, and keep the guard for the paths
   that do read the host environment directly.
2. **Add `DB_POOL_SIZE_TOTAL=50`** — the pool across _all_ instances, sized
   against the database's `max_connections` (100), not against the instance
   count.
3. **Add `APP_INSTANCES=<n>`.** Eight cores, and Postgres, two Valkeys, the
   browser-tier scraper and HAProxy all want some, so this is a share of the
   host rather than a count of the work. **Production runs 3.** Each replica
   takes `floor(total / n)` connections and the boot log says so:
   `Database pool: 8 connection(s) here (24 total / 3 instance(s))`.

`APP_BIND_IP` / `APP_BIND_PORT` keep their meaning — the `lb` container now
publishes them instead of the app, so **the host nginx needs no change at
all**. Nothing else in `.env` moves.

## 4. The deploy

`scripts/deploy.sh` as always (build → `compose run --rm migrate` → `up -d`).
It now prints the running instances at the end. What is new about this one:

- The migration `1789296000000-sync-log-owner` runs in the migrate gate. One
  nullable `varchar(64)`; it cannot fail on data.
- The single container `whisky-be` becomes the replicas `whisky-be-1..N`,
  and there is a new `whisky-lb`. The names come from the compose project
  (`whisky`, declared in the file) plus the service (`be`), since compose
  builds a replica's name as `<project>-<service>-<number>`. **Anything on
  the host that names the bare `whisky-be` needs updating** — either to a
  numbered replica or to `docker compose exec be` / `docker compose logs
  be`, which address the first replica and every replica respectively.
- `haproxy.cfg` is mounted from the repository root. `docker compose up -d`
  pulls `haproxy:3.2-alpine` (~23 MB); the host must be able to reach the
  registry.
- Deploy when **no sync is running** — `GET /store/sync-status` answers with
  an empty array when it is safe.

### After it, three checks

```bash
# 1. the balancer sees every replica
docker compose exec lb sh -c 'wget -qO- http://127.0.0.1:8404/metrics' \
  | grep 'haproxy_server_status.*state="UP"' | grep -c ' 1$'

# 2. the probe answers through the whole chain
curl -s -o /dev/null -w '%{http_code}\n' https://<site>/api/health

# 3. every replica divided the pool
docker compose logs be | grep 'Database pool'
```

`docker compose exec lb sh -c 'wget -qO- http://127.0.0.1:8404/stats'` is the
human view (which replicas are up, sessions, queues, errors). It is bound to
the compose network only — nothing is published to the host.

## 5. The ladder

Follow [`../loadtest/README.md`](../loadtest/README.md) → "The ceiling run".
In short: `--cleanup`, re-seed 1000 users with `--prefs` (**the seeded refresh
tokens rotate on use, so a previous ladder burned them**), run `observe.sh`
beside k6 from the laptop over the VPN, `STAGES=50,100,200,300,400,500,650,800,1000`.

**What it has to be compared against** (v1.2.1, single instance, same harness):

| Fact                                      | Value                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Throughput plateau                        | ~139 requests/s                                                          |
| Ceiling by the response-time limits       | between 300 and 400 users; zero failures through 400                     |
| Database at the ceiling (400 users)       | 279 commits/s, 15.4 active backends, **≤2 waiting**                      |
| Database during the collapse (500 users)  | **49 commits/s, 2.4 active, ~50 idle** — it went quiet, it did not choke |
| Highest database throughput ever observed | 328 commits/s, **still climbing**                                        |

The last row is the honest limit of what is known: the database's own ceiling
has never been reached, so the expected gain is real but unquantified. That is
what this run settles.

### What is new to watch this time

- **Where the bottleneck went.** If it is now Postgres, `observe.sh` shows it
  as waiting backends and a commits/s plateau — and the first lever is
  `DB_POOL_SIZE_TOTAL` against `max_connections`, not more instances.
- **The limiter's round trip.** Every request now charges a bucket in the
  session Valkey. It measured ~10 µs of CPU and one round trip in isolation;
  under load, watch that instance's ops/s and latency.
- **`rate_limited` in the k6 summary.** Above ~1 % the scenario is outrunning
  the per-account limits and nothing else in the run can be read. Keep the
  limiter configured exactly as the earlier ladders had it, or the comparison
  is not like for like — check `LOAD-TEST-2026-09.md` for what they used.
- **HAProxy's own view**: `haproxy_backend_current_sessions` and the per-server
  session counts say whether the spread is even.

## 6. Traps, each of which has already cost something

- **Never run k6 on the host under test.** Laptop only, over the VPN.
- **Never run a ladder while production is syncing.** Ask first.
- **Re-seed before every ladder** — the tokens rotate on use.
- **Those 1000 `loadtest-*` users live in production and in the latest
  backup.** Harmless, but the next backup is clean only if they are removed
  first. The database was verified undamaged after the earlier runs.
- **A ladder cannot measure a database setting.** A cached request runs none
  of the queries the database compiles, and that column is what sets the
  ceiling — see `POSTGRES-TUNING.md`, where this nearly produced a wrong
  conclusion.
- **`BaseConfig` schedules its validation with `setImmediate` from the
  constructor**, before subclass field initializers run, so a field that
  throws produces a second, meaningless error a tick later. Masked in
  production by `process.exit(1)`; `test/db-pool-size.spec.ts` works around it
  with fake timers. Worth fixing on its own, out of scope here.
- **A failed cron claim is not a no-op.** With Valkey unreachable every
  instance enters `runFullSync`; no store syncs twice (Postgres' partial
  unique index is the guard), but the stores are distributed across the fleet
  and the host runs up to `instances × SYNC_MAX_PARALLEL_TRACKS` scrapes at
  once. Accepted deliberately — see CLAUDE.md → "Sync orchestration".

## 7. The system under test

| Thing          | Where                        | Note                                                             |
| -------------- | ---------------------------- | ---------------------------------------------------------------- |
| API            | `http://192.168.180.1:10001` | after the deploy this is HAProxy, not the app                    |
| Postgres       | `192.168.180.1:10432`        | tuning deployed and verified                                     |
| Session Valkey | `192.168.180.1:10379`        | sessions, limiter buckets, login ladder, heartbeats, cron claims |
| Cache Valkey   | `192.168.180.1:10380`        | catalogue cache, ~976 MB cap                                     |
| Credentials    | `be/.env.loadtest`           | git-ignored, present on the laptop                               |

Deploys run through `scripts/deploy.sh`; a change to the `db` service's
`command:` needs `docker compose up -d db` instead. `postgresql.auto.conf` was
reset on 2026-09-13, so compose is the single source of the Postgres settings
— keep it that way.

## 8. Open, unrelated to the ladder

- `docs/LOAD-TEST-HANDOFF-2026-09-13.md` is superseded by this file and can be
  deleted; it was committed rather than dropped because it had never been in
  git.
- `docs/LOAD-TEST-PLAN.md` tells an operator to watch `docker stats` for a
  container called `whisky-be`. That name is now a prefix rather than a
  container: the replicas are `whisky-be-1..N`. It is a record of a plan
  rather than a runbook, so it was left alone.
