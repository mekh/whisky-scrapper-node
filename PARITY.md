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

**Detail-page stores** (`winewine`, `wine-point`, `goodwine`): the TS dry run
performs the detail-enrichment pass, so `scrape-parity-dump.py` has to perform
it too (the `collect_site._enrich_details` gate on `db.skus_with_abv`) —
otherwise `abv`/`whiskyType`/`country`/`ageYears` diff for no reason.

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
| `winewine`         | 1    | step 7    | pending                                            |
| `wine-point`       | 1    | step 7    | pending                                            |
| `goodwine`         | 2    | step 7    | pending                                            |
| `rozetka`          | 3    | step 7    | pending                                            |
| `silpo`            | 3    | step 7    | structure only — not registered, stays on `python` |

`metro` and `novus` stand in for all 19 Zakaz.ua networks: they share one
parameterized adapter, and `novus` is the category-slug exception (`whiskey`
instead of `whiskey-<chain>`). The release sweep covers each chain
individually.

A full live sync of `maudau` through `POST /store/maudau/sync` on 2026-07-25
wrote 713 same-day snapshots (`added=5`, `updated=708`, `removed=0`, 1 m 37 s),
with no duplicate `(productId, capturedOn)` rows.

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
