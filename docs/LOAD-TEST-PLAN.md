# Load test — 1000 concurrent users on the new host

Status: **ceiling run done and profiled — the API holds ~100 users, 70 % of a page is decoding the cached set; see [`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md); step 5 pending** (2026-09-13).

The API moved from a 3-core / 4 GB host to an 8-core / 16 GB one. This plan
describes how to find out (a) whether it serves 1000 simultaneously active
users within the API's own rate limits, and (b) where it stops — which
resource gives first, and at what load.

## 1. Tool: Grafana k6

k6 is the right tool here and it is already installed on the laptop
(`k6 v1.3.0`, with the `dashboard`, `sql/postgres` and `prometheus` output
extensions built in). What it gives that the alternatives do not:

- **One virtual user (VU) is one real user**: a JS function with its own
  state — its own JWT, refresh cookie, persona, think time. That is exactly
  the shape of "1000 people browsing", and it is what raw throughput tools
  (`wrk`, `oha`, `autocannon`, `vegeta`) cannot express at all.
- **Scenario executors** for both questions: `ramping-vus` for the 1000-user
  hold, and a shrinking think time or a taller ramp for the ceiling.
- **Thresholds as pass/fail** (`p(95) < 500 ms`, `http_req_failed < 1 %`) and
  per-route tagging, so the summary says which endpoint degraded first.
- **A live dashboard with no Grafana stack**: `K6_WEB_DASHBOARD=true` serves
  it on `127.0.0.1:5665` during the run and exports a self-contained HTML
  report at the end. Prometheus remote-write into a Grafana instance stays
  available for later, but is not needed for this.
- `SharedArray` loads the 1000 seeded users once per process, and
  `http.batch` reproduces the SPA's parallel page-load fan-out.

Weighed and set aside: **Locust** (Python; the persona model is equally
natural, but the metrics/thresholds story is weaker and it adds a runtime
this repo does not have), **Artillery** (YAML + Node; noticeably heavier per
VU), **Gatling** (JVM), and the throughput tools above (useful later for a
single-endpoint ceiling, useless for behaviour).

## 2. What the API's own limits force on the design

Read from the code, not assumed — each one shapes the harness.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                        | Consequence for the test                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An access token is valid only while its **session exists in Valkey** (`AuthService.authenticate` → `AuthSessionService.has`)                                                                                                                                                                                                                                                                                                                                                                                      | `domain/auth`                                                                                | Tokens cannot be minted offline from the JWT secret; every test user needs a real session. The seed script calls `AuthService.createSession`                                                               |
| Authenticated requests are rate-limited **per account**: 3 rps / burst 10 globally, `/report` + `/dashboard` 1 rps / burst 60, `/collection` 1 rps / burst 3                                                                                                                                                                                                                                                                                                                                                      | `app/rate-limit`, `RateLimitConfig`                                                          | 1000 accounts = 1000 independent budgets. One account cannot stand in for many users                                                                                                                       |
| `/auth/login` and `/auth/refresh` are **public**, so their limits are keyed by **client address**, and three apply. The `AUTH` bucket (1 rps, burst 5) is an in-process token bucket that **nothing resets** — a successful login spends a token like a failed one. The login ladder (one attempt per second, then penalty stages) keeps its state in Valkey and **deletes it on success**, so it only spaces failed and concurrent attempts. nginx adds `limit_req` 10 r/min, burst 8, per `$binary_remote_addr` | `AuthController` (`@RateLimit(AUTH)`), `AuthThrottleService.reset`, `infra/nginx/nginx.conf` | Sequential successful logins from **one** address are capped at 1/s by the bucket: ~17 min for 1000 through the API port, ~100 min through nginx. Auth traffic needs many addresses or no live auth at all |
| `JWT_ACCESS_EXPIRES` defaults to **600 s**                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `JwtAccessConfig`                                                                            | A 20-minute run needs refresh, which is subject to the per-address limit above                                                                                                                             |
| The address is read from `X-Real-IP` (single hop, replace-style) when `APP_TRUST_PROXY=true`; nginx overwrites the header with `$remote_addr`                                                                                                                                                                                                                                                                                                                                                                     | `ClientIpUtils`, `client-ip.hook.ts`, `nginx.conf`                                           | Hitting the API port directly lets each VU present its own address; going through nginx does not                                                                                                           |
| The API is published on `${APP_BIND_IP}:${APP_BIND_PORT}` beside nginx's upstream — on this host `192.168.180.1:10001`, reachable over the VPN (the compose defaults `192.168.179.2:9977` are overridden by the host `.env`)                                                                                                                                                                                                                                                                                      | `docker-compose.yaml`                                                                        | A direct-to-API mode exists without touching the deployment                                                                                                                                                |
| `LogInterceptor` logs every request at `debug` and every response body at `verbose`. The compose in this checkout pins `LOG_LEVEL=trace`, but the running deployment is at `debug` (owner, 2026-09-13), so bodies are not written; there is no `logging:` driver limit either way                                                                                                                                                                                                                                 | `app/interceptors/log.interceptor.ts`, `docker-compose.yaml`                                 | Logging is a small per-request cost at `debug`; the `trace` pin must not reach production (hypothesis H3)                                                                                                  |
| A catalogue sync (`SYNC_CRON_ENABLED`, noon Kyiv) or any boot bumps the cache generation                                                                                                                                                                                                                                                                                                                                                                                                                          | "Catalogue cache" in `CLAUDE.md`                                                             | A run that overlaps a sync sees every report request miss at once. Either avoid the window or run it on purpose as a scenario                                                                              |

## 3. Two run modes

Both are the same k6 script; `BASE_URL` and `SPOOF_IP` select the mode.

**`direct`** — `BASE_URL=http://192.168.180.1:10001`, `SPOOF_IP=true`. k6 runs
on the laptop (or any host on that network — never on the server itself, so
the load generator's CPU does not compete with the thing being measured).
Every VU sends `X-Real-IP: 10.<n>.<n>.<n>` derived from its user index, so
the API sees 1000 distinct callers exactly as it would in production. Live
`/auth/login` (a small share of VUs each iteration) and `/auth/refresh` (when
a token is within 60 s of expiry) are part of the traffic, which also puts
Argon2 verification on the table (H5). This is the primary mode: it measures
the API, Postgres and both Valkey instances, which is what changed hosts.

**`edge`** — `BASE_URL=https://<domain>/api`, `SPOOF_IP=false`. The full
production path including TLS and nginx. Auth traffic is impossible from one
address at this scale, so the seed mints **long-lived** access tokens
(`--access-ttl 86400`) and the script never logs in or refreshes. Use it once
to confirm nginx adds nothing surprising; the numbers that matter come from
`direct`.

## 4. Seed script — `scripts/loadtest-seed.ts`

`pnpm loadtest:seed --users 1000 [--out loadtest/users.json] [--access-ttl <sec>] [--prefs] [--cleanup]`

A standalone Nest application context (same pattern as `enrich-flavors.ts`)
over `ConfigModule` + TypeORM + `CoreUserModule` + `DomainAuthModule`
(+ `CorePreferenceModule`, `CoreQuickFilterModule`, `CoreUserCollectionModule`
for `--prefs`). It runs against whatever `.env` points at — the production
database, when that is the target — so everything it creates is marked and
reversible:

- Users `loadtest-0001` … `loadtest-NNNN`, `active`, not `admin`, **no
  permissions** (they reach every `Resource.AUTHENTICATED` route and nothing
  admin-only, like a real account), no email. One random password per seed
  run, compliant with the `Password` field rules; Argon2 hashing runs in
  chunks of eight (1000 hashes is a minute or two).
- One session per user through `AuthService.createSession({ user, ip,
  userAgent })`, which writes the Valkey session and returns the pair. The
  `ip` is the user's spoofed address, so the session records match what the
  test sends. `--access-ttl` sets `JWT_ACCESS_EXPIRES` in the script's own
  process before the config is built, so a long-lived token is signed the
  ordinary way, not by a second signer.
- `--prefs`: about 30 % of users get 3–8 favourites and 15 % 1–3 blacklist
  entries (bottlings and brands) drawn from the live catalogue, 20 % get
  1–3 quick filters, 10 % get 2–5 collection rows with purchases. Without it
  `ReportService.personalize`, `favoritesOnly`, `/collection` and
  `/collection/stats` all run over empty sets and prove nothing.
- Output `loadtest/users.json` (git-ignored, holds tokens): `{ createdAt,
  baseUrlHint, password, users: [{ index, id, name, ip, access, refresh,
  accessExp }] }`.
- `--cleanup` deletes every user whose name carries the prefix — favourites,
  blacklist, quick filters, collection rows and purchases go with the row by
  cascade (to be verified against the FK definitions in step 1; anything that
  does not cascade is deleted explicitly first) — and revokes their sessions
  with `AuthSessionService.revokeAll`.

### Where the seed runs

The tokens it mints must be signed with the **API's** `JWT_ACCESS_SECRET`,
and the sessions it writes must land under the **API's** `VALKEY_PREFIX` in
the **session** instance (`whisky-valkey`, not the cache). A token signed
with another secret, or a session under another prefix, is simply invisible
to the API and every request answers `401`. Two ways to satisfy that:

- **Alternative: inside the API container on the host.** The compiled script
  ships in the image as `dist/scripts/loadtest-seed.js` (every `scripts/*.ts`
  does), so `docker compose exec be node dist/scripts/loadtest-seed.js
  --users 1000 --prefs --out /app/log/users.json` runs with exactly the
  API's environment and no secret leaves the server; `./log` is already a
  bind mount, so the file appears on the host and one `scp` brings it to the
  laptop. Costs one ordinary deploy of the build that contains the script —
  the same procedure `docs/CURRENCY-RATES-PROD.md` uses for the rates
  backfill.
- **Chosen (2026-09-12): from the laptop over the VPN**, with
  `DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed …` pointing at
  `192.168.180.1:10432` (Postgres) and the host's published port of the **session** Valkey (`VALKEY_BIND_PORT` in the host `.env`, to be confirmed) and carrying
  the production `JWT_ACCESS_SECRET` and `VALKEY_PREFIX`. Works without a
  deploy, at the price of a copy of the production secrets on the laptop.

k6 itself needs the VPN in either case: `direct` mode targets the API on
`192.168.180.1:10001`.

## 5. Scenario script — `loadtest/whisky-users.js`

Plain k6 ES modules, not TypeScript: `loadtest/*.ts` would be swept into
`nest build` (the tsconfig has no `include`), and adding excludes to three
tsconfigs buys nothing over JSDoc. The `**/*.js` ESLint block already covers
the file.

**One VU = one seeded user** (`users[(__VU - 1) % users.length]`), holding its
tokens in VU-local state. **One iteration = one visit**: pick a persona by
weight, perform its steps with think time between them, end. Think time is
`THINK_MIN`–`THINK_MAX` seconds (default 3–12), which puts a user at roughly
0.1–0.3 requests per second between page loads — about what the web client
produces for a person reading a list.

| Persona   | Weight                            | Steps                                                                                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing   | every visit starts with it        | `http.batch` of what the SPA fires on load: `/meta`, `/report/catalog?page=1`, `/preference`, `/collection/ids`, `/quick-filter`, `/push/config`, `/currency/rate/latest` (the exact list is read off `../web` in step 2)                                                                                                                                         |
| Browser   | 30 %                              | Pages 2–5 of `catalog` with a common sort                                                                                                                                                                                                                                                                                                                         |
| Filterer  | 25 %                              | A filter set, then 1–3 pages. **60 % of sets come from a short "popular" list** (`countries=GB-SCT`, `excludeFlavors=peated`, `types=…`, `maxPrice=2000`, a store pair, `regions`/`excludeRegions`), **40 % are random combinations** of `/meta` values fetched once in `setup()`. The split is what makes the cache hit ratio realistic rather than 0 % or 100 % |
| Searcher  | 15 %                              | Autocomplete typing: `/product/search?q=` with 3, 4, 5 characters of a term at 300–600 ms spacing, then `/report/catalog?name=<term>`, then `/report/history?term=<offer id from the result>`                                                                                                                                                                     |
| Deals     | 15 %                              | `drops` (`window=week&sort=daysDiscount&order=asc`), `new`, `best`, `low`                                                                                                                                                                                                                                                                                         |
| Dashboard | 8 %                               | `/dashboard/meta`, then `summary`, `series`, `breakdown`, `movers` for a range                                                                                                                                                                                                                                                                                    |
| Collector | 5 %                               | `/collection`, `/collection/stats?currency=USD`                                                                                                                                                                                                                                                                                                                   |
| Writer    | 2 %, **only with `WRITES=true`**  | Toggle one favourite on and off (`POST` then `DELETE /preference/favorites`), which also exercises the personalised re-read. Default off: the production database is read-only under test unless asked                                                                                                                                                            |
| Login     | 3 % in `direct` mode, 0 in `edge` | `POST /auth/login` with the seeded password — replaces the VU's tokens                                                                                                                                                                                                                                                                                            |

Mechanics that keep the numbers honest:

- **Every request is tagged with a route template** (`name: 'GET /report/:kind'`,
  `'GET /product/search'`, …). Without it k6 keys metrics on the full URL and
  a thousand distinct filter strings bury the summary.
- **429 is a first-class outcome, not a failure**: counted in a
  `rate_limited` metric per route, and the VU sleeps for
  `X-RateLimit-Retry-After-Ms` (falling back to `Retry-After`, then 1 s)
  before continuing — the same rule `../web`'s fetcher applies. A 429 rate
  above ~1 % under realistic think time means the _scenario_ is too eager for
  the API's limits, and the run says so instead of reporting a server fault.
- **Token refresh** (`direct` mode): the VU decodes `exp` from its access
  token and calls `/auth/refresh` with its refresh cookie when under 60 s
  remain, keeping cookies per VU (k6's jar is per VU by default).
- **Checks**: status 200, a `data` array on paginated routes, `total > 0` on
  `catalog`, the expected keys on `/meta`.
- **Thresholds** (initial, tuned after the smoke run): `http_req_failed
  { expected_response: true } < 1 %`; `http_req_duration { name: 'GET
  /report/:kind' } p(95) < 500 ms, p(99) < 1500 ms`; `/product/search p(95) <
  300 ms`; `rate_limited rate < 1 %`; `checks > 99 %`.
- **Knobs via `__ENV`**: `BASE_URL`, `SPOOF_IP`, `VUS`, `RAMP_UP`, `HOLD`,
  `RAMP_DOWN`, `THINK_MIN`, `THINK_MAX`, `THINK_SCALE`, `WRITES`,
  `USERS_FILE`. The ceiling run first shrinks `THINK_SCALE` (keeps 1000 real
  accounts and their limits — the per-account budgets stay far above what
  the server can serve, so the limiter is not what caps a ceiling run), then
  raises `VUS` with a larger seed if that was not enough.

Output: the built-in web dashboard live, `--summary-export` JSON and the HTML
report into `loadtest/out/<timestamp>/` (git-ignored).

## 6. Server-side observer — `loadtest/observe.sh`

k6 measures what the client sees; this records what the server was doing at
the same moments, so the two can be laid side by side. Run over ssh on the
host for the duration of a run; appends one TSV line every 5 s:

- `docker stats --no-stream` for `whisky-be`, `whisky-db`, `whisky-valkey`,
  `whisky-cache`: CPU %, memory.
- Host load average and, once, `nproc`.
- Postgres: `pg_stat_activity` counts by `state` for the app's database
  (active / idle / idle in transaction / waiting), and `xact_commit` from
  `pg_stat_database` (a rate after differencing). Optional:
  `pg_stat_statements` top statements before and after the run — the
  extension ships with the PG 18 image but needs `shared_preload_libraries`
  and a restart, so only if the owner wants it.
- The cache Valkey: `INFO stats` → `keyspace_hits`, `keyspace_misses`,
  `evicted_keys`; `INFO memory` → `used_memory`. The session Valkey:
  `connected_clients`, `instantaneous_ops_per_sec`.
- Size of the API container's json log file (`/var/lib/docker/containers/
  <id>/<id>-json.log`), for H3.

A tiny `loadtest/join.ts` (or a shell one-liner) later aligns the TSV with
k6's timeline by timestamp for the results document.

## 7. Hypotheses the runs should confirm or refute

Written down before the first run so the results are read against them,
not fitted afterwards.

- **H1 — the connection pool is the first ceiling.** `DB_POOL_SIZE` is 10
  with `DB_ACQUIRE_TIMEOUT_MS = 5000`. Every authenticated request runs the
  `lastActiveAt` UPDATE (matches no row outside the five-minute window, but
  still a round trip); every report request runs `findFilterIds`; every
  cache miss runs the 136–300 ms report query. At ~200 rps with a 20 % miss
  rate that is ~8 pool-seconds per second — at capacity. Expected symptom: a
  latency knee, then `500`s from acquire timeouts. Expected remedy: raise
  `DB_POOL_SIZE` (Postgres `max_connections` is 100), which the 8 cores can
  now back.
- **H2 — one Node process saturates one core while seven idle.** A warm
  report request decompresses and parses a ~786 KB cache entry, sorts,
  pages, `plainToInstance`s and validates 50 groups. That is milliseconds of
  CPU each, on the one thread the API has. Expected symptom: `whisky-be` at
  ~100 % of one core with the host at ~15 %, latency rising smoothly with
  load. If confirmed, the fix is replicas behind nginx — which the in-process
  rate limiter and the single-instance assumptions of the sync lock's boot
  sweep do not allow today. Out of scope here; the test says whether it is
  needed.
- **H3 — logging is a measurable share of the CPU and grows the disk
  unboundedly.** Written when the checkout's compose pin of `LOG_LEVEL=trace`
  was taken for the running configuration; production is at `debug`, so
  response bodies are not logged and only the request lines remain. What
  stands: no rotation on the json-file driver. Remedy: a `logging:` block
  with `max-size`/`max-file`, and forwarding the level instead of pinning
  `trace`.
- **H4 — the cache carries the report load.** The realistic filter mix
  should hit ≥ 80 %. A second short run with the popular list disabled
  (`POPULAR_SHARE=0`) shows the miss-heavy case, and the gap between the two
  is how much the server depends on the cache.
- **H5 — a login storm is CPU-bound on the libuv threadpool.** Argon2id
  verification runs on four threads; 1000 logins compressed into the
  ramp-up raise login p95 and can delay anything else using that pool.
  Measured in `direct` mode only.
- **H6 — the ceiling is above 1000 users at realistic think time.** The
  nominal run should pass every threshold; the ceiling run finds the number
  where it stops.

## 8. Runs

1. **Smoke** — 50 VUs, 3 min, `direct`. Confirms tokens, spoofed addresses,
   tags and thresholds, and that nothing writes unless asked.
2. **Nominal** — 1000 VUs, 3 min ramp-up, 20 min hold, 2 min ramp-down,
   `direct`, `--prefs` seed. The headline answer to question (a).
3. **Miss-heavy** — as 2 but `POPULAR_SHARE=0`, 10 min (H4).
4. **Ceiling** — `THINK_SCALE` stepped 1 → 0.5 → 0.25 → 0.1 at 1000 VUs, 5 min
   each, until a threshold fails; then, if still passing, a taller `VUS` ramp
   with a 3000-user seed. The headline answer to question (b).
5. **Edge** — 300 VUs, 10 min through nginx, long-lived tokens, no auth
   traffic. Confirms the proxy path.

Runs happen while no catalogue sync is scheduled, and with the owner aware
that real users share the server during them. Each produces a directory
under `loadtest/out/` and a section in `docs/LOAD-TEST-2026-09.md`
(results, the observer's series, verdict per hypothesis, and tuning
recommendations with the evidence beside each).

## 9. Safety and cleanup

- Test users are prefixed, unprivileged and removed by `--cleanup`; their
  sessions are revoked, not left to expire.
- The default scenario performs **no writes** against the production data.
  `WRITES=true` writes only to the test user's own preference rows.
- `users.json` and `loadtest/out/` are git-ignored: the file holds live
  tokens for a thousand accounts.
- No production setting is changed for the test. Anything the results argue
  for (`DB_POOL_SIZE`, log level, log rotation) is a separate, reviewed
  change.

Answered by the owner on 2026-09-12: the production database is backed up
and losing its current state is acceptable, so test rows in it are not a
concern; the VPN gives the laptop direct access to the host's published
ports. Writes stay off by default anyway — for the validity of the
measurement, not for safety: a run that mutates preferences measures a
different workload than the one being asked about.

## 10. Checkpoints

| # | Step                                                                                                                                                | Gate                                                                                                                                                                                                                               | Status                                                                                                                                                                                          |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 | This plan                                                                                                                                           | Owner approves the approach and the two modes                                                                                                                                                                                      | **done — decisions answered 2026-09-12, awaiting go for step 1**                                                                                                                                |
| 1 | `scripts/loadtest-seed.ts` + `pnpm loadtest:seed` / `--cleanup`; `.gitignore` entries; `.env.loadtest.example`                                      | Locally against the dev stack: seed 20 users with `--prefs`; a `curl` with an emitted token answers `/auth/me` and `/report/catalog`; `--cleanup` leaves no `loadtest-*` user, no orphan preference/collection row, no session key | **done 2026-09-12** — see the progress log                                                                                                                                                      |
| 2 | `loadtest/whisky-users.js` + `loadtest/README.md`                                                                                                   | Locally: 20 VUs × 2 min in `direct` mode, zero unexpected failures, every request tagged by route template, 429 handling observed by forcing `THINK_SCALE` down                                                                    | **done 2026-09-12** — see the progress log                                                                                                                                                      |
| 3 | `loadtest/observe.sh` — a **remote** observer (Postgres and both Valkey instances over the VPN), since the owner chose to work from the laptop only | One sample from production carries every column with sane values                                                                                                                                                                   | **done 2026-09-13** — see the progress log                                                                                                                                                      |
| 4 | Runs on the new host                                                                                                                                | `docs/LOAD-TEST-2026-09.md` with results per run and a verdict per hypothesis                                                                                                                                                      | **ceiling run done 2026-09-13** — aborted by the safety valve at 200 users; the nominal 1000-user hold is moot until the per-request cost drops. Results and verdicts in `LOAD-TEST-2026-09.md` |
| 5 | Cleanup and recommendations                                                                                                                         | `--cleanup` run on production; recommendations listed with evidence; this plan's status updated                                                                                                                                    | pending                                                                                                                                                                                         |

Each checkpoint ends with a report (what was done, how it was verified, what
the next step does) and a stop; the next starts on explicit permission.

## 11. Progress log

### Step 1 — seed script (2026-09-12)

Built `scripts/loadtest-seed.ts` (+ `loadtest-seed.interfaces.ts`), the
`pnpm loadtest:seed` script, `.env.loadtest.example`, the `.gitignore`
entries and a `CLAUDE.md` command entry. One line of domain code changed:
`AuthService.revokeAllSessions`, the public sibling of `revokeSession` the
cleanup needs. Design points as planned: users `loadtest-0001…`, active,
non-admin, no permissions, one shared random password; a real session per
user through `AuthService.createSession` recorded under the user's spoofed
`10.x.x.x` address; `--prefs` draws favourites (30 %), blacklist entries
(15 %), quick filters (20 %) and collection rows with purchases (10 %) from
the live catalogue with a per-user seeded generator, so a re-seed is
reproducible; the seed refuses to run on top of an existing population
(login resolves by name, and `user.name` has no unique index); `--prefix`
shorter than five characters is refused so `--cleanup` cannot match real
accounts; the token file is written `0600`.

Gate, against the local dev stack (Postgres 5431, Valkey 6378, the API on
4000):

| Check                                                                 | Result                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--users 20 --prefs`                                                  | 4.5 s wall clock; 20 users, 29 favourites, 12 hidden bottlings, 3 hidden producers, 9 quick filters, 10 collection rows, 17 purchases — Postgres counts match the script's own tally exactly                                                          |
| `GET /auth/me` with an emitted token                                  | 200, the seeded user, `admin: false`, no permissions                                                                                                                                                                                                  |
| `GET /report/catalog?perPage=50`                                      | 200, 3136 groups, 50 rows, `X-RateLimit-*` headers present                                                                                                                                                                                            |
| `GET /auth/session`                                                   | the session's `ip` is the spoofed `10.0.0.1`, user agent `k6-loadtest`                                                                                                                                                                                |
| `POST /auth/login` with the shared password and `X-Real-IP: 10.9.9.9` | 200, and the new session records `10.9.9.9` — the API honours the header, which is what `direct` mode relies on                                                                                                                                       |
| `--cleanup`                                                           | 20 users deleted, every session key of every seeded user gone (including the extra live-login session), zero orphan rows in `favorite`, `blacklist_*`, `quick_filter`, `user_collection`, `user_collection_purchase`; a second `--cleanup` is a no-op |
| `tsc`, `eslint`, `dprint`, `pnpm test`                                | clean; 1138 tests pass                                                                                                                                                                                                                                |

Next: step 2, the k6 scenario `loadtest/whisky-users.js` and its README.

### Step 2 — k6 scenario (2026-09-12)

Built `loadtest/whisky-users.js` and `loadtest/README.md` (the operating
manual: seed, run, knobs, personas, how to read the metrics, clean up), plus
an ESLint block for `loadtest/**/*.js` that knows the `k6/*` modules and the
init-context globals. The script is as planned: one VU plays one seeded
user, every iteration is a visit (the SPA's eight-request page load, a
think, one weighted persona), requests are tagged by route template, 429 is
counted in `rate_limited` and waited out per `X-RateLimit-Retry-After-Ms`
with one retry — a step refused again is counted in `rate_limited_dropped`
rather than failing `checks`, so the two keep measuring different things —
and tokens are refreshed 60 s before expiry through `/auth/refresh` with the
cookie carried by hand (it is `Secure`, which k6's jar would withhold over
plain HTTP). Two things learnt while verifying: k6 resolves `open()` paths
against the **script's** folder, so `USERS_FILE` defaults to `./users.json`
beside the script; and `setup()` renews an expired seed token by **logging
in**, not by refreshing — a refresh rotates the seeded session's token, and
the VU that later plays that user would fail its own refresh with the stale
copy (observed as exactly one `401` before the change).

Gate, against the local dev stack:

| Run                                                                                                                     | Result                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke: 20 VUs, 15 s up / 75 s hold / 10 s down, `direct` mode, 20 seeded users with `--prefs`                           | 75 visits, 832 requests, **0 failed, 0 rate-limited**, 942/942 checks; `GET /report/:kind` p95 117 ms, p99 291 ms; `/product/search` p95 43 ms; `/meta` p95 23 ms; 7 live logins; every threshold green                                                                                                   |
| Forcing run: 3 VUs, `THINK_SCALE=0.02`, users seeded with `--access-ttl 5` so every token was expired before k6 started | `setup()` logged in and proceeded; 3 refreshes, 0 auth failures; 79.75 % of requests answered 429, 151 steps dropped after a refused retry, **`http_req_failed` 0 %**, checks 100 %; the `rate_limited` threshold crossed and k6 exited non-zero, which is the designed outcome of an over-eager scenario |
| `eslint`, `dprint`                                                                                                      | clean                                                                                                                                                                                                                                                                                                     |

Production was briefly unreachable for the seed: the API port `10001` answered
over the VPN, but `10432` (Postgres) and `10379` (session Valkey) time out
from the laptop's tunnel address `192.168.255.6` (route via `utun4`, gateway
`192.168.255.5`) until the owner opened them on 2026-09-13. What was checked on
the host, for the record: the rule has to sit in `DOCKER-USER` (published container
ports traverse `FORWARD`, so an `INPUT` rule never sees them) and above the
`LOG`/`DROP` tail (`iptables -I DOCKER-USER 1 …`); its source has to cover
`192.168.255.6`, not only the `192.168.180.0/24` side of the tunnel; and
`PSAD_BLOCK_INPUT` should not list that address, since the probes against
the closed ports look like a port scan to `psad`. `sudo tcpdump -ni any 'tcp
port 10432 or tcp port 10379'` during a retry shows whether the packets
arrive at all and with which source.

### Production check (2026-09-13)

With `10432` and `10379` open, the whole path was exercised against
production from the laptop over the VPN, using `.env.loadtest`:

| Check                                                                                                  | Result                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --users 20 --prefs`                               | 8.7 s; 20 users, 29 favourites, 12 hidden bottlings, 3 hidden producers, 9 quick filters, 10 collection rows, 17 purchases                                                                                                                                                                 |
| `GET /auth/me`, `GET /report/catalog` on `192.168.180.1:10001` with a seeded token and its `X-Real-IP` | 200 / 200, 3 146 groups, rate-limit headers present; the session records the spoofed `10.0.0.1` — the production API honours the header on its direct port                                                                                                                                 |
| k6 smoke, 20 VUs, 15 s / 75 s / 10 s, `direct` mode                                                    | 70 visits, 761 requests, **0 failed, 0 rate-limited**, 883/883 checks, every threshold green; 1 live login                                                                                                                                                                                 |
| Latency, production vs the local run                                                                   | `/meta` p95 87 ms (local 23), `/product/search` p95 91 ms (43), `/report/:kind` **median 284 ms, p95 497 ms, p99 770 ms, max 1.09 s** (local 60 / 117 / 291). The VPN adds ~50–60 ms of floor (`/meta` min 58 ms); the report median is far above that floor even at 6 requests per second |

The report latency is the first real signal, and it was split rather than
guessed at. The cache is **not** the cause: the production cache instance
reported 634 hits against 44 misses (93 %) after the smoke, 43 report
entries under the live generation, nothing evicted. Timing one warm
`GET /report/catalog?perPage=50` from the laptop with `curl` gives 110 KB,
time-to-first-byte 240–290 ms, total 380–430 ms, against a 93 ms
time-to-first-byte for the 149-byte `/auth/me`. Two conclusions:

- **The server spends ~150–200 ms on a warm catalogue page** (first byte
  minus the round trip), where `CLAUDE.md` measured ~40 ms on a development
  machine. That is H2 (one Node core doing decompress, parse, sort, page,
  transform, validate and serialise) showing up before any load is
  applied; H3 was later withdrawn, since production logs at `debug`. If it is CPU, the API serves a few catalogue pages per second per
  core and saturates well under 1000 users; the observer's per-container CPU
  is what decides between CPU and waiting.
- **The VPN is a bottleneck for the load generator, not for the server.**
  The direct port sends uncompressed JSON (no `Content-Encoding` even when
  offered; compression is nginx's job at the edge), and transfer of the 110
  KB page took ~135 ms — about 1 MB/s per connection through the tunnel.
  A thousand users at realistic think time produce on the order of 100
  report requests per second, ~11 MB/s, which a home VPN link will not
  carry; k6 on the laptop would then measure the tunnel and call it the
  server.

**Decision this forces: the nominal, miss-heavy and ceiling runs are
generated on the host itself, not over the VPN.** Section 3's "never on the
server" holds for a load generator that competes for the same cores, and the
cost is accepted knowingly: k6 at 1000 VUs with these think times is roughly
one core and under a gigabyte, the API has one event-loop thread to spend,
and the host has eight cores. The observer records k6's own container-less
CPU alongside the API's so the share is visible. Traffic to
`192.168.180.1:10001` from the host stays on the host. Procedure: install the
k6 Linux binary, `scp` `loadtest/whisky-users.js` and `users.json` over, run
with the same `-e` knobs, `scp` the summary and HTML report back. The smoke
from the laptop stays useful as a wiring check.

The 20 seeded users are left in place for the next step; `--cleanup`
removes them in one command.

### Step 3 and the run plan the owner chose (2026-09-13)

The owner decided to work from the laptop only, k6 included, judging the
home Wi-Fi's ~30 Mbit/s sufficient, and asked for one run that raises the
load step by step and shows where the response time leaves the allowed
range — about 1 s for a report the cache holds, about 2 s for one that has
to run the query. Three things changed to serve that:

- **The script grew a ladder.** `STAGES=50,100,200,300,400,500,650,800,1000`
  with `STEP_RAMP=45s` and `STEP_HOLD=2m` replaces the plateau, every
  request is tagged with the step it was made in (from the schedule, so the
  ramp-down cannot pollute a lower step) and with its expected cache class
  (`hit` for the default views, popular filter sets and search terms,
  `miss` for random combinations), and thresholds are generated per step for
  `http_req_duration` **and** `http_req_waiting` of the two classes against
  `CACHED_MAX_MS=1000` / `UNCACHED_MAX_MS=2000`. Total time is the owner's
  criterion; time to first byte is what attributes a breach to the server
  rather than to the tunnel, and `http_req_receiving` is the tunnel's own
  column. Two safety valves abort the run on a collapse (error rate above
  5 %, report p95 above 10 s, both over the run so far).
- **The observer is remote.** `loadtest/observe.sh` samples `pg_stat_activity`
  by state, waiting backends, connections and the database's commit and
  block counters, plus hits/misses, ops/s, memory and clients of both Valkey
  instances, every 5 s into a TSV, through the same VPN. It cannot see
  container CPU; a latency rise with flat database and cache numbers is
  therefore read as the API's event loop. The first sample from production:
  10 client connections (the pool), 647 cache hits to 44 misses, 5.3 MB of
  cache, 1 749 session keys.
- **The 30 Mbit/s caveat stands and is measured, not argued.** At that rate
  the tunnel carries ~34 uncompressed catalogue pages per second, which the
  ladder reaches somewhere around 300–400 users. Past that point
  `http_req_receiving` — not the server — is expected to be what pushes
  `http_req_duration` over the line, and the per-step `http_req_waiting`
  thresholds are what keep the server's own answer readable. Whether that
  happens is part of the result.

### The ceiling run (2026-09-13)

Ran 00:23–00:29 Kyiv and was ended by the `p(95)<10 s` valve twenty seconds
into the 200-user step. Fifty users were within the limits, a hundred
crossed the 1 s line for cached reports (p95 1.46 s), two hundred queued to
an 11 s p95 with zero errors while the database, the cache and the tunnel
stayed idle. Full write-up, per-step tables, hypothesis verdicts and the
recommendations: [`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md).

Next: the owner's `LOG_LEVEL=info` change, a repeat of steps 50/100/200,
then cleanup (step 5).
