# Load test

k6 scenario that plays a population of seeded users against the API, plus
the seed that creates them. The plan, the reasoning behind every choice and
the results live in [`docs/LOAD-TEST-PLAN.md`](../docs/LOAD-TEST-PLAN.md);
this file is the operating manual.

## Prerequisites

- `k6` ≥ 1.0 on the machine that generates load (`brew install k6`). Never
  run it on the host under test — its CPU would compete with the API.
- Network reach to the API port (`direct` mode), and for the seed to the
  host's Postgres **and session Valkey** ports. Against production that is
  the VPN plus a `DOCKER-USER` rule for the load generator's address.
- For another environment than `.env` describes: `.env.loadtest`, copied
  from [`.env.loadtest.example`](../.env.loadtest.example) and filled in.

## 1. Seed the users

```bash
# Local dev stack (.env)
pnpm loadtest:seed --users 20 --prefs

# Production over the VPN (.env.loadtest)
DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --users 1000 --prefs
```

Writes `loadtest/users.json` (git-ignored, mode `0600`): one entry per user
with its id, name, spoofed address and a live access/refresh pair. Options:

| Flag                 | Meaning                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--users <n>`        | How many users (default 1000, max 10000).                                                                                                             |
| `--prefs`            | Give 30 % of them favourites, 15 % blacklist entries, 20 % quick filters and 10 % collection rows with purchases, so personalised reads do real work. |
| `--access-ttl <sec>` | Sign the access tokens with this lifetime instead of `JWT_ACCESS_EXPIRES`. Needed for `edge` mode, where refresh is impossible from one address.      |
| `--prefix <p>`       | Name prefix, default `loadtest-`; at least five characters.                                                                                           |
| `--out <file>`       | Output path, default `loadtest/users.json`.                                                                                                           |
| `--cleanup`          | Delete every user carrying the prefix and revoke their sessions. Everything they own cascades.                                                        |

The seed refuses to run while users with the prefix exist — run `--cleanup`
first. Login resolves accounts by name and `user.name` is not unique, so a
second population under the same names would be ambiguous.

## 2. Run

```bash
# Smoke, local
k6 run -e BASE_URL=http://127.0.0.1:4000 -e VUS=20 \
  -e RAMP_UP=15s -e HOLD=75s -e RAMP_DOWN=10s loadtest/whisky-users.js

# Nominal, production, direct mode, with the live dashboard and an HTML report
mkdir -p loadtest/out/$(date +%Y%m%d-%H%M)
K6_WEB_DASHBOARD=true \
K6_WEB_DASHBOARD_EXPORT=loadtest/out/$(date +%Y%m%d-%H%M)/report.html \
k6 run --summary-export loadtest/out/$(date +%Y%m%d-%H%M)/summary.json \
  -e BASE_URL=http://192.168.180.1:10001 -e VUS=1000 \
  loadtest/whisky-users.js
```

The dashboard is at `http://127.0.0.1:5665` while the run lasts. The
`users.json` path is resolved **relative to the script's folder**, not the
working directory (k6's `open()` semantics); pass an absolute `USERS_FILE`
to use another file.

### Knobs (`-e NAME=value`)

| Variable                            | Default                 | Meaning                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`                          | `http://127.0.0.1:4000` | The API. `direct` mode is its published port; `edge` mode is the nginx origin plus `/api`.                                                                                                                                                                                                                                  |
| `SPOOF_IP`                          | `true`                  | Send each user's own `X-Real-IP`. Only works against the API port — nginx overwrites the header. Set `false` in `edge` mode.                                                                                                                                                                                                |
| `VUS`                               | `1000`                  | Concurrent users at the plateau. Seed at least this many.                                                                                                                                                                                                                                                                   |
| `RAMP_UP` / `HOLD` / `RAMP_DOWN`    | `3m` / `20m` / `2m`     | Stage durations.                                                                                                                                                                                                                                                                                                            |
| `THINK_MIN` / `THINK_MAX`           | `3` / `12`              | Seconds a user reads between actions.                                                                                                                                                                                                                                                                                       |
| `THINK_SCALE`                       | `1`                     | Multiplies every pause. The ceiling run steps it down (`0.5`, `0.25`, `0.1`) rather than adding users, so the population and its per-account limits stay real.                                                                                                                                                              |
| `POPULAR_SHARE`                     | `0.6`                   | Share of filter visits using one of the popular filter sets; the rest draw random combinations that mostly miss the cache. `0` gives the miss-heavy run.                                                                                                                                                                    |
| `LOGIN_SHARE`                       | `0.03`                  | Share of visits that log in again with the seeded password. Forced to `0` when `SPOOF_IP=false`.                                                                                                                                                                                                                            |
| `WRITES`                            | `false`                 | Enable the writer persona (favourite on, favourites-only read, favourite off). Off by default against production.                                                                                                                                                                                                           |
| `USERS_FILE`                        | `./users.json`          | The seed's output.                                                                                                                                                                                                                                                                                                          |
| `STAGES`                            | unset                   | A ladder of user counts, e.g. `50,100,200,400,700,1000`. Each step ramps for `STEP_RAMP` (default `45s`) and holds for `STEP_HOLD` (default `2m`); replaces the `VUS` plateau. Every request is tagged `stage:<count>`, and the summary prints the report percentiles per step, so it states where the limits were crossed. |
| `CACHED_MAX_MS` / `UNCACHED_MAX_MS` | `1000` / `2000`         | The p95 limits for a report the cache is expected to hold (`cache:hit`) and for one that has to run the query (`cache:miss`). Applied to total time and to time-to-first-byte, overall and per step.                                                                                                                        |

### What a visit is

Every iteration is one visit by one user (VU _n_ plays user _n_): the page
load the SPA performs (`/auth/me`, `/meta`, the first catalogue page,
`/preference`, `/collection/ids`, `/quick-filter`, `/currency`,
`/currency/rate/latest`, in parallel), a think, then one persona:

| Persona   | Weight  | Does                                                                                                                                   |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| browser   | 30      | Pages 2–5 of the catalogue with a common sort                                                                                          |
| filterer  | 25      | A filter set (popular or random), 1–3 pages, mostly `catalog`, sometimes `drops`/`best`                                                |
| searcher  | 15      | Types a brand into `/product/search` three characters at a time, opens the matching catalogue rows, then one offer's `/report/history` |
| deals     | 15      | Two or three of `drops`, `new`, `best`, `low`                                                                                          |
| dashboard | 8       | `/dashboard/meta`, then summary, series, breakdown and movers for the last 30 days in parallel                                         |
| collector | 5       | `/collection` and `/collection/stats` in a random currency                                                                             |
| writer    | 2 (off) | Favourite one bottling, read `favoritesOnly`, unfavourite                                                                              |
| login     | 3       | `POST /auth/login` with the seeded password                                                                                            |

Access tokens are refreshed through `/auth/refresh` 60 s before they expire.
The refresh cookie is `Secure`, which k6's jar would withhold over plain
HTTP, so the script carries it by hand.

### The ceiling run

```bash
RUN=loadtest/out/$(date +%Y%m%d-%H%M); mkdir -p "$RUN"
ENV_FILE=.env.loadtest loadtest/observe.sh "$RUN/observer.tsv" &
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT="$RUN/report.html" \
k6 run --summary-export "$RUN/summary.json" \
  -e BASE_URL=http://192.168.180.1:10001 \
  -e STAGES=50,100,200,300,400,500,650,800,1000 \
  -e STEP_RAMP=45s -e STEP_HOLD=2m -e RAMP_DOWN=1m \
  loadtest/whisky-users.js
kill %1
```

Two safety valves end the run early against a production target: an
error rate above 5 % or a report p95 above five times `UNCACHED_MAX_MS`,
both evaluated over the run so far after a grace period.

### Reading the result

- **`rate_limited`** is the share of requests the API answered `429`. It is
  not a failure — the script waits the stated `X-RateLimit-Retry-After-Ms`
  and retries once, as the web client does — and it is not a server fault
  either: above ~1 % it means the scenario is more eager than the API's
  per-account limits, so slow it down before reading anything else.
- **`http_req_failed`** excludes 429 and is the real error rate.
- **`http_req_waiting` is the server, `http_req_receiving` is the link.**
  Time-to-first-byte is the API's own time plus one round trip; the receive
  time is the transfer of the (uncompressed, on the direct port) body. When
  the second grows while the first stays flat, the load generator's network
  is saturating, not the server — the 110 KB catalogue pages make this the
  first thing to check on a VPN.
- **`cache:hit` / `cache:miss`** is the _expected_ class of a report request
  — the default views, the popular filter sets and the search terms count as
  hits, random filter combinations as misses — not what the server did. The
  observer's `cache_hits`/`cache_misses` columns are the truth.
- **`stage:<n>`** is which step of the ladder the request was made in, taken
  from the schedule rather than the live VU count, so the ramp-down cannot
  pollute a lower step.
- Latency is tagged by route template (`GET /report/:kind`,
  `GET /product/search`, …), never by full URL, so the summary stays
  readable under a thousand distinct filter strings.
- `auth_logins`, `auth_refreshes`, `auth_failures` count the auth traffic;
  `persona_visits` counts visits per persona (tag `persona`).
- The thresholds in the script are the initial pass/fail line and are tuned
  after the smoke run; k6 exits non-zero when one fails.

## Observer

`loadtest/observe.sh <out.tsv>` samples Postgres (`pg_stat_activity` by
state, waiting backends, connections, `xact_commit`, block reads/hits) and
both Valkey instances (keyspace hits/misses, ops/s, memory, clients, keys)
every `INTERVAL` seconds (default 5) into a TSV, reading the connection
details from `ENV_FILE` (default `.env.loadtest`). It runs on the load
generator over the VPN, which is why it sees no container CPU: a latency
rise with flat database and cache numbers is the API's own event loop, and
that inference is the best a remote observer can offer.

## 3. Clean up

```bash
DOTENV_CONFIG_PATH=.env.loadtest pnpm loadtest:seed --cleanup
```

Deletes the users, cascades their preferences, quick filters and collection
rows, and revokes their sessions. Idempotent.
