# Deferred follow-ups

Known problems that are deliberately **not** fixed yet, with the reason for
waiting and what a correct fix looks like. Everything here is scheduled for
**after the Python-to-TypeScript scrape migration is fully complete** (see
[`PARITY.md`](PARITY.md) and the migration plan) — during the migration the
overriding requirement is that the TypeScript engine produce byte-identical
results to the legacy Python one, which blocks several of these fixes.

Do not let an item sit here silently: each one is a real defect, not a
preference.

## 1. `goodwine`'s page cap truncates the catalog — wrong by design

**Status**: cap FIXED (2026-08-22, 30 -> 80), together with the
listing-completeness sweep gate. The parity blocker was already stale — the
cutover finished 2026-08-08. **A follow-on capacity question is now open, see
item 6.**

`GoodwineAdapter`'s `MAX_PAGES = 30` (`src/scrape/adapters/goodwine/`) was not a
runaway backstop — it was **below the real catalog length**, so the walk stopped
on the limit rather than at the end of the catalog.

**This item badly understated the damage.** It assumed a ~32-page catalogue and
"roughly 48 SKUs" never seen. Measured against the live site on 2026-08-22, the
category is **61 pages of 24 — 1444 items**, stated by the listing's own
toolbar, with page 61 carrying 4 and page 62 empty; sampled pages 1, 31 and 60
share no product id, so the depth is real and not a wrap-around. The cap was
therefore hiding **half the store**: every run collected 720 items and the other
~724 were never seen — and, since persist only ever inserts what a run saw,
never inserted either. Both engines had the same cap, so `goodwine` has never
been fully scraped.

**Why this was the wrong approach in general**: a page limit must never be the
end-of-catalog signal. The end-of-catalog signal is "this page brought no new
SKU", which `PagedHtmlAdapterBase` implements; `MAX_PAGES` exists purely to stop
an infinite walk if a store starts serving the same page forever, and must
therefore be set far above any plausible catalog size.

Making the sweep depend on where a walk stopped turned this from a silent data
gap into a blocking one: a walk that ends on its cap cannot claim to have seen
the whole listing, so `goodwine` would have been refused the sweep on every run
and every run recorded as failed.

**What was done**: `goodwine`'s cap raised 30 -> 80, and every other adapter's
cap audited against a live dry run. Only one other was reachable — `rozetka`
sat at 45 against a ~39-page catalogue (six pages of headroom), raised to 80.
The rest have multiples of headroom and all report `stop=exhausted` or
`stop=counted`: `bayadera` 124 items, `fozzy` 299, `winewine` 320, `wine-point`
340, `alcomag` 603, `novus` 345, `metro` 146, `okwine` 560, `maudau` 497,
`silpo` 249.

## 2. The browser tier's Docker build was never verified

**Status**: partially closed (2026-08-08). **Blocked by**: nothing technical —
the original "cannot pull `node:24`" failure was stale docker.io credentials.

The `service_run` stage installs Chromium (`playwright install --with-deps
chromium`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`) and drops to a non-root
`appuser` (uid 10001), mirroring `../scrapper/Dockerfile`, which runs the same
browser in production today.

Verified on the dev machine (podman, arm64): the image builds, the app boots
and serves from it, `appuser` can read `/ms-playwright`, and Chromium launches
and renders a page inside the container under the engine's own launch
arguments (`--disable-blink-features=AutomationControlled`, no `--no-sandbox`)
— so the sandbox is happy without extra flags. Note the browser no longer
installs against the production `node_modules` at all: it is installed by
`npx playwright@<pinned>` in a layer keyed only on the version, with a
build-time assertion that the version matches `package.json`.

Still unproven: the same on the amd64 production host, and one real `rozetka`
sync in the container — in particular whether the default `/dev/shm` holds up
under a full walk (a browser in Docker classically needs a larger `/dev/shm`
or `--disable-dev-shm-usage`; neither is configured, because the Python image
does not need them).

**Fix**: build and run on the production host, then run one real `rozetka` sync
in the container before that store is trusted on `ts`.

## 3. `rozetka` walks the whole catalog to collect a 7-page prefix

**Status**: open. **Blocked by**: nothing technical — it needs a decision on
what `total` should mean once the walk stops early.

Everything in stock sits in the **first ~7 of ~38 pages** (2026-07-25: 60, 60,
57, 60, 60, 60, 50 available, then nothing on pages 8 and 20), yet the adapter
walks the tail as well, which costs ~8 of the run's 11 minutes. `maudau` already
solves the same shape with `EARLY_STOP_EMPTY_PAGES`.

The stop rule has to be "K consecutive pages with no in-stock tile", not "the
first page holding an out-of-stock tile": sold-out tiles are interleaved into
the prefix (3 of them on page 3, 10 on page 7). Contiguity past page 8 has not
been proven — pages 9-19 and 21-38 were never sampled — so confirm it first by
logging in-stock counts per page during a normal full run, which costs no extra
requests.

One consequence to settle before switching it on:

- `total` (the `sync_log` counter and the `found` figure) drops from ~2330 to
  ~600, so any threshold or eyeballed comparison against history changes basis.

The other former blocker is gone (2026-08-08): products are no longer deleted
on unavailability — the persist sweep flags everything not seen in stock this
run as `product."inStock" = false`, so the deep out-of-stock SKUs are handled
without ever visiting their pages.

**Availability detection itself is fixed** (2026-07-25, both engines): the tile's
buy button is now the positive marker, see [`PARITY.md`](PARITY.md).

## 4. Legacy report SQL keys on `createdAt::date`, not `capturedOn`

**Status**: open. **Blocked by**: nothing technical — pure consistency debt.

The report-era queries (`latestDate`, `priceExtremes`, `currentPriceSince`,
`priceSeries` in `price-snapshot.repository.ts`, plus `CURRENT_SQL` in
`store-product.repository.ts`) key the snapshot day on `"createdAt"::date`,
while the dashboard queries (2026-08-22) key on `capturedOn` — the column
that carries the one-row-per-offer-per-day unique index and the semantic
guarantee. Verified on a production dump: the two agree on 100% of 422,565
rows today, so there is no live bug — but nothing _enforces_ that agreement
(a backdated upsert or a midnight-straddling run could split them), and the
legacy form cannot use the `price_snapshot_captured_idx` index.

**Fix**: migrate the legacy queries to `capturedOn`, one behavioral
equivalence test per query. No schema change needed.

## 5. Dashboard cache lifetime is static for immutable ranges

**Status**: open (deliberately deferred at the dashboard's v1).

A `/dashboard/*` range whose `to` lies strictly before today is immutable —
historical snapshot rows are only ever rewritten by `upsertForDate` for the
current day — yet it is served with the same `Cache-Control: max-age=600` as
a live range. A dynamic max-age (a day or more for closed ranges) is a real
win once dashboard use grows, but `@CacheControl` compiles to a static Nest
`@Header`, so the fix needs a small response interceptor.

**Fix**: an interceptor that inspects the resolved `to` and lengthens
`max-age` for closed ranges; keep 600s for anything touching today.

## 6. `goodwine`'s full catalog does not fit its sync budget

**Status**: timeout RESOLVED (2026-08-22) — `SYNC_STORE_TIMEOUT_MS` raised from
15 to **20 minutes**. The one-off field backfill below is still outstanding.

With the item-1 cap raised, `goodwine`'s listing walk is 61 pages at its tier-2
politeness delay of 8-15 s, i.e. **roughly 8-15 minutes for the listing alone**.
Against the old 15-minute budget an average run fitted (~11.7 min) but an
unlucky one did not, and a run that overruns is abandoned having written
nothing — so the tightest store was the one that lost a whole scrape to jitter.
At 20 minutes even the worst case (61 x 15 s = 15.25 min) clears the budget with
~4.75 minutes to spare, and the soft LLM/detail deadline
(`SYNC_LLM_DEADLINE_MARGIN_MS`, 2 min) leaves the run time to persist.

The trade accepted: the budget is global, so every HTTP store may now run five
minutes longer before being cut off. That only costs anything on a store that
was already going to fail, and a store that hangs is still bounded.

**Still open — the one-off field cost.** The first successful run discovers ~724
SKUs the store has never had on file. `goodwine` is `supportsDetail`, so each
wants a detail page at the same 8-15 s delay (~2.4 h of fetching). The soft
deadline cuts that short, so the offers land with their secondary fields null
and stay that way until seeded — the same pattern `fozzy`, `alcomag` and `silpo`
needed:

```
pnpm backfill --store goodwine
```

Takes hours, holds no sync lock, and is re-runnable. Nothing breaks without it;
those ~724 offers simply carry no abv/volume/type/country until it has run.

Lowering `goodwine`'s `store_config` delay towards the tier-1 stores' 4-8 s
would halve both numbers, but that is a judgement call about how hard the store
may be hit and is deliberately not taken here.

## 7. One brand is split across several `brand` rows

**Status**: open, measured 2026-09-01 on a restored production dump. Deferred
by decision while the `& Whisky` collision was fixed (see "Brand from the name"
in [`CLAUDE.md`](CLAUDE.md) and the `brand-whisky-artifact` migration). The two
defects share a cause — what a brand string reduces to — but not a fix.

`BrandUtils.key` treats only whitespace, apostrophes, hyphens and underscores
as separators. Every other matcher in the codebase (`brandHaystack`,
`KbKeyUtils.key`, `ProductMatchUtils.fold`) treats **every** non-alphanumeric
run as one. So `&`, `+`, `.` and `!` survive into the canonical spelling, and
one brand becomes several rows:

```
jack daniels   Jack Daniel's (49)  | Jack Daniels (0)
grants         Grant's (35)        | Grants (0)
whyte mackay   Whyte Mackay (10)   | Whyte & Mackay (2)  | Whyte&mackay (0)
macarthurs     MacArthur's (4)     | Macarthurs (3)
j b            J&b (4)             | J+b (0)
lot no 40      Lot No 40 (2)       | Lot No. 40 (0)
roe co         Roe&co (1)          | Roe & Co (0)        | Roe + Co (0)
darkness       Darkness! (6)       | Darkness (0)
writers tears  Writers Tear's (8)  | Writers Tears (0)
```

**15 duplicate-key groups in 708 rows.** The damage is smaller than the list
looks: in 12 of the 15 the extra rows hold **zero** products — legacy import
residue that `BrandUtils.canonical` would fold today. Only three genuinely
split a catalogue: `whyte mackay` (10 + 2), `macarthurs` (4 + 3) and
`rowans creek` (1 + 1).

Three consequences, in order of severity:

- **The brand-from-name pass is non-deterministic across these keys.**
  `buildBrandIndex` dedups by key and keeps the _first_ name it sees, and
  `CoreBrandService.listNames` issues no `ORDER BY` — so which spelling a
  brandless listing is given depends on Postgres row order. Adding an explicit
  order is a one-line partial mitigation that is worth doing whatever else is
  decided.
- Empty duplicates still surface in `/brand/search` and the settings
  blacklist picker, where a user can pick the row that hides nothing.
- A brand blacklist rule or a `brand` report filter only covers the row it
  names, so a rule on `Whyte & Mackay` leaves 10 bottlings visible.

**Why this is not a one-line fix.** `canonical` folds to a key and then
_reconstructs_ a display spelling from it, so making `&` a separator would
silently rename `Whyte & Mackay` to `Whyte Mackay` and `Malt & Grain` to
`Malt Grain`. `Gordon & MacPhail` survives today only because it has a
`DISPLAY_OVERRIDES` entry. Any separator widening therefore has to be paired
with a rule for reconstructing the connector, or with an override per affected
brand — decide that before touching the regex.

**What the merge must not do.** `product.matchKey` is frozen at creation and
the brand is one of its tokens, so a data migration that merges brand rows must
re-point `product."brandId"` and `blacklist_brand."brandId"` and **leave every
match key alone**. Re-keying would detach offers that are already linked. For
the same reason `brandHaystack` must not gain folding it does not have — it
feeds that frozen key. Note that a merge changes the brand token for _future_
listings of the affected bottlings, so a later SKU can compute a different key
and mint a second bottling for curation to merge; that is the accepted,
already-documented cost of any brand change.
