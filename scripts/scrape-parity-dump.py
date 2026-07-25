"""Dump one store's pre-database snapshots from the legacy Python scraper.

The counterpart of `scrape-dry-run.ts` on the Python side: it runs the very
same pipeline `collect_site` runs before it writes anything — fetch the
listing, enrich the detail pages of items whose ABV is still unknown, normalize
every item, keep the in-stock ones — and prints the result as JSON on stdout.
The LLM pass is deliberately skipped so both sides stay deterministic and
comparable.

Run it through the scraper's virtualenv, with the scraper package importable
and the same `DB_*` variables the backend uses (the adapters read their delay
configuration from the database, and the detail pass reads the already-known
ABVs from it):

    PYTHONPATH=../scrapper DB_PORT=5431 ../scrapper/.venv/bin/python \
        scripts/scrape-parity-dump.py metro > /tmp/metro.python.json

`scrape-parity-diff.ts` invokes this automatically; call it by hand only to
capture a dump for later comparison.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict

from whisky import db, normalize
from whisky.adapters import get_adapter


def enrich_details(adapter, snaps: list) -> None:
    """Fetch detail pages for items whose ABV is not already stored.

    A verbatim port of `collect_site._enrich_details`: the same
    `db.skus_with_abv` gate, the same per-item error tolerance and the same
    politeness delay between requests. The TypeScript dry run performs this
    pass too, so skipping it here would make every detail store diff on
    abv/whisky_type/country/age_years for no reason.
    """
    with db.connect() as conn:
        have_abv = db.skus_with_abv(conn, adapter.slug)

    pending = [snap for snap in snaps if snap.store_sku not in have_abv]
    if not pending:
        return

    print(f"enriching {len(pending)} of {len(snaps)} items", file=sys.stderr)
    for snap in pending:
        try:
            adapter.enrich_detail(snap)
        except Exception as exc:  # one bad page must not stop the pass
            print(f"detail failed for {snap.url}: {exc}", file=sys.stderr)
        adapter.sleep()


def main() -> int:
    """Print the store's normalized in-stock snapshots as a JSON array."""
    if len(sys.argv) < 2:
        print("Usage: scrape-parity-dump.py <slug>", file=sys.stderr)
        return 1

    slug = sys.argv[1]
    adapter = get_adapter(slug)
    try:
        snaps = adapter.fetch_listing()
        if getattr(adapter, "supports_detail", False) and snaps:
            enrich_details(adapter, snaps)
    finally:
        adapter.close()

    snaps = [normalize.normalize(snap) for snap in snaps]
    in_stock = [snap for snap in snaps if snap.in_stock]

    json.dump([asdict(snap) for snap in in_stock], sys.stdout,
              ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
