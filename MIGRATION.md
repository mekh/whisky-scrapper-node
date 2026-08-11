# Frontend migration map (legacy FastAPI → Node API)

Reference for porting the legacy web UI (the Python FastAPI app's former
`whisky/web`, since removed) to the React frontend (`../web`) talking to this
Node API.

Guiding differences from the legacy API:

- **Field names are camelCase, exactly as stored in the database.** No
  snake_case adaptation layer. (`current_price` → `price`, `volume_ml` →
  `volumeMl`, etc.)
- **No UI text in responses.** The legacy `note`/`title` strings (e.g.
  `"нова позиція"`, `"діє N дн."`, `"дешевше на N%"`, report titles) are gone.
  The API returns **structured** fields (`isNew`, `daysNew`, `daysDiscount`,
  `discountPct`, `referencePrice`) and the frontend composes any display text /
  i18n.
- **Filter options come from the database**, not hardcoded lists. `flavors`
  and `types` in `/meta` are the `flavor` / `type` tables; `countries` are the
  countries actually referenced by products.
- **IDs are UUID v7 strings** (were integers).
- **Auth** is bearer-JWT + a refresh cookie; every non-public endpoint needs
  `Authorization: Bearer <access>`.

## Auth

| Legacy                                                                                   | Node                                                                  | Notes                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /login` `{login,password}` → `{access_token, token_type}` + `refresh_token` cookie | `POST /auth/login` `{login,password}` → `{access}` + `refresh` cookie | Response key is `access` (no `token_type`). Cookie is `refresh`, HttpOnly, `sameSite=strict`, `path=/`. Migrated (pbkdf2) users log in with old passwords; the hash is upgraded to Argon2 on first login. |
| `POST /refresh` (refresh cookie) → `{access_token,…}`                                    | `POST /auth/refresh` (refresh cookie) → `{access}`                    | Rotates the refresh cookie.                                                                                                                                                                               |
| `POST /logout`                                                                           | `POST /auth/logout`                                                   | Revokes the session. `204`.                                                                                                                                                                               |
| —                                                                                        | `GET /auth/me` → `{id, sid, admin}`                                   | Current user from the token.                                                                                                                                                                              |
| —                                                                                        | `GET /auth/session[/:userId]`, `DELETE /auth/session/:userId/:sid`    | Session listing/revocation (new).                                                                                                                                                                         |

Access token payload: `sub` (user id), `sid` (session id), `admin`, `scope`
(space-separated `resource:action`). Admins bypass scope checks.

## Endpoint map

| Legacy                                                                                | Node                                                                                                                                         | Auth               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `GET /api/meta`                                                                       | `GET /meta`                                                                                                                                  | any logged-in user |
| `GET /api/report/{kind}`                                                              | `GET /report/{kind}` (`kind`: catalog\|drops\|low\|new\|best)                                                                                | any logged-in user |
| `GET /api/history?term=`                                                              | `GET /report/history?term=` — `term` takes a report row's id (a store offer), a canonical `productId` (resolved to that bottling's in-stock, most recently seen offer), or a name/URL substring. The series is always one store's price history | any logged-in user |
| `GET /api/config`                                                                     | `GET /store` (sites + config) + fixed constants in `/meta`                                                                                   | admin              |
| `GET /api/stores/{slug}`                                                              | `GET /store/{slug}`                                                                                                                          | admin              |
| `PATCH /api/stores/{slug}` `{active}`                                                 | `PATCH /store/{slug}` `{active}`                                                                                                             | admin              |
| — (new)                                                                               | `POST /store/{slug}/sync` — starts an on-demand sync, `202` + the open sync-log row                                                          | `store:sync`       |
| — (new)                                                                               | `GET /store/sync-status` — the syncs currently in flight                                                                                     | admin              |
| — (new)                                                                               | `POST /product/update` `{id, name?, countryCode?, typeName?, age?, abv?, volumeMl?}` — edit product overrides (undefined fields untouched). `id` accepts a report row's id (a store offer) or a canonical `productId`; either way the edit writes the **bottling**, so it applies to every store listing it | `product:edit`     |
| `GET/POST /api/users`, `POST /api/users/{id}/active`, `POST /api/users/{id}/password` | existing `user` module: `GET/POST /user`, `GET/PATCH/DELETE /user/:id`, `POST /user/password[/:userId]`, `GET/PUT /user/:userId/permissions` | admin              |
| `GET /` + static                                                                      | unchanged — the frontend is hosted separately (point it at this API's base URL)                                                              | —                  |

Report list responses are paginated: `{ data: ReportRow[], total, limit,
offset }` (was `{rows, title, latest_date, count, page, per_page, total_pages}`
— `title` dropped; `total`/`limit`/`offset` replace `count`/`per_page`/`page`).

The read endpoints (`GET /meta`, `GET /report/{kind}`, `GET /report/history`,
`GET /store`, `GET /store/{slug}`) send `Cache-Control: private, max-age=600`
so the browser caches them for 10 minutes; a hard reload bypasses it. Mutations
(`POST /product/update`, `PATCH /store/{slug}`, `POST /store/{slug}/sync`) and
`auth`/`user` endpoints are uncached; `GET /store/sync-status` is explicitly
uncacheable (`private, no-cache, no-store, must-revalidate`) because the web
client polls it while a sync runs.

### Sync endpoints

`POST /store/{slug}/sync` (permission `store:sync`) starts a sync of one store
and returns `202` immediately with the freshly opened `sync_log` row — the
collection itself continues in the background. Failure cases: `404` unknown
slug; `400` when the store is inactive, has no scrape configuration, or is
still owned by the legacy Python scraper; `409` when the store — or any store
of its concurrency `group` — is already syncing (the message names the
blocker).

`GET /store/sync-status` (permission `store:list`) returns the runs currently
in flight, oldest first:

| Field       | Notes                                                   |
| ----------- | ------------------------------------------------------- |
| `storeId`   | Store being synced                                      |
| `storeSlug` | Its slug                                                |
| `group`     | Concurrency group, or `null`                            |
| `startedAt` | When the run started                                    |
| `total`     | Products written so far (updated as the run progresses) |

An empty array means nothing is running.

## Field maps

### ReportRow (report list items + `history.product`)

| Legacy           | Node                        | Notes                                                                                                                                                                                                                                         |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (int)       | `id` (uuid)                 | the **store offer** — one row per store × SKU. Unchanged by the catalogue split; still what `/report/history` and `/product/:id` take                                                                                                          |
| —                | `productId` (uuid)          | new — the **bottling** this row is an offer of. Rows from different stores sharing it are the same whisky: that is how `best` groups them, and an edit through any of them applies to all                                                       |
| `store`          | `storeName`                 |                                                                                                                                                                                                                                               |
| —                | `storeSlug`                 | new                                                                                                                                                                                                                                           |
| —                | `sku`                       | new                                                                                                                                                                                                                                           |
| `name`           | `name`                      | the product alone — brand + expression (see the note below the table); **nullable** — `null` when cleaning left nothing, fall back to `nameOrig`                                                                                              |
| —                | `nameOrig`                  | new — raw scraped name, always present; the display fallback for `name` and the value shown (read-only) in the edit modal                                                                                                                     |
| `url`            | `url`                       |                                                                                                                                                                                                                                               |
| `current_price`  | `price`                     |                                                                                                                                                                                                                                               |
| `previous_price` | `previousPrice`             | price of the immediately previous snapshot                                                                                                                                                                                                    |
| —                | `referencePrice`            | the value the discount is measured against (previous observed price / window max / competing offer); report-specific, always from our own price history, never `oldPrice`                                                                     |
| —                | `oldPrice`                  | store strike-through price from the latest snapshot                                                                                                                                                                                           |
| `discount_pct`   | `discountPct`               |                                                                                                                                                                                                                                               |
| `age_years`      | `age`                       |                                                                                                                                                                                                                                               |
| `abv`            | `abv`                       |                                                                                                                                                                                                                                               |
| `volume_ml`      | `volumeMl`                  |                                                                                                                                                                                                                                               |
| `whisky_type`    | `type`                      |                                                                                                                                                                                                                                               |
| —                | `brand`                     | new                                                                                                                                                                                                                                           |
| `country`        | `countryName`               |                                                                                                                                                                                                                                               |
| `country_code`   | `countryCode`               |                                                                                                                                                                                                                                               |
| `country_flag`   | `countryIcon`               |                                                                                                                                                                                                                                               |
| `currency`       | `currency`                  |                                                                                                                                                                                                                                               |
| —                | `inStock`, `promo`          | new; `promo` comes from the latest snapshot. `inStock` is the product's current availability (2026-08-08): list endpoints only ever return `true` (out-of-stock products are filtered out, not deleted), `/report/history` can return `false` |
| —                | `flavors` (string[])        | new                                                                                                                                                                                                                                           |
| —                | `firstSeen`, `capturedDate` | new (`YYYY-MM-DD`)                                                                                                                                                                                                                            |
| `is_new`         | `isNew`                     |                                                                                                                                                                                                                                               |
| `days_new`       | `daysNew`                   |                                                                                                                                                                                                                                               |
| —                | `daysDiscount`              | new — days the current price has held (days since it was last higher); `drops` only, null elsewhere. Structured replacement for the legacy `"діє N дн."` note                                                                                 |
| `note`           | —                           | removed (was UI text)                                                                                                                                                                                                                         |

**`name` holds the product alone.** The category prefix, age, ABV, volume,
packaging and bundle descriptors are stripped at scrape/import time, so the
client builds the display name by appending `age` / `abv` / `volumeMl` back to
it (see `web/src/entities/report/model/compose-name.ts`). When `name` is
`null`, show `nameOrig` **as-is** and append nothing — the raw name already
carries all of them inline.

Consequence for the client: **one `name` now covers what used to be several
rows.** A bottling listed as `Aerstone, Land Cask` by one store and
`Aerstone Land Cask` by another, plain vs boxed, and bottle vs bottle-with-two-
glasses all collapse onto the same name, so rows that used to look distinct now
group together. `volumeMl` still separates a multipack from a single bottle.

### Offers vs products

A report row is still one store's offer, and `id` still identifies it. What is
new is that the offer now points at a **canonical product** — the bottling
itself — through `productId`, and everything that describes the whisky rather
than the sale (`name`, `age`, `abv`, `volumeMl`, `brand`, `type`, the country
fields, `flavors`) is that product's single stored value, read identically by
every store's row. Only `id`, `sku`, `url`, `nameOrig`, `storeSlug`,
`storeName`, `inStock`, `firstSeen` and the price fields vary between the
offers of one bottling.

Two practical consequences: the filters `types`, `countries`, `minVolume`,
`maxVolume`, `flavors` and `excludeFlavors` now answer the same way for every
store carrying a whisky (before the split two stores' rows could disagree),
and `POST /product/update` edits the bottling, so one call fixes every store at
once.

### Report query params

Same set as legacy, camelCased: `stores`, `minPrice`, `maxPrice`, `minVolume`,
`maxVolume`, `flavors`, `excludeFlavors`, `types` (was `whisky_type`; now a CSV,
`unknown` matches typeless products), `countries`, `minDiscount`, `name`,
`window` (today|yesterday|week|month|year), `sort`, `order` (asc|desc), `page`,
`perPage`. Multi-value params are comma-separated (e.g. `stores=maudau,novus`).
`window` drives the `low`/`drops` lookback with `week|month|year`; for the `new`
report `today`/`yesterday` instead narrow listings to that added-on day (`/meta`
`windows` still lists only the period values). The `new` report measures recency
(`daysNew`, the `NEW_DAYS`-day window, and `today`/`yesterday`) against the real
current date — not the latest snapshot date — so ages are true elapsed days and
the report is empty when nothing has appeared in the last `NEW_DAYS` days. The
`drops` report likewise carries `daysDiscount` — how long the current price has
held (days since it was last higher), measured against the same real current
date; `null` on every other report.

`sort` values (ReportRow fields): `storeName`, `name`, `type`, `countryName`,
`age`, `abv`, `volumeMl`, `previousPrice`, `price`, `discountPct`,
`daysDiscount`. Nulls sort last. Omitting `sort` keeps the report's natural
order (e.g. `drops` by discount desc); the web `drops` tab defaults its view to
`sort=daysDiscount&order=asc` (freshest price drops first).

### `/meta`

| Legacy                       | Node                           | Notes                                                       |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `stores[].needs_browser`     | `stores[].needsBrowser`        | + `active` added                                            |
| `whisky_types`               | `types`                        | now from the `type` table                                   |
| `flavors`                    | `flavors`                      | now from the `flavor` table                                 |
| `countries[].name` / `.flag` | `countries[].nameUa` / `.icon` |                                                             |
| —                            | `allCountries[]`               | all countries, for edit dropdowns (superset of `countries`) |
| `per_page_options`           | `perPageOptions`               |                                                             |
| `default_per_page`           | `defaultPerPage`               |                                                             |
| `windows`                    | `windows`                      | unchanged                                                   |

### Store detail (`GET /store/:slug`)

| Legacy          | Node                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `url`           | `baseUrl`                                                                  |
| `created_at`    | `createdAt`                                                                |
| `product_count` | `productCount`                                                             | the store's in-stock offers (unchanged meaning) |
| `last_sync`     | `lastSync`                                                                 |
| `recent_syncs`  | `recentSyncs`                                                              |
| —               | `color`, `active`, `tier`, `needsBrowser`, `retailChain`, `category` (new) |
| —               | `group`, `engine` (new — see below)                                        |

`group` (from `store_config.group`, nullable) is the sync-concurrency group:
stores sharing a non-null group never sync at the same time; today only the 19
Zakaz.ua networks are grouped as `zakaz`. `engine` (from `store_config.engine`,
`python` \| `ts` \| `python-api`, default `python`) is which scraper owns the
store; the `be/` sync path only acts on `ts` stores. Both also appear on the
`GET /store` list items.

Sync-log entry fields: `added`, `removed`, `updated`, `total`, `success`,
`error`, plus `id`, `storeId`, `createdAt` (was `started_at`), `updatedAt` (was
`updated_at`), `finishedAt`, `group`, `trigger` (`manual` \| `cron`; null on
rows written before the sync overhaul).

## Things intentionally not reproduced

- **`config.toml` report defaults** (`min_price`, `max_price`, `new_days`, …):
  now fixed server constants (`~constants/report.constants.ts`); unset filters
  simply mean "no constraint". `windows`/`perPageOptions`/`defaultPerPage` are
  in `/meta`.
- **Collector settings** exposed by legacy `/api/config` (`delay_multiplier`,
  `apply_exclude_flavors`): belong to the Python scraper, not this API.
- **`best` offer grouping** reads the persisted `productId` — the offers of one
  bottling — rather than recomputing a key at read time. The key itself
  (normalized name + brand + volume + age, no ABV) is derived once, when a
  store first lists a SKU, and then frozen; a mismatch is corrected by hand and
  the correction sticks. The intent is unchanged from legacy: the same product
  across ≥2 stores, cheapest. Two guards remain — a group must span at least
  two stores (one store can list the same bottling twice), and a winner far
  below the runner-up is dropped as an implausible deal. Products with no known
  volume now participate, where the old read-time key had to skip them.

## Errors

Typed JSON errors from the global exception filter, all messages in English:
`400` bad request (validation), `401` not authenticated, `403` not authorized,
`404` not found, `409` duplicate, `500` server/config. Each maps to a dedicated
error class in `src/errors`.
