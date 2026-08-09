# Spike results

Decision gate for porting the Python scraper into this backend. See
[README.md](README.md) for how to reproduce each run.

Versions under test: `playwright` 1.62.0 (Chromium 151 headless shell),
`impit` 0.14.3, `cheerio` 1.2.0, Node 22 (`ts-node`).

---

## Phase A — local, residential IP (2026-07-25)

Quick pass: 3 attempts x 2 listing pages per
pair, a fresh client per attempt, real per-store politeness delays.

| Store        | Client     | Verdict | Items/attempt | Statuses | Duration/attempt |
| ------------ | ---------- | ------- | ------------- | -------- | ---------------- |
| `metro`      | plain      | PASS    | 60, 60, 60    | 200      | 3.6-4.5 s        |
| `novus`      | plain      | PASS    | 60, 60, 60    | 200      | 4.9-9.2 s        |
| `maudau`     | plain      | PASS    | 96, 96, 96    | 200      | 6.3-8.1 s        |
| `okwine`     | plain      | PASS    | 60, 60, 60    | 200      | 4.7-6.2 s        |
| `winewine`   | plain      | PASS    | 48, 48, 48    | 200      | 4.6-8.3 s        |
| `wine-point` | plain      | PASS    | 48, 48, 48    | 200      | 5.3-8.3 s        |
| `goodwine`   | plain      | PASS    | 48, 48, 48    | 200      | 10.0-16.0 s      |
| `goodwine`   | impit      | PASS    | 24 (1 page)   | 200      | 0.5 s            |
| `rozetka`    | playwright | PASS    | 123, 123, 123 | 200      | 39.8-43.6 s      |

No Cloudflare interstitial was detected in any run, and every attempt parsed
real data (name, price, SKU) rather than empty shells.

**What Phase A does and does not prove.** It proves the Node clients, the
ported parsers, and the stealth browser context all work: every store is
reachable and every parser produces sane items. It does **not** settle the
client choice for the Cloudflare-fronted stores — the Python scraper's own
note says plain clients get 403 specifically from datacenter IPs, and this run
came from a residential address.

### Notable observations

- **Zakaz.ua** returns 30 items/page for both networks tested, including
  `novus` with its bare `whiskey` category — so the one parameterized adapter
  covers the category-slug exception correctly.
- **MauDau** returns 48 items/page and its `x-total-pages` header, as the
  Python adapter expects.
- **Goodwine** passed with plain `fetch` here, so its Cloudflare protection is
  not an unconditional block on non-browser TLS — the question is purely
  IP-dependent. It is also the slowest HTTP store (8-15 s delays).
- **Rozetka** needs ~20 s per page (fresh context + navigation + 10-20 s
  politeness delay). At ~38 pages a full catalog pass lands around 16 min,
  matching the Python adapter's "a few minutes" note plus its delays. Accepted
  as-is (reliability over speed); the per-store timeout is set with headroom.
- Page 2 of Rozetka repeated 3 SKUs from page 1 (sponsored/promoted tiles);
  SKU-level deduplication handles it.

---

## Phase B — datacenter IP (2026-07-25)

Quick pass:
3 attempts x 2 pages per pair.

| Store        | Client     | Verdict  | Items/attempt | Statuses | Note                         |
| ------------ | ---------- | -------- | ------------- | -------- | ---------------------------- |
| `metro`      | plain      | PASS     | 60            | 200      |                              |
| `novus`      | plain      | PASS     | 60            | 200      |                              |
| `maudau`     | plain      | PASS     | 96            | 200      |                              |
| `okwine`     | plain      | PASS     | 60            | 200      |                              |
| `winewine`   | plain      | **FAIL** | 0             | **403**  | CF challenge, instant (0.2s) |
| `winewine`   | impit      | PASS     | 48            | 200      | impersonation clears it      |
| `wine-point` | plain      | PASS     | 48            | 200      |                              |
| `goodwine`   | plain      | PASS     | 48            | 200      |                              |
| `goodwine`   | impit      | PASS     | 48            | 200      |                              |
| `rozetka`    | playwright | PASS     | 123           | 200      |                              |

**The key finding: the datacenter IP does not match the old code's notes.**
`winewine` — which nothing in the Python scraper flags as protected — gets an
instant 403 Cloudflare challenge on plain `fetch`, while `goodwine` — the one
store the Python code explicitly wraps in `curl_cffi` — passes plain cleanly.
So plain-vs-impersonation cannot be decided from the legacy code; it has to be
measured per store from a datacenter IP, which is exactly what this spike is
for. `winewine` needs `impit`; every other store's cheapest client holds.

### Soak — full catalogs, single continuous pass, datacenter IP

| Store      | Client     | Pages | Items | In stock | Duration | Non-200       | Challenge |
| ---------- | ---------- | ----- | ----- | -------- | -------- | ------------- | --------- |
| `winewine` | impit      | 15    | 318   | 202      | 90 s     | one 404 (end) | none      |
| `goodwine` | plain      | 32    | 768   | 768      | 6.2 min  | none          | none      |
| `rozetka`  | playwright | 40    | 2328  | 451      | 20.1 min | none          | none      |

No Cloudflare escalation appeared under sustained load — not on `winewine`
via `impit`, not on `goodwine` via plain across a full 32-page walk, and not on
`rozetka` across 40 pages / 20 minutes of continuous headless-browser traffic
(the single most ban-prone path in the whole system). The trailing 404 on
`winewine` is the natural end of the catalog (page 15 past the last page), not
a block. `rozetka`'s ~20 min full pass confirms the reliability-over-speed
budget; the per-store timeout is set with headroom.

---

## Decision — GO (full migration to TypeScript)

Every store is reachable from a datacenter IP with a Node client, so no store
falls to the hybrid Python contingency.

Per-store HTTP strategy for the engine's `HTTP_STRATEGY_BY_SLUG` map:

| Store(s)                                              | Strategy    |
| ----------------------------------------------------- | ----------- |
| all 19 Zakaz.ua networks, `maudau`, `okwine`          | plain fetch |
| `winewine`, `wine-point`, `goodwine`                  | **impit**   |
| `rozetka` (+ `silpo`, kept disabled) — `needsBrowser` | playwright  |

### Resolved — pre-emptive `impit` on CF-fronted HTML stores

`winewine` proved a plain-fetch store can start 403ing from a datacenter IP
with no warning. `wine-point` and `goodwine` are the same platform family
(WooCommerce / Magento behind Cloudflare) and pass plain **today**, but could
flip the same way. `impit` costs ~nothing (goodwine: 11-14 s either client)
and is strictly more browser-like.

**Decision (user, 2026-07-25): put all three CF-fronted HTML stores on
`impit`.** Only the JSON-API stores stay on plain `fetch`; `rozetka`/`silpo`
stay on the browser. This trades slightly wider reliance on a pre-1.0 native
dependency (already isolated behind the `ScrapeHttpClient` interface) for a
much smaller chance of a surprise production 403.
