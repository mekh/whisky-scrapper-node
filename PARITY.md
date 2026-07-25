# Scrape parity log

Every store must produce **identical pre-database snapshots** in the legacy
Python scraper (`../scrapper`) and this backend's TypeScript engine
(`src/scrape`) before its `store_config.engine` is flipped to `ts`. This file
is the record of those comparisons.

**Sign-off rule:**

1. **Porting run** — one clean run (0 diffs on the shared SKUs) accepts a
   store's adapter. The two engines are compared against the same live catalog
   minutes apart, so a clean run is a strong signal on its own.
2. **Release sweep** — right before the cutover, parity is re-run for **every**
   store on a different calendar day. That sweep is the second, independent
   confirmation, and a non-zero diff there blocks the flip for that store.

## How to run

```bash
pnpm exec ts-node -r tsconfig-paths/register scripts/scrape-parity-diff.ts <slug>
```

The harness runs both engines back to back against the live store and diffs
their output by SKU:

- The Python side goes through `scripts/scrape-parity-dump.py`, executed with
  `../scrapper/.venv/bin/python` (override with `PARITY_PYTHON`). It runs the
  same pipeline `collect_site` runs before it writes: fetch → normalize → keep
  the in-stock items.
- The TypeScript side is `ScrapeService.collectStore(slug, { dryRun: true })`.
- The LLM pass is disabled on both sides, so every compared field is
  deterministic.

Compared fields: `url`, `name`, `price`, `oldPrice`, `promo`, `brand`,
`volumeMl`, `abv`, `ageYears`, `whiskyType`, `country`, `flavorTags`.

Exit code `1` means the shared SKUs differ — that is a porting bug. SKU-set
drift is reported but does not fail the run: the two engines scrape a few
minutes apart, so a handful of stock flips is expected. Anything larger is
worth investigating. Pass `--out <dir>` to keep both JSON dumps, or
`--python <file>` / `--ts <file>` to diff dumps captured earlier.

Both sides read the store's delay configuration from the database, so a full
store takes a few minutes per engine.

**Detail-page stores** (`winewine`, `wine-point`, `goodwine`): both engines run
the detail-enrichment pass, gated the same way (`db.skus_with_abv` /
`products.skusWithAbv` — only items whose ABV is not stored yet).
`scrape-parity-dump.py` performs it in `enrich_details`, a port of
`collect_site._enrich_details`; without it `abv`/`whiskyType`/`country`/
`ageYears` would diff for no reason. Because the gate reads the database, a
store whose ABVs are already filled enriches nothing and its run is fast.

**Browser store** (`rozetka`): the Python side needs its optional browser extra
(`.venv/bin/python -m pip install -e ".[browser]"` plus
`.venv/bin/playwright install chromium`), and the TS side a local Chromium
(`pnpm exec playwright install chromium`). Both engines walk ~38 pages with a
fresh browser context per page, so this run is by far the longest one.

## Porting runs

Counts are `python / ts` items; "clean" means every shared SKU matched on every
compared field.

| Store              | Tier | Ported in | Porting run                                        |
| ------------------ | ---- | --------- | -------------------------------------------------- |
| 19 Zakaz.ua chains | 1    | step 6    | see below — `metro` + `novus`                      |
| `metro`            | 1    | step 6    | 2026-07-25 clean — 123 / 123                       |
| `novus`            | 1    | step 6    | 2026-07-25 clean — 288 / 288                       |
| `maudau`           | 1    | step 6    | 2026-07-25 clean — 713 / 713                       |
| `okwine`           | 1    | step 6    | 2026-07-25 clean — 563 / 563                       |
| `winewine`         | 1    | step 7    | 2026-07-25 clean — 202 / 202                       |
| `wine-point`       | 1    | step 7    | 2026-07-25 clean — 220 / 220                       |
| `goodwine`         | 2    | step 7    | 2026-07-25 clean — 717 / 717                       |
| `rozetka`          | 3    | step 7    | 2026-07-25 clean — 443 / 444                       |
| `silpo`            | 3    | step 7    | structure only — not registered, stays on `python` |

`metro` and `novus` stand in for all 19 Zakaz.ua networks: they share one
parameterized adapter, and `novus` is the category-slug exception (`whiskey`
instead of `whiskey-<chain>`). The release sweep covers each chain
individually.

The three step-7 HTML stores also passed a **fixture-level** check before their
live runs, which is a stronger signal than a live diff on its own: one captured
listing page and one captured product page per store were fed to _both_ engines,
so the two parsers saw the very same bytes. Result: `winewine` 24/24,
`wine-point` 24/24, `goodwine` 23/23 cards with zero field differences, and
identical detail-page output (country/brand/type/abv/volume). That is what
caught the one real porting trap — selectolax strips every text node before
joining them while cheerio's `.text()` does not (see `src/scrape/html/`).

### Live syncs through `POST /store/:slug/sync`

All performed locally against a copy of the production database, with the store
temporarily flipped to `engine = 'ts'` and a temporary non-admin user holding
`store:sync` + `store:list` (both removed afterwards). No duplicate
`(productId, capturedOn)` row appeared in any of them.

| Store      | Date       | Duration  | found | added | updated | removed |
| ---------- | ---------- | --------- | ----- | ----- | ------- | ------- |
| `maudau`   | 2026-07-25 | 1 m 37 s  | 713   | 5     | 708     | 0       |
| `winewine` | 2026-07-25 | 13 m 46 s | 318   | 0     | 202     | 0       |
| `rozetka`  | 2026-07-25 | 11 m 03 s | 2329  | 25    | 419     | 497     |

`winewine` reproduces the legacy numbers exactly: production's Python runs on
19-21 July each recorded `found=318`, `updated=202`, `removed=0` in ~13 m 40 s.

**Two `rozetka` observations, neither of them a porting problem:**

- `removed=497` is an artifact of the stale local database: it is a copy of
  production taken days earlier, so products that were in stock then and are not
  now come back out of stock and are deleted (cascading their history). Both
  engines behave identically here — the rule is "delete the SKUs the current
  listing reports as out of stock".
- **In-stock counts differ by origin IP.** This local run saw ~444 items in
  stock; production's Python runs on 19-21 July consistently saw 900-970 of the
  same ~2320-item catalog. Rozetka reports availability per city/warehouse, so
  the residential and datacenter IPs genuinely see different stock. Parity is
  unaffected — it is measured engine-vs-engine from the same machine minutes
  apart (443 vs 444, 0 diffs) — but at the cutover (step 10) `rozetka`'s
  counters must be compared against **production's own** Python history, never
  against these local numbers.

The browser tier was also checked for resource behavior: after the `rozetka`
run the API process was back at its pre-run RSS (272 MB, peak 292 MB during the
walk) and no `headless_shell` process was left behind, so `adapter.close()` in
`ScrapeService`'s `finally` does release Chromium. At 11 m the run fits the
15-minute HTTP budget, but the `SYNC_BROWSER_STORE_TIMEOUT_MS` headroom stays:
production is slower (13 m 59 s and 18 m 01 s on 20-21 July) and a slow page can
push it past 15 minutes.

## Release sweep (step 10)

Re-run for every store with a registered adapter — the 19 Zakaz.ua chains,
`maudau`, `okwine`, `winewine`, `wine-point`, `goodwine`, `rozetka` — on a
different calendar day than the porting runs, immediately before the cutover.

| Date | Stores | Result      |
| ---- | ------ | ----------- |
| —    | —      | not run yet |

## Production flips

No store is flipped yet: every `store_config.engine` is `python`, so the Python
collector is still the live writer everywhere. The flips happen in step 10,
performed by the user.
