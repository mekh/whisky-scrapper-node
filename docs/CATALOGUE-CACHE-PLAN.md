# Backend-side catalogue cache — analysis, alternatives and plan

## Execution protocol (owner's instructions, 2026-09-10)

These rules govern how the plan below is carried out and override any default
working style.

1. **The plan lives in the repository.** Step 0 of execution is to save this
   document verbatim as `docs/CATALOGUE-CACHE-PLAN.md` (English only, as every
   document in the repository), and every later step keeps it current: a
   checkpoint is marked done in that file when it is reported.
2. **Model.** Execution runs on **Opus 5** — selected by the owner in the
   app's model picker before the first step starts. **Every sub-agent is
   launched on Sonnet 5** (`model: "sonnet"` on each `Agent` call), never on
   anything else; a sub-agent is used only for read-only exploration or
   review, never to write code.
3. **One checkpoint at a time.** After each checkpoint below is finished and
   verified, report to the owner: which step was completed (with the
   verification that was run and its outcome), and what the next step will
   do. Then **stop**. The next checkpoint starts only after the owner's
   explicit permission. No step is begun on the assumption that permission
   will come.
4. **Nothing is committed or pushed** without the owner's explicit
   per-request authorization (the standing git rule); hooks are never
   bypassed.

### Checkpoints

| # | Checkpoint                                                                                                                                                                                 | Maps to         | Ends with                                                                            | Status          |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------ | --------------- |
| 0 | Save this plan as `docs/CATALOGUE-CACHE-PLAN.md`                                                                                                                                           | —               | report, pause                                                                        | done 2026-09-10 |
| 1 | Query rewrite: `CURRENT_SQL` → LATERAL, `latestDate`/`priceExtremes` on `capturedOn`, `currentPriceSince` per-offer; old-vs-new equivalence integration test; sanity `EXPLAIN`             | Phase 1         | `pnpm lint && pnpm build && pnpm test && pnpm test:integration` green; report, pause | done 2026-09-10 |
| 2 | Personalization out of SQL: `ReportPersonalization`, `findFilterIds`, maker ids on the internal row, public wire types, controller split, unit + integration specs                         | Phase 2         | same gate; report, pause                                                             | done 2026-09-10 |
| 3 | Cache foundation: `TransactionUtils.afterCommit`, `CacheConfig` + interfaces + constants, `lib/cache` with its own `iovalkey` client, codec, boot bump, unit specs; compose env forwarding | Phase 3.0-3.1   | `pnpm test` green, boot log shows the bump; report, pause                            | done 2026-09-10 |
| 4 | Bump points: persist, KB reconcile, product update/relink, store `setActive`, scripts; service specs assert the bumps                                                                      | Phase 3.2       | `pnpm test` green; report, pause                                                     | done 2026-09-10 |
| 5 | Reads through the cache: `ReportCacheKeyUtils`, `ReportService`, `MetaService`; key-canonicalization spec; `report-cache.integration.spec.ts`                                              | Phase 3.3 + 3.6 | full gate green plus the manual `valkey-cli` sequence from Part 6; report, pause     | done 2026-09-11 |
| 6 | Observability: `CacheStats` on the heartbeat, cache ping, bump log lines                                                                                                                   | Phase 3.4       | `pnpm test` green, heartbeat line shows the cache segment; report, pause             | done 2026-09-11 |
| 7 | Docs and ops: CLAUDE.md section and updates, `docs/VALKEY-CACHE-PROD.md`, plan document marked complete                                                                                    | Phase 4         | review by the owner; done                                                            | done 2026-09-11 |

## Context

The owner asked for a full backend-side cache of the catalogues, stored in
Valkey, invalidated **only** when a catalogue-related table is written (no
TTL, delete-on-write). This document analyses that proposal against the code
as it stands, surveys how real projects solve the same problem, lays out the
alternatives (full and partial), and ends with a recommended, phased plan.

"Catalogue" here means `GET /report/:kind` for the five kinds
(`catalog | drops | low | new | best`) plus the `GET /meta` payload the client
needs to render them. `GET /report/history`, `GET /product/search` and
`GET /brand/search` are single-row or autocomplete reads with free-text keys
and are out of scope.

### Decisions taken by the owner (2026-09-10)

- **Store**: the cache has its **own Valkey connection config** (`CACHE_VALKEY_*`).
  Whatever instance it points at is the cache: a dedicated instance in
  production, the sessions' instance in development. Configurability is the
  requirement; the dedicated instance is the recommended production value.
- **TTL ≈ 24 h is accepted as garbage collection**, not as the freshness
  mechanism (the generation counter is).
- **Order**: build everything — the query rewrite, the personalization move
  and the cache — in one stream. No measurement gate now: there is no load to
  measure under, but filtering a catalogue is already perceptibly slow, and
  every filter change is a browser-cache miss, so the rewrite is what makes
  _filtering_ fast and the cache what makes _repeat views_ fast. Measuring
  happens once there is load to measure.
- **Scope**: `/report/:kind` (all five kinds) and `/meta`.

### Where the cost actually is (verified in code, not assumed)

- Every `/report/:kind` request runs **two full scans of `price_snapshot`**
  (~422k rows, FOLLOWUPS.md item 4): `CURRENT_SQL`'s `ranked` window CTE
  (`src/core/store-product/store-product.repository.ts:51-99`) that finds the
  latest snapshot and previous price of each of ~8.4k offers, and
  `latestDate()` = `SELECT MAX("createdAt"::date)`
  (`src/core/price-snapshot/price-snapshot.repository.ts:166-172`) whose cast
  defeats every index. `drops` adds `priceExtremes` (cast again, seq scan) and
  the parameterless three-pass `currentPriceSince()` (lines 181-231). The whole
  matching set is then grouped, sorted and paginated in JavaScript
  (`src/domain/report/report.service.ts:47-59`), so page 2 costs what page 1
  costs.
- **The expensive part is user-independent.** The only per-user work is three
  cheap `NOT EXISTS` predicates (blacklist by bottling, blacklist by producer
  on both slots, `favoritesOnly`) at `store-product.repository.ts:385-400`,
  and all three are bottling-level: "a group is either wholly present or
  wholly gone" (repo doc, lines 296-300).
- `new` and `drops` read the **real UTC date** (`report.service.ts:724-726`):
  `daysNew`, `daysDiscount` and the `today|yesterday` windows change at
  midnight with no database write. `catalog`, `low`, `best` never read the
  clock; their window cutoff is data-derived (`cutoff()`, lines 735-742).
- Writers: `ScrapePersistService.persist` (one `@Transactional()` per store,
  minutes long, up to 4 concurrent, ~20 per daily cron run; its `persisted`
  reporter event at line 233 fires **inside** the transaction);
  `ProductService.update`/`relink`; `KbReconcileService.run` (three
  autocommits, **not** transactional; called inline by four review endpoints,
  by `KbBootApplyService` at **every boot**, and by `pnpm reconcile-flavors`);
  `StoreService.setActive` (only `/meta` shows `active`; `CURRENT_SQL` does not
  filter on it); preference mutations (per-user tables); and **out-of-process**
  writers with no in-app hook — seven `scripts/*.ts` (`backfill` runs the whole
  persist path in its own process) and the 17 catalogue data migrations that
  `dist/scripts/migrate.js` applies at deploy **while the old app still serves**
  (`scripts/deploy.sh:40-44`).
- Valkey today: one `iovalkey` client (`src/lib/valkey/valkey.module.ts`),
  2 s command timeout, db 0 shared with auth sessions (which are
  **fail-closed**: `AuthSessionService.has()` rethrows, and a _missing_ key
  triggers `revokeAll(userId)` + 401) and the login throttle (fail-open).
  Sessions are stored with `PXAT`, so they are "volatile" keys. No
  `maxmemory`, no eviction policy → default `noeviction`; RDB + AOF on. No
  `@nestjs/cache-manager`, no event bus, no TypeORM subscribers, no pub/sub.
  `runOnTransactionCommit` (typeorm-transactional 0.5.0) is available but
  unused; it **throws** outside an `@Transactional()` context and fires via
  `setImmediate` strictly after COMMIT.
- The browser already caches every catalogue read for 10 minutes
  (`private, max-age=600`), and the web client busts it after every
  report-affecting mutation with `forceFreshWindow()` + `markReportsStale()`
  (`../web/src/shared/api/fetcher.ts:138-186`) and when `sync-status` reports
  a run finished.
- Single-instance deployment (`src/app/rate-limit/rate-limit.store.ts:12-27`).
  A handful of user accounts.

## Part 1 — the proposal as stated: pros and cons

### Pros

- **Right shape of workload.** Writes are rare and batched: one daily sync
  burst, occasional manual syncs, rare curation edits. The data is stable for
  ~23 hours a day — the textbook case for write-triggered invalidation.
- **No staleness window.** A new price is visible on the first request after
  the sync commits, which is what a user pressing "sync" and reloading expects.
- **Skips the heavy statements entirely on a hit.** A Valkey `GET` is sub-ms
  on the same host.
- **Survives restarts, shared across a user's devices** — the two things the
  browser cache cannot do.
- **Valkey is already wired**, with bounded timeouts and a documented
  single-client invariant.

### Cons and traps (each verified against this codebase)

1. **Per-user keys collapse the hit rate.** The blacklist predicates are
   unconditional and user-scoped, so a response cache keys on `userId ×
   kind × filters × sort × page`. With a handful of users every entry serves
   one browser — which already holds a private copy for 10 minutes. Worse,
   the invalidation triggers are the same set the client already busts on, so
   the server cache misses in exactly the situations the browser misses. A
   user paging 1→2→3 mints three keys, each a full recompute. Expected hit
   rate on the literal design: well under 50 %; ~0 during the sync window.
2. **Delete-on-write has a well-known race** (the "stale set" of Nishtala et
   al., _Scaling Memcache at Facebook_, NSDI 2013):
   ```
   T0 persist(S) begins (minutes)
   T1 GET /report/catalog → miss → query sees pre-persist rows (READ COMMITTED)
   T2 persist commits → DEL report:*   (nothing to delete yet)
   T3 request from T1 finishes → SET report:… = pre-persist payload
   T4 no write for ~24 h → stale prices served to everyone until tomorrow
   ```
   Hooking the flush to the `persisted` reporter event makes it worse: it
   fires pre-commit, so a reader after the flush and before the commit
   repopulates with stale data _deterministically_. Generation keys read
   before the query make this harmless (see Part 3 F).
3. **No TTL + persistent Valkey + out-of-process writers = stale forever.**
   Deploy migrations, the boot KB pass, `pnpm backfill`/`enrich-flavors`/
   `reconcile-flavors`/… and hand-run SQL all change catalogue rows with no
   in-app hook. A boot-time flush covers what happened while the app was down;
   nothing but a TTL (or a DB-side signal) covers a script against a live app.
4. **Midnight rollover.** `new` and `drops` change content at UTC midnight
   (02:00/03:00 Kyiv) with no write; the cron writes at 12:00 Kyiv, so the
   morning view would be wrong every day.
5. **Unbounded key space in the sessions' Valkey.** `name` is free text,
   prices are free numbers, pages and sorts multiply everything. With no TTL
   the instance grows until OOM. **No eviction policy protects the
   sessions**: `noeviction` → every `SET` fails, so login/refresh fail;
   `allkeys-*` → a session key gets evicted → `has()` false → `revokeAll` →
   the user is logged out of every device; `volatile-*` → sessions have
   `PXAT`, so they are candidates too. A logical `db` number does not help
   (`maxmemory` is per instance). Only a separate instance (or no Valkey for
   payloads) isolates sessions.
6. **A second Valkey dependency ahead of the DB on the hottest read.** The
   2026-08-30 outage was a fail-closed Valkey lookup. A cache read must be
   fail-open with its own deadline — and then "fail-open reads, no-TTL
   entries, best-effort DEL" is internally inconsistent: a `DEL` that fails
   leaves an entry stale forever. Fail-open only makes sense with a TTL.
7. **Granularity can only be global.** A report page mixes every store and
   bottling; `mergeInto` deletes `product` rows. Nothing finer than "flush all
   catalogue entries" is honest, which means the cache is cold ~20 times in
   the sync window and after every (frequent) deploy.
8. **Hits still pay the wire layer.** `@Paginated` runs `plainToInstance`
   inside the handler and `ValidationInterceptor` re-validates the page on
   the way out. A `JSON.parse` of a multi-MB payload also blocks the loop.
9. **Hidden couplings.** `persisted` fires pre-commit; `KbReconcileService`
   is three autocommits (a reader between statements caches a half-applied
   KB); review endpoints write then reconcile in separate autocommits.

## Part 2 — how real projects do this

- **Cache-aside with TTL** — the default pattern in Redis' own tutorials. TTL
  alone is wrong when the owner expects a sync to be visible immediately, but
  TTL as _garbage collection_ is present even in event-invalidated systems.
- **Key-based expiration / generation keys** — DHH, "How key-based cache
  expiration works" (2012); Rails `cache_key_with_version`; Redis "namespace
  versioning". Nothing is deleted; the key embeds a version that changes on
  write, old entries age out. O(1) invalidation, no `SCAN`+`DEL`, and it
  sidesteps the stale-set race when the version is read before the query.
- **Post-commit hooks** — Rails `after_commit`, Django
  `transaction.on_commit`, `typeorm-transactional`'s `runOnTransactionCommit`:
  the standard answer to "invalidate after the transaction, not inside it".
- **Leases / single-flight** (Facebook memcache; Go `singleflight`) against
  stampedes when a hot key expires. Optional at this user count.
- **Surrogate keys / cache tags** (Fastly, Varnish, Drupal, Next.js
  `revalidateTag`) for fine-grained purges — not useful here (granularity is
  global anyway).
- **CDC (Debezium → Kafka) or Postgres `LISTEN/NOTIFY` from statement
  triggers** for writers the app cannot see. `NOTIFY` delivers at commit and
  dedups identical notifications within a transaction — the right semantics
  for free; the cost is a pinned listener connection and trigger DDL.
- **Read models / materialized views** (CQRS-lite) — precompute the expensive
  derivation once, transactionally, cache nothing. The common e-commerce
  catalogue shape when the expensive part is a derivation over history.
- **Personalization outside the cache** — cache the shared data, apply
  per-user filters at request time (Shopify's storefront caching keeps
  customer data out of the cacheable catalogue layer; every CDN does the
  same). Possible whenever personalization is a cheap post-filter — as here.
- **Never mix a cache and sessions under one eviction policy** — standard
  Redis operational advice; the two have opposite loss semantics.

## Part 3 — alternatives, full and partial

### A. Query rewrite only (no cache) — do this first regardless

Drive from in-stock `store_product` and fetch the latest and previous
snapshot per offer with `LATERAL` subqueries using the existing
`(storeProductId, createdAt)` index (`ORDER BY "createdAt" DESC, id DESC
LIMIT 1`, and a second lateral for the row before it). Semantically identical
to `ROW_NUMBER() = 1` + `LEAD(price)`: ties are impossible in practice (one
row per offer per day, `createdAt` never rewritten), single-snapshot offers
yield `NULL` in both forms, out-of-stock offers are covered because the
driving set is parameterised (`findCurrentRowById`,
`findCurrentRowsByProductIds`). Also `latestDate()` → `MAX("capturedOn")`
(index-only) and `priceExtremes` → `"capturedOn" >= $1` (index range; the two
columns agree on 100 % of rows, FOLLOWUPS item 4). `currentPriceSince` →
per-offer lateral, or memoized per generation (the one place a cache is
unarguably honest: user-independent, changes only on persist).

Effect: ~8.4k × 2 index probes instead of sorting 422k rows; **flat as
history grows** (the window form degrades linearly, ~8k rows/day). Expected
seconds → tens to low hundreds of ms. Zero invalidation problem, reversible by
reverting a constant. Effort 1.5-3 days including an old-vs-new SQL
equivalence test on the integration fixture.

### B. Current-offer read model (columns on `store_product`)

`currentPrice`, `currentOldPrice`, `previousPrice`, `currentCapturedOn`,
`promo`, `currency` maintained by `upsertForDate` inside the persist
transaction (rule: new day row → `previous := current, current := new`;
same-day conflict → `current := new`, `previous` untouched), backfilled once
from history. Transactionally consistent, zero invalidation. Columns live on
the offer, so `mergeInto`/regroups move them for free. Drift risk from any
direct `price_snapshot` writer unless a trigger maintains them. Does not help
`drops`/`low` (they still need history). Effort 3-5 days; touches the most
sensitive transaction in the system. Escalation if A measures short — unlikely
at 8.4k offers.

### C. Materialized view of the snapshot-derived columns only

`store_product_current` MV (unique on `storeProductId`) refreshed
`CONCURRENTLY` after each persist commit (and from `pnpm backfill`, same code
path). Joins to product/producer/type/country/flavor stay live, so KB,
curation, merges, migrations and preferences need **no** invalidation — the MV
depends only on `price_snapshot`, which only persist writes. Cost: ~20
full-recompute refreshes (seconds each) per sync run, serialised against each
other (coalesce or advisory-lock), hand-written migration, "a snapshot-writing
migration must refresh" as a documented obligation. Keeps the O(N log N) work,
moves it off the request path. Effort 2-3 days. What you do if A measures badly.

### D. Postgres `LISTEN/NOTIFY` as invalidation transport

Statement-level `AFTER INSERT OR UPDATE OR DELETE` triggers on ~9 tables do
`pg_notify('catalogue', TG_TABLE_NAME)`; the app holds one listener
connection outside the pool and bumps the generation per notification.
Covers **every** writer — app, scripts, deploy migrations while the old app
still serves, psql by hand — with no discipline required of future writers.
Costs: connection lifecycle (reconnect + "reconnect ⇒ bump unconditionally"),
trigger DDL migration, a heartbeat field. Never replace it with a single-row
version table bumped by the trigger — four concurrent persists would serialise
on that row lock for minutes. Effort 1.5-2.5 days. Recommended as a **later
hardening**, not the first step.

### E. In-process byte-budgeted LRU instead of Valkey

Single instance; a boot-time bump discards Valkey entries anyway, so
persistence buys nothing; no second round trip on the hottest read, no
multi-MB `JSON.parse` per hit, no eviction coupling with sessions. What it
costs: heap (bounded by the budget, visible on the watchdog line), and
scripts cannot bump it (they would rely on D or on the TTL). The owner chose
Valkey; this is the honest comparison, and the design below keeps the store
behind an interface so either can back it.

### F. Version-keyed cache of the shared result set, personalized per request (recommended shape)

The owner's proposal with the amendments that remove every trap in Part 1:

1. **Cache the user-agnostic result set, below pagination.** Move the three
   user predicates out of SQL and apply them as a JavaScript filter over the
   groups — exactly equivalent because they are bottling-level. The cached
   unit is the unsorted, unpaginated `ReportGroup[]` for
   `(kind, catalogue filter, selection options[, UTC day])`; `sort`, `order`,
   `page`, `perPage` are applied on the hit. One entry serves every user and
   every page. Preference changes invalidate **nothing**: personalization is
   read fresh per request (one small query, three id sets).
2. **Generation keys instead of delete-on-write.** One catalogue generation
   counter, bumped **after commit** (via `runOnTransactionCommit` inside a
   transaction, immediately otherwise) by persist, product update/relink,
   `KbReconcileService.run`, store activation, and **at every boot** (covers
   deploy migrations, the boot KB pass, scripts run while the app was down).
   Scripts that run against a live app bump at their end. The generation is
   read _before_ the query and the entry stored under it, so an overlapping
   read can never poison the live generation — the race in Part 1 §2 lands
   its stale payload under a key nobody reads again.
3. **A UTC-day key component for `new`/`drops`**; **a TTL as garbage
   collection** (about a day — generations bump at least daily anyway) plus a
   per-entry size cap. TTL is not the freshness mechanism; the generation is.
4. **Fail-open by construction**: any cache error or timeout is a miss; a
   read deadline far below the 2 s command timeout; a failed bump sets a
   `dirty` flag that bypasses reads until a bump succeeds (so a write during
   a Valkey outage can never be masked by entries stored before it).
5. **Payloads never share an eviction policy with sessions in production.**
   The cache owns its connection settings (`CACHE_VALKEY_*`) and builds its
   own client, so production points it at a dedicated instance
   (`maxmemory` + `allkeys-lru`, no persistence — the standard split) while
   development points it at the shared one, where the TTL and the per-entry
   cap keep it small and `noeviction` means a full instance degrades to
   misses (and, on that shared dev instance only, also refuses session
   writes — documented, acceptable in dev).

## Part 4 — comparison

| Option                                                           | Miss cost                                        | Hit rate                                                         | Consistency risk                                                                               | Effort                         | New failure modes                                                              | Reversibility                            |
| ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------- |
| Literal proposal (Valkey, per-user, delete-on-write, no TTL)     | unchanged (2 full scans, +2 for `drops`)         | low; duplicates the browser cache; ~0 during sync window         | **high**: stale-set race, stale-forever from scripts/migrations, midnight, pre-commit reporter | 2-3 d                          | Valkey OOM logs everyone out or blocks logins; second timeout on the read path | easy flag, but stale data already served |
| F on Valkey (shared result set, generation keys, TTL, fail-open) | unchanged                                        | high for repeated shapes across users; pages 2..N free; warmable | medium: race closed; scripts covered by boot bump + script bump + TTL                          | 3-4 d (+ Phase 2 prerequisite) | session coupling unless a separate instance                                    | easy (`CACHE_ENABLED`)                   |
| A query rewrite                                                  | **~10-50× lower**, flat as history grows         | n/a                                                              | none (equivalence-tested)                                                                      | 1.5-3 d                        | none                                                                           | trivial                                  |
| B read-model columns                                             | lowest for current rows; `drops`/`low` unchanged | n/a                                                              | low with trigger, medium app-side                                                              | 3-5 d                          | write in the persist transaction; silent drift                                 | medium                                   |
| C materialized view                                              | low                                              | n/a                                                              | seconds of staleness after commit                                                              | 2-3 d                          | refresh serialisation; forgotten refresh                                       | medium                                   |
| A + F                                                            | low miss, high hit                               | high                                                             | low                                                                                            | 5-7 d                          | as F                                                                           | easy                                     |
| A + F + D (NOTIFY)                                               | low                                              | high                                                             | lowest (every writer announces itself)                                                         | 7-9 d                          | listener lifecycle                                                             | easy                                     |
| Do nothing                                                       | unchanged, growing ~2 %/day                      | browser only                                                     | none                                                                                           | 0                              | none                                                                           | —                                        |

**Bottom line.** Build A + F together (the owner's decision): A removes the
O(N log N) scan for everyone and for every product-card open, is reversible
in one line, and is the only option whose cost stays flat as `price_snapshot`
grows; F makes repeat views and pagination free and is built in the shape
that has none of the literal proposal's traps. D and the other refinements
stay as later hardening.

## Part 5 — the plan

Phases are ordered so that each is independently shippable and reviewable;
they land in one stream. Estimated 6-9 days in total.

### Phase 1 — query rewrite (A), independent of any cache (1.5-3 days)

**Done 2026-09-10.** Measured on the local production-shaped copy (571 383
snapshots, 9 555 offers of which 7 389 in stock, 3 839 bottlings), end to end
through `ReportService`, median of three runs:

| Report    | Before | After  |
| --------- | ------ | ------ |
| `catalog` | 426 ms | 136 ms |
| `drops`   | 895 ms | 299 ms |
| `low`     | 444 ms | 146 ms |
| `best`    | 424 ms | 135 ms |
| `new`     | 400 ms | 128 ms |

Every kind returned an identical `total` before and after (3137 / 406 / 263 /
979 / 50). Both assumptions the rewrite rests on were verified against the
whole table rather than assumed: zero `createdAt` ties inside an offer's
partition, and zero rows where `createdAt::date` disagrees with `capturedOn`.
The equivalence suite is
`test/integration/current-rows-equivalence.integration.spec.ts`, which keeps
the superseded SQL as its reference implementation and diffs it against the
new code over the ambient database as well as over a fixture seeded for the
edge cases (a one-snapshot offer, a price that only ever rose, a price that
fell after a rise, an out-of-stock offer read by id). It refuses to pass
quietly on an empty database. One defect the suite caught before it shipped:
the middle probe of `currentPriceSince` has to be a LEFT JOIN, because 7 048
of the 9 555 offers have never been listed above their current price and an
inner join dropped three offers in four.

Files: `src/core/store-product/store-product.repository.ts` (`CURRENT_SQL`
and the three `findCurrentRow*` methods), `src/core/price-snapshot/
price-snapshot.repository.ts` (`latestDate` → `MAX("capturedOn")`,
`priceExtremes` → `"capturedOn" >= $1`, `currentPriceSince` → per-offer
lateral). Gate: an integration test running the old and new SQL against the
fixture in `test/integration/report-group.integration.spec.ts` /
`database-fixture.ts` and diffing row sets, plus all existing report
integration specs unchanged. Sanity check, not a gate: `EXPLAIN (ANALYZE,
BUFFERS)` of the new `findCurrentRows` on the local copy confirms an index
scan on `price_snapshot_store_product_created_idx` per offer and no sort over
the whole table. Note FOLLOWUPS item 4 as partially addressed (the two
snapshot-day columns agree on 100 % of rows).

### Phase 2 — personalization out of SQL (prerequisite for a shared cache, 1-1.5 days)

**Done 2026-09-10.** The three anti-joins are gone from `findCurrentRows`,
which now takes no user at all, and `ReportService.report` takes a required
fourth argument instead. Report latency is unchanged by the move (the extra
preference read runs in parallel with the catalogue query and costs a few
milliseconds), and every kind still answers the same `total` it did before
Phase 1: 3137 / 406 / 263 / 979 / 50.

The six assertions in `test/integration/preference-report.integration.spec.ts`
were kept verbatim, as promised: the diff of that file touches only the
helper's plumbing, the constructor and the type names, so the tests that used
to prove the SQL predicates now prove the JavaScript pass over rows the live
query produced. Nine unit tests were added for the pass itself, including the
two cases most likely to regress — a blacklisted maker matched through the
`bottlerId` slot, and a bottling the knowledge base could not place surviving
every maker rule (the SQL read `IN (NULL, NULL)` as UNKNOWN; a null id is in
no `Set`) — plus one that asserts the producer ids never reach the wire.

One defect found while renumbering the query's placeholders: the `regions`
predicate silently became `$14`, the trusted-sources array, instead of `$16`.
Caught by reading the parameter list back against the SQL rather than by a
test, which is worth noting — no suite covers `regions` today.

- `src/interfaces/report.interfaces.ts`: `ReportFilter` loses `userId` /
  `favoritesOnly`; new required `ReportPersonalization { userId; favoritesOnly? }`
  argument of `ReportService.report()` — this is where the "never serve an
  unpersonalized catalogue" guarantee now lives, by construction (the only
  public read path cannot be called without it; `findCurrentRows` no longer
  has a user parameter to forget). New `ReportMakerIds { producerId; bottlerId }`
  on `ReportCurrentRow` (internal), and `ReportPublicRow` / `ReportPublicGroup`
  = `Omit<…, keyof ReportMakerIds>` for the wire; the DTOs in
  `src/domain/report/types/` implement the public shapes.
- `src/core/preference/preference.repository.ts` + `core-preference.service.ts`:
  `findFilterIds(userId): { blacklistProducts; blacklistProducers; favorites }`
  (ids, one statement with three `array_agg`). `CoreWhiskyModule` already
  exports `CorePreferenceModule`.
- `store-product.repository.ts`: `CURRENT_SQL` selects `p."producerId",
  p."bottlerId"`; `findCurrentRows` drops the three predicates and renumbers
  `$16..$20` → `$14..$18`; the doc paragraphs about the user predicates move.
- `report.service.ts`: `report()` = `Promise.all([groups, findFilterIds])` →
  `personalize()` (keep a group iff not blacklisted by `productId`, not by
  `producerId`/`bottlerId` — `null` never matches, so brandless bottlings
  survive — and, when `favoritesOnly`, in the favorites set) → `sort` → slice →
  `toPublic()` on the page. `history()` strips the maker ids too.
- `report.controller.ts`: `toFilter(query)` + `toPersonalization(query, user)`.
- Equivalence: all three predicates reference only bottling columns, every
  row of a group shares `productId`, so filtering rows before grouping and
  groups after grouping select the same groups with the same members; `new`/
  `drops`/`low`/`best` row-level logic reads no user data, so the filters
  commute; `total` is counted after personalization in both versions. One
  observable difference: `cutoff()` is now computed over the user-agnostic
  set (a blacklist can no longer shift a user's lookback by a day) — note in
  CLAUDE.md.
- Tests: `test/report.service.spec.ts` (new personalization suite: product
  blacklist, producer via each slot, null makers survive, favoritesOnly with
  and without favorites, `best` group intact), `test/report.controller.spec.ts`
  (the split), the four integration specs change wiring only — the six
  assertions in `test/integration/preference-report.integration.spec.ts:350-448`
  stay verbatim and now prove the JS filter over live `CURRENT_SQL` rows;
  `persistence.integration.spec.ts` drops `userId` from `findCurrentRows`.

### Phase 3 — the cache (3-4 days)

**Done 2026-09-10.** Verified on a real boot, not only in tests: the log
line `Catalogue cache generation -> 1789072161 (boot)` appears, the counter
lands in Valkey, a restart increments it rather than re-seeding it
(…161 → …162), and the process still exits cleanly on `SIGTERM` — which it
would not have, since the client keeps the event loop alive until
`onModuleDestroy` closes it.

Two decisions were revised while building it, both away from the plan as
written:

- **No new dependency.** The plan had `lib/cache` build its own `iovalkey`
  client, with `iovalkey` pinned as a direct dependency. On the owner's
  instruction the second connection is registered through
  `@toxicoder/nestjs-valkey` instead, as a second `forRootAsync` inside
  `CacheModule`. Two modules give two instances, which is ordinary Nest and
  needs no defending; `~lib/valkey`'s warning is about registering the _same_
  logical store twice, which is a different mistake. The only thing the two
  registrations share is the DI token `ValkeyService`, so module scope rather
  than the token says which connection a service gets — and since
  `CacheModule` exports only `VersionedCacheService`, nothing outside it can
  reach the cache client at all.
- **The client is not lazy.** The plan wanted no socket opened while the
  cache is switched off; through DI the client is built with the module. Left
  eager, because the connection settings fall back to the session instance,
  which is running regardless. `CACHE_ENABLED=false` stops every command, not
  the connection.

One defect the unit tests structurally could not catch, found by booting the
application: `CacheModule` imported the Valkey registration but not
`ConfigModule`, so `CacheConfig` could not be injected into the service — the
`imports` inside `forRootAsync` reach only the options factory. Specs that
construct a service directly never exercise the module graph, which is the
argument for the boot check being part of this checkpoint's gate.

**3.0 Groundwork**

- `src/utils/transaction.util.ts` — `TransactionUtils.afterCommit(cb)`:
  wrap `cb` in a try/catch that logs (the commit event fires in a
  `setImmediate` macrotask, so an uncaught throw there would crash the
  process); call `runOnTransactionCommit(guarded)`; on **any** throw (the
  library's "No hook manager found in context", or `TypeError` under the unit
  specs' `jest.mock('typeorm-transactional', () => ({ Transactional }))`)
  run `guarded()` immediately — correct because outside a transaction the
  preceding write is already autocommitted. Nested `REQUIRED` transactions
  share the outer emitter, so the hook fires at the outermost commit and
  never on rollback.
- `src/config/parts/cache.config.ts` + `src/interfaces/cache.interfaces.ts`
  (`CacheSettings`, `CacheStats`) + `src/constants/cache.constants.ts`
  additions; register in `config.module.ts` / `config/index.ts`; forward the
  new vars in `docker-compose.yaml` next to `VALKEY_*`. Connection fields use
  `nonEmpty` (compose forwards an omitted var as an empty string — the
  `PUSH_VAPID_SUBJECT` lesson).

| Env                                         | Default                         | Purpose                                                                                                                                                         |
| ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_ENABLED`                             | `true`                          | kill switch; every failure path degrades to today's behaviour                                                                                                   |
| `CACHE_TTL_SEC`                             | `86400`                         | GC only — generations bump at least daily and `new`/`drops` keys rotate at midnight                                                                             |
| `CACHE_READ_TIMEOUT_MS`                     | `250`                           | a hit must stay an order of magnitude under the query; far under the 2000 ms client timeout                                                                     |
| `CACHE_MAX_ENTRY_BYTES`                     | `8 MiB` (encoded)               | the unfiltered catalog is ~8 MB JSON / ~1 MB gzipped — admitted with headroom                                                                                   |
| `CACHE_VALKEY_HOST` / `CACHE_VALKEY_PORT`   | `VALKEY_HOST` / `VALKEY_PORT`   | **the owner's decision: whichever instance is configured is the cache.** Falls back to the sessions' instance so dev needs nothing; prod sets the dedicated one |
| `CACHE_VALKEY_DB` / `CACHE_VALKEY_PASSWORD` | `VALKEY_DB` / `VALKEY_PASSWORD` | same fallback                                                                                                                                                   |
| `CACHE_VALKEY_PREFIX`                       | `cache:`                        | key namespace on whichever instance                                                                                                                             |
| `CACHE_VALKEY_COMMAND_TIMEOUT_MS` etc.      | the `VALKEY_*` values           | the same bounded-wait settings as the session client; never "wait forever"                                                                                      |

**3.1 `src/lib/cache/`** — a thin wrapper around `iovalkey`, which is what
`lib/` is for. It builds **its own client** from `CacheConfig` rather than
reusing `ValkeyModule`'s: the `@toxicoder/nestjs-valkey` library registers
its client under one fixed injection token, so a second `forRootAsync` for a
second instance is not possible, and the owner's requirement is exactly a
second, independently configured instance. `iovalkey` becomes a direct
dependency pinned to the version the library already resolves (0.3.3) — the
same rule as `cron` pinned to `@nestjs/schedule`'s version, so there is only
ever one copy. The client is created lazily on first use (a disabled cache
never opens a socket; tests can pass a stub), with `enableOfflineQueue:
false`, `commandTimeout`, `connectTimeout`, `keepAlive`,
`maxRetriesPerRequest` from the config, and closed in `onModuleDestroy` —
required, or every script that boots a Nest context carrying `ScrapeModule`
would never exit. `ValkeyModule`'s single-client comment gets one sentence
saying the cache client is deliberately separate and why.

`CacheModule` (imports `ConfigModule`; providers/exports `VersionedCacheService`)
with `getOrCompute(ref, generation, loader)`, `bump(generation, reason)`
(never rejects), `bumpAfterCommit(generation, reason)` (= `afterCommit` +
`bump`), `readGeneration`, `stats()`, and `onApplicationBootstrap → bump('boot')`.
Every command goes through a `track()` that logs _before_ sending (the
`AuthSessionService.track()` rule from the 2026-08-30 post-mortem) and a
`bounded()` race against `readTimeoutMs` with an unref'd timer (the
`WatchdogService.pingValkey` shape). `cache-codec.util.ts`: `JSON` → async
`zlib.gzip` above 1 KiB (keeps multi-MB encodes off the loop; ~8-12× on this
JSON), stored as `SET key <Buffer> EX ttl`, read with `getBuffer`.

Key shape:

```
<prefix>cache:gen:catalogue                          → integer
<prefix>cache:report:g{gen}:{kind}:{day|-}:{hash32}  → gzip(JSON ReportGroup[])
<prefix>cache:meta:g{gen}                            → gzip(JSON Meta)
```

`gen` is read before the loader runs and the entry is stored under that
value. A missing generation is seeded with epoch seconds via `SET NX`
(strictly larger than anything a surviving old entry was stored under, so a
flushed or deleted key can never resurrect stale entries); `bump` =
`MULTI { SET … NX; INCR } EXEC`. `day` = UTC `YYYY-MM-DD` for `new`/`drops`,
`-` otherwise. `hash32` = first 32 hex of `sha256(JSON.stringify(canonical))`.

Canonicalization (`src/utils/report-cache-key.util.ts`, `ReportCacheKeyUtils`),
built from an explicit field list, never the input's key order:
`{ kind, stores, minPrice, maxPrice, minVolume, maxVolume, countries, name,
types, flavors, excludeFlavors, regions, excludeRegions, verifiedFacts,
window, discountWindow, minDiscount, day }`. Rules: input is the caller's
catalogue filter (so `best` keeps its price bounds in the key though its SQL
drops them — they still decide the group set in JS); `userId`, `favoritesOnly`,
`sort`, `order`, `page`, `perPage` are not inputs; `undefined`, `[]`,
`verifiedFacts: false` and `minDiscount` 0 are omitted (SQL treats each as no
constraint), while price/volume `0` is kept; arrays are deduped and sorted
(`= ANY` is set-semantic), `countries` lower-cased; `name` verbatim.

**Done 2026-09-10.** Verified against the running database as well as in
tests: a real `pnpm rederive-name-facts` moves the counter, a `--dry-run` of
the same script leaves it exactly where it was.

The plan did not anticipate one thing, and it took a live run to see it.
`NestFactory.createApplicationContext` fires `onApplicationBootstrap`, so
every script — dry runs included — was bumping the generation as it started.
Harmless for correctness, but wrong twice over: a dry run is supposed to
leave everything as it found it, and a bump at a script's _start_ discards
entries the script is about to supersede anyway, doing no good at all. The
boot bump is now conditional (`CACHE_BOOT_BUMP`, default true) and the
scripts turn it off through `suppressBootBump()` before they build their
context. The bump that matters is the one at the end, in the `finally`, so a
run that failed halfway still invalidates what it had already written.

**3.2 Bump points** (all `bumpAfterCommit(CACHE_GENERATION_CATALOGUE, reason)`):

- `src/scrape/persist/scrape-persist.service.ts` — last statement of
  `persist()`, reason `persist:<storeId>`; `ScrapeModule` imports `CacheModule`.
- `src/scrape/kb/kb-reconcile.service.ts` — after `applyKbFlavors`, not on
  the dry-run return, reason `kb:reconcile`. Covers all four review endpoints,
  `KbBootApplyService` and `pnpm reconcile-flavors` at once.
- `src/domain/product/product.service.ts` — `update`/`relink`.
- `src/domain/store/store.service.ts` — `setActive` (for `/meta` only).
- Scripts (`enrich-flavors`, `backfill-nulls`, `clean-product-names`,
  `rederive-name-facts`, `research-brands`, `restore-flavor-import`): add
  `CacheModule` to the standalone module and `bump(…, 'script:<name>')` before
  `app.close()` when not dry-run; `reconcile-flavors` only needs the import.
- Preference mutations bump nothing (personalization is per request).

**Done 2026-09-11.** Measured over HTTP against the running application on
the production-shaped copy:

| Request                    | Result                                     |
| -------------------------- | ------------------------------------------ |
| `/report/catalog`, first   | 290 ms, one entry written                  |
| `/report/catalog`, again   | 40 ms                                      |
| `/report/catalog?page=2`   | 40 ms, **no new entry**                    |
| `/report/drops`, first     | 370 ms, key carries the UTC day            |
| `PATCH /store/:slug`       | generation moves, log says `store:active`  |
| `/report/catalog` after it | 230 ms, new entry under the new generation |

The stored catalog entry is 786 KB compressed with a TTL of ~24 h, and the
keys read as intended in `valkey-cli`:

```
cache:gen:catalogue
cache:meta:g1789074305
cache:report:g1789074305:catalog:-:a93f84069f4838aa99d6c1a6e8305e29
cache:report:g1789074305:drops:2026-09-10:c0864db449f6e2a77d45ab2c0ff29d9e
```

The `-` on `catalog` and the date on `drops` are the day bucket doing its
job, and entries of the superseded generation simply stop being addressed.

**The property the whole personalization split exists for, confirmed live**:
hiding a bottling took the catalogue from 3137 to 3136 on the very next
request, with the generation unchanged before and after — no invalidation,
no recomputation of the shared set, and un-hiding restored it just as fast.

The manual pass needed a login, so it ran as a throwaway admin created for
it and deleted afterwards; the user's own account was left alone.

**3.3 Reads through the cache**

- `report.service.ts`: `buildGroups` becomes the loader of
  `getOrCompute({ scope: 'report', suffix }, 'catalogue', …)`.
- `src/domain/meta/meta.service.ts`: `build()` behind
  `getOrCompute({ scope: 'meta', suffix: '' }, …)`.
- `DomainReportModule` / `DomainMetaModule` import `CacheModule`.

**Done 2026-09-11.** The line on a live boot:

```
heartbeat: loop lag 1.6/2.6 ms (mean/max), rss 225 MB, heap 108 MB,
handles 4, db pool 0 open/0 idle/0 waiting, valkey 3 ms,
cache 0h/0m/0e/0b gen 1789092974 ping 3 ms
```

The cache is pinged separately from the session store, because production
gives it an instance of its own and one answering says nothing about the
other; `VersionedCacheService.ping` proxies it, since the client is
deliberately not reachable from outside `CacheModule`. A switched-off cache
reads `cache off` and never raises a warning; `DIRTY` leads the segment when
a bump is outstanding, and that — like a silent cache instance — promotes the
whole line to `warn`.

**3.4 Observability** — `CacheStats { hits, misses, errors, bypasses,
generation, lastBumpAt, dirty, pingMs }` on `WatchdogSample`; the watchdog
pings the cache client the same way it pings the session one (a dedicated
instance is a second thing that can stall), and the heartbeat gains
`cache 120h/8m/0e/0b gen 1757500123 (bumped 5 min ago) 1 ms`; `dirty` or a
missing ping promotes the line to `warn`; one `log` line per bump naming the
reason. Logs carry hashes, sizes, durations and reasons — never payloads or
user ids — so `LOG_REDACT_PATHS` needs no new path (state so in the PR).

**3.5 Failure modes (condensed)**

| Situation                                            | Behaviour                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Valkey down / slow / black-holed                     | command rejects or read deadline fires → miss → DB path; bump failure → `dirty` + warn                                                                                                                                                                             |
| cache instance full                                  | dedicated prod instance (`allkeys-lru`): oldest entries evicted, nothing else affected; shared dev instance (`noeviction`): `SET` fails → miss, `INCR` fails → `dirty` → reads bypassed until a bump succeeds, and session writes also fail (documented, dev only) |
| cache instance down while the session instance is up | every cache command fails fast (`enableOfflineQueue: false`) → misses; sessions unaffected — the isolation the dedicated instance buys                                                                                                                             |
| entry over the cap / undecodable                     | not stored / treated as miss + best-effort `DEL`                                                                                                                                                                                                                   |
| read overlaps a write                                | entry lands under the pre-bump generation; nobody reads it after the bump                                                                                                                                                                                          |
| process dies between COMMIT and bump                 | stale until restart (`restart: unless-stopped` → boot bump within seconds) or TTL                                                                                                                                                                                  |
| migrate-before-swap window                           | old app serves the pre-migration generation for the seconds until `up -d`; closed fully only by D                                                                                                                                                                  |
| UTC midnight                                         | `new`/`drops` keys rotate → one recompute per filter per day                                                                                                                                                                                                       |
| two identical misses in parallel                     | both compute, last write wins (identical); in-process single-flight is an optional follow-up                                                                                                                                                                       |
| `CACHE_ENABLED=false`                                | loader always runs, bumps are no-ops — today's behaviour                                                                                                                                                                                                           |

**3.6 Tests** — unit: `transaction.util.spec` (deferred until hook fires;
immediate when no context; throwing `cb` never propagates),
`report-cache-key.util.spec` (param order, defaults, `best` bounds present,
day only for new/drops, `[]`≡absent, `false`≡absent, countries case),
`versioned-cache.service.spec` (disabled → loader only; rejects/hangs →
miss; oversize; decode error; `dirty` cycle; boot bump; `SET NX` seeding;
counters), `cache-codec.util.spec`; existing service specs assert the bump
via a `{ bumpAfterCommit: jest.fn() }` stub. Integration: the four report
specs pass a disabled cache; new `test/integration/report-cache.integration.spec.ts`
(`VALKEY_PREFIX=it:`; hit after miss; a real `persist` bumps the generation
and the next read misses and shows the new offer; `afterAll` scans and
deletes `it:cache:*`).

### Phase 4 — docs and ops

**Done 2026-09-11.** `CLAUDE.md` gained a "Catalogue cache" section and the
env list gained the `CACHE_*` block; the passages the work made untrue were
corrected rather than left to drift — the preferences paragraph no longer
says the blacklist filters in SQL, the heartbeat example carries its cache
segment, the read-path description states the LATERAL rewrite with its
numbers, the timeouts table has `CACHE_READ_TIMEOUT_MS`, the directory layout
lists `lib/cache/`, and the `READ_CACHE_MAX_AGE_SECONDS` comment no longer
claims there is no server-side cache. `FOLLOWUPS.md` item 4 is marked partly
done: `latestDate` and `priceExtremes` moved to `capturedOn`, while
`CURRENT_SQL`'s `capturedDate` projection has not.
[`docs/VALKEY-CACHE-PROD.md`](VALKEY-CACHE-PROD.md) is the ops procedure — the
one decision it asks for is a dedicated Valkey instance, and it says plainly
what a shared one risks.

- CLAUDE.md: new "Catalogue cache" section (what is cached, key and
  canonicalization, generation semantics and why read-before-query closes the
  race, bump points and the `afterCommit` rule, fail-open + `dirty`, TTL as GC,
  the moved personalization guarantee with the cutoff nuance, the scripts'
  obligation, `CACHE_ENABLED`); update "Config", the compose sentence,
  "Preferences" ("filters every report kind … in SQL" → in
  `ReportService.personalize`), the sentences saying `findCurrentRows`
  mandates a `userId`, the heartbeat example, the directory layout, and the
  Commands block (scripts bump at the end). FOLLOWUPS item 5 (dynamic
  `Cache-Control`) stays adjacent and out of scope.
- `docs/VALKEY-CACHE-PROD.md` (style of `CURRENCY-RATES-PROD.md`): how to
  run the dedicated instance (a second external container, e.g.
  `valkey/valkey:8 --maxmemory 512mb --maxmemory-policy allkeys-lru --save ''
  --appendonly no`, attached to the compose network the way `whisky-valkey`
  is), the `CACHE_VALKEY_*` values to set in the host `.env`, the
  host-firewall note if the container reaches a new destination, `valkey-cli
  INFO memory` and key checks, what a `dirty` heartbeat means, how to force a
  bump (restart, or any curation write). `docker-compose.yaml` forwards the
  `CACHE_*` vars; `docker-compose.dev.yaml` stays with one Valkey (dev shares).

### Later hardening (not in this plan's scope)

D (`LISTEN/NOTIFY` bump) to cover every writer without discipline; pre-warm
the default view of each kind after `runFullSync`; in-process single-flight;
per-kind pruning of `window`/`discountWindow`/`minDiscount` from the key;
skipping `plainToInstance`+validation on hits if measured significant.

## Part 6 — verification

```bash
docker compose -f docker-compose.dev.yaml up -d   # PG 5431 + Valkey 6378
pnpm lint && pnpm build && pnpm test && pnpm test:integration
```

Manual, `valkey-cli -p 6378` (dev shares the instance; in prod point
`valkey-cli` at the cache instance): `GET cache:gen:catalogue` (bumped once
at boot); `--scan --pattern 'cache:report:*'`; `TTL <key>` ≤ 86400;
`MEMORY USAGE <key>` (~1 MB for the unfiltered catalog); `INFO memory`.
Sequence: `GET /report/catalog` twice → second logs `hit`; run
`pnpm reconcile-flavors` or `POST /store/:slug/sync` or `PATCH /store/:slug`
→ generation incremented with the reason logged → next request logs `miss`;
toggle a favorite/blacklist entry → the next report reflects it with **no**
bump; stop the cache instance → requests still answer (misses, `errors`
climbing on the heartbeat), logins unaffected; set `CACHE_VALKEY_HOST` to a
second local instance → keys appear there and not on the session instance.
Latency (recorded now for the record, judged later under load):
`LogInterceptor`'s `processing time` for `GET /report/catalog` with and
without filters before Phase 1, after Phase 1, and hit vs miss after
Phase 3; locally `DB_SLOW_QUERY_MS=100` makes `CURRENT_SQL` appear on every
miss and vanish on hits.

## References

- Nishtala et al., _Scaling Memcache at Facebook_, NSDI 2013 —
  https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf
- DHH, _How key-based cache expiration works_ (2012) —
  https://signalvnoise.com/posts/3113-how-key-based-cache-expiration-works
- Redis, _Cache REST API responses with Node.js and Redis_ —
  https://redis.io/tutorials/how-to-cache-rest-api-responses-using-redis-and-nodejs/
- antirez, _Cache stampede prevention_ —
  https://redis.antirez.com/fundamental/cache-stampede-prevention.html
- Debezium, _Automating cache invalidation with CDC_ —
  https://debezium.io/blog/2018/12/05/automating-cache-invalidation-with-change-data-capture/
- PGCacheWatch (Postgres NOTIFY-driven invalidation) —
  https://github.com/janbjorge/PGCacheWatch/blob/main/docs/introduction.md
- Shopify, _Caching Shopify API data with Hydrogen and Oxygen_ —
  https://shopify.dev/docs/storefronts/headless/hydrogen/caching
- Shopify Engineering, _Making Shopify's Flagship App 20 % Faster … Caching_ —
  https://shopify.engineering/shop-app-custom-caching-solution
- Leapcell, _Postgres materialized views vs Redis application caching_ —
  https://leapcell.io/blog/choosing-between-postgres-materialized-views-and-redis-application-caching
- Valkey, _Client-side caching_ (not needed at one instance) —
  https://valkey.io/topics/client-side-caching/
- typeorm-transactional (`runOnTransactionCommit`) —
  https://www.npmjs.com/package/typeorm-transactional
