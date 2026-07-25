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

**Status**: open. **Blocked by**: nothing technical — the local Docker daemon
could not pull `node:24` (registry authentication) when the change was written.

The `service_run` stage now installs Chromium (`playwright install --with-deps
chromium`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`) and drops to a non-root
`appuser` (uid 10001). This mirrors `../scrapper/Dockerfile`, which runs the
same browser in production today, but **this image has not been built or run
even once**. Everything about it is therefore unproven: that the browser
installs against the pruned production `node_modules`, that `appuser` can read
`/ms-playwright`, that Chromium's sandbox is happy, and that the container has
enough shared memory for it (a browser in Docker classically needs a larger
`/dev/shm` or `--disable-dev-shm-usage`; neither is configured, because the
Python image does not need them).

**Fix**: build the image, run it as `appuser`, and launch Chromium inside it
with the engine's own launch arguments — then run one real `rozetka` sync in the
container before the cutover flips that store to `ts`.

## 3. `rozetka`'s availability count does not match the catalog

**Status**: under investigation in a separate session.

The store's whisky category holds **410 in-stock items** (verified from both a
residential and a datacenter IP: the in-stock items form a contiguous prefix
ending on page 7, which holds 50 of them, after 6 full pages of 60). Neither
engine reports that number: both the TypeScript and the Python adapter found
443-444 in stock locally on 2026-07-25 (they agree with each other, so the port
is faithful — the defect is in the shared logic), while production's Python runs
on 19-21 July recorded 900-970.

Two suspects: the in-stock test itself (a negative text match,
`!/нема\S* в наявн/i`, on the tile's whole text — it infers availability from
the _absence_ of a phrase, so any rendering change reads as "in stock"), and the
fact that the adapter walks all ~38 pages even though everything in stock sits
in the first ~7 — which also costs ~9 of the run's 11 minutes.

**Fix**: pending the investigation's findings. Note that changing the
availability rule diverges from the Python engine, so either it lands after the
cutover, or it is applied with a fresh parity comparison and a deliberate,
documented break.
