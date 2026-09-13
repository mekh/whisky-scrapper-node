# Postgres tuning — 2026-09-13

What was changed on the production database, what was measured to justify it,
and — the longer half — what was deliberately left alone. Companion to
[`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md), which is where the load
numbers quoted here come from.

The settings themselves live in the `db` service's `command:` in
`docker-compose.yaml`, parameterised through `PG_*` variables documented in
`.env.example`. They are **not** applied with `ALTER SYSTEM`: that writes
`postgresql.auto.conf` inside the data volume, where a fresh environment
would not inherit it and a reader of this repository would not see it.

> **Superseded in one respect, 2026-09-13 evening.** The headline below was
> true of a single API process and is no longer true of three: with the
> event loop no longer the constraint, the database became one. Commits per
> second now flatten at ~350-360 while the offered load doubles. What is
> still true is the reasoning — the ceiling is not made of connections, and
> the ladder still cannot measure a planner setting. The two
> multi-instance ladders and the `pg_stat_statements` attribution are in
> [`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md); the one change that
> follows from them is a query rewrite, not a setting.

## The headline, before the values

**Tuning Postgres does not raise this API's ceiling, because Postgres is not
the constraint at the ceiling.** That is worth stating first, because the
values below look like a performance change and only one of them is.

The evidence is one row of the ladder. At 400 concurrent users — the rung
where both response-time limits break — the database was idle: 15.4 active
backends of a 50-connection pool, at most two ever waiting, `blks_read` at
zero. In the same step a **cached** catalogue page, which is served from
Valkey plus one small indexed lookup, answered in 1 609 ms with 756 ms of
that before the first byte. A request that touches almost no database at all
cannot be slowed by the database; that time is queueing in the single Node
process. Postgres only becomes a constraint past 500 users, which is already
beyond where the service has stopped meeting its limits.

So what follows is hygiene plus one real saving, not a route to more
requests per second. The route to more requests per second is several API
processes.

## What was measured

All measurements against the production database over the VPN, `EXPLAIN
(ANALYZE)` with timing off, three runs per side unless noted.

### `jit` — the one that paid

The catalogue query (`CURRENT_SQL` in `StoreProductRepository`, ~7 400 rows
across eight joins and two LATERAL probes):

| Setting          | Execution time         |
| ---------------- | ---------------------- |
| `jit=on` (stock) | 317 / 288 / 312 ms     |
| `jit=off`        | **213 / 207 / 228 ms** |

**About 32 % faster.** The plan showed `JIT: Functions: 83` on every
execution. JIT earns its compilation cost on long analytical queries; this
one finishes in a fifth of a second with no I/O, so the compilation is pure
overhead paid per request. It runs on every cache miss.

This does not show up in a ladder run, and the reason is worth recording
because it nearly caused a wrong conclusion. A repeat ladder with `jit=off`
produced a throughput plateau of 134 requests/s against the previous run's
137, and its `cache:hit` latencies moved in _both_ directions between steps
(200 users 539 → 309 ms, 300 users 583 → 988 ms). A cached request runs none
of the queries JIT compiles, so no Postgres setting can move that column —
those differences are run-to-run noise, and since that column is what sets
the ceiling, the ladder is structurally unable to measure this change. The
isolated query measurement is the reliable one.

### I/O — already a non-issue

`pg_stat_database` over the database's lifetime: `blks_hit` 1 482 054 367
against `blks_read` 45 094, a **99.997 %** hit ratio, and the load test's
observer recorded `blks_read` at zero in every step of every run. The
database is 151 MB (127 MB of it `price_snapshot`) on a 16 GB host, so it is
fully resident between shared buffers and the OS page cache.

`shared_buffers` was therefore raised as insurance and headroom, not as a
speedup, and `effective_cache_size` is a planner hint that allocates nothing.
Expect no measurable change from either.

### `work_mem` — a real spill, with no latency attached

The dashboard's daily aggregate (three `COUNT(DISTINCT)` and three
`percentile_cont` over ~850 000 snapshot rows for a 90-day range):

| `work_mem` | Sort                              | Execution time |
| ---------- | --------------------------------- | -------------- |
| 4 MB       | `external merge  Disk: 39 144 kB` | 1 454 ms       |
| 64 MB      | `quicksort  Memory: 60 467 kB`    | 1 476 ms       |

Raising it removes a 39 MB spill per execution and changes the time not at
all — an idle SSD absorbs that write for free. This is the source of the
16 GB of `temp_bytes` the database has accumulated, and the cost is real
under concurrency (page-cache churn, temp I/O from many sessions at once)
rather than in a single query's latency.

The value chosen is 16 MB, which clears the small spills. **It deliberately
does not clear this one**: `work_mem` applies per sort or hash _node_, not
per query, so the ~64 MB that would hold this sort could mean gigabytes
across a busy 50-connection pool, in exchange for a latency gain measured at
zero. The dashboard aggregate is a structural problem — 850 000 rows and
three percentiles on every request — and its fix is a materialised rollup,
not a GUC.

### `random_page_cost` — no measured effect

Compared at 4 (the stock value, which describes a spinning disk) and 1.1 on
the catalogue query: **the plans were identical**, node for node. Every table
it touches is small enough that a sequential scan is correct regardless.

It is set to 1.1 anyway, as the correct description of SSD storage for
queries this analysis did not cover, and this paragraph is here so nobody
later credits it with something it did not do.

### `max_parallel_workers_per_gather` — left alone

Compared at 2 (stock) and 0 on the dashboard aggregate: 1 511 / 1 490 ms
against 1 597 / 1 544 ms, and **no `Gather` node appeared in either plan** —
the query never launches a worker. With no measured effect there was nothing
to justify changing it, so it keeps its default.

### `max_connections` — deliberately not raised

This is the one where the intuitive direction is wrong. The host has eight
cores. At 500 users the ladder already ran 27.7 active backends on average
with a peak of 51 and seven waiting; at that point Postgres is oversubscribed
by more than three to one and its commits per second had stopped growing.
More connections would buy context switching, not throughput. It stays at the
stock 100, which leaves comfortable headroom over the application's
`DB_POOL_SIZE_TOTAL` of 50, shared across every instance.

## What is set

| Setting                | Value  | Why                                             |
| ---------------------- | ------ | ----------------------------------------------- |
| `jit`                  | `off`  | Measured: −32 % on the catalogue query          |
| `shared_buffers`       | 1 GB   | Six times the database; headroom, not a fix     |
| `effective_cache_size` | 8 GB   | Planner hint; allocates nothing                 |
| `work_mem`             | 16 MB  | Clears small spills; per node, so it multiplies |
| `maintenance_work_mem` | 512 MB | VACUUM, index builds, migrations; never serving |
| `random_page_cost`     | 1.1    | Correct for SSD; no measured effect here        |

Unchanged and intentionally so: `max_connections` (100),
`max_parallel_workers_per_gather` (2), `synchronous_commit` (on — the write
volume is tiny and durability is worth more), `checkpoint_completion_target`
(already 0.9), `autovacuum` (on).

## Applying it

The memory settings need the container recreated, not merely reloaded:

```bash
docker compose up -d db
```

Then confirm what the server actually took, which is the only check that
matters — a typo in a `-c` flag makes Postgres refuse to start, but a value
silently clamped to a boundary does not announce itself:

```bash
psql -c "select name, setting, unit, source from pg_settings
         where name in ('jit','shared_buffers','effective_cache_size',
                        'work_mem','maintenance_work_mem','random_page_cost',
                        'max_connections')"
```

`source` should read `command line` for the six above. Anything reading
`configuration file` means a stale `postgresql.auto.conf` entry is competing
and should be removed with `ALTER SYSTEM RESET <name>`.

## What to do next

Not more of this. The remaining work in order of what the evidence supports:

1. ~~**Several API processes behind nginx.**~~ **Done** (2026-09-13) — three
   replicas behind HAProxy. It removed the ceiling this document describes
   and put the constraint on this database instead.
2. ~~**`pg_stat_statements`.**~~ **Done**, and it was worth the restart: it
   immediately contradicted two assumptions. The largest single consumer is
   `/currency/rate/latest` at **24 %** of all statement time — 235 ms a call,
   one call per page load — which `EXPLAIN` then showed to be a full sort of
   `currency_rate` on every call, fixable to 0.338 ms by a lateral rewrite.
   The catalogue, which every optimisation so far has targeted, is not in
   the top of the list at all.
3. **A materialised rollup for the dashboard aggregate**, now quantified:
   the dashboard is ~8 % of visits in the scenario and about **60 %** of
   database time, `/dashboard/series` alone 20 % at 2 799 ms a call. Measure
   the real persona mix before spending on it — that 8 % is a guess, while
   the currency read above rides every page load and is real under any mix.
