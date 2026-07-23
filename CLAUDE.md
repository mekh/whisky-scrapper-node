# Whisky Scrapper — Node.js Backend

NestJS 11 + Fastify + TypeORM + PostgreSQL rewrite of the Python project in
`../scrapper`. Valkey (Redis-compatible) is used for caching/sessions, Pino for
logging, JWT (access + refresh) for auth, Argon2id for hashing.

This document describes the intended architecture and conventions. Follow it
when creating any new file — placement, naming, and layering are strict.

## Commands

All commands run from the `be/` directory with `pnpm`.

```bash
pnpm build                  # nest build
pnpm build:prod             # nest build -p tsconfig.build.json
pnpm start                  # nest start
pnpm start:prod             # node dist/src/main.js
pnpm lint                   # eslint --fix on {src,test}/**/*.ts
pnpm test                   # jest unit tests
pnpm test:cov               # jest with coverage

pnpm openapi                # write ./openapi.json from a running server's
                            # /docs-json (optional local snapshot; git-ignored).
                            # The web frontend fetches /docs-json over HTTP at
                            # deploy instead — prod needs SWAGGER_ENABLED=true.

# TypeORM migrations (DataSource: ./typeorm.config.ts, files in ./migrations/)
pnpm migration:generate <name>   # diff entities -> ./migrations/<ts>-<name>.ts
pnpm migration:create <name>     # empty skeleton in ./migrations/
pnpm migration:run
pnpm migration:revert

# One-time import of the legacy SQLite DB into Postgres. Path resolution:
# <sqlite-path> arg > $LEGACY_SQLITE_PATH > ./whisky.db (be root); fails fast
# if the file does not exist.
pnpm exec ts-node -r tsconfig-paths/register scripts/sync-from-sqlite.ts \
  [<sqlite-path>] [--dry-run] [--tables=country,store,...]
```

Because `scripts/` sits beside `src/`, `nest build` nests the output under
`dist/src/` — the built entry point is `dist/src/main.js` (which `start:prod`
runs).

Pass only the bare `<name>` — no path or extension. All four scripts route
through `scripts/migration.ts`, a thin wrapper over the TypeORM CLI that pins
the output to `./migrations/` (so generated/created files never land in the
project root) and injects `-d ./typeorm.config.ts`. Extra flags after the name
are forwarded to the CLI (e.g. `pnpm migration:generate init --dryrun`).

Local infrastructure: `docker-compose.dev.yaml` starts **PostgreSQL 18**
(host port **5431**, db `db`, user `user`, password `1`) and **Valkey 8**
(host port **6378**). PG 18 is required — entity PKs default to `uuidv7()`,
which PG 18 provides natively.

Formatting is enforced by **dprint** + **ESLint** (strict-type-checked).
Husky and lint-staged run `tsc --noEmit`, `eslint`, and `dprint fmt` on staged
files.

## Path aliases (tsconfig)

| Alias       | Target               | Example                                                                                                                                    |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `~*`        | `src/*`              | `~errors`, `~enums`, `~config`, `~utils`, `~constants`, `~app/context`, `~core/user`, `~domain/auth`, `~lib/logger`, `~decorators/columns` |
| `~types`    | `src/interfaces`     | `import { ID, EntityUser } from '~types'`                                                                                                  |
| `~types/*`  | `src/interfaces/*`   | `~types/entity.interfaces`                                                                                                                 |
| `~common/*` | `src/core/_common/*` | rarely used; prefer `~core/_common`                                                                                                        |

Always import through aliases and barrel files (`index.ts`), never via deep
relative paths across top-level folders. Within the same folder/module use
relative imports (`./`, `../`).

## Directory layout and responsibilities

```
be/
├── typeorm.config.ts        # DataSource for TypeORM CLI (migrations)
├── migrations/              # generated TypeORM migrations
└── src/
    ├── app/                 # application layer: global cross-cutting concerns
    │   ├── app.module.ts    # root module: global guards/interceptors/filters/pipes
    │   ├── context/         # request context (nestjs-cls): ClsService, ContextManager
    │   ├── filters/         # global exception filter
    │   ├── guards/          # AuthJwtGuard, PermissionGuard
    │   └── interceptors/    # LogInterceptor, ValidationInterceptor (outgoing)
    ├── config/              # env-driven config classes
    │   ├── base.config.ts   # BaseConfig: asString/asNumber/asBoolean/asEnum/asArray + self-validation
    │   ├── parts/           # one class per concern: app, db, jwt-access, logger, validation
    │   └── config.module.ts # provides + exports all config classes
    ├── constants/           # plain constants, one file per topic (*.constants.ts)
    ├── core/                # PERSISTENCE layer: one self-contained module per entity
    │   ├── _common/         # BaseRichEntity (id/createdAt/updatedAt), BaseRepository
    │   └── <entity>/        # user/, permissions/ + whisky domain (see below)
    │       ├── <name>.entity.ts      # internal to this folder
    │       ├── <name>.repository.ts  # internal: injected only by <name>.service.ts
    │       ├── <name>.service.ts     # public API of the entity
    │       ├── <name>.module.ts      # exports: [<Name>Service] only
    │       ├── index.ts              # re-exports the module + public services only
    │       └── types/       # DTO classes derived from the entity (*.type.dto.ts)
    ├── decorators/
    │   ├── columns/         # TypeORM column composites (*.column.decorator.ts)
    │   └── fields/          # class-validator composites (*.field.decorator.ts)
    ├── domain/              # BUSINESS layer: feature modules
    │   └── <feature>/       # e.g. auth/
    │       ├── services/    # *.service.ts + index.ts barrel
    │       ├── controllers/ # *.controller.ts (REST handlers)
    │       ├── dto/         # request/response DTOs
    │       └── <feature>.module.ts
    ├── enums/               # shared enums (*.enum.ts): Action, Resource, ErrorCodes, PermissionMode
    ├── errors/              # ErrorBase + typed domain errors (*.error.ts)
    ├── interfaces/          # ALL shared interfaces/types (~types): *.interfaces.ts
    ├── lib/                 # thin wrappers around external infra packages
    │   ├── logger/          # wraps @toxicoder/nestjs-pino (redaction, msg formatting)
    │   └── valkey/          # wraps @toxicoder/nestjs-valkey
    └── utils/               # pure stateless helpers (*.util.ts), e.g. Hash (argon2)
```

### Layering rules

- `core/` (data access) must not import from `domain/` or `app/`.
- **Database access happens only in repositories.** No `EntityManager`,
  query builders, or raw queries anywhere else.
- **Repositories are injected only by `core` services** — never by `domain`
  services, controllers, guards, or anything outside `core`.
- **Each entity has exactly one repository, and only the service of that same
  entity may inject it.** Cross-entity data access goes service → service
  (via the other entity's module), never through a foreign repository.
- **Each `core/<entity>` folder is exposed only as a NestJS module**
  (`<name>.module.ts`), and the module's `exports` array contains **only its
  public services**. Entities and repositories are internal implementation
  details of the folder; the `index.ts` barrel re-exports only the module and
  its public services.
- **`domain` services/modules may only import modules from `core`**: a domain
  module lists the core module in `imports` and its services inject the
  core services exported by it. Direct imports of entities, repositories, or
  any other core-internal files are forbidden. For typing across this
  boundary use the shape interfaces from `~types`.
- `domain/` holds the business logic (never in controllers or repositories)
  and may also use `~config`, `~types`, and other leaf layers.
- `app/` wires everything globally (guards, interceptors, filters, CLS).
- `interfaces/`, `enums/`, `constants/`, `errors/`, `utils/`, `decorators/`
  are leaf layers: they may be imported from anywhere and import (almost)
  nothing but each other.
- `import-x/no-cycle` is an ESLint **error** — see "Avoiding import cycles"
  below.

## Naming conventions

Files are kebab-case with a role suffix; classes are PascalCase with a role
suffix; one primary export per file; every folder has an `index.ts` barrel.

| Kind               | File name                     | Class/export name         |
| ------------------ | ----------------------------- | ------------------------- |
| Entity             | `user.entity.ts`              | `UserEntity`              |
| Repository         | `user.repository.ts`          | `UserRepository`          |
| Entity-derived DTO | `user-public.type.dto.ts`     | `UserPublicType`          |
| Service            | `auth-token.service.ts`       | `AuthTokenService`        |
| Module             | `context.module.ts`           | `ContextModule`           |
| Guard              | `auth-jwt.guard.ts`           | `AuthJwtGuard`            |
| Interceptor        | `log.interceptor.ts`          | `LogInterceptor`          |
| Filter             | `exception.filter.ts`         | `ExceptionFilter`         |
| Config             | `parts/db.config.ts`          | `DbConfig`                |
| Enum               | `resource.enum.ts`            | `Resource`                |
| Error              | `not-found.error.ts`          | `NotFoundError`           |
| Interfaces         | `auth.interfaces.ts`          | multiple types/interfaces |
| Constants          | `headers.constants.ts`        | `UPPER_SNAKE_CASE` consts |
| Util               | `hash.util.ts`                | `Hash` (static class)     |
| Column decorator   | `guid-v7.column.decorator.ts` | `GuidV7Column`            |
| Field decorator    | `password.field.decorator.ts` | `Password`                |

Barrels use explicit named re-exports (`export { X } from './x'`);
`constants/` and `interfaces/` use `export *`.

Database naming: table names are singular lowercase strings passed to
`@Entity('user')` (`PermissionEntity` maps to table `permission`). Unique
indexes are named explicitly (e.g. `user_email_uindex`), FK constraints get
`foreignKeyConstraintName` (e.g. `fk_permission_user`). Numeric/decimal columns
use the `NumericColumn` composite (`~decorators/columns`) so they surface as a
JS `number`, not the string TypeORM returns by default.

## Base-class inheritance (mandatory)

CRUD plumbing lives in shared base classes; concrete classes MUST extend them
so behavior stays uniform. The chain is strict:

- A **`core` repository** whose entity extends `BaseRichEntity`
  (`src/core/_common/base.entity.ts`) MUST extend **`BaseRepository`**
  (`src/core/_common/base.repository.ts`).
- A **`core` service** built on a `BaseRepository`-derived repository MUST
  extend **`CoreBaseService`** (`src/core/_common/core-base.service.ts`) with
  the entity as its generic, and pass the repository to `super()`. Add only
  entity-specific logic; inherit `list`/`findById`/`create*`/`update*`/
  `delete*`. Override an inherited method only when the base leaves it as a
  `Not implemented` stub or the entity needs different behavior.
- A **`domain` service** built on a `CoreBaseService`-derived core service MUST
  extend **`DomainBaseService`** (`src/domain/_common/domain-base.service.ts`),
  parameterized with the entity **shape interface** (`Entity<Name>` from
  `~types`, never the entity class — layering), and pass the injected core
  service to `super()`. Add only feature-specific methods.

## Core layer: entity + repository + service + module

Every `core/<entity>` folder is a self-contained NestJS module composed of
four pieces:

- **Entity** (`<name>.entity.ts`) — TypeORM model, internal to the folder.
- **Repository** (`<name>.repository.ts`) — the only place with DB access;
  custom queries only, no business logic. Injected exclusively by the
  service of the same entity.
- **Service** (`<name>.service.ts`) — the public API of the entity; wraps the
  repository, returns DTO type instances (see below). Other core services
  and `domain` talk to this entity only through it.
- **Module** (`<name>.module.ts`) — provides the entity's repository and
  services; `exports` contains **only the public services**. `index.ts`
  re-exports only the module and those services.

Primary keys are **GUID v7 strings** (`ID` type from `~types`), generated by
the DB via `uuidv7()` default. Every entity:

1. Has a shape interface `Entity<Name>` declared in
   `src/interfaces/entity.interfaces.ts` extending `EntityBaseRich` — this
   interface (not the entity class) is what other layers use for typing.
2. Extends `BaseRichEntity` (gives `id`, `createdAt`, `updatedAt`) and
   `implements Entity<Name>`.
3. Carries **both** TypeORM column decorators and class-validator decorators
   on each field — entities double as validated types. Prefer the composite
   decorators from `~decorators` (`GuidV7Column`, `PasswordColumn`, `Email`,
   `Password`, `Username`, `GuidV7`) over raw ones; lengths come from
   `~constants`.

`PasswordColumn` auto-hashes on write (argon2 via `Hash`) and sets
`select: false`.

Repositories:

```ts
@TypeormRepository(UserEntity) // from @toxicoder/nestjs-typeorm-repository
export class UserRepository extends BaseRepository<UserEntity> {
  // custom queries only; no business logic
}
```

### Avoiding import cycles

Cross-entity relations never import the other entity class. Use the string
entity name plus the shape interface:

```ts
@ManyToOne('UserEntity', (user: EntityUser) => user.id, { onDelete: 'CASCADE' })
@JoinColumn({ foreignKeyConstraintName: 'fk_permission_user', name: 'userId' })
public user!: EntityUser;
```

The same principle applies everywhere: share **interfaces** (`~types`), not
concrete classes, across module boundaries.

### Entity-derived DTOs

Response types are `*.type.dto.ts` classes derived from the entity:
`UserType extends UserEntity`, `UserPublicType extends OmitType(UserType,
['password'])` (mapped types from `@nestjs/swagger`). They currently live
under `domain/<feature>/types/` (moved there during the migration; a
controller imports them relatively via `./types`).

Conversion is **decorator-driven**, not manual. The `@Plain(Dto, ...perms)`
and `@Paginated(Dto, ...perms)` type decorators (`~decorators/types`) wrap the
handler: they run `plainToInstance(Dto, result)` on whatever the handler
returns, so the handler may return a raw entity or a `~types` shape and still
produce a validated DTO instance. The global `ValidationInterceptor` then
`validateOrReject`s that instance. Consequences:

- A controller handler can be typed to return the `~types` shape interface
  (e.g. `EntityUser` / `TypePaginated<EntityUser>`) — the decorator produces
  the concrete DTO at runtime. No `plainToInstance` in service/controller.
- **Use the `*Public*` DTO for responses.** `UserType` inherits the required
  `password` field (`@Password()`), but the column is `select: false`, so it
  is never loaded and outgoing validation of `UserType` would fail. Responses
  use `UserPublicType` (password omitted). The core service returns entities
  without the hash; password never leaves the core layer.

## Whisky domain (data model)

The whisky domain (ported from the legacy Python app, **normalized** — not a
1:1 copy) lives as nine `core/` modules, each following the standard
entity/repository/service/module shape:

- Lookups (dedup targets, unique `name`/`code`): `country` (`code`, `nameUa`,
  `icon`), `brand` (`name`), `type` (`name`, whisky type), `flavor` (`name`).
- `store` (`slug` unique, `name`, `baseUrl`, `color?`, `active`) and
  `store-config` (1:1 → store via `storeId` unique + `fk_store_config_store`;
  `tier`, `delayFrom`/`delayTo` reals, `needsBrowser`, `retailChain?`,
  `category?` — this is scrape-config, unrelated to product category).
- `product` — `storeId`, `sku`, `url`, `name`, `age?`, `abv?`, `volumeMl?`,
  FKs `brandId?`/`typeId?`/`countryId?`, `firstSeen`/`lastSeen` (date). Unique
  `(storeId, sku)`. Many-to-many `flavors` via the `product_flavor` join table.
- `price-snapshot` — `productId`, `price`/`oldPrice?` (`NumericColumn`),
  `currency`, `inStock`, `promo`. **No capture-date column**: the snapshot time
  is the inherited `createdAt`; multiple snapshots per day are allowed; index
  `(productId, createdAt)`.
- `sync-log` — `storeId`, counters, `success?`, `error?`, `finishedAt?`; the
  legacy `started_at`/`updated_at` map to the base `createdAt`/`updatedAt`.

Dropped vs legacy: `products.category` and `products.raw_attrs` (both only ever
consumed by the Python scraper/enrich utilities, never by the API).

Migrations: `1783840439247-init` (`user`, `permission`) and
`1783840751031-whisky-domain` (all of the above) — both applied, formatted per
the `typeorm-migration-format` skill, and drift-free against the entities.

Data migration: `scripts/sync-from-sqlite.ts` (uses the `better-sqlite3`
devDependency) reads the legacy SQLite DB and upserts into Postgres by natural
key, resolving FKs by natural key (legacy integer ids are never carried over).
Brand names pass through `BrandUtils.canonical` (`~utils`, mirrors the scraper's
`normalize.canonical_brand`) so the case/whitespace/Cyrillic variants stores
emit collapse onto one lookup row. Idempotent/re-runnable — a one-time importer
for the historical SQLite data; the Python collector now writes Postgres
directly, so this is no longer a live bridge. Chunked at 500/1000 rows to stay under the PG 65 535-param
limit. Verified against the real 24 MB legacy DB (8 724 products, 210 357
snapshots). Timestamp columns are `timestamp` (no tz); legacy UTC ISO values
shift by the local offset on display — decide a tz policy before production.

## Auth and permissions

Model: a permission is `Resource` × `Action` (enums in `~enums`), stored per
user in the `permission` table (`PermissionEntity`) and encoded into the JWT
as a space-separated `scope` string of `resource:action` pairs
(`AuthTokenService.encodeScopes/decodeScopes`). `AccessJwt` payload: `sub`
(user id), `sid` (session id), `admin`, `scope`.

Special resources: `Resource.PUBLIC` (no auth), `Resource.AUTHENTICATED` (any
logged-in user). Admin users bypass scope checks.

Request flow (both global guards, `AuthJwtGuard` before `PermissionGuard`):

1. `ClsMiddleware` + `ContextModule` fill the CLS `ClsService` (ip, user-agent,
   access token from `Authorization: Bearer`, refresh token from the `refresh`
   cookie). NB: on Fastify the CLS middleware does **not** isolate context per
   request, so `ClsService` behaves like a shared singleton — do **not** store
   per-request auth state on it (see gotcha below).
2. `AuthJwtGuard` verifies the access JWT (`AuthService.authenticate`) and
   stores the resolved `CtxUser` (`{ id, sid, admin, permissions }`) on the
   **per-request Fastify request context** via `ContextManager` (`req.ctx`),
   not `ClsService`. Public resources tolerate a missing/invalid token.
3. `PermissionGuard` reads `AuthPermissionMeta` from handler metadata
   (Reflector key `PERMISSION_META_INJECT_TOKEN`) and checks the user (read
   from `ContextManager`/`req.ctx`) against the required scopes. Every handler
   MUST carry permission metadata — `ContextManager.getMetaOrThrow` throws a
   `ServerError` ("Resource ... is not exposed") otherwise. A tuple may carry a
   `CanDo` callback (e.g. "self"); `PermissionMode.AND/OR` combines tuples.

**Gotcha — read the current user from the request context, not CLS.** Because
`nestjs-cls` is not request-isolated under the Fastify + Nest-middleware setup,
reading/writing `ClsService.user` for authorization leaks state across requests
(an unauthenticated request could be served as a previous user). Both guards
therefore use `ContextManager.create(ctx)` (backed by `req.ctx`, which Fastify
scopes per request) for the current user. New guards/interceptors/decorators
that need the user MUST do the same; `@CurrentUser()` already reads `req.ctx`.
`ClsService` is still used for best-effort request logging context only.

## Config

Every config concern is a class in `src/config/parts/` extending `BaseConfig`:

- Read env vars via `this.asString('NAME') ?? default`, `asNumber`,
  `asBoolean`, `asEnum`, `asArray` — never `process.env` directly.
- Fields are `public readonly`, annotated with class-validator decorators;
  `BaseConfig` self-validates on construction (via `setImmediate`) and throws
  `ConfigurationError` on invalid values.
- Register the class in `config.module.ts` providers/exports AND re-export it
  from `src/config/index.ts`.
- `DbConfig` intentionally has no `@Injectable()` — it is also instantiated
  directly by `typeorm.config.ts` (TypeORM CLI, outside DI).

Known env vars: `APP_NAME`, `APP_HOST`, `APP_PORT` (default 4000),
`APP_LOGGING`, `APP_LOGLEVEL`; `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASS`, `DB_LOGGING`, `DB_SLOW_QUERY_MS`, `DB_RETRY_ATTEMPTS`,
`DB_RETRY_DELAY`; `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES` (seconds,
default 600); logger vars consumed by `@toxicoder/nestjs-pino` (`LOG_LEVEL`,
`LOG_JSON`, `LOG_PRETTY`, `LOG_COLORS`, `LOG_CALLSITES`); Valkey vars
consumed by `@toxicoder/nestjs-valkey` (`VALKEY_HOST`, `VALKEY_PORT`,
`VALKEY_DB`, `VALKEY_PASSWORD`, `VALKEY_MODE`, `VALKEY_PREFIX`,
`VALKEY_INJECT_KEY`).

## Errors

Never throw Nest `HttpException` from business code. Throw typed errors from
`~errors`, all extending `ErrorBase` with an `ErrorCodes` HTTP-status code:
`BadRequestError` (400), `NotAuthenticatedError` (401), `NotAuthorizedError`
(403), `NotFoundError` (404), `DuplicateError` (409), `ServerError` /
`ConfigurationError` (500). The global `ExceptionFilter` maps them to HTTP
responses; 5xx and unknown errors are logged at `error`, expected ones at
`verbose`. To add a new error: create `src/errors/<name>.error.ts` extending
`ErrorBase`, add the code to `ErrorCodes` if needed, re-export from the
barrel.

## Validation

- Incoming: global `ValidationPipe` built from `ValidationConfig`
  (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`,
  `transform: true`); violations become `BadRequestError` with a flattened
  message.
- Outgoing: `ValidationInterceptor` runs `validateOrReject` on response
  objects (arrays supported) — a mismatch is a 500 `ServerError`, so response
  DTOs must carry class-validator decorators and be class instances.
- Reusable field rules belong in `~decorators/fields` composites, with limits
  in `~constants`.

## Logging

Use Nest's `Logger` with a class-name context:
`private readonly logger = new Logger(MyService.name);`. Messages use
printf-style interpolation (`%s`, `%d`, `%o` for objects) — pino renders
them. Secrets (passwords, tokens) are redacted by `LoggerModule` config; keep
new secret-bearing paths in that redact list. Levels in practice: `error` for
unexpected failures, `debug` for request-level info, `verbose` for payload
dumps.

## Code style essentials

Enforced by ESLint (strict + stylistic type-checked) and dprint:

- Max line length **80**, 2-space indent, single quotes, semicolons, trailing
  commas in multiline literals, `1tbs` braces (no single-line blocks).
- Explicit accessibility modifiers (`public`/`private`/`protected`) and an
  explicit return type on every function/method
  (`@typescript-eslint/explicit-function-return-type`).
- One blank line between class members; max one consecutive empty line;
  a blank line before `return` (house style seen throughout).
- Named exports only (no default exports). Imports: node builtins, then
  external packages, then `~` aliases, then relative; type-only imports last.
- No import cycles (`import-x/no-cycle` is an error).

## Current state / known gaps

The project builds, `tsc`/`eslint` are clean, and 35 unit tests pass. Done:

- **Auth works end-to-end.** `domain/auth` (login/refresh/logout/me/sessions)
  is fully implemented with Valkey-backed sessions and a self-describing
  `userId.sid.secret` refresh token. `AuthJwtGuard` + `PermissionGuard` are both
  global (`APP_GUARD`, in that order). `AuthService.authenticate` is implemented.
- **Dual-hash login.** `Hash.verifyAsync` verifies both Argon2 and legacy
  `pbkdf2_sha256$…` hashes (detected by prefix); `Hash.needsRehash` flags
  pbkdf2. On a successful login `AuthService.login` upgrades a pbkdf2 hash to
  Argon2 (`upgradeHashIfNeeded` → `CoreUserService.changePassword`). Lets
  migrated users log in with their old passwords, transparently re-hashed.
- `core/user`, `core/permissions` (now full module: `CorePermissionModule`/
  `CorePermissionService`), and the whisky-domain modules all follow the
  base-class chain. `domain/user` (CRUD + permissions) is complete.
- Schema + data migration complete and verified (see "Whisky domain").

Pre-existing bugs fixed while wiring auth (context for future changes):

- `req.cookies` could be undefined in the CLS setup → guarded with `?.`.
- `user`↔`permission` relation inverse sides pointed at columns, not the
  relations, breaking `permissions` eager/relation loads (`joinColumns`
  undefined) — fixed to reference the paired relation by name.
- JWT `secret` leaked into `jsonwebtoken` options → dropped from
  `signOptions`/`verifyOptions` (the JwtModule secret is authoritative).
- The `nestjs-cls` request-isolation issue (see the auth gotcha above).

- **Read-API is built** (`domain/report`, `domain/meta`, `domain/store`):
  `GET /meta` (filter options — all DB-sourced), `GET /report/:kind`
  (`catalog|drops|low|new|best`, paginated) + `GET /report/history`, `GET
  /store` + `GET /store/:slug` + `PATCH /store/:slug` (admin). The report SQL
  (latest snapshot + previous + joins, keyed on `price_snapshot.createdAt`)
  lives in `ProductRepository`; report logic (per-kind rules, sort, pagination,
  best-offer grouping) in `ReportService`. Response DTOs are camelCase (DB field
  names), carry no UI text (structured `isNew`/`daysNew`/`discountPct`/
  `referencePrice` instead of the legacy `note`). Whisky types/flavors come from
  the `type`/`flavor` tables, never hardcoded. The whisky core graph is wired
  via the aggregate `CoreWhiskyModule` (`~core/core-whisky.module`) so all
  related entities register together under `autoLoadEntities`. The GET read
  endpoints (`/report/*`, `/store`, `/store/:slug`, `/meta`) send
  `Cache-Control: private, max-age=600` via the `@CacheControl` decorator
  (`~decorators/http`), so the browser caches them for 10 minutes and a hard
  reload bypasses it; mutations and `auth`/`user` endpoints stay uncached.

**`MIGRATION.md`** is the endpoint + field map (legacy → node) for the future
React frontend — update it alongside any API contract change.

**OpenAPI / security.** The `@nestjs/swagger` CLI plugin is enabled in
`nest-cli.json` (auto-`@ApiProperty` on DTOs/entities). The `@Plain` /
`@Paginated` type decorators also emit the `@ApiOkResponse` schema (paginated
endpoints get the `{ data, total, limit, offset }` envelope with `data` items
`$ref`-ing the item DTO), so `/docs-json` fully describes every response. The
web frontend generates its client by fetching `/docs-json` over HTTP at deploy
(`../web/deploy/deploy.sh`), so **prod must run with `SWAGGER_ENABLED=true`** (the
route is gated by that flag — see `main.ts` — and blocked publicly by nginx +
iptables). `pnpm openapi` (server up) still snapshots it to a git-ignored local
`./openapi.json` for manual inspection. `@fastify/helmet` is registered in `main.ts` (its CSP is relaxed
for the Swagger UI; the SPA's own CSP belongs on the reverse proxy). No global
route prefix is used — the SPA reaches the API same-origin via a `/api` proxy
that strips the prefix.

Still open:

- The Python collector writes Postgres directly, so `sync-from-sqlite.ts` is now
  a one-time importer for the historical SQLite data, not a live bridge. Still
  missing: an owned seed for `store`/`store_config`/`country` so a fresh DB can be
  populated without importing that legacy file.
- The React frontend (`../web`) has replaced the legacy Python-served UI (which
  was removed) and consumes this API per `MIGRATION.md` (login returns
  `{ access }`, fields are camelCase, `/meta` keys renamed, etc.).
The original Python implementation (now scraper-only, in `../scrapper`) is the
functional reference for the eventual feature set, but its code style and
structure are NOT to be copied.
