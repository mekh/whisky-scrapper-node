# Page-addressable report cache

Status: **steps 1–5 done; step 6 (deploy and the production ladder) is the owner's** (2026-09-13).

Follows from the load test ([`LOAD-TEST-2026-09.md`](LOAD-TEST-2026-09.md)):
70 % of a catalogue page's CPU is spent decompressing, UTF-8-decoding and
`JSON.parse`-ing the whole cached result set — 4–6 MB of JSON for ~3 000
groups — of which the response uses fifty. The owner's requirement: **a
request must deserialise only the page it returns.** Everything else
(dropping the outgoing validation, slimming payloads, more processes) is
sized against that and comes after.

## 1. What changes, in one paragraph

A cached set stops being one blob. It becomes a small **index** — the
group ids, the producer and bottler id per group (what personalisation
tests), and one precomputed **order** per sortable field and direction,
each an array of positions — plus a Valkey **hash of the groups**, one
field per position holding that group's public JSON. A request reads the
index, walks the chosen order skipping the caller's hidden bottlings and
makers (which also yields `total`), takes the fifty positions of the page,
fetches exactly those fifty fields with `HMGET`, and parses fifty small
strings. The database is asked for nothing on a hit, as today; the event
loop parses ~150 KB instead of 4–6 MB.

## 2. Layout

Same key prefix as today (`cache:report:g<generation>:<kind>:<day>:<hash>`),
two keys per set:

| Key     | Type                        | Content                                                                                                                                                               | Size, full catalogue                                                  |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `…:idx` | string, existing gzip codec | `{ ids, producers, bottlers, orders }` — `orders` holds `natural` plus `<field>:<asc\|desc>` for the eleven `ReportSortField`s, each an array of positions into `ids` | ~500 KB raw, ~150 KB gzipped                                          |
| `…:grp` | hash                        | field `"<position>"` → the group's **public** JSON (`producerId`/`bottlerId` already stripped — they live in the index)                                               | ~5 MB, uncompressed (values are 1–2 KB, under the codec's gzip floor) |

Both carry the entry TTL. Positions are stable for the life of the set: the
set is immutable under its generation, and a bump makes both keys
unreachable together, exactly as one blob is today.

Order semantics are the current `sort()` + `compare()` verbatim: numbers
numerically, strings case-insensitively by `localeCompare`, **nulls last in
either direction**, ties broken by id ascending. Both directions are stored
rather than derived by reversing, because reversing would flip the tie
order and put nulls first.

## 3. Read and write paths

`ReportService.report`:

1. In parallel: the caller's filter ids (`findFilterIds`, as today) and
   the set's index from the cache.
2. Hit: `ReportPageUtils.select(index, preferences, favoritesOnly, options)`
   walks `orders[<sort>:<order>]` (or `natural`), skips a position whose
   product is hidden or whose producer/bottler is a hidden maker, keeps
   only favourites when asked, counts the survivors (`total`) and collects
   the positions of the requested page. The cache then `HMGET`s those
   fields and decodes them. Any missing field — a hash that expired or
   was evicted apart from its index — is a miss, and both keys are dropped.
3. Miss: `buildGroups` as today, `ReportPageUtils.buildIndex(groups)`, one
   pipelined write (`SET idx`, chunked `HSET grp`, `EXPIRE` both), and the
   page is served from the in-memory groups **through the same `select`**,
   so hit and miss share one selection implementation and cannot drift.
4. Bypass (cache disabled, generation unreadable, bump pending): build and
   `select` in memory — the same code path as a miss without the write.

The generation is still read **before** the loader runs, and the counters
(`hits`/`misses`/`bypasses`/`errors`) keep their meaning; this is a new
storage shape inside `VersionedCacheService`, not a second cache. `/meta`
keeps using the blob form (`getOrCompute`), which is right for a 20 KB
payload read whole.

## 4. Pieces

- `~utils/report-page.util.ts` — `ReportPageUtils`: `buildIndex(groups)`,
  `orderKey(sort, order)`, `select(index, prefs, favoritesOnly, options)`.
  Pure and unit-tested by **equivalence**: for generated sets with nulls,
  ties, both directions, every sort field, hidden products, hidden makers
  in either slot and `favoritesOnly`, the page and `total` must equal what
  the current `personalize` → `sort` → `slice` produces.
- `~types`: `ReportPageIndex`, `CacheIndexedSet<I, E>`, `CachePagePick`,
  `CachePage<E>`.
- `VersionedCacheService.getPage(ref, generation, loader, pick)` — reads
  the index, calls `pick`, fetches the fields; on a miss runs the loader,
  stores, and picks in memory. A new cap, `CACHE_MAX_SET_BYTES` (default
  32 MiB, the index plus every field, uncompressed), replaces
  `maxEntryBytes` for sets; past it the set is served and not stored, with
  a warning, as today. Deadline, error-as-miss and the bump-pending bypass
  apply unchanged.
- `ReportService.report` wired to `getPage`; `personalize`, `sort` and
  `compare` move into the utils (their tests move with them).
- Config/env/docs: `CACHE_MAX_SET_BYTES` in `CacheConfig`, `.env.example`,
  the compose `environment` block, the `CLAUDE.md` "Catalogue cache"
  section (what is cached, what a request does), `VALKEY-CACHE-PROD.md`
  (memory per set grows ~10×: ~5 MB for the full catalogue against ~0.4
  MB; ~100 sets a day fit well under the 976 MB `maxmemory` with LRU, and
  `evicted_keys` is the number to watch).

## 5. Expected effect, and what it does not fix

Per page, locally: ~35 ms → **~3–5 ms** of CPU (index decode ~1.5 ms, walk
< 0.5 ms, fifty parses < 1 ms, the untouched DTO pipeline ~5 ms). Twice as
many Valkey round trips per hit (index + fields, ~1 ms each over the
docker network) — negligible against what is removed. On the host, the
ceiling should move from ~100 users to several hundred on the same single
thread; the repeat of steps 50/100/200/300 says by how much.

What remains afterwards, in order: the outgoing `plainToInstance` +
`validateOrReject` over fifty groups (14 % of the old cost, now the largest
share), then more processes. The index itself could later be memoised per
generation in the process — it is immutable — but that is an optimisation
on top of this shape, not a prerequisite.

Rejected for this step: an in-process cache of the decoded set (keeps the
whole-catalogue work per request in the process and per process; the
owner's requirement is page-level deserialisation), and SQL `LIMIT/OFFSET`
(the database still evaluates the full join and both LATERAL probes per
page, personalisation would have to go back into SQL, and the set-based
kinds — `drops`, `low`, `new`, `best` — are set-based by nature).

## 6. Checkpoints

| # | Step                                                                                                                                                                                                                                                | Gate                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `ReportPageUtils` + interfaces, with the equivalence tests against the current `personalize`/`sort`/`slice`                                                                                                                                         | unit tests green; the equivalence test covers every sort field, both directions, nulls, ties, both maker slots, `favoritesOnly`, page bounds | **done 2026-09-13** — `src/utils/report-page.util.ts`, `ReportPageIndex`/`ReportOrderKey`/`CachePagePick` in `~types`, `test/report-page.util.spec.ts`: 15 tests, among them 600 generated cases (0–70 groups, 20 % nulls, deliberate ties, random blacklists in both maker slots, `favoritesOnly`, pages 1–5 of 3/5/7/50) producing the same page and `total` as the legacy oracle kept verbatim in the test                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2 | `VersionedCacheService.getPage`, `CACHE_MAX_SET_BYTES`, unit tests (miss stores idx+hash and picks in memory; hit `HMGET`s exactly the page's positions and never reads a blob; partial hash → miss + drop; cap → bypass; disabled → loader + pick) | `pnpm test` green, existing cache tests untouched                                                                                            | **done 2026-09-13** — `getPage` reads the `:idx` blob through the existing codec, `pick`s, then `HMGET`s exactly the page's fields from the `:grp` hash; a miss writes both in one pipeline (chunked `HSET`, both with the TTL) under a deadline four times the read one; a hash lacking an entry or holding an undecodable one is dropped whole and rebuilt, while a failed `HMGET` is a plain miss that drops nothing; `CACHE_MAX_SET_BYTES` (32 MiB, index plus uncompressed entries) refuses to store, not to serve. Nine new unit tests over a fake client that grew hashes and pipelines; 14 existing cache tests unchanged; the passthrough stub other suites use gained `getPage`                                                                                                                                                                              |
| 3 | `ReportService.report` on `getPage`; dead code removed; report tests adapted                                                                                                                                                                        | `pnpm test`, `pnpm test:integration` green (`report-cache`, `preference-report`, `report-group`, `kb-report`)                                | **done 2026-09-13** — `report()` starts the preference read, asks the cache for the page with an async picker that awaits it, and returns `page.entries`/`page.total`; `buildSet` replaces `cachedGroups` and stores groups in their public shape (maker ids live in the index); `personalize`, `sort` and `compare` are gone from the service (their semantics live in `ReportPageUtils`, pinned by the equivalence test). No test needed adapting: unit 1162/1162, integration 206/206                                                                                                                                                                                                                                                                                                                                                                               |
| 4 | Local perf gate: the profile replay (4 VUs, 60 s, limiter off) before/after                                                                                                                                                                         | ≥ 3× requests per second; `CacheCodec.decode` + `Buffer.toString` under 10 % of busy CPU                                                     | **done 2026-09-13** — same replay, same laptop, same database copy: **28 → 113 requests/s (4.0×)**, median **141 → 34 ms**, CPU per page **~35 → ~8.5 ms**; the event loop sat idle 49 % of the time, so four closed-loop users no longer saturate it and the true ceiling is above 113/s. Decoding (index blob + fifty groups: `lib/cache` 9.9 %, `node:buffer` 2.7 %, `zlib` 1.0 %) fell from ~19 ms to ~1.1 ms per request — 18× less in absolute terms; its share is 12.6 % rather than under 10 % only because everything else shrank around it. What remains: `class-validator` 40 % + `class-transformer` 15 % — the outgoing DTO pipeline is now more than half of every page — GC 12 %, `ReportPageUtils` 3 %. Stored shape verified: `:idx` 125 KB gzipped, `:grp` hash of 3 137 fields, ~5.7 MB in Valkey, TTL set, maker ids absent from the stored groups |
| 5 | Config, env, compose, `CLAUDE.md`, `VALKEY-CACHE-PROD.md`                                                                                                                                                                                           | lint/format clean; every new variable in `.env.example` and the compose block                                                                | **done 2026-09-13** — `CACHE_MAX_SET_BYTES` in `.env.example` and the compose `environment` block; `CLAUDE.md` "Catalogue cache" describes the two-key set, the request path and the measured effect, and its config list names the variable; `VALKEY-CACHE-PROD.md` sizing rewritten for ~5.7 MB per full-catalogue set with the two new log lines; `LOAD-TEST-2026-09.md` carries the before/after table                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6 | Deploy (owner) and repeat the ladder 50/100/200/300 with the observer                                                                                                                                                                               | rows appended to `LOAD-TEST-2026-09.md` beside the originals                                                                                 | pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Each checkpoint ends with a report and a stop; the next starts on explicit
permission.

## 7. Progress log

### Steps 1–4 (2026-09-13)

Built and verified locally; nothing deployed yet. The local replay that
profiled the problem (four closed-loop users over `GET /report/catalog`,
pages 1–5, four sort orders, rate limiter off, production database copy)
is the before/after instrument:

|                                                              | Before        | After              |
| ------------------------------------------------------------ | ------------- | ------------------ |
| Requests per second (4 VUs, closed loop)                     | 28            | **113**            |
| Median request                                               | 141 ms        | **34 ms**          |
| CPU per page                                                 | ~35 ms        | **~8.5 ms**        |
| Event loop idle during the replay                            | 26 %          | 49 %               |
| Decoding the cached data, per request                        | ~19 ms (70 %) | ~1.1 ms (13 %)     |
| Outgoing `plainToInstance` + `validateOrReject`, per request | ~5 ms (14 %)  | ~4.7 ms (**55 %**) |

The stored shape for the unfiltered catalogue: an index of 125 KB gzipped
(3 137 ids, producer and bottler ids, 23 orders) and a hash of 3 137 public
groups, ~5.7 MB in Valkey — against ~0.4 MB for the blob it replaces, as
the plan predicted. Profiles, replay script and aggregator are archived
beside the load-test run in `loadtest/out/20260913-0020/`
(`profile-local-catalog.cpuprofile` before, `…-after.cpuprofile` after).

Two things the profile settles for what comes next. The outgoing DTO
pipeline is now more than half of every page and is the obvious next cut.
And the remaining decode is the index — immutable per generation, so an
in-process memo of it would remove most of the 13 % that is left, an
optimisation on top of this shape rather than a change to it.
