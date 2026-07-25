"""Dump one store's pre-database snapshots from the legacy Python scraper.

The counterpart of `scrape-dry-run.ts` on the Python side: it runs the very
same pipeline `collect_site` runs before it writes anything — fetch the
listing, normalize every item, keep the in-stock ones — and prints the result
as JSON on stdout. The LLM pass is deliberately skipped so both sides stay
deterministic and comparable.

Run it through the scraper's virtualenv, with the scraper package importable
and the same `DB_*` variables the backend uses (the adapters read their delay
configuration from the database):

    PYTHONPATH=../scrapper DB_PORT=5431 ../scrapper/.venv/bin/python \
        scripts/scrape-parity-dump.py metro > /tmp/metro.python.json

`scrape-parity-diff.ts` invokes this automatically; call it by hand only to
capture a dump for later comparison.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict

from whisky import normalize
from whisky.adapters import get_adapter


def main() -> int:
    """Print the store's normalized in-stock snapshots as a JSON array."""
    if len(sys.argv) < 2:
        print("Usage: scrape-parity-dump.py <slug>", file=sys.stderr)
        return 1

    slug = sys.argv[1]
    adapter = get_adapter(slug)
    try:
        snaps = adapter.fetch_listing()
    finally:
        adapter.close()

    snaps = [normalize.normalize(snap) for snap in snaps]
    in_stock = [snap for snap in snaps if snap.in_stock]

    json.dump([asdict(snap) for snap in in_stock], sys.stdout,
              ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
