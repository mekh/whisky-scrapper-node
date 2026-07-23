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
  The API returns **structured** fields (`isNew`, `daysNew`, `discountPct`,
  `referencePrice`) and the frontend composes any display text / i18n.
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
| `GET /api/history?term=`                                                              | `GET /report/history?term=`                                                                                                                  | any logged-in user |
| `GET /api/config`                                                                     | `GET /store` (sites + config) + fixed constants in `/meta`                                                                                   | admin              |
| `GET /api/stores/{slug}`                                                              | `GET /store/{slug}`                                                                                                                          | admin              |
| `PATCH /api/stores/{slug}` `{active}`                                                 | `PATCH /store/{slug}` `{active}`                                                                                                             | admin              |
| — (new)                                                                               | `POST /product/update` `{id, name?, countryCode?, typeName?, age?, abv?, volumeMl?}` — edit product overrides (undefined fields untouched)   | `product:edit`     |
| `GET/POST /api/users`, `POST /api/users/{id}/active`, `POST /api/users/{id}/password` | existing `user` module: `GET/POST /user`, `GET/PATCH/DELETE /user/:id`, `POST /user/password[/:userId]`, `GET/PUT /user/:userId/permissions` | admin              |
| `GET /` + static                                                                      | unchanged — the frontend is hosted separately (point it at this API's base URL)                                                              | —                  |

Report list responses are paginated: `{ data: ReportRow[], total, limit,
offset }` (was `{rows, title, latest_date, count, page, per_page, total_pages}`
— `title` dropped; `total`/`limit`/`offset` replace `count`/`per_page`/`page`).

The read endpoints (`GET /meta`, `GET /report/{kind}`, `GET /report/history`,
`GET /store`, `GET /store/{slug}`) send `Cache-Control: private, max-age=600`
so the browser caches them for 10 minutes; a hard reload bypasses it. Mutations
(`POST /product/update`, `PATCH /store/{slug}`) and `auth`/`user` endpoints are
uncached.

## Field maps

### ReportRow (report list items + `history.product`)

| Legacy           | Node                        | Notes                                                                                                                                                                     |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (int)       | `id` (uuid)                 |                                                                                                                                                                           |
| `store`          | `storeName`                 |                                                                                                                                                                           |
| —                | `storeSlug`                 | new                                                                                                                                                                       |
| —                | `sku`                       | new                                                                                                                                                                       |
| `name`           | `name`                      | cleaned display name (leading category prefix stripped at scrape/import time); **nullable** — `null` when cleaning left nothing, fall back to `nameOrig`                  |
| —                | `nameOrig`                  | new — raw scraped name, always present; the display fallback for `name` and the value shown (read-only) in the edit modal                                                 |
| `url`            | `url`                       |                                                                                                                                                                           |
| `current_price`  | `price`                     |                                                                                                                                                                           |
| `previous_price` | `previousPrice`             | price of the immediately previous snapshot                                                                                                                                |
| —                | `referencePrice`            | the value the discount is measured against (previous observed price / window max / competing offer); report-specific, always from our own price history, never `oldPrice` |
| —                | `oldPrice`                  | store strike-through price from the latest snapshot                                                                                                                       |
| `discount_pct`   | `discountPct`               |                                                                                                                                                                           |
| `age_years`      | `age`                       |                                                                                                                                                                           |
| `abv`            | `abv`                       |                                                                                                                                                                           |
| `volume_ml`      | `volumeMl`                  |                                                                                                                                                                           |
| `whisky_type`    | `type`                      |                                                                                                                                                                           |
| —                | `brand`                     | new                                                                                                                                                                       |
| `country`        | `countryName`               |                                                                                                                                                                           |
| `country_code`   | `countryCode`               |                                                                                                                                                                           |
| `country_flag`   | `countryIcon`               |                                                                                                                                                                           |
| `currency`       | `currency`                  |                                                                                                                                                                           |
| —                | `inStock`, `promo`          | new (from latest snapshot)                                                                                                                                                |
| —                | `flavors` (string[])        | new                                                                                                                                                                       |
| —                | `firstSeen`, `capturedDate` | new (`YYYY-MM-DD`)                                                                                                                                                        |
| `is_new`         | `isNew`                     |                                                                                                                                                                           |
| `days_new`       | `daysNew`                   |                                                                                                                                                                           |
| `note`           | —                           | removed (was UI text)                                                                                                                                                     |

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
the report is empty when nothing has appeared in the last `NEW_DAYS` days.

`sort` values (ReportRow fields): `storeName`, `name`, `type`, `countryName`,
`age`, `abv`, `volumeMl`, `previousPrice`, `price`, `discountPct`. Nulls sort
last. Omitting `sort` keeps the report's natural order.

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
| `product_count` | `productCount`                                                             |
| `last_sync`     | `lastSync`                                                                 |
| `recent_syncs`  | `recentSyncs`                                                              |
| —               | `color`, `active`, `tier`, `needsBrowser`, `retailChain`, `category` (new) |

Sync-log entry fields: `added`, `removed`, `updated`, `total`, `success`,
`error`, plus `id`, `storeId`, `createdAt` (was `started_at`), `updatedAt` (was
`updated_at`), `finishedAt`.

## Things intentionally not reproduced

- **`config.toml` report defaults** (`min_price`, `max_price`, `new_days`, …):
  now fixed server constants (`~constants/report.constants.ts`); unset filters
  simply mean "no constraint". `windows`/`perPageOptions`/`defaultPerPage` are
  in `/meta`.
- **Collector settings** exposed by legacy `/api/config` (`delay_multiplier`,
  `apply_exclude_flavors`): belong to the Python scraper, not this API.
- **`best` offer grouping** uses a match key (brand + significant name tokens +
  volume + age); implementation differs from legacy but the intent (same
  product across ≥2 stores, cheapest) is preserved.

## Errors

Typed JSON errors from the global exception filter, all messages in English:
`400` bad request (validation), `401` not authenticated, `403` not authorized,
`404` not found, `409` duplicate, `500` server/config. Each maps to a dedicated
error class in `src/errors`.
