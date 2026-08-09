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
| `silpo`            | 1    | post-mig. | 2026-08-09 — rebuilt on the open catalog JSON API (tier 1, no browser) and registered; no parity run — the Python adapter never ran in production, so there is nothing to be parity with |

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

## Whole-catalog sweep against a production dump (2026-07-26)

The strongest evidence so far, and a different method from the porting runs: no
side-by-side Python run, but **production's own numbers** for the same calendar
day. A fresh production dump (`whisky_20260726_150513Z.dump`, taken 15:05 UTC)
was restored locally, its three pending migrations applied, every store flipped
to `ts`, and one full sync driven by the internal cron — then the TS
`sync_log` rows (`trigger = 'cron'`) were compared with production's Python rows
(`trigger IS NULL`) from the same day's 12:00 Kyiv run, roughly six hours
earlier.

**Two facts this run established about production itself:**

- **Production runs the pre-overhaul schema.** The dump carries only `Init` and
  `WhiskyDomain`; `store-config-group-engine`, `sync-log-lock` and
  `price-snapshot-captured-on` have **never been applied there**. The cutover
  must run `pnpm migration:run` in production _before_ anything else. Applying
  them to the dump was clean: `"group" = 'zakaz'` on 11 rows, **0** duplicate
  `(productId, capturedOn)` pairs (so production's Python has not been racing
  itself), `capturedOn = "createdAt"::date` everywhere, all 253 771 snapshots
  preserved, no open `sync_log` row.
- **Production has 17 stores, not 26 — and 11 Zakaz.ua chains, not 19.** The
  extra 9 stores in the older local database (`silpo`, `grono`, `torba`,
  `vostorg`, `ideal`, `kharkiv`, `onde`, `tavriav`, `chudomarket`) came from the
  legacy SQLite import and do not exist in production. Every figure of "19
  chains"/"26 stores" in this file and in the plan describes that local set, not
  the live one. All 17 live stores have a registered adapter.

**Result: 17 of 17 stores succeeded, 0 failed, 0 skipped, in 23 m 06 s** with
the default `SYNC_MAX_PARALLEL_TRACKS = 4` (7 tracks) — against 1 h 04 m for
production's strictly sequential Python pass, a 2.8× speed-up. Per-track:
`zakaz` 8 m 29 s (11 stores sequential), `wine-point` 14 m 37 s, `winewine`
14 m 09 s, `rozetka` 11 m 47 s, `goodwine` 6 m 51 s, `okwine` 2 m 25 s,
`maudau` 1 m 36 s.

**14 of 17 stores matched production's `total` exactly.** The three that did not
are catalog drift over the six-hour gap, not engine differences:

| Store        | Python `total` | TS `total` | Δ  | Why                                                                           |
| ------------ | -------------- | ---------- | -- | ----------------------------------------------------------------------------- |
| `maudau`     | 706            | 702        | −4 | lists in-stock items only; 4 went out of stock (kept, not deleted, as Python) |
| `rozetka`    | 2319           | 2328       | +9 | 9 more tiles in the catalog                                                   |
| `wine-point` | 336            | 341        | +5 | 5 more products listed                                                        |

`added`/`removed` agree in kind everywhere (both engines delete for the same
stores and neither deletes for `maudau`). The one number to watch at the
cutover is **`rozetka` `removed`: 55 here against Python's 36 that morning** —
same order, same cause (its catalog rotates and `deleteGone` cascades the
history of a rotated-out SKU), but it is the largest destructive figure in the
run. See `FOLLOWUPS.md` §3.

**No unit or normalisation drift.** Of the 5 949 products holding both a Python
price (2026-07-25) and a TS price (2026-07-26), **5 938 are identical** and 11
moved; no store shows a price ratio above 2× in either direction, so nothing
resembling a kopecks/hryvnia error survives anywhere.

Afterwards every store was flipped back to `python` and no `sync_log` row was
left open. Baseline CSVs and the comparison SQL: `~/whisky-parity-20260726/`.

## Release sweep (step 10)

Re-run for every store with a registered adapter — the 11 Zakaz.ua chains,
`maudau`, `okwine`, `winewine`, `wine-point`, `goodwine`, `rozetka` — on a
different calendar day than the porting runs, immediately before the cutover.

| Date       | Stores | Result                                                      |
| ---------- | ------ | ----------------------------------------------------------- |
| 2026-07-26 | 17/17  | clean against production's own same-day numbers (see above) |

## Production flips

No store is flipped yet: every `store_config.engine` is `python`, so the Python
collector is still the live writer everywhere. The flips happen in step 10,
performed by the user.
