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
| `rozetka`          | 3    | step 7    | 2026-07-25 clean — 443 / 444, re-run 393 / 393     |
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
- In-stock counts looked origin-dependent (~444 here against production's
  900-970 on 19-21 July) and were first written up as per-city availability.
  **That was wrong** — see "The `rozetka` availability defect" below: the gap was
  a difference of dates, not of origins, and both engines reported 442-444 on
  2026-07-25 from a datacenter and a residential IP alike.

The browser tier was also checked for resource behavior: after the `rozetka`
run the API process was back at its pre-run RSS (272 MB, peak 292 MB during the
walk) and no `headless_shell` process was left behind, so `adapter.close()` in
`ScrapeService`'s `finally` does release Chromium. At 11 m the run fits the
15-minute HTTP budget, but the `SYNC_BROWSER_STORE_TIMEOUT_MS` headroom stays:
production is slower (13 m 59 s and 18 m 01 s on 20-21 July) and a slow page can
push it past 15 minutes.

## The `rozetka` availability defect (fixed 2026-07-25, both engines)

Rozetka labels a sold-out tile in **two** ways — «Закінчився» when it has just
run out, «Немає в наявності» when it has been gone longer — and the shared
extractor inferred availability from the _absence_ of the second phrase
(`!/нема\S* в наявн/i`), so every freshly sold-out tile counted as available.
Both engines now key on the **positive** marker instead, the tile's buy button
(`button.buy-button`).

Measured on captured tiles, 840 of them across pages 1-8 and 20 from both a
residential and a datacenter (Hetzner/DE) IP: buy button present ⟺ no
out-of-stock label, with **zero exceptions**. 407 tiles available, 37
«Закінчився» (the ones the old rule got wrong), 96 «Немає в наявності». The
store's own catalog holds ~410 in stock, so the new rule matches reality and the
old one over-reported by 34.

Why production's counter read 900-970 while local runs read 444: **the two
numbers are from different days, not different origins.** Production's own
Python run collapsed from 909 in stock (24 July) to 442 with `removed=470`
(25 July) while `total` stayed at 2323-2324, i.e. the catalog did not change —
its rendering did. Until 24 July that ~470-item cohort carried no out-of-stock
text at all, so the negative rule counted all of it; when Rozetka started
labelling those tiles the inflated count deflated on its own. Ruled out by
measurement, not by argument: a datacenter IP sees the same labels as a
residential one, and CPU throttling at 10× does not change them either (every
tile carries its label in the same DOM state as the tile itself, so there is no
hydration window to lose).

Because a positive marker fails **closed**, the adapter now also refuses to
guess: every tile must carry either the buy button or a known out-of-stock
label, and a page with tiles that carry neither is retried once and then fails
the run. Without that guard a renamed CSS class would mark the whole catalog
out of stock and `deleteGone` would delete every `rozetka` product along with
its price history.

Both engines were re-diffed after the fix, on the same evening: **393 / 393
items, 0 diffs** on the 385 SKUs they share, with 8 SKUs drifting each way
between the two runs 11 minutes apart (the store sells briskly in the evening —
it had 407 available a couple of hours earlier). Parity therefore survives the
change, which is why it was made in both engines at once rather than in
TypeScript alone.

Covered by a golden test that runs the real extractor in Chromium against the
captured tiles (`test/scrape/fixtures/rozetka-page-{7,8}.html`, in the
integration lane because it needs a browser) plus unit tests for the guard on
both sides (`test/scrape/rozetka.adapter.spec.ts`,
`../scrapper/tests/test_rozetka.py`).

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
