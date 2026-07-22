# Whisky Scrapper — Backend (Node.js API)

The NestJS API for the whisky price monitor. It **owns the PostgreSQL schema**
(products, daily price snapshots, per-store sync journal, and the
`brand`/`type`/`flavor`/`country` lookups) and serves the JSON API that the web
SPA consumes — authentication, the price report, catalog meta, and the admin
screens (stores, users, permissions).

It is the hub of the three-repo project:

- **`../scrapper`** (Python) writes scraped products/snapshots into this
  backend's database — this service owns and migrates the schema; the scraper
  only reads reference data and writes results.
- **`../web`** (React) is the only API client; it also generates its typed
  client from this service's `openapi.json`.

## Stack

- **NestJS 11** on **Fastify 5**, **TypeScript** (strict).
- **TypeORM** + **PostgreSQL 18** (entity PKs default to native `uuidv7()`).
- **Valkey 8** (Redis-compatible) for sessions and caching.
- **JWT** access + refresh auth; **Argon2id** hashing (`@node-rs/argon2`).
- **Pino** logging; **Swagger** (`@nestjs/swagger`) served at `/docs`.
- Formatting: **dprint**. Linting: **ESLint 9**. Husky + lint-staged on commit.

## Prerequisites

- **Node 22** (see `.nvmrc`) and **pnpm 10** (`corepack enable` picks up the
  pinned version).
- **Docker** or **Podman** for the local Postgres + Valkey.

## Prepare

```bash
pnpm install
# create .env in this dir (no .env.example yet — use the block below)
docker compose -f docker-compose.dev.yaml up -d   # Postgres 18 + Valkey 8
pnpm init                # run migrations + create the first admin (one-time)
```

`.env` (dev defaults that match `docker-compose.dev.yaml`):

```dotenv
APP_PORT=4000
APP_HOST=0.0.0.0
APP_NAME=Whisky Scrapper
APP_LOGLEVEL=info

# The dev compose seeds Postgres from these same three values, so keep them
# in sync with whatever the container was first created with.
DB_HOST=localhost
DB_PORT=5431
DB_NAME=db
DB_USER=user
DB_PASS=1
DB_LOGGING=false

VALKEY_HOST=localhost
VALKEY_PORT=6378

# Required — no default. Any long random string.
JWT_ACCESS_SECRET=change-me
JWT_ACCESS_EXPIRES=600       # access-token TTL, seconds
REFRESH_EXPIRES_SEC=2592000  # refresh-token TTL, seconds (30d)
```

Only `JWT_ACCESS_SECRET` is mandatory; the rest have sensible defaults (see
`src/config/parts/*`). The Valkey client reads the `VALKEY_*` names, **not**
`REDIS_*`.

## Run

```bash
pnpm start        # nest start (watch) — API on http://localhost:4000
```

- REST API is served at **bare paths** (`/auth`, `/report`, `/meta`, ...); the
  web app reaches them same-origin under `/api/*` (its dev proxy / prod nginx
  strips the prefix).
- Swagger UI: **http://localhost:4000/docs** (JSON at `/docs-json`).

## Scripts

| Command                    | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `pnpm start`               | Dev server (Fastify) on `:4000`                       |
| `pnpm build`               | `nest build`                                          |
| `pnpm build:prod`          | Production build (`tsconfig.build.json`)              |
| `pnpm start:prod`          | Run the built app (`node dist/src/main.js`)           |
| `pnpm lint`                | ESLint with autofix                                   |
| `pnpm test` / `test:cov`   | Jest unit tests (+ coverage)                          |
| `pnpm openapi`             | Emit `openapi.json` — input for the web client codegen; **commit it** |
| `pnpm init`                | One-time bootstrap: run migrations + create 1st admin |
| `pnpm migration:generate <name>` | Diff entities → new migration in `./migrations/`|
| `pnpm migration:create <name>`   | Empty migration skeleton                        |
| `pnpm migration:run` / `:revert` | Apply / roll back migrations                    |
| `pnpm clean-names`         | Maintenance: normalize existing product names         |

One-time SQLite import (historical data only, not a live bridge):

```bash
pnpm exec ts-node -r tsconfig-paths/register scripts/sync-from-sqlite.ts \
  [<sqlite-path>] [--dry-run] [--tables=country,store,...]
# path: <arg> > $LEGACY_SQLITE_PATH > ./whisky.db (this repo root); errors if absent
```

## Database & migrations

TypeORM `DataSource` lives in `typeorm.config.ts`; migration files in
`./migrations/`. All `migration:*` scripts route through `scripts/migration.ts`,
which pins generated/created files to `./migrations/` and injects
`-d ./typeorm.config.ts` — pass only a bare `<name>`. PostgreSQL 18 is required
(native `uuidv7()`).

## How it fits together

- **Web frontend (`../web`)** — consumes this API. It is served same-origin in
  production (nginx proxies `/api` here) so the `HttpOnly; Secure;
  SameSite=strict` refresh cookie works without CORS. After any contract change,
  run `pnpm openapi` here, then `pnpm codegen` in `../web`. Endpoint/field map:
  [`MIGRATION.md`](MIGRATION.md).
- **Python scraper (`../scrapper`)** — writes products, snapshots and
  `sync_log` rows straight into this backend's Postgres. This service is the
  **schema owner**; the scraper never creates or migrates tables.
- **Valkey** — refresh-session storage and caching.

## Production / Docker

- [`Dockerfile`](Dockerfile) — production image.
- [`docker-compose.yaml`](docker-compose.yaml) — runs the API container against
  an **external** PostgreSQL + Valkey: it joins their networks and reads `DB_*`
  / `VALKEY_*` (plus the secrets) from its `environment` block.

## Notes

- Architecture, layering rules and path aliases (`~*`, `~types`, ...) are in
  [`CLAUDE.md`](CLAUDE.md).
