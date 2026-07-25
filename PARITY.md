# Scrape parity log

Every store must produce **identical pre-database snapshots** in the legacy
Python scraper (`../scrapper`) and this backend's TypeScript engine
(`src/scrape`) before its `store_config.engine` is flipped to `ts`. This file
is the record of those comparisons — one section per store, one row per run.

**Sign-off rule (from the migration plan): two clean runs on two different
calendar days.** Only then is the store handed over for the production flip.

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

## Tier-1a (step 6)

`metro` and `novus` stand in for all 19 Zakaz.ua networks: they share one
adapter, and `novus` is the category-slug exception (`whiskey` instead of
`whiskey-<chain>`).

| Store    | Day 1 (2026-07-25)         | Day 2 | Flipped in prod |
| -------- | -------------------------- | ----- | --------------- |
| `metro`  | clean — 123 / 123, 0 diffs | —     | no              |
| `novus`  | clean — 288 / 288, 0 diffs | —     | no              |
| `maudau` | clean — 713 / 713, 0 diffs | —     | no              |
| `okwine` | clean — 563 / 563, 0 diffs | —     | no              |

Counts are `python / ts` items; every SKU matched on both sides.

A full live sync of `maudau` through `POST /store/maudau/sync` on the same day
wrote 713 same-day snapshots (`added=5`, `updated=708`, `removed=0`, 1 m 37 s),
with no duplicate `(productId, capturedOn)` rows.

## Tier-1b (step 7) — pending

`winewine`, `wine-point`.

## Tier-2 (step 8) — pending

`goodwine`. Needs the datacenter-IP (VPN) protocol.

## Tier-3 (step 9) — pending

`rozetka`. Needs the datacenter-IP (VPN) protocol. `silpo` is ported for
structure only and stays unregistered.
