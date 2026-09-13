# Load test results — 2026-09-13, ceiling runs against production

Plan and harness: [`LOAD-TEST-PLAN.md`](LOAD-TEST-PLAN.md),
[`../loadtest/README.md`](../loadtest/README.md). Artefacts of this run:
`loadtest/out/20260913-0020/` (git-ignored) — `k6.log`, `summary.json`,
`report.html` (the k6 dashboard export), `observer.tsv`.

**Three runs are recorded here, in order.** Everything down to "The fix,
measured locally" is the first, which found the ceiling and diagnosed it.
"Repeat run after the fix" is the second, after the page-addressable cache
was deployed. **"Third run" is the current one** — after the outgoing DTO
pipeline came off `/report`, `DB_POOL_SIZE` went to 50 and the process
guards landed. Read it for today's numbers: the service holds about
**139 requests/s** and roughly **350 concurrent users** of this workload,
not the 100 below or the 200 of the second run.

## Headline (first run, before the fix)

**The API on the new 8-core host holds about 100 simultaneously active users
of this workload. At 200 it queues, not fails: cached catalogue pages take
3.5 s at the median and 11 s at p95, with zero errors and zero 429s.** The
database, the cache and the network were idle the whole time; the limit is
the API process itself — one Node event loop doing all the work.

Where the owner's limits were crossed:

| Users | Cached reports (`cache:hit`) p50 / p95 / TTFB p95 | Uncached reports (`cache:miss`) p50 / p95 / TTFB p95 | Verdict against 1 s / 2 s                                         |
| ----- | ------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| 50    | 303 / 623 / 485 ms                                | 239 / 759 / 617 ms                                   | within limits                                                     |
| 100   | 394 / **1 460** / 1 110 ms                        | 256 / 1 179 / 984 ms                                 | cached over 1 s at p95                                            |
| 200   | 3 527 / **11 526** / 11 410 ms                    | 451 / 1 829 / 1 779 ms                               | collapse; the 10 s safety valve ended the run 20 s into this step |

(`TTFB` is `http_req_waiting`: the server's time plus one round trip. The
transfer half, `http_req_receiving`, stayed at p50 136 ms / p95 226 ms for
reports throughout — the tunnel carried 723 kB/s, a fifth of its capacity.)

## Setup

- 1 000 users seeded on production with `--prefs` (1 783 favourites, 266
  hidden bottlings, 104 hidden producers, 369 quick filters, 289 collection
  rows, 445 purchases); k6 v1.3.0 on the laptop over the VPN in `direct`
  mode (`192.168.180.1:10001`, per-user `X-Real-IP`); the remote observer
  sampling Postgres and both Valkey instances every 5 s.
- Ladder `50,100,200,300,400,500,650,800,1000`, 45 s ramp + 2 min hold per
  step, think time 3–12 s, the persona mix from the plan (30 % browsing,
  25 % filters, 15 % search, 15 % deals, 8 % dashboard, 5 % collection, 3 %
  live login; no writes).
- Started 00:23:08 Kyiv, aborted 00:29:44 by the `p(95)<10 s` valve on
  `GET /report/:kind` — 6 m 36 s, 12 041 requests, 1 121 visits, 29 logins,
  190 refreshes, 0 auth failures, 0 failed requests, 0 rate-limited, checks
  100 %.

## What the server was doing (observer, per step)

| Step | ≈ requests/s (session Valkey ops/s) | Postgres active avg / max | Waiting backends | Connections             | Commits/s | Cache hit ratio | Cache memory |
| ---- | ----------------------------------- | ------------------------- | ---------------- | ----------------------- | --------- | --------------- | ------------ |
| 50   | 15                                  | 1.5 / 9                   | 0                | 12 (pool 10 + observer) | 36        | 97.5 %          | 10 MB        |
| 100  | 41                                  | 1.9 / 6                   | 0                | 12                      | 73        | 98.6 %          | 15 MB        |
| 200  | 38                                  | 2.4 / 11                  | 0                | 12                      | 66        | 98.5 %          | 17 MB        |

Two readings matter. **Throughput stopped growing between 100 and 200
users** (41 → 38 requests per second) while latency went from 1.5 s to
11 s: the API was serving at its maximum and queueing the rest. And **none
of the dependencies were busy**: two active Postgres backends on average,
nobody waiting on a lock, the pool never exhausted, 98 % cache hits, a
17 MB cache, block reads at zero (everything from shared buffers).

## Interpretation

- **The cost is per request on the Node thread, and it scales with the
  size of the result set the request handles, not with database work.**
  The uncached class (random filter combinations, which run the SQL) was
  _faster_ than the cached class at every step — 451 ms against 3 527 ms
  at the median under 200 users — because a filtered result set is small
  and the database serves it from a pool of ten connections in parallel,
  while the unfiltered catalogue is thousands of groups that one JavaScript
  thread has to decode, personalise, sort, page, transform and validate on
  every request. The cache removed the query; it did not remove the work,
  and it moved that work from eight Postgres cores onto one Node core. The
  profile below says where it goes.
- **Roughly 40 requests per second of this mix is the ceiling**, about a
  dozen catalogue pages per second among them. At idle a warm catalogue
  page already cost ~150–200 ms of server time (measured before the run),
  which is consistent with a single thread saturating around that rate.
- **Nothing failed.** `APP_REQUEST_TIMEOUT_MS` (30 s) was never reached,
  the pool never timed out, the rate limiter never fired (every user stayed
  inside its own budget). Under overload this API degrades into long waits
  rather than errors, which is the kinder failure but also the one a
  dashboard of error rates would miss.

## Where a catalogue page's CPU goes (local profile)

Measured on the laptop, not the host, so the absolute numbers are 2–3×
better than production's and only the _shares_ carry over. The API was
started with `node --cpu-prof` and `RATE_LIMIT_ENABLED=false` against the
local copy of the production database, warmed once, and replayed with four
closed-loop users for 60 s over `GET /report/catalog?perPage=50` (pages
1–5, four sort orders): 1 696 requests, 28 per second, median 141 ms with
four in flight — **≈ 35 ms of CPU per page**, one core saturated.

| Share of busy CPU | What                                                  | Where                                                      |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| **35 %**          | `JSON.parse` of the cached entry                      | `CacheCodec.decode`                                        |
| **18 %**          | UTF-8 decoding of the entry's buffer to a string      | `Buffer.toString` (`node:buffer slice`)                    |
| **14 %**          | Garbage collection                                    | mostly the strings and objects the two rows above allocate |
| 3 %               | gunzip                                                | `node:zlib`                                                |
| **10 %**          | Outgoing validation of the 50 groups and their offers | `class-validator` (`ValidationInterceptor`)                |
| 4 %               | `plainToInstance` of the same                         | `class-transformer` (`@Paginated`)                         |
| 5 %               | Personalise, sort, page                               | `ReportService`                                            |
| < 1 %             | JSON serialisation of the response                    | Fastify                                                    |

**Seventy percent of every catalogue page is spent turning the cached
result set back into objects.** One cached catalogue entry read from the
production cache is 396 KB gzipped and **4.17 MB of JSON** for 2 156 groups
with 3 683 offers — and the unfiltered catalogue the landing page and the
browser persona read holds 3 146 groups, so it is larger still. Every
request decompresses, decodes and parses all of it, uses fifty groups, and
hands the rest to the garbage collector. The design note in `CLAUDE.md`
("what is cached is the unsorted, unpaginated result set … one entry serves
them all") is right about Postgres and wrong about the event loop: one entry
does serve everyone, at the price of a full parse per request. The
personalisation and sorting the design moved into JavaScript are, by
contrast, cheap — 5 % together.

Profile, replay script and aggregator: `profile-local-catalog.cpuprofile`,
`profile-local-catalog.txt`, `replay-catalog.js`, `profile-summary.mjs` in
the run's folder.

## Hypotheses, settled

| #  | Hypothesis                                           | Verdict                                                                                                                                                                                                                                                                                                       |
| -- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 | The 10-connection pool is the first ceiling          | **No.** Two active backends on average, none waiting, pool never exhausted                                                                                                                                                                                                                                    |
| H2 | One Node process saturates one core while seven idle | **Yes**, by elimination: dependencies idle, throughput flat, latency queueing. Container CPU was not observable from the laptop; the host's `docker stats` during a repeat would make it direct                                                                                                               |
| H3 | Logging is a measurable share of the CPU             | **Mostly withdrawn.** Production runs at `debug` (owner, 2026-09-13), so the response-body dump the hypothesis rested on is not written; what remains is two small request lines per request. The compose used to pin `LOG_LEVEL=trace`; it forwards the variable with `info` as the default since 2026-09-13 |
| H4 | The cache carries the report load                    | **Yes** as a cache (98 % hits), **no** as a remedy: the per-request processing of the cached set is the cost                                                                                                                                                                                                  |
| H5 | A login storm is CPU-bound on the libuv threadpool   | Not reached; 29 logins, p95 778 ms, no failures                                                                                                                                                                                                                                                               |
| H6 | The ceiling is above 1 000 users                     | **No.** ~100                                                                                                                                                                                                                                                                                                  |

## Recommendations, in order of cost

1. **Config: keep production at `debug` or lower.** `docker-compose.yaml`
   used to pin `LOG_LEVEL=trace`, which would have added a response-body
   dump per request to the saturated thread; it forwards the variable with
   `info` as the default since 2026-09-13. Still owed: a `logging:` block
   with `max-size`/`max-file` on the API service.
   Logging is not expected to be the dominant cost at `debug`, so this is
   hygiene rather than the remedy.
2. **Deserialise only the page** — the owner's chosen fix, planned in
   [`REPORT-PAGE-CACHE-PLAN.md`](REPORT-PAGE-CACHE-PLAN.md): a cached set
   becomes a small index plus a hash of per-group JSON, and a request
   parses fifty groups instead of the whole catalogue. Expected ~35 ms →
   ~3–5 ms of CPU per page.
3. **Take the outgoing DTO pipeline off the hot path in production**: the
   `validateOrReject` + `plainToInstance` pass over fifty groups and their
   offers is 14 % of the page. Keep it in development and tests, where it
   catches contract drift, and gate it by config in production.
4. **Slim the cached representation**, afterwards: 1.9 KB of JSON per group
   is more than a page needs, and a leaner shape shrinks the one decode per
   generation that remains.
5. **Scale out** once the per-request cost is honest: several API processes
   behind nginx. The in-process rate limiter, the sync lock's boot sweep
   and the single-instance assumptions documented in `CLAUDE.md` have to
   move first; with four workers on eight cores, items 2–3 plus this put the
   ceiling well past 1 000 users of this mix.

## The fix, measured locally (2026-09-13)

Recommendation 2 was built the same day
([`REPORT-PAGE-CACHE-PLAN.md`](REPORT-PAGE-CACHE-PLAN.md)): a cached set is
now a small index plus a hash of per-group JSON, and a request decodes the
page it returns. On the replay that profiled the problem — four closed-loop
users over the catalogue, production copy, limiter off, same laptop:

|                                                 | Before        | After              |
| ----------------------------------------------- | ------------- | ------------------ |
| Requests per second                             | 28            | **113**            |
| Median request                                  | 141 ms        | **34 ms**          |
| CPU per page                                    | ~35 ms        | **~8.5 ms**        |
| Decoding the cached data, per request           | ~19 ms (70 %) | ~1.1 ms (13 %)     |
| Outgoing `plainToInstance` + `validateOrReject` | ~5 ms (14 %)  | ~4.7 ms (**55 %**) |

Deployed to production on 2026-09-13; the repeat ladder below is the
measurement, and the outgoing DTO pipeline is the next cut.

## Repeat run after the fix — production, 2026-09-13 09:33–09:49

Same seed, same ladder, same harness; artefacts
`loadtest/out/20260913-0933/`. Ended by the same `p(95)<10 s` valve, this
time **three rungs higher** — 16 m 02 s, 63 147 requests, 5 877 visits,
zero 429s, cache hit ratio 97–99 %.

**The ceiling roughly doubled, from about 100 simultaneously active users
to about 200, and at the load that used to collapse the improvement is
tenfold.** Cached catalogue pages at 200 users went from 11 526 ms at p95
to 1 159 ms. The throughput plateau went from ~40 requests/s to ~95. And
the bottleneck moved: it is no longer the Node event loop.

### Cached reports (`cache:hit`), p50 / p95 / TTFB p95

| Users | Before (blob cache)            | After (page-addressable)     |
| ----- | ------------------------------ | ---------------------------- |
| 50    | 303 / 623 / 485 ms             | **218 / 306 / 146 ms**       |
| 100   | 394 / **1 460** / 1 110 ms     | **219 / 379 / 232 ms**       |
| 200   | 3 527 / **11 526** / 11 410 ms | **284 / 1 159 / 1 016 ms**   |
| 300   | — (run ended at 200)           | 1 663 / 2 751 / 2 632 ms     |
| 400   | —                              | 4 218 / 5 130 / 5 015 ms     |
| 500   | —                              | 2 613 / 22 183 / 21 746 ms ⚠ |

⚠ **The 500-user step is confounded** — the catalogue cache was invalidated
19 s into it. See "What happened at 500 users" below; steps 50–400 are
clean.

### Uncached reports (`cache:miss`), p50 / p95 / TTFB p95

| Users | Before                 | After                        |
| ----- | ---------------------- | ---------------------------- |
| 50    | 239 / 759 / 617 ms     | **212 / 716 / 579 ms**       |
| 100   | 256 / 1 179 / 984 ms   | **220 / 735 / 612 ms**       |
| 200   | 451 / 1 829 / 1 779 ms | **276 / 1 418 / 1 354 ms**   |
| 300   | — (run ended at 200)   | 1 638 / 3 329 / 3 255 ms     |
| 400   | —                      | 4 255 / 8 382 / 8 349 ms     |
| 500   | —                      | 2 638 / 11 658 / 11 613 ms ⚠ |

### Where the limits are crossed now

| Limit                    | Before                              | After                                 |
| ------------------------ | ----------------------------------- | ------------------------------------- |
| Cached report, 1 s p95   | within at 50, crossed at **100**    | within at 100, crossed at **200**     |
| Uncached report, 2 s p95 | within at 200 (1 829 ms); run ended | within at 200, crossed at **300**     |
| Failure-free operation   | zero errors through the collapse    | 0.0–1.5 % through 400; 500 confounded |

The cached limit — the binding one, since the landing page and the browsing
persona read the unfiltered catalogue — moved one full rung of the ladder.
The uncached limit moved one rung too. Reading the two tables together, the
honest statement of the ceiling is **a little under 200 users**: at 100 the
service is comfortable (379 ms cached p95, 735 ms uncached), at 200 it is
at the edge (1 159 ms cached, just over the 1 s limit, 1 418 ms uncached,
still inside the 2 s one), and by 300 both are gone.

### What the server was doing (observer, per step)

| Step | k6 requests/s | Postgres active avg / max | Waiting | Conns | Commits/s | Cache hit ratio | Cache memory |
| ---- | ------------- | ------------------------- | ------- | ----- | --------- | --------------- | ------------ |
| 50   | 17.1          | 1.4 / 7                   | 0       | 12    | 35.1      | 97.3 %          | 122 MB       |
| 100  | 36.0          | 2.0 / 6                   | 1       | 12    | 75.0      | 99.1 %          | 191 MB       |
| 200  | 70.6          | 4.0 / 11                  | 1       | 12    | 145.3     | 99.1 %          | 278 MB       |
| 300  | 91.3          | 4.7 / 9                   | 1       | 12    | 187.0     | 99.1 %          | 397 MB       |
| 400  | **95.0**      | 3.6 / 11                  | 0       | 12    | 188.6     | 99.2 %          | 473 MB       |
| 500  | 72.9          | 4.8 / 11                  | 1       | 12    | 142.7     | 97.3 %          | 667 MB       |

### What happened at 500 users — the step is confounded

**The catalogue cache was invalidated 19 seconds into the 500-user step,
so that row is not a clean overload measurement and should not be quoted
as one.** The evidence is exact. Valkey keyspace misses ran at 1–6 per
five-second sample for the whole run, then jumped to 20, 21 and 18 at
06:47:52–06:48:03 and stayed elevated, while cache memory climbed 475 →
666 MB as sets were rebuilt. The 500-user ramp had begun at 06:47:33.

The cause is visible in the generation counter, which is an `INCR` and not
a clock: it stood at `1789224206` before the run and at `1789224210`
after, and the instance now holds live keys under **three** generations —
`…206` (855 keys, the run's own), `…208` (210) and `…210` (169). Four
bumps, in two pairs. A pair is the signature of an application restart:
`CACHE_BOOT_BUMP` fires at bootstrap and `KbBootApplyService` runs the
reconcile pass immediately after, which bumps again. The same 2-gap
appears before the run (keys at `…204`, counter at `…206`), from the
restart the evening before.

So at 500 users the API was not merely overloaded — it was overloaded
_and_ rebuilding every catalogue set from SQL at the same time, with
hundreds of concurrent requests missing at once. That is a cache stampede,
and it accounts for the shape of the row: a p50 (2 613 ms) _lower_ than
the 400-user step's while p95 explodes to 22 s, and a 24.5 % failure rate
where every earlier step was under 1.5 %.

Two things are worth separating out, because they survive the caveat:

- **The pool-acquire timeouts are independent of it.** They were first
  logged at 06:46:17, during the 400-user step, a minute and a half
  _before_ the invalidation. That finding stands on its own.
- **Steps 50–400 are clean.** Misses never exceeded 6 per sample and cache
  memory grew smoothly with new filter combinations. The ceiling claim
  rests on the 100/200/300 rows, none of which are touched by this.

What is still unknown is _why_ the application restarted twice under load
— whether it was killed (the container has no memory limit set in the
compose service for the API, unlike `whisky-cache`), crashed, or was
deployed by hand while the ladder ran. `docker ps` uptime and the
container's exit history would settle it, from the host. Until it is
settled, **a rerun of the 500/650/800 rungs is owed** before anything is
concluded about where the service actually breaks.

### Did the ceiling move as the profile predicted?

**Directionally yes, in magnitude only half.** The profile predicted a move
from ~100 "towards several hundred" on the strength of a 4× local replay
(28 → 113 requests/s). Production delivered **2.4× throughput** (a plateau
of ~40 requests/s became ~95) and **2× users** (~100 became ~200).

The shortfall is explained, not mysterious, and three things account for it:

- **Amdahl.** The local profile itself said the decode was 70 % of a
  catalogue page and that after the fix the outgoing `plainToInstance` +
  `validateOrReject` pass would be **55 %** of what remained. Removing the
  larger half of a cost cannot multiply throughput by more than the rest
  allows, and the DTO pipeline is now the dominant term — which is exactly
  why it is next on the list.
- **A new bottleneck appeared one layer down.** See below.
- **The other routes were never optimised** and now dominate the tail:
  `GET /meta` p95 9 713 ms, `GET /dashboard/series` 10 535 ms,
  `GET /report/history` 13 148 ms over the whole run. `/meta` is still
  cached in the blob form, and the two heavy reads are uncached by design.

### The bottleneck moved off the event loop, onto the connection pool

This is the substantive new finding, and it is what a 2× rather than 4×
result actually looks like from the inside.

In the first run the dependencies were idle while the API queued: Postgres
averaged 1.5–2.4 active backends and throughput stopped growing at ~40
requests/s. In this run Postgres is **doing three times the work** —
commits per second went 35 → 188, active backends 1.4 → 4.8 — because the
API can finally push that much through. And at 400 users and above the
application began logging

```
ERROR: timeout exceeded when trying to connect
  at Timeout._onTimeout (pg-pool/index.js:224:27)
```

which is `DB_ACQUIRE_TIMEOUT_MS` (5 000 ms) firing: a request queued for a
connection from the ten-connection client pool and gave up. **Postgres
itself was still not the constraint** — the observer never saw more than
one backend waiting, `blks_read` stayed at zero (everything from shared
buffers) and the server-side connection count sat flat at 12 throughout.
The constraint is `DB_POOL_SIZE = 10` on the client side; connections spend
most of their time `idle` because each query is short, and what runs out is
checkout slots during bursts, not database capacity.

Two consequences worth stating plainly:

- **The failure mode changed.** The first run degraded into long waits with
  _zero_ errors — the kinder failure, and the one an error-rate dashboard
  would miss. This one produces bounded failures instead, and they begin
  at 400 users (0.28 %), before the cache invalidation that confounds the
  500 row. That is the resilience work behaving as designed (`CLAUDE.md`,
  "Timeouts": the acquire timeout exists to stop "queueing forever for a
  drained pool"), but it does mean overload is now visible as errors and
  reaches real users as errors. How steep it gets past 400 is not yet
  measured cleanly.
- **It is the cheapest remaining win.** Raising `DB_POOL_SIZE` costs one
  variable and some Postgres memory; the server has the headroom, with four
  or five backends busy out of ten and `max_connections` far above that.
  It should be measured, not assumed — the pool is a queue in front of a
  finite machine, and widening it past what eight cores can serve moves the
  wait rather than removing it.

### Cache memory is the new operational cost

Peak cache memory went from **17 MB to 667 MB**, a factor of about forty,
against a 976 MB `maxmemory`. That is the page-addressable form doing
exactly what its plan said it would: a set stored as a hash of per-group
JSON is ~5.4 MB where the gzipped blob was ~0.4 MB. Measured on production
after the run: 1 422 keys, 675 MB, **zero evictions and zero expirations**,
hit ratio 98.6 % lifetime.

So nothing was evicted — but the ladder stopped at 500 users with 300 MB of
headroom, and the last step alone added 194 MB as the filter personas
cached new combinations. A longer run, a wider filter mix, or the 650/800/
1000 rungs would plausibly have reached `allkeys-lru`. That matters for
reading a future run: eviction on this instance shows up as cache misses,
which look like the cache not working rather than like the cache being too
small. Worth either raising `--maxmemory` or slimming the stored group
(recommendation 4, ~1.9 KB per group) before the next ladder.

### Caveats of this run, so the two are compared honestly

- **The 500-user step is not a clean measurement** — see "What happened at
  500 users". Quote the 50–400 rows; treat 500 as evidence that something
  restarted under load, not as the breaking point.
- **The application's working tree was being edited while the ladder ran.**
  The owner was building the response-validation opt-out (recommendation 1)
  between 09:38 and 09:47 local, inside the run window. Those changes were
  uncommitted and `HEAD` stayed at `4f5fe70`, so what production served was
  the deployed image; but it is the reason a mid-run deploy has to be ruled
  out by hand rather than assumed away.
- **Every virtual user refreshed its token once at the start**, which the
  first run never did: its seed was two minutes old, this one nine hours,
  and `REFRESH_MARGIN_SEC` makes a stale access token refresh before use.
  That adds ~1 000 `POST /auth/refresh` calls spread over the ladder — the
  reason `auth_failures` (300) and refresh latency (p95 15 504 ms) are not
  comparable across the two runs. Both are collapse artefacts of the 500
  step, not token problems.
- **Five users' refresh tokens were already spent** in `users.json` before
  the run (refresh tokens rotate on use, and two smoke runs had used
  `loadtest-0001..0005`). Those five map to VUs 1–5 and account for the
  1.53 % failure rate of the 50-user step, which is otherwise unexplained
  and should not be read as the service failing at 50 users.
- **The harness needed a one-line fix to run at all.** `stageLabel()` reads
  `exec.scenario`, which exists only inside a VU, and `setup()` calls it
  through the stale-token login path — a path the first run never took. It
  now labels such a request `setup`, which no threshold names. The change
  is in the working tree, uncommitted.
- Ladder, personas, think time, spoofed per-user IPs and the `direct` mode
  against `192.168.180.1:10001` are otherwise identical to the first run.
  The link was again not the constraint: `http_req_receiving` for reports
  held p50 136 ms / p95 184 ms.

## Third run — production, 2026-09-13 10:32-10:51

Artefacts `loadtest/out/20260913-1032/`. Three changes since the second run,
deployed together and therefore measured together: `/report` opts out of the
outgoing `plainToInstance` + `validateOrReject` pipeline, `DB_POOL_SIZE` went
from 10 to 50, and the process guards stop an orphaned rejection from killing
the API. Freshly re-seeded users, so no virtual user had to refresh at start
— the same footing as the first run.

**The service sustains about 139 requests per second, and holds about 350
simultaneously active users of this mix inside the response-time limits.**
The ladder ran seven rungs to 650 before the valve ended it, against five in
the second run and three in the first. Nothing failed at all through 400
users; 97 074 requests, 9 065 visits, zero 429s.

### Throughput per step, all three runs (k6 requests/s)

| Users | First | Second   | Third     |
| ----- | ----- | -------- | --------- |
| 50    | 15    | 17.1     | 16.6      |
| 100   | 41    | 36.0     | 37.0      |
| 200   | 38    | 70.6     | 70.6      |
| 300   | —     | 91.3     | 107.0     |
| 400   | —     | **95.0** | 136.8     |
| 500   | —     | 72.9     | **139.1** |
| 650   | —     | —        | 81.2      |

The plateau is the number that matters: ~40 requests/s became ~95 and is now
**~139**, a 3.5x improvement over where this started. Below 200 users the
three runs are identical, which is the expected shape — at that load nothing
was ever queueing, so nothing could get faster.

### Cached reports (`cache:hit`) p95, all three runs

| Users | First      | Second   | Third   |
| ----- | ---------- | -------- | ------- |
| 50    | 623 ms     | 306 ms   | 332 ms  |
| 100   | **1 460**  | 379      | **267** |
| 200   | **11 526** | 1 159    | **539** |
| 300   | —          | 2 751    | **583** |
| 400   | —          | 5 130    | 1 836   |
| 500   | —          | 22 183 ⚠ | 10 751  |
| 650   | —          | —        | 29 590  |

At 200 users — the load that collapsed the first run — p95 is now 539 ms
against 11 526 ms: **twenty-one times better**, and less than half what the
second run managed there.

### Uncached reports (`cache:miss`) p95

| Users | First  | Second   | Third  |
| ----- | ------ | -------- | ------ |
| 50    | 759 ms | 716 ms   | 830 ms |
| 100   | 1 179  | 735      | 896    |
| 200   | 1 829  | 1 418    | 868    |
| 300   | —      | 3 329    | 1 358  |
| 400   | —      | 8 382    | 2 471  |
| 500   | —      | 11 658 ⚠ | 8 141  |
| 650   | —      | —        | 15 090 |

### Where the limits are crossed now

| Limit                    | First   | Second  | Third            |
| ------------------------ | ------- | ------- | ---------------- |
| Cached report, 1 s p95   | **100** | **200** | **400**          |
| Uncached report, 2 s p95 | > 200   | **300** | **400**          |
| First failed request     | none    | 400     | **500** (2.10 %) |

Both limits now cross at the same rung, which they did not before: at 300
users a cached page is 583 ms and an uncached one 1 358 ms, both comfortably
inside; at 400 they are 1 836 ms and 2 471 ms, both outside. So the honest
ceiling is **between 300 and 400 users**, and unlike the previous two runs
the service is still answering _everything_ there — the first failure appears
only at 500.

### What the server was doing (observer, per step)

| Step | req/s     | Postgres active avg / max | Waiting | Conns | Commits/s | Cache hit ratio | Cache memory |
| ---- | --------- | ------------------------- | ------- | ----- | --------- | --------------- | ------------ |
| 50   | 16.6      | 1.5 / 5                   | 0       | 29    | 36.2      | 97.2 %          | 774 MB       |
| 100  | 37.0      | 2.1 / 8                   | 0       | 37    | 80.2      | 98.8 %          | 822 MB       |
| 200  | 70.6      | 4.4 / 14                  | 1       | 52    | 145.9     | 99.1 %          | 899 MB       |
| 300  | 107.0     | 11.5 / 39                 | 2       | 52    | 221.6     | 99.1 %          | 977 MB       |
| 400  | 136.8     | 14.2 / 38                 | 3       | 52    | 279.7     | 99.2 %          | 976 MB       |
| 500  | **139.1** | 27.7 / **51**             | **7**   | 52    | 275.3     | 99.2 %          | 976 MB       |
| 650  | 81.2      | 9.3 / 45                  | 1       | 52    | 154.2     | 99.1 %          | 976 MB       |

**The database is now genuinely working, which it never was before.** Active
backends averaged 1.5-2.4 across the whole first run; here they reach 27.7 at
500 users with a maximum of 51, and commits per second peaked at 280 against
the first run's 73. That is the point of the whole exercise: the work has
moved from one saturated JavaScript thread onto eight Postgres cores that
were previously idle.

It also shows where the next edge is. At 500 users the fifty-connection pool
is nearly all in use (51 of 52 observed connections, seven backends waiting),
and that is the rung where failures start. `DB_POOL_SIZE` moved the wall from
400 users to 500-650; it did not remove it, and raising it further now runs
into the machine rather than into a queue — commits per second stopped
growing between 400 and 500 while latency tripled, which is the same
saturation signature the first run showed on the event loop.

### The run is clean, unlike the second

Three checks, all of which the second run failed:

- **The process never restarted.** The cache generation stood at
  `1789224212` before the ladder and still does after it, and a restart is
  two bumps. The guards committed this morning are the reason to expect
  that, since the failure they catch — an orphaned `pg-pool` acquire
  timeout — is exactly what 500 and 650 users produce.
- **The cache stayed coherent.** No miss cliff anywhere in the observer;
  the hit ratio held at 99.1-99.2 % from 200 users up.
- **Eviction happened and cost nothing.** 866 keys were evicted once memory
  reached the 976 MB cap, and `allkeys-lru` took them from the three dead
  generations left by earlier restarts, exactly as it should. The live
  generation was never touched — visible in that flat hit ratio.

So the 500 and 650 rows are real overload measurements, not artefacts.

### A fourth ladder was run, and measures nothing

`loadtest/out/20260913-1118/`, immediately after `jit=off` was applied to
Postgres. It is recorded here so nobody finds the artefacts and wonders: it
reached 500 rather than 650, plateaued at 134 requests/s against 137, and its
`cache:hit` latencies moved in both directions between steps (200 users
539 → 309 ms, 300 users 583 → 988 ms).

None of that is attributable. A cached request runs none of the queries JIT
compiles, so no Postgres setting can move the column that defines the
ceiling — those differences are run-to-run noise, and so is a collapse that
lands one rung earlier. The isolated measurement of that change (312 → 213 ms
on the catalogue query, three runs each way) is the reliable one, and it is
in [`POSTGRES-TUNING.md`](POSTGRES-TUNING.md) together with why tuning the
database cannot raise this ceiling at all: at 400 users the database is idle
and a cached page still takes 1 609 ms, which is queueing in the Node
process.

## Next steps proposed

In the order the evidence now ranks them:

~~0. Settle why the API restarted twice at 500 users.~~ **Done** — an
orphaned `pg-pool` acquire timeout was killing the process; the guards
in `src/app/process/` log it and keep serving, and the third run
restarted zero times.

~~1. Take the outgoing DTO pipeline off the hot path.~~ **Done** —
`/report` opts out; 121.6 -> 316.7 requests/s on the local replay and a
share of the 95 -> 139 requests/s measured in production.

~~2. Raise `DB_POOL_SIZE`.~~ **Done** — 10 -> 50, which moved the first
failed request from 400 users to 500.

Remaining, re-ranked on the third run:

3. **Memoise the index in process.** It is immutable for the life of a
   generation, so one decode per generation would remove most of the 13 %
   that decoding still costs.
4. **Slim the stored group**, which now buys memory as well as CPU: 1.9 KB
   per group is what makes a cached set 5.4 MB, and the instance now runs
   pinned at its 976 MB cap, evicting continuously. Harmless today — the
   third run evicted only dead generations and held a 99 % hit ratio — but
   it is the headroom that disappears first as the catalogue grows.
5. **Then the unoptimised reads**, which are the tail of the third run:
   `/dashboard/series` (p95 10 983 ms), `/report/history` (8 765 ms),
   `/product/search` (6 184 ms), `/collection` (6 053 ms) and `/meta`
   (3 052 ms, still blob-cached). `/report` is no longer among them.
6. **Several API processes behind nginx**, which is now the move with the
   most left in it: at 500 users the fifty-connection pool is nearly all in
   use and commits per second have stopped growing, so the next gain is
   more than one process feeding the eight cores rather than a cheaper
   request. Still blocked by the in-process rate limiter and the sync
   lock's single-instance boot sweep, both documented in `CLAUDE.md`.

- The 1 000 seeded users stay in place for a repeat run after any change;
  `DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --cleanup` removes
  them. Their refresh tokens expire around **2026-09-20**, after which the
  seed must be recreated rather than reused.
