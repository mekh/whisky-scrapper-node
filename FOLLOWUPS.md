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

**Status**: open. **Blocked by**: parity with the Python engine.

`GoodwineAdapter`'s `MAX_PAGES = 30` (`src/scrape/adapters/goodwine/`) is not a
runaway backstop — it is **below the real catalog length** (~32 pages of 24
items), so the walk stops on the limit rather than at the end of the catalog and
roughly 48 SKUs are never seen. The legacy Python adapter has the same 30-page
cap, so raising it in TypeScript alone would make the two engines disagree and
fail the parity gate; that is the only reason the wrong value is still there.

**Why this is the wrong approach in general**: a page limit must never be the
end-of-catalog signal. The end-of-catalog signal is "this page brought no new
SKU", which `PagedHtmlAdapterBase` already implements; `MAX_PAGES` exists purely
to stop an infinite walk if a store starts serving the same page forever, and
must therefore be set far above any plausible catalog size.

**Fix**: raise `goodwine`'s cap to a real backstop (well above the catalog, e.g.
80) and audit the cap of every other adapter the same way — each must be a
backstop, not a limit that can be reached in normal operation. Then confirm the
extra pages really do parse (the run gets ~48 SKUs longer).

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
