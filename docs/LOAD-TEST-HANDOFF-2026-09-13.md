# Handoff — load testing and the report page cache (2026-09-13)

Written to continue this work in a fresh session. Everything here is
verified against the repository and the running production host at the time
of writing; anything stated as "not done" was checked, not assumed.

Read with: [`LOAD-TEST-PLAN.md`](LOAD-TEST-PLAN.md) (how the harness is
built and why), [`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md) (what the
ceiling run measured), [`REPORT-PAGE-CACHE-PLAN.md`](REPORT-PAGE-CACHE-PLAN.md)
(the fix, checkpoint by checkpoint) and
[`../loadtest/README.md`](../loadtest/README.md) (the operating manual:
seed, run, knobs, cleanup).

## 1. Where things stand, in one paragraph

The API moved to an 8-core / 16 GB host. A k6 harness was built, a thousand
users were seeded on production, and a stepped ladder found the ceiling at
**about 100 simultaneously active users**: at 200 the service queued to an
11-second p95 on cached catalogue pages with zero errors, while Postgres,
the cache and the network sat idle. A CPU profile blamed one thing — every
request decompressed and parsed the **whole** cached result set (4–6 MB of
JSON) to return fifty groups. That was fixed: a cached set is now stored
page-addressably and a request decodes only its page (28 → 113 requests/s
locally, ~35 → ~8.5 ms of CPU per page). **The fix is committed and pushed
but not deployed.** The next measurement is a repeat of the ladder against
production after the owner deploys.

## 2. The system under test

| Thing          | Where                        | Note                                                                                             |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| API            | `http://192.168.180.1:10001` | The container's own published port, beside nginx. Reachable over the owner's VPN from the laptop |
| Postgres       | `192.168.180.1:10432`        |                                                                                                  |
| Session Valkey | `192.168.180.1:10379`        | `whisky-valkey`. Sessions live here; the seed writes to it                                       |
| Cache Valkey   | `192.168.180.1:10380`        | `whisky-cache`. The catalogue cache                                                              |
| Credentials    | `be/.env.loadtest`           | Git-ignored, present on the laptop. Template: `.env.loadtest.example`                            |

All four ports answered at the time of writing. k6 and the seed run **on
the laptop**, never on the host — the load generator must not compete for
the cores being measured. The owner judged the home link (~30 Mbit/s)
sufficient; the ceiling run confirmed it, carrying a fifth of its capacity.

## 3. What was built, and where it lives

Three commits on `main`, pushed, working tree clean:

- **`35c84fd`** — the load-test harness. `scripts/loadtest-seed.ts`
  (`pnpm loadtest:seed`), `loadtest/whisky-users.js` (the k6 scenario),
  `loadtest/observe.sh` (a remote observer over the VPN),
  `loadtest/k6-summary.js` and `loadtest/observer-summary.js` (per-step
  tables), `loadtest/README.md`, the two planning documents, and
  `AuthService.revokeAllSessions`.
- **`413e12d`** — the page-addressable report cache. `ReportPageUtils`
  (`src/utils/report-page.util.ts`), `VersionedCacheService.getPage`,
  `CACHE_MAX_SET_BYTES`, `ReportService.report` rewired, `personalize` /
  `sort` / `compare` removed from the service, docs updated. Also stops
  pinning `LOG_LEVEL=trace` in compose and forwards it with `info` as the
  default.
- **`4f5fe70`** — removal of the watchdog heartbeat and the step-by-step
  `verbose` tracing (the owner's pending change, committed alongside).

Tests at that point: **1162 unit (87 suites), 206 integration (20 suites)**,
`tsc` / `eslint` / `dprint` clean.

## 4. What was measured

**Ceiling run against production, 2026-09-13 00:23–00:29** (before the fix).
Ladder `50,100,200,300,400,500,650,800,1000`, 45 s ramp + 2 min hold per
step; ended by the `p(95)<10 s` safety valve twenty seconds into the
200-user step. Artefacts: `loadtest/out/20260913-0020/` (git-ignored).

| Users | Cached reports p50 / p95 / TTFB p95 | Uncached reports p50 / p95 / TTFB p95 | Against 1 s / 2 s |
| ----- | ----------------------------------- | ------------------------------------- | ----------------- |
| 50    | 303 / 623 / 485 ms                  | 239 / 759 / 617 ms                    | within limits     |
| 100   | 394 / **1 460** / 1 110 ms          | 256 / 1 179 / 984 ms                  | cached over 1 s   |
| 200   | 3 527 / **11 526** / 11 410 ms      | 451 / 1 829 / 1 779 ms                | collapse          |

Zero failed requests, zero 429s, Postgres two active backends on average,
cache hit ratio 98 %, transfer time flat (p95 226 ms) — the bottleneck was
the single Node event loop, by elimination.

**The fix, locally** (same replay both sides: four closed-loop users over
`GET /report/catalog`, production database copy, rate limiter off):

|                                                 | Before        | After              |
| ----------------------------------------------- | ------------- | ------------------ |
| Requests per second                             | 28            | **113**            |
| Median request                                  | 141 ms        | **34 ms**          |
| CPU per page                                    | ~35 ms        | **~8.5 ms**        |
| Decoding the cached data                        | ~19 ms (70 %) | ~1.1 ms (13 %)     |
| Outgoing `plainToInstance` + `validateOrReject` | ~5 ms (14 %)  | ~4.7 ms (**55 %**) |

## 5. What is NOT done

1. **The deploy.** Verified at the time of writing: production still holds
   blob-form cache keys and **zero** `…:idx` keys, so the page-cache build
   is not running there. The owner deploys with `scripts/deploy.sh`.
2. **The repeat ladder** against production after that deploy — the whole
   point of the next session.
3. **Docker log rotation.** The API service still has no `logging:` block
   with `max-size`/`max-file` in `docker-compose.yaml`; the json log grows
   unbounded. Small, separate, worth doing.

## 6. The next session, step by step

**Preconditions to check first** (all four are one-liners):

```bash
git log --oneline -3                       # 4f5fe70, 413e12d, 35c84fd
nc -z -w 3 192.168.180.1 10001 && echo ok  # VPN up
redis-cli -h 192.168.180.1 -p 10380 --scan --pattern 'cache:report:*:idx' | head -1
psql "$(...)" -c "select count(*) from \"user\" where name like 'loadtest-%'"
```

The third must print a key — that is how you know the deploy landed. The
fourth must print 1000.

**The run** (from `be/`, roughly 26 minutes, or shorter if a valve fires):

```bash
RUN=loadtest/out/$(date +%Y%m%d-%H%M); mkdir -p "$RUN"
date -u +%Y-%m-%dT%H:%M:%SZ > "$RUN/started-at.txt"
ENV_FILE=.env.loadtest loadtest/observe.sh "$RUN/observer.tsv" &
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT="$RUN/report.html" \
k6 run --summary-export "$RUN/summary.json" \
  -e BASE_URL=http://192.168.180.1:10001 \
  -e STAGES=50,100,200,300,400,500,650,800,1000 \
  -e STEP_RAMP=45s -e STEP_HOLD=2m -e RAMP_DOWN=1m \
  loadtest/whisky-users.js
kill %1
node loadtest/k6-summary.js "$RUN/summary.json"
node loadtest/observer-summary.js "$RUN"
```

**Then**: append the new rows beside the originals in
`docs/LOAD-TEST-2026-09.md`, state where the limits are crossed now, and
say whether the profile's prediction (ceiling from ~100 towards several
hundred) held.

## 7. Traps, each of which has already cost something

- **The seeded tokens expire, the file does not.** `loadtest/users.json`
  was written 2026-09-13 00:21 with default-lifetime access tokens (600 s),
  so they are long dead; the **refresh** tokens live seven days, so the
  file keeps working until roughly **2026-09-20**. Each virtual user
  refreshes on its own, and `setup()` logs in when its own token is stale —
  it **logs in** rather than refreshing, deliberately, because refreshing
  would rotate a session a virtual user is about to use. Past that date,
  re-seed: `DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --cleanup`
  then `… --users 1000 --prefs`.
- **Seeding on top of an existing population is refused.** Login resolves
  accounts by name and `user.name` has no unique index, so `--cleanup`
  comes first, always.
- **The prefix guard.** `--prefix` under five characters is refused, so a
  careless cleanup cannot match real accounts.
- **Two safety valves end a run early** against production: error rate
  above 5 % (after 2 min) and report p95 above 10 s (after 3 min). k6 then
  exits 99. That is success, not failure — it is what stops a ladder from
  riding out a collapse on a live service.
- **429 is not an error here.** It is counted in `rate_limited`, waited out
  per `X-RateLimit-Retry-After-Ms` and retried once. Above ~1 % it means
  the scenario is more eager than the API's per-account limits, so slow it
  down (`THINK_SCALE`) before reading anything else.
- **`http_req_waiting` is the server, `http_req_receiving` is the link.**
  The direct port sends uncompressed JSON; a growing receive time with flat
  time-to-first-byte is the VPN saturating, not the API.
- **Writes are off by default** (`WRITES=true` enables one persona that
  toggles a favourite). The production database is backed up and the owner
  accepts test rows in it, but a run that mutates preferences measures a
  different workload.
- **Production logs at `debug`,** not `trace`. Compose forwards `LOG_LEVEL`
  with `info` as the default since `413e12d`; at `trace` the request
  interceptor serialises every response body into the log, on the very
  thread this work relieved.
- **`cache:hit` / `cache:miss` tags are the scenario's _expectation_**, not
  what the server did. The observer's `cache_hits`/`cache_misses` columns
  are the truth.

## 8. What comes after the repeat run

In the order the profile ranks them:

1. **Take the outgoing DTO pipeline off the hot path in production.**
   `plainToInstance` + `validateOrReject` over fifty groups and their
   offers is now **more than half** of a catalogue page. Keep it in
   development and tests, where it catches contract drift; gate it by
   config in production.
2. **Memoise the index in process.** It is immutable for the life of a
   generation, so one decode per generation would remove most of the 13 %
   that decoding still costs. An optimisation on top of the current shape,
   not a change to it.
3. **Slim the stored group.** ~1.9 KB of JSON per group is more than a page
   needs.
4. **Several API processes behind nginx.** Blocked first by the in-process
   rate limiter and the single-instance assumptions of the sync lock's boot
   sweep, both documented in `CLAUDE.md`.

Rejected, with reasons, in `REPORT-PAGE-CACHE-PLAN.md` §5: an in-process
cache of the whole decoded set, and SQL `LIMIT`/`OFFSET` (the database
still evaluates the full join and both LATERAL probes per page,
personalisation would have to move back into SQL, and `drops`/`low`/`new`/
`best` are set-based by nature).

## 9. Cleanup, when the testing is finished

```bash
DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --cleanup
```

Deletes every `loadtest-*` user and revokes their sessions; favourites,
blacklists, quick filters and collection rows cascade. Idempotent, and
verified to leave no orphan rows and no session keys.
