# Monitoring — Prometheus, Grafana, and what this project is worth measuring

Status: **all steps done** (2026-09-15). Deploying it is the owner's — see `infra/README.md`.

Why now: every performance decision this repository records was measured by
hand and then thrown away. `docs/LOAD-TEST-2026-09.md` was produced by a k6
ladder driven from a laptop with an ad-hoc observer script sampling Postgres
and both Valkeys every five seconds; `docs/POSTGRES-TUNING.md` was three runs
each way with a stopwatch; the 2026-08-30 outage was diagnosed from nginx's
error log and Valkey's save timestamps, **because the application wrote
nothing at all for sixty-eight minutes**. The stack is now three API
replicas, two Valkeys, Postgres and HAProxy sharing eight cores, and nothing
records what any of them is doing between one hand-run ladder and the next.

The brief: Prometheus and Grafana, health of every dependent service (both
Valkeys, the database, HAProxy) and of the replicas, all standard metrics
plus whatever else is worth having **on this project specifically**. Code
changes plus configuration under `infra/`, which also becomes the home of
both edge configs — `haproxy.cfg` from this repository and the host nginx
server block from `../web`.

## 0. Decisions taken before writing this

| Decision                | Answer                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose layout          | A **separate compose project**, `infra/docker-compose.monitoring.yaml`                                    | Monitoring must have a lifecycle of its own: a broken exporter config can never abort `scripts/deploy.sh`, and watching the stack must not require redeploying it                                                                                                                                                                                                                                                                                                |
| Per-container metrics   | **cAdvisor with a read-only Docker socket**                                                               | The question this host actually has is which of eight processes ate the eight cores. Unlike the Traefik case that socket was refused for, cAdvisor terminates no public traffic, publishes no port outside the private interface, and only reads                                                                                                                                                                                                                 |
| Grafana exposure        | **Private interface only**, `${MON_BIND_IP}:${GRAFANA_BIND_PORT}`                                         | The same address Postgres, both Valkeys and the API are already published on. No public route to it exists, so the host nginx needs no location for it at all                                                                                                                                                                                                                                                                                                    |
| Alerting                | **Prometheus rules + Alertmanager + Telegram**                                                            | Placeholders in `infra/.env.example` until a bot token and chat id exist; the stack runs and fires with the receiver unconfigured                                                                                                                                                                                                                                                                                                                                |
| Postgres exporter login | **The existing `DB_USER`**                                                                                | It is the database owner and therefore may read `pg_stat_statements`, which is the point (see §4). A dedicated role is a migration away if the host ever stops being single-tenant                                                                                                                                                                                                                                                                               |
| Metrics client          | **`@prometheus-io/client`**, not `prom-client`                                                            | npm marks `prom-client` deprecated in favour of it, and it is the Prometheus org's own continuation (`github.com/prometheus/client_js`, maintained by the Prometheus team) with a strictly larger but otherwise identical API. It is three weeks old, which is the honest risk; the whole dependency is confined to `MetricsService`, so reverting is one file                                                                                                   |
| Terminus version        | **11.1.1**, not 12                                                                                        | 12 ships ESM only (`"type": "module"`, no CJS export) and this project compiles to CommonJS — `dist/src/main.js` is `require()` calls. Node 22's `require(esm)` makes 12 work at runtime, but Jest's own module registry cannot load it, and two rounds of transform configuration did not fix it. 11 needs no configuration at all; the only thing lost is the `degraded` **status**, whose semantics the cache indicator reproduces as data while staying `up` |
| `/metrics` reachability | Scraped **directly on the compose network**; blocked publicly **at the host nginx**, not at HAProxy       | Prometheus resolves the replicas through Docker's DNS exactly as HAProxy does, so the endpoint never has to be publicly routable. The edge policy belongs where the other one already is — nginx blocks `/api/docs` in the same shape — and HAProxy stays a balancer with no routing rules of its own                                                                                                                                                            |
| Edge configuration      | **Both** `haproxy.cfg` and the host nginx server block move into `infra/`                                 | One directory that is the whole edge plus observability, instead of a balancer config here and a proxy config in a sibling repository. The nginx file is a deployment-topology document, and the topology already lives in this repository                                                                                                                                                                                                                       |
| Health checks           | **`@nestjs/terminus`**; `/health` becomes a real dependency check, and the probe splits to `/health/live` | Reverses the "probe names no dependency" decision in `CLAUDE.md`, at the owner's call. The split is what keeps the reversal safe: HAProxy probes from inside the compose network, so a `/health` that can answer `503` would drain every replica at once and no nginx block could prevent it (see §5)                                                                                                                                                            |

## 1. What is added, in one paragraph

The application gains a `@prometheus-io/client` registry and a `GET /metrics`
endpoint that is unauthenticated on the private network, outside the rate limiter and
outside the outgoing DTO pipeline. HTTP timing is collected by a **Fastify
`onResponse` hook** rather than an interceptor, so it counts every response
including the ones Nest never sees, and labels them by the registered route
pattern rather than the raw URL. Everything else is recorded where it already
happens: the cache's existing counters, the rate limiter's refusal site, the
login ladder, the TypeORM logger's slow-query and error hooks, the `pg` pool's
own numbers, the scrape progress event funnel, the LLM client and batch
runner, the push outcome enum, and the currency sync. A periodic collector
turns four business questions into gauges. Beside it, a monitoring compose
project runs Prometheus, Grafana, Alertmanager, node-exporter, cAdvisor,
postgres-exporter and two redis-exporters, and scrapes HAProxy's own native
endpoint.

## 2. Layout

```
infra/
├── README.md                                # what runs where, and how to operate it
├── .env.example                             # the monitoring project's own variables
├── docker-compose.monitoring.yaml           # the eight monitoring containers
├── haproxy/
│   └── haproxy.cfg                          # MOVED from be/haproxy.cfg; comments only in step 1, probe URI in step 3
├── nginx/
│   └── nginx.conf                           # MOVED from ../web/scripts/nginx.conf; + /api/metrics and /api/health blocks
├── prometheus/
│   ├── prometheus.yml
│   └── rules/
│       ├── api.rules.yml
│       ├── infra.rules.yml
│       └── domain.rules.yml
├── alertmanager/
│   └── alertmanager.yml
├── postgres-exporter/
│   └── queries.yaml                         # pg_stat_statements + table sizes
└── grafana/
    ├── provisioning/
    │   ├── datasources/prometheus.yml
    │   └── dashboards/dashboards.yml
    └── dashboards/
        ├── whisky-api.json
        ├── whisky-runtime.json
        ├── whisky-infra.json
        └── whisky-domain.json
```

In `src/`:

```
src/lib/metrics/          MetricsService (the registry) + one small facade per area
src/app/metrics/          the Fastify request hooks
src/domain/metrics/       GET /metrics, and the periodic collector
src/domain/health/        terminus: /health, /health/live, /health/ready + the indicators
src/config/parts/metrics.config.ts
src/constants/metrics.constants.ts
```

`haproxy.cfg` moving is a one-line change to `docker-compose.yaml`'s volume
mount — it is mounted read-only at a fixed container path. The move itself
changes **no directive at all**, only comments; the probe URI becomes
`/health/live` later, in step 3, in the same change that creates that route
(see the ordering note in §10). Either way it gains no routing rule, no
header handling and nothing about who the client is. Keeping that file a pure
balancer config is deliberate: it is where the `X-Forwarded-For` contract
lives, with a comment saying nothing there may touch it, and it is the wrong
place for a policy the edge already owns.

**Both edge configs live in `infra/`, so the directory is the whole edge and
observability surface of this deployment rather than half of it.**
`../web/scripts/nginx.conf` moves to `infra/nginx/nginx.conf` and gains the
`location` blocking `/api/metrics`, beside the one that already blocks
`/api/docs`. Like the HAProxy file it is a template the owner copies to the
host, so the change is inert until that copy and a reload.

Two consequences, stated rather than discovered later:

- **`web` names it in five places** — four in `README.md`, including a
  literal `sudo cp scripts/nginx.conf /etc/nginx/conf.d/whisky-web.conf`, and
  one in `TODO-web-push.md`. All five are updated to the new path in the same
  step, along with two in this repository (`CLAUDE.md`'s trusted-header note
  and `docs/LOAD-TEST-PLAN.md`'s limiter table) that would otherwise have
  been left pointing at a file that no longer exists. The relative cross-repository reference is not a new pattern
  here — `be` already documents `../web` and `../scrapper` the same way, and
  both are checked out side by side.
- **Roughly half that file is about serving the SPA** (`root`, the
  `/assets/` immutable caching, `/sw.js`, `manifest.webmanifest`, the
  history fallback) rather than about the API. Moving it means a web-only
  edge change now lands in the backend repository. That is the price of
  having one place that describes the edge, and it is the right trade here:
  the file is a deployment-topology document, and this repository is already
  where the topology lives — the compose project, the private-interface
  addresses, the replica count and HAProxy are all here.

## 3. Networking, and why a separate project still reaches everything

The monitoring project declares one network of its own and attaches to the
three the application project already creates, as `external`:

| Container              | Networks                             | Reaches                                              |
| ---------------------- | ------------------------------------ | ---------------------------------------------------- |
| prometheus             | `whisky_monitoring`, `whisky-be`     | the replicas (`be:4000`), HAProxy (`whisky-lb:8404`) |
| grafana                | `whisky_monitoring`                  | prometheus                                           |
| alertmanager           | `whisky_monitoring`                  | —                                                    |
| postgres-exporter      | `whisky_monitoring`, `whisky_db`     | `whisky-db:5432`                                     |
| redis-exporter-session | `whisky_monitoring`, `whisky_valkey` | `whisky-valkey:6379`                                 |
| redis-exporter-cache   | `whisky_monitoring`, `whisky-be`     | `whisky-cache:6379`                                  |
| node-exporter          | `whisky_monitoring`                  | the host, through read-only mounts                   |
| cadvisor               | `whisky_monitoring`                  | the Docker socket and the cgroup tree, read-only     |

**Replica discovery reuses HAProxy's own mechanism.** Compose gives every
replica the network alias `be`, so Docker's embedded DNS answers that name
with one A record per replica — which is exactly what `server-template` in
`haproxy.cfg` consumes. Prometheus consumes it the same way:

```yaml
- job_name: whisky-api
  dns_sd_configs:
    - names: [be]
      type: A
      port: 4000
```

Scaling `APP_INSTANCES` therefore needs no change here either. The Prometheus
`instance` label is a container IP and churns on redeploy, which is why every
metric the application emits carries a `replica` label of its own (§5) — the
dashboards group by that, so a redeploy does not split a graph in half.

## 4. What is scraped, and what each source is actually for

| Job              | Source                                    | Interval | Why it earns a container                                                                                                                                                                                 |
| ---------------- | ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whisky-api`     | the replicas' own `/metrics`              | 15 s     | Everything in §5. The only source that knows what a request _was_                                                                                                                                        |
| `haproxy`        | `whisky-lb:8404/metrics`, already enabled | 15 s     | **The authoritative answer to "which replicas are up"** — stable slot names (`be1`…`be16`) that survive a redeploy, plus queue depth, retries, redispatches and per-server 5xx                           |
| `postgres`       | postgres-exporter                         | 30 s     | Connections against `max_connections`, commits/s, cache hit ratio, deadlocks, long transactions, table and index sizes — and `pg_stat_statements`, which is the whole reason the extension was installed |
| `valkey-session` | redis-exporter                            | 30 s     | Memory, keys, ops/s, AOF state. **It must never evict**, so `evicted_keys` here is an alert rather than a statistic                                                                                      |
| `valkey-cache`   | redis-exporter                            | 30 s     | The opposite: eviction is normal, and `evicted_keys` is the number that said 3 GiB was needed. Each eviction is a database query later                                                                   |
| `node`           | node-exporter                             | 15 s     | Eight cores shared by everything, and a disk that holds `pg_data`, the AOF and `./log`                                                                                                                   |
| `cadvisor`       | cAdvisor                                  | 30 s     | Which container spent them, by name. Also catches the failure mode the compose file guards against with `CACHE_MEMORY_LIMIT` — a container OOM-killed instead of evicting                                |

`pg_stat_statements` deserves its own line: it was installed on 2026-09-13
precisely because nothing could say where the database's time went, and it
immediately showed one query to be 24 % of it. Left unscraped, it answers that
question only for whoever is logged in at the time. The custom
`queries.yaml` publishes the top statements by total time, mean time and
calls, with the query text truncated and **the query id as the label** — the
text is a label value otherwise, and a few thousand of those is how a
Prometheus falls over.

## 5. The application's own metrics

Standard first: `collectDefaultMetrics()` gives process CPU and RSS, heap,
handles, GC, and `nodejs_eventloop_lag_*`. That last one is not a formality
here — the documented ceiling of this API _was_ one event loop, and p99 lag is
the single number that says a replica is queueing rather than working.

Everything below carries a `replica` label (the `InstanceService` id's stable
half: hostname and pid, without the random suffix, which would mint a new
series on every restart). Metric names are collected in
`~constants/metrics.constants.ts` so there is one inventory.

### HTTP — a Fastify hook, not an interceptor

| Metric                                 | Type      | Labels                |
| -------------------------------------- | --------- | --------------------- |
| `whisky_http_requests_total`           | counter   | method, route, status |
| `whisky_http_request_duration_seconds` | histogram | method, route, status |
| `whisky_http_requests_in_flight`       | gauge     | method                |
| `whisky_http_response_size_bytes`      | histogram | route                 |

Three things about this choice. It is an `onRequest`/`onResponse` pair
registered from `main.ts` beside `registerClientIpHook`, because a Nest
interceptor sees only requests that reach a handler — a 404 from the router, a
request refused in `AuthJwtGuard`, a body rejected by the pipe are all
invisible to it, and those are exactly the ones worth counting. It reads
`request.routeOptions.url`, the **registered pattern** (`/store/:slug`), never
`request.url`, whose ids would mint one time series per product. An unmatched
route is labelled `__unmatched__` rather than by its path, for the same
reason. And `reply.statusCode` at `onResponse` is the status actually sent,
after `ExceptionFilter` has had its say, so no error-to-status mapping is
duplicated anywhere.

Buckets are chosen against the owner's own limits (1 s and 2 s appear in
`LOAD-TEST-2026-09.md`): 5, 10, 25, 50, 100, 250, 500 ms, 1, 2, 5, 10, 30 s.

### Cache

`VersionedCacheService` already counts hits, misses, errors and bypasses, and
already samples slow commands; today they leave the process only through
`stats()` and a log line.

| Metric                                  | Type      | Labels    | Note                                                                    |
| --------------------------------------- | --------- | --------- | ----------------------------------------------------------------------- |
| `whisky_cache_operations_total`         | counter   | result    | hit / miss / bypass / error                                             |
| `whisky_cache_command_duration_seconds` | histogram | operation | replaces guessing from the slow-sample log line                         |
| `whisky_cache_bumps_total`              | counter   | reason    | the reason strings the bump points already pass                         |
| `whisky_cache_generation`               | gauge     | —         |                                                                         |
| `whisky_cache_dirty`                    | gauge     | —         | **1 means a committed write the cache was never told about** — an alert |

`cache_dirty` is the highest-value single bit in this whole document: it is a
state the code already models and that nothing outside the process can
currently observe, and while it holds, every read bypasses the cache.

### Rate limiting and the login ladder

| Metric                                   | Type    | Labels          | Note                                                     |
| ---------------------------------------- | ------- | --------------- | -------------------------------------------------------- |
| `whisky_rate_limit_decisions_total`      | counter | bucket, outcome | allowed / refused, bucket = `global` or the profile name |
| `whisky_rate_limit_store_failures_total` | counter | —               | **fail-open events**                                     |
| `whisky_auth_login_attempts_total`       | counter | outcome         | success / failed / throttled                             |
| `whisky_auth_throttle_penalties_total`   | counter | stage           | which rung of 5/10/60/300/900/3600 s was imposed         |

The fail-open counter is the point of this group. When the limiter's Valkey
call times out the request is let through and the failure is logged **at most
once a minute**; from outside the process, an API with no effective rate limit
looks exactly like one whose limits are working. A counter makes the two
different.

### Database

| Metric                         | Type    | Labels | Source                                     |
| ------------------------------ | ------- | ------ | ------------------------------------------ |
| `whisky_db_pool_connections`   | gauge   | state  | total / idle / waiting, from the `pg` pool |
| `whisky_db_slow_queries_total` | counter | —      | `DbQueryLogger.logQuerySlow`               |
| `whisky_db_query_errors_total` | counter | —      | `DbQueryLogger.logQueryError`              |

`waiting > 0` is `DB_ACQUIRE_TIMEOUT_MS` about to start failing requests, and
it is per replica, which the exporter's server-side view cannot give.

### Dependency health — the answer to "статус усіх пов'язаних сервісів"

| Metric                                     | Type  | Labels     |
| ------------------------------------------ | ----- | ---------- |
| `whisky_dependency_up`                     | gauge | dependency |
| `whisky_dependency_check_duration_seconds` | gauge | dependency |

`dependency` is `postgres`, `valkey_session`, `valkey_cache`. The checks
themselves are **`@nestjs/terminus`** indicators, and the periodic collector
runs the same `HealthCheckService` the endpoint does — so the gauge and the
endpoint can never disagree about whether Postgres is up, which two
independent probes eventually would.

#### `/health` becomes a real health check, and the probe splits off

This reverses the decision recorded in `CLAUDE.md` under "The liveness
probe". The owner's call, and the reasoning that decision was based on is
preserved rather than deleted — because it is still true, and it is what
shapes the new arrangement.

**The constraint that does not go away:** HAProxy probes `/health` **from
inside the compose network**, so blocking the route at nginx does nothing
about it:

```
haproxy.cfg:77   http-check send meth GET uri /health ... expect status 200
```

A `/health` that answers `503` when Postgres or a Valkey wobbles therefore
fails on all three replicas at the same instant, and the balancer drains the
entire backend. One dependency having a bad minute becomes the API being
completely unreachable — which is precisely the outage the old decision was
written to prevent, and which the nginx block cannot touch.

So the endpoint splits, in the shape terminus is built for:

| Route           | Checks                                                  | Status code                | Read by                              | Exposure                         |
| --------------- | ------------------------------------------------------- | -------------------------- | ------------------------------------ | -------------------------------- |
| `/health/live`  | nothing — the process answering **is** the answer       | always `200`               | **HAProxy**                          | harmless; says only "this is up" |
| `/health`       | Postgres, session Valkey, cache Valkey, heap, RSS, disk | `503` when any check fails | a person, Grafana, the collector     | **blocked at nginx**             |
| `/health/ready` | the same dependency checks, terse body                  | `503` when not ready       | a future orchestrator; nothing today | blocked at nginx                 |

`haproxy.cfg` changes by exactly one word — `uri /health` becomes
`uri /health/live`. That is a balancer telling itself which URL to probe, not
a routing rule, so the file stays what §2 says it is. **It changes in step 3,
not step 1**: pointing the probe at a route that does not exist yet would
fail every replica's check and drain the backend, so the flip and the route
land together.

Three details that follow:

- **`@NoRateLimit()` moves with the probe, and does not spread.** The rule
  that comes with that decorator is _only on a route that costs nothing to
  serve_; `/health/live` qualifies and `/health` no longer does. The deep
  routes are rate-limited like anything else, which also bounds what an
  attacker on the private network could make them do.
- **The disk check earns its place here specifically.** `pg_data`, the
  session Valkey's AOF and the bind-mounted `./log` directory share one
  disk, and `SYNC_LOG_RETENTION_DAYS` is the only thing bounding the last of
  them.
- **`/health/live` may stay publicly reachable**, unlike the other two. It
  states nothing beyond the fact that something answered, and leaving it open
  is what lets an external uptime monitor watch the site without a
  credential.

Using terminus's own `TypeOrmHealthIndicator` means one `SELECT 1` issued
outside a repository, which the layering rule in `CLAUDE.md` forbids. Taken
deliberately: it is a third-party probe rather than application code reaching
into the database, it already carries its own timeout, and the alternative —
a `core/health` module with an entity-less repository — is a module invented
to satisfy the letter of a rule aimed at business queries. The two Valkeys
get custom indicators, because they are reached through
`@toxicoder/nestjs-valkey` and the cache's client is private to
`CacheModule`; that one needs a small `ping()` on `VersionedCacheService`.

### Sync and scrape — one tap, eleven events

`SyncOrchestratorService.buildReporter` already fans every
`ScrapeProgressEvent` out to the run's log file and the open `sync_log` row.
It gains a third sink and nothing inside `src/scrape/` is touched.

| Metric                                       | Type      | Labels                  | Fed by                            |
| -------------------------------------------- | --------- | ----------------------- | --------------------------------- |
| `whisky_sync_runs_total`                     | counter   | store, trigger, outcome | run start/finish                  |
| `whisky_sync_run_duration_seconds`           | histogram | store                   | run finish                        |
| `whisky_sync_runs_in_flight`                 | gauge     | —                       | run start/finish                  |
| `whisky_sync_last_success_timestamp_seconds` | gauge     | store                   | run finish, and the collector     |
| `whisky_sync_items_total`                    | counter   | store, kind             | `persisted`                       |
| `whisky_scrape_pages_total`                  | counter   | store                   | `page`                            |
| `whisky_scrape_detail_pages_total`           | counter   | store, outcome          | `enrich` / `detail-failed`        |
| `whisky_scrape_listing_incomplete_total`     | counter   | store, stop             | `listing-incomplete`              |
| `whisky_scrape_stock_drop_total`             | counter   | store                   | `stock-drop`                      |
| `whisky_scrape_deadline_skips_total`         | counter   | store, pass             | `detail-deadline`, `llm-deadline` |

The last two rows are the ones worth the work. A deadline skip is a run that
silently gave up on filling fields and said so only inside a file on disk; a
listing-incomplete stop is a scraper that broke in a way that deliberately
does **not** flag the store's stock, which is correct and invisible. Both
become numbers a graph can show trending.

`sync_last_success_timestamp_seconds` per store is the single most useful
alert in the document: _"nothing has successfully synced `rozetka` in two
days"_ is currently discoverable only by opening the store page and reading a
date.

### LLM — the one that costs money

| Metric                                | Type      | Labels               |
| ------------------------------------- | --------- | -------------------- |
| `whisky_llm_requests_total`           | counter   | pass, model, outcome |
| `whisky_llm_request_duration_seconds` | histogram | pass, model          |
| `whisky_llm_tokens_total`             | counter   | pass, model, type    |
| `whisky_llm_batch_failures_total`     | counter   | pass, kind           |
| `whisky_llm_batch_retries_total`      | counter   | pass                 |
| `whisky_llm_batch_halvings_total`     | counter   | pass                 |

`completion.usage` is read today only to compose an error message; its
`prompt_tokens` and `completion_tokens` are never looked at. Counting them by
pass and model is direct spend visibility per sync, and `type=reasoning`
catches the specific failure this repository has already paid for once — a
provider ignoring `reasoning: {enabled: false}` and burning the whole
completion budget before the first answer token. `kind` reuses
`LlmRetryPolicy.classify`'s existing `transport | halve | fatal`, so the
labels cannot drift from the retry behaviour they describe.

This needs one signature change: an optional `pass` on `LlmCallOverrides`, so
the client can label what it was asked.

### Push, currency, and the catalogue

| Metric                                                  | Type    | Labels  |
| ------------------------------------------------------- | ------- | ------- |
| `whisky_push_notifications_total`                       | counter | outcome |
| `whisky_push_digests_total`                             | counter | outcome |
| `whisky_currency_rate_sync_total`                       | counter | outcome |
| `whisky_currency_rate_last_effective_timestamp_seconds` | gauge   | code    |
| `whisky_catalogue_store_offers`                         | gauge   | store   |
| `whisky_catalogue_store_active`                         | gauge   | store   |
| `whisky_catalogue_store_last_sync_success`              | gauge   | store   |

`WebPushOutcome` is already the exact label set (`sent | gone | failed |
too-large | throttled`), so that counter is a one-line addition at the point
the outcome is decided.

**The collector runs every `METRICS_COLLECT_INTERVAL_MS` (60 s), never on
scrape.** This is the rule that keeps the endpoint safe: a `/metrics` handler
that ran SQL would let a misconfigured Prometheus, or two of them, put the
database under load nobody asked for. The gauges come from one existing call,
`StoreService.list()`, which already returns per-store in-stock offer counts
and last-sync state — so four business gauges cost one query the API already
serves on `GET /store`, and no new SQL is written at all.

## 6. Alert rules

Grouped in three files. Thresholds come from this repository's own recorded
numbers wherever one exists.

**API** — any replica down 2 m; all replicas down (critical); 5xx ratio above
5 % for 5 m; `/report` p95 above 2 s for 10 m (the owner's stated limit);
event-loop lag p99 above 200 ms for 5 m; sustained 429s, which usually means a
client looping rather than an attack.

**Infrastructure** — a dependency down 2 m; pool waiting above zero for 5 m;
Postgres connections above 80 % of `max_connections`; deadlocks; a transaction
open longer than 5 m; **session Valkey evicting anything at all** (it must
not, and an evicted session signs a user out of every device); cache Valkey
memory above 90 % of `maxmemory` — 3 GiB was chosen after a ladder evicted
4 038 live entries; a container restarting repeatedly; host disk above 85 %;
load average above cores for 15 m.

**Domain** — `cache_dirty` for 5 m; no successful sync of an active store in
48 h; a store failing three runs in a row; listing-incomplete seen; LLM fatal
failures; rate-limiter fail-open events; currency rates older than 3 days
(the NBU publishes every calendar day, so 3 days cannot be a weekend).

Alertmanager groups by alert name and severity, routes everything to one
Telegram receiver, and ships with `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
as placeholders — the container runs and alerts fire without them, they are
simply not delivered until the two values exist.

## 7. Grafana

Provisioned datasource and dashboards from files, so nothing is clicked into
existence and everything is in git. Four dashboards:

| Dashboard        | Answers                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `whisky-api`     | Is it up and fast? RPS, p50/p95/p99 by route, error and 429 rates, in-flight, slowest routes, per-replica split                                                          |
| `whisky-runtime` | Which replica is struggling? Event-loop lag, heap, GC, CPU, handles, DB pool per replica, dependency health, HAProxy per-server                                          |
| `whisky-infra`   | What is the host doing? node-exporter, cAdvisor per container, Postgres, both Valkeys side by side, `pg_stat_statements` top                                             |
| `whisky-domain`  | Is the product working? Cache hit ratio and dirty state, per-store sync freshness table, scrape outcomes, LLM tokens and spend, push, currency freshness, catalogue size |

The per-store staleness table on `whisky-domain` is the screen this project
does not have today and should: one row per store, last successful sync, its
age, offers in stock, and whether the last run was incomplete.

## 8. Security posture

- `/metrics` is `Resource.PUBLIC`, `@NoRateLimit()` and `@ValidateResponse(false)`,
  because the scraper cannot hold a token and the payload is not a DTO. It
  carries **no request data, no ids and no user-derived label values** — route
  patterns, store slugs, currency codes and enum members only.
- It is nonetheless blocked **at the host nginx**, in `infra/nginx/nginx.conf`,
  and so are `/api/health` and `/api/health/ready` — beside the
  `location ~ ^/api/docs(-json|-yaml)?(/|$)` block that already exists for
  exactly this reason and in exactly this shape: a regex location returning
  `404`, matched ahead of the `/api/` prefix. `404` rather than `403` follows
  that precedent — it states that nothing is there, rather than that
  something is and you may not have it. **`/api/health/live` is deliberately
  left open**, because it discloses nothing and is what an external uptime
  monitor can watch without a credential; the regex is written to exclude it
  rather than to blanket the prefix.
- **The edge is nginx's job.** HAProxy's only change is the one word naming
  the URL it probes; it gains no routing rule, no header handling and no
  policy. That role is kept intact deliberately: it is the one place where a
  rule would sit beside the `X-Forwarded-For` contract that must not be
  disturbed, and every rule added there is a second, divergent copy of a
  policy nginx already owns.
- Residual exposure, stated rather than glossed over: HAProxy binds on the
  private interface (`192.168.179.2:9977`), so anything already on that
  network can reach `/metrics` without passing nginx. That is the same
  exposure Postgres (`5431`), the session Valkey (`6378`) and the cache
  (`6377`) already have on that same address, so it is the posture this
  deployment has chosen rather than a new hole. An optional `METRICS_TOKEN`
  turns on bearer checking for a deployment that wants it closed anyway;
  unset means no check, which is the right default here.
- `/health` and `/health/ready` name dependencies and their latencies and do
  work per call, so they stay inside the rate limiter. They are **not**
  permission-gated: a health check that needs a token cannot be read by the
  tooling that most needs it, and the nginx block plus the private-interface
  bind is what keeps them off the public internet.
- `@NoRateLimit()` gains a second user and loses none. It applies to
  `/metrics` and `/health/live`; the rule that comes with it — _only on a
  route that costs nothing to serve_ — holds for both: one is a constant, the
  other is string concatenation over in-memory numbers.
- Grafana, Prometheus and Alertmanager publish on the private interface only.
  cAdvisor's socket mount is read-only and it publishes nothing.
- New log call sites are checked against `LOG_REDACT_PATHS`; none of the
  metric code logs an object carrying credentials, but the check is the
  standing rule.

## 9. Cost, honestly

- **Per request**: two hook callbacks and one histogram observation, roughly
  a microsecond. Against the ~8.5 ms of CPU a cached report page spends, and
  the 10 µs the rate limiter's Valkey charge already costs, it is noise. It
  will be measured before and after on the same replay the cache work used,
  and the number recorded here.
- **Per process**: one registry, a few hundred series. `collectDefaultMetrics`
  adds an interval timer.
- **On the host**: eight containers, of which Prometheus is the only heavy
  one. Retention is 15 days at these intervals — a few hundred megabytes on
  the same disk as `pg_data`, which is why disk usage is itself alerted.
- **What this does not do**: no tracing. Log aggregation was also out of
  scope here and has since been built — see
  [`LOGS-PLAN.md`](LOGS-PLAN.md), which revisits §11's assumption and lands on
  VictoriaLogs rather than the Loki named there.

## 10. Checkpoints

Executed one at a time, each with its own gate, reported before the next
begins.

**One ordering constraint runs through the table**: the HAProxy probe may
only be pointed at `/health/live` in the same change that creates that route
(step 3). Doing it in step 1 would leave the repository undeployable in
between — the probe would 404 on every replica and the balancer would drain
the whole backend. Every other step is independently deployable, and step 1
in particular changed no HAProxy directive at all.

| # | Step                                                                                                                                                                                                                                                                                              | Gate                                                                                                                                                                                                                                                                                  | Status   |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0 | This plan                                                                                                                                                                                                                                                                                         | reviewed                                                                                                                                                                                                                                                                              | done     |
| 1 | `infra/` skeleton; `haproxy.cfg` moved (comments only, **no directive changed**); `../web/scripts/nginx.conf` moved to `infra/nginx/` with the `/api/metrics` and `/api/health` blocks added; `.dockerignore` widened to `infra`; the five `web` references and two stale paths in `be` rewritten | compose YAML parses and every bind source exists; `haproxy -c` clean; `nginx -t` clean; the routing proven by probe (`/api/health/live` proxies, `/api/health`, `/api/health/ready` and `/api/metrics` are 404, `/api/docs` unchanged); no stale path in either repository            | **done** |
| 2 | Metrics core: `@prometheus-io/client`, `~lib/metrics`, `MetricsConfig`, `GET /metrics`, the Fastify hooks, default metrics, `app_info`                                                                                                                                                            | 9 unit tests; a live boot proving the route label is the pattern (`/store/:slug`, never the path), that a request refused in `AuthJwtGuard` and a router 404 are both counted, that 15 rapid scrapes are all 200 while the limiter is on, and that `METRICS_TOKEN` gates when set     | **done** |
| 3 | Health: `@nestjs/terminus`, `/health` + `/health/live` + `/health/ready`, the two Valkey indicators, `VersionedCacheService.ping`, the dependency gauges off the same `HealthCheckService`, **and the HAProxy probe URI flipped to `/health/live` in the same change**                            | 16 unit tests; a live boot with the session Valkey stopped proving `/health/live` stays 200 while `/health` answers 503 and both gauges fall to 0, then return to 1 on recovery                                                                                                       | **done** |
| 4 | Domain instrumentation: cache counters through one helper, the rate limiter's charges and fail-open, the login ladder, the DB pool, the scrape progress tap, the LLM transport, push and the currency sync, plus the periodic collector                                                           | 1227 unit tests green; a live boot showing every family published, the collector's per-store gauges read from the real database, a failed login counted and the limiter's two buckets counted separately                                                                              | **done** |
| 5 | The monitoring stack: compose project, `prometheus.yml`, the seven exporters and jobs, `infra/.env.example`                                                                                                                                                                                       | `promtool check config` clean over the scrape config and all three rule files; every bind source and network declaration reviewed. Targets come up only on the production host                                                                                                        | **done** |
| 6 | Alert rules and Alertmanager with the Telegram receiver                                                                                                                                                                                                                                           | `promtool check rules` clean (29 rules); `amtool check-config` clean. The Telegram receiver ships commented out because Alertmanager validates every receiver and rejects a stub chat id — a placeholder would stop the container starting                                            | **done** |
| 7 | Grafana provisioning and the four dashboards (77 panels, generated); `infra/README.md` (which absorbed the planned `docs/MONITORING.md` — one operator doc rather than two that drift); `CLAUDE.md`, `.env.example`, `ROLLBACK.md`                                                                | all 78 PromQL expressions parse under `promtool`, and every metric name in them is cross-checked against `metrics.constants.ts` — nothing the app publishes is unwatched, and no panel names a metric that does not exist. `CLAUDE.md` no longer claims the probe names no dependency | **done** |

## 11. What is deliberately not here

- **Tracing.** The request path is short and the interesting latency is
  already attributable to a route, a cache result and a query id. OpenTelemetry
  would be the way to do it and is its own project.
- **Log aggregation.** ~~Loki beside Grafana is the obvious pairing~~ — done
  on 2026-09-16, and **not with Loki**. The per-sync log files under `./log`
  were indeed one of the three first sources. The pairing this document called
  obvious did not survive contact with the evidence: Loki removed Promtail
  outright in 3.7.3 and its replacement wants ten times the CPU of the
  alternatives on a host already short of cores. See
  [`LOGS-PLAN.md`](LOGS-PLAN.md) §2 for the argument and the operator reports
  it rests on.
- **Business metrics on the price data itself.** `/dashboard/*` already
  answers those questions with SQL against the real history, and duplicating
  them as Prometheus series would give worse answers with worse retention.
  The gauges in §5 are about whether the machinery works, not about whisky
  prices.
- **Dependency checks on the balancer's probe.** `/health` gains them;
  `/health/live`, which HAProxy reads, deliberately does not. §5 says why —
  it is the one thing in this document that cannot be traded away without
  turning a degradation into a total outage.
