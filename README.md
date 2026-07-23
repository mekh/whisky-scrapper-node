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
- **`../web`** (React) is the only API client; it generates its typed client by
  fetching this service's `/docs-json` over HTTP at deploy time — so prod must
  run with `SWAGGER_ENABLED=true` (no committed `openapi.json`).

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

| Command                          | What it does                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm start`                     | Dev server (Fastify) on `:4000`                                                                   |
| `pnpm build`                     | `nest build`                                                                                      |
| `pnpm build:prod`                | Production build (`tsconfig.build.json`)                                                          |
| `pnpm start:prod`                | Run the built app (`node dist/src/main.js`)                                                       |
| `pnpm lint`                      | ESLint with autofix                                                                               |
| `pnpm test` / `test:cov`         | Jest unit tests (+ coverage)                                                                      |
| `pnpm openapi`                   | Emit `openapi.json` locally (optional snapshot; git-ignored — web fetches `/docs-json` over HTTP) |
| `pnpm init`                      | One-time bootstrap: run migrations + create 1st admin                                             |
| `pnpm migration:generate <name>` | Diff entities → new migration in `./migrations/`                                                  |
| `pnpm migration:create <name>`   | Empty migration skeleton                                                                          |
| `pnpm migration:run` / `:revert` | Apply / roll back migrations                                                                      |
| `pnpm clean-names`               | Maintenance: normalize existing product names                                                     |

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

## Database backups

[`scripts/db-backup.sh`](scripts/db-backup.sh) dumps the PostgreSQL database,
ships the dump to an SFTP host over an existing SSH-key login, keeps a bounded
number of dumps (pruning the oldest), and can restore any of them back into a
database. It is a self-contained **Bash** script with no Node.js/pnpm
dependency, so it runs cleanly from **system cron**. It shells out to the
standard client tools — `pg_dump`, `pg_restore`, `psql` and OpenSSH's `sftp` —
which must be on `PATH` (see the container note below).

It runs in **safe mode by default**: new data is written (the dump is made and
uploaded), but nothing is ever deleted or dropped — the destructive steps are
only printed. Pass **`--safe=false`** to actually prune old dumps and, on
restore, drop and recreate the target database.

### Configuration

The script sources a Bash config file — `scripts/db-backup.env` by default,
overridable with `--config <path>` or the `BACKUP_CONFIG` env var. Copy the
committed example and fill it in:

```bash
cp scripts/db-backup.env.example scripts/db-backup.env
# then edit scripts/db-backup.env — it is git-ignored (it holds the DB password)
```

| Variable                                    | Required | Default               | Meaning                                                                                                  |
| ------------------------------------------- | -------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `SFTP_TARGET`                               | yes      | —                     | SFTP login as `user@host`. Auth is by SSH key — put `HostName`/`IdentityFile`/`Port` in `~/.ssh/config`. |
| `REMOTE_DIR`                                | yes      | —                     | Absolute directory on the SFTP host where dumps live (created if missing).                               |
| `DB_NAME`                                   | yes      | —                     | Database to back up / restore into.                                                                      |
| `DB_USER`                                   | yes      | —                     | Postgres role.                                                                                           |
| `DB_PASS`                                   | yes      | —                     | Password for that role (passed to the tools via `PGPASSWORD`, never on the command line).                |
| `DB_HOST`                                   | no       | `localhost`           | Postgres host.                                                                                           |
| `DB_PORT`                                   | no       | `5432`                | Postgres port.                                                                                           |
| `BACKUP_PREFIX`                             | no       | `$DB_NAME`            | File-name prefix; dumps are `<prefix>_<UTC-timestamp>.dump`.                                             |
| `MAX_BACKUPS`                               | no       | `14`                  | How many dumps to keep; the oldest beyond this are pruned after each upload (only with `--safe=false`).  |
| `SFTP_PORT`                                 | no       | (ssh_config)          | Override the SSH port (`sftp -P`). Prefer setting it in `~/.ssh/config`.                                 |
| `PGDUMP_BIN` / `PGRESTORE_BIN` / `PSQL_BIN` | no       | tool on `PATH`        | Absolute paths to the client binaries, e.g. `/usr/lib/postgresql/18/bin/pg_dump`.                        |
| `DB_MAINT`                                  | no       | `postgres`            | Restore only: maintenance database to connect to while dropping/recreating `DB_NAME`.                    |
| `ADMIN_USER` / `ADMIN_PASS`                 | no       | `DB_USER` / `DB_PASS` | Restore only: role allowed to DROP/CREATE the database (superuser, or CREATEDB + owner).                 |

Because the config is plain Bash, it can reuse the DB block already in `.env`
instead of duplicating it (`$BE_DIR` is exported by the script before sourcing):

```bash
# scripts/db-backup.env
set -a; . "$BE_DIR/.env"; set +a   # pull in DB_HOST/PORT/NAME/USER/PASS
SFTP_TARGET="backup@backups.example.com"
REMOTE_DIR="/srv/backups/whisky"
MAX_BACKUPS=14
```

### Commands

```bash
# Safe mode is the DEFAULT — destructive steps are only printed, never run.
scripts/db-backup.sh backup                   # dump + upload; prune is previewed
scripts/db-backup.sh backup --safe=false      # dump + upload + actually prune old dumps
scripts/db-backup.sh list                     # list stored dumps, newest first
scripts/db-backup.sh prune --safe=false       # actually apply the MAX_BACKUPS retention
scripts/db-backup.sh restore <file>           # download + validate + print the plan
scripts/db-backup.sh restore <file> --safe=false        # recreate the DB and restore (confirms first)
scripts/db-backup.sh restore <file> --safe=false --yes  # ... skipping the confirmation prompt
```

`backup` always makes a real dump and uploads it — safe mode gates only the
deletion. It uploads to a `<file>.partial` name and renames it into place only
once the transfer succeeds, so an interrupted run never leaves a file that looks
like a finished backup, and the dump is validated (`pg_restore --list`) before
upload. Old dumps are removed only with `--safe=false`; by default the script
just prints which dumps it **would** delete, so nothing is ever lost silently.

`restore` in the default safe mode downloads and validates the dump, prints the
exact commands it would run (terminate sessions, `DROP`/`CREATE DATABASE`,
`pg_restore`), and stops — the database is untouched. With `--safe=false` it
actually recreates the database: it refuses to run until you confirm by typing
the database name (or pass `--yes`), then **drops and recreates the whole
database** so nothing from the old contents (data, objects, or default
privileges) can survive. The restore runs in a **single transaction** (a failure
rolls back to a clean empty database, not a half-restored one), and the dump is
validated _before_ anything is dropped, so a corrupt or wrong file can never
destroy the current data. **Stop the API before restoring** — a live connection
pool reconnects and blocks `DROP DATABASE`; the script terminates leftover
sessions itself, but cannot outrun a running app.

### Cron

Daily dump at 03:30, appending to a log (adjust the path to your checkout):

```cron
30 3 * * * cd /home/mech/Project/whisky-scrapper/be && ./scripts/db-backup.sh backup --safe=false >> /var/log/whisky-db-backup.log 2>&1
```

`--safe=false` is **required in cron for pruning to happen** — without it the
backup uploads but never deletes, so dumps accumulate past `MAX_BACKUPS`.
(`restore` is manual and is never part of cron.) The script logs timestamped
lines to stderr and exits non-zero on any failure, so cron's `MAILTO` (or the
log) surfaces problems.

### Requirements & caveats

- Requires the PostgreSQL **client tools whose major version matches the
  server** (18). On Debian/Ubuntu: `apt-get install postgresql-client-18`.
- If Postgres is only reachable inside its Docker container (no published
  port), either publish the port and point `DB_HOST`/`DB_PORT` at it, or set
  `PGDUMP_BIN`/`PGRESTORE_BIN`/`PSQL_BIN` to small wrapper scripts that
  `docker exec` into the DB container.
- Dumps use `pg_dump -Fc` (compressed custom format); restore is via
  `pg_restore --no-owner --no-acl`, which keeps them portable across roles.
- `restore` recreates the database, so it needs a role allowed to `DROP`/`CREATE`
  it (a superuser, or `CREATEDB` + ownership), reached through `DB_MAINT`
  (default `postgres`). By default it reuses `DB_USER`/`DB_PASS`; override with
  `ADMIN_USER`/`ADMIN_PASS` when a separate admin role is required. It refuses to
  target `template0`/`template1` or a database equal to `DB_MAINT`.
- **Input hardening (destructive-safety).** Every value that reaches an `sftp`
  command or a SQL statement is whitelisted at startup: paths/`REMOTE_DIR` allow
  `[A-Za-z0-9._/-]`, prefixes/file names `[A-Za-z0-9._-]`, and database/role
  names `[A-Za-z0-9_-]`. Anything with a space, glob metacharacter (`* ? [ ]`),
  quote, `;` or newline is rejected **before any dump, upload, `rm` or SQL runs**
  — so, e.g., a trailing space in `REMOTE_DIR` can never turn a delete into a
  wider one, and a DB name can never inject SQL. `MAX_BACKUPS` must be `>= 1`.
  The config file itself is sourced as Bash, so treat it as trusted (`chmod 600`);
  it is the one input assumed not to be hostile.

## Notes

- Architecture, layering rules and path aliases (`~*`, `~types`, ...) are in
  [`CLAUDE.md`](CLAUDE.md).
