# Load test results — 2026-09-13, ceiling run against production

Plan and harness: [`LOAD-TEST-PLAN.md`](LOAD-TEST-PLAN.md),
[`../loadtest/README.md`](../loadtest/README.md). Artefacts of this run:
`loadtest/out/20260913-0020/` (git-ignored) — `k6.log`, `summary.json`,
`report.html` (the k6 dashboard export), `observer.tsv`.

## Headline

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

Not yet deployed; the production ladder (steps 50/100/200/300) is the next
measurement, and the outgoing DTO pipeline is the next cut.

## Next steps proposed

- Implement recommendation 2 (and 3) behind config, then repeat steps
  50/100/200/300 with the same seed and ladder and compare the rows above.
- The 1 000 seeded users stay in place for a repeat run after any change;
  `DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --cleanup` removes
  them.
