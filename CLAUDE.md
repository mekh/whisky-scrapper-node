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

node dist/scripts/migrate.js     # prod runner (no ts-node): waits for the DB,
                                 # applies pending migrations, exits 0/1
scripts/deploy.sh                # prod deploy: build -> run migrate -> up -d

# LLM flavor classification of stored products (no sync lock, re-runnable).
# --limit costs a model on one batch before committing to the full sweep.
pnpm enrich-flavors [--dry-run] [--store <slug>] [--limit <n>]

# Knowledge base. Merge the research into the seed files, recompute the
# catalogue from them, and read the disagreements the scrape logged.
pnpm kb-merge <agent-output-dir> <seed-output-dir> [curation-dir]
pnpm reconcile-flavors [--dry-run] [--out <tsv>] [--store <slug>]
                       [--brand <name>] [--keep-unknown-peat]
                       [--report-attr-conflicts]
pnpm fact-conflicts [--attribute <name>] [--store <slug>]   # read-only
pnpm rederive-name-facts [--dry-run]   # re-stamp type/country from nameOrig
pnpm research-brands [--dry-run] [--limit <n>] [--review]
pnpm kb-export [--out <dir>] [--all]   # freeze the live KB back into TSVs
pnpm kb-verify-merge [--allow-partial] # gate the verification-round outputs
                                       # into the kb-verification-import
                                       # migration's TSV assets

# Local repair: re-apply the checked-in sixteen-agent flavour classification
# over a bad enrich-flavors run. A script, not a migration — the import
# migration already shipped this data everywhere.
pnpm restore-flavor-import [--dry-run]
```

Because `scripts/` sits beside `src/`, `nest build` nests the output under
`dist/src/` — the built entry point is `dist/src/main.js` (which `start:prod`
runs).

Pass only the bare `<name>` — no path or extension. All four scripts route
through `scripts/migration.ts`, a thin wrapper over the TypeORM CLI that pins
the output to `./migrations/` (so generated/created files never land in the
project root) and injects `-d ./typeorm.config.ts`. Extra flags after the name
are forwarded to the CLI (e.g. `pnpm migration:generate init --dryrun`).

In production the image carries no ts-node (a devDependency), so migrations
run through the compiled `dist/scripts/migrate.js` instead: the `migrate`
service in `docker-compose.yaml` runs it from the same image as the app, and
the app service may only start after it exits successfully
(`depends_on: condition: service_completed_successfully`). Deploy via
`scripts/deploy.sh` (build → `compose run --rm migrate` → `up -d`): the gate
alone only blocks the new container's **start** — during a bare
`up -d --build` compose still replaces the old container in its create phase,
so a failed migration leaves the app stopped, while the script keeps the
previous version serving. `typeorm.config.ts` anchors its entity/migration
globs to `__dirname` so the one DataSource file works both from the TS
sources (ts-node, dev) and from `dist/` (compiled, prod image) — keep any new
globs anchored the same way.

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
    │   ├── interceptors/    # TimeoutInterceptor, LogInterceptor, ValidationInterceptor
    │   └── middleware/      # RequestDeadlineMiddleware (runs before the guards)
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
    │   ├── valkey/          # wraps @toxicoder/nestjs-valkey (timeouts live here)
    │   ├── watchdog/        # runtime heartbeat: loop lag, memory, pool, cache RTT
    │   └── web-push/        # wraps the web-push package (VAPID, outcome mapping)
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

- **Migrations added by the knowledge-base work**, after the schema trio:
  `kb-seed-producer` / `kb-seed-alias` / `kb-seed-producer-flavor` /
  `kb-seed-rule` (the four TSVs and their fail-closed importers — an unknown
  country, type or peat level, a `peated` house style, or a name alias under
  five characters aborts the whole migration rather than importing a row with a
  silently-null column), and `llm-flavor-restamp`, which clears
  `lastLlmFlavorAt` wherever `flavorsCuratedAt` is null so the whole catalogue
  is a candidate for the re-grounded flavour pass. That last one deletes no
  tag on purpose: a destructive sweep belongs in something dry-runnable, and
  `pnpm reconcile-flavors` already is. After them, `kb-verification-import`
  (2026-08-29) ships the verification round: four TSV assets generated by
  `pnpm kb-verify-merge`, updating producers only `WHERE status =
  'unverified'`, inserting the parents/bottlers/aliases/house-styles/rules
  the round discovered, fail-closed like the seed importers; its `down()`
  removes only what it inserted — the updates are documented irreversible.
  Then `brand-whisky-artifact` (2026-09-01) removes the `& Whisky` brand row
  and rejects its `and-whisky` producer — goodwine's own category label, which
  a legacy import turned into a brand and which the brand-from-name pass then
  handed to every listing ending in the word (see "Brand from the name"). It
  detaches the 14 bottlings explicitly rather than through the FK's
  `ON DELETE SET NULL`, so no provenance column is left stating where a null
  came from, and writes no `producerId`: `SET_PRODUCERS_SQL` is that column's
  only writer, and a rejected producer leaves the resolver index, so
  `KbBootApplyService` clears the 15 links at the next boot. `down()` is a
  documented no-op — re-creating the row would restore the defect, and the
  next sync re-derives every value it cleared.
  Then the three that retire the table altogether (2026-09-01, see "The brand
  label"): `brand-retire-prep` adds `product.brandOrig` and backfills it,
  creates `blacklist_producer` and rewrites every brand rule as a producer
  rule through `producer_alias` — failing closed if any blacklisted brand
  resolves to nothing — and deletes the `product_fact_conflict` rows whose
  `attribute` is `brand`, since their values are ids into a table that is
  about to stop existing; `brand-canonical-regroup` re-signs every
  reproducible match key with the resolved producer's slug and merges the
  collisions (71 restated, 44 merged, 156 offers moved, 14 skipped as
  unreproducible), asserting its own idempotence before it commits and
  nulling the key of every emptied source so nothing can join it again; and
  `brand-drop` drops `blacklist_brand`, `product.brandId`,
  `product.brandSource` and `brand`. The first and third reverse
  structurally, the middle one is a documented no-op — undoing it would put
  one whisky back under several identities.
- Lookups (dedup targets, unique `name`/`code`): `country` (`code`, `nameUa`,
  `icon`), `type` (`name`, whisky type), `flavor` (`name`). There is no
  `brand` lookup any more.
- `store` (`slug` unique, `name`, `baseUrl`, `color?`, `active`) and
  `store-config` (1:1 → store via `storeId` unique + `fk_store_config_store`;
  `tier`, `delayFrom`/`delayTo` reals, `needsBrowser`, `retailChain?`,
  `category?`, `group?` (sync-concurrency group; `zakaz` for the Zakaz.ua
  networks — **11 of them in production**, 19 in the older local database seeded
  from the legacy SQLite import, see [`PARITY.md`](PARITY.md)), `engine`
  (`python`|`ts`|`python-api`, default `python`) — this is scrape-config,
  unrelated to product category.
- `product` — the **bottling**, independent of who sells it: `matchKey?`
  (unique), `name?`, `age?`, `abv?`, `volumeMl?`, FKs
  `typeId?`/`countryId?`/`producerId?`/`bottlerId?`, `brandOrig?`,
  `lastLlmFlavorAt?`, plus one `<field>Source` column per fact (see
  "Fact provenance" below). There is no `brandId`: the label comes from the
  knowledge base (see "The brand label"), and `brandOrig` is the shop's own
  spelling, kept only to feed the research queue. One row per whisky, so a correction, a flavor
  classification and (next) a photo are stored once and read by every store.
- `store-product` — one store's **offer** of a bottling: `storeId`,
  `productId` (FK → `product`, `RESTRICT`), `sku`, `url`, `nameOrig`,
  `inStock` (bool, default true — current availability),
  `firstSeen`/`lastSeen` (date). Unique `(storeId, sku)`; prices hang off this
  row, not off the bottling.
  **`matchKey` is the cross-store identity** (`ProductMatchUtils`, `~utils`): a
  normalized signature of the cleaned name plus the brand, then `|v{ml}|a{age}`.
  Strength is deliberately absent — it is missing on about one row in ten and
  two stores that both state it disagree often enough (`Balvenie DoubleWood` at
  40 % and 43 %) that including it would split a bottling more often than it
  would keep two apart. Bare numbers, on the other hand, are **kept**, unlike in
  the legacy Python key: the name cleaner already lifts strength, size and age
  into their own columns, so a surviving number is part of the name, and
  dropping it merged `Wild Turkey 81` into `Wild Turkey 101` (39 rows on one
  key), `Maker's Mark 46` into `Maker's Mark` and every Octomore release into
  one. The stop-token list is evidence-driven and its **exclusions** are the
  load-bearing part: `bourbon` and `rye` head a cask or grain qualifier far more
  often than they name a category, and `scottish`, `kentucky`, `canadian`,
  `irish`, `british`, `english` and `grain` all head real brands in this
  catalogue (`Scottish Leader`, `Kentucky Owl`, `Canadian Club`, `North
  British`, `Nikka The Grain`). `box` and `gb` **are** stop tokens — every
  occurrence is a gift-box marker on an otherwise identical listing.
  **The key is frozen at creation.** A rename, a filled-in volume or a manual
  edit never re-derives it: re-keying would silently detach the offers already
  linked, and identity is meant to be decided once and corrected by hand.
  Two consequences to keep in mind — a later listing whose key differs creates a
  _second_ bottling that curation must merge, and `age`/`volumeMl` are therefore
  effectively immutable (which is why `pnpm fix-age` and `pnpm fix-volume` were
  retired after their final pre-split run).
  **Matching happens once**, when a store first lists a SKU. The offer upsert
  leaves `productId` out of its conflict-update clause, so nothing a sync does
  can undo a manual relink — see `CURATION.md` for the recipes.
  Flavors hang off the **explicit** `product_flavor` join
  entity (`core/product/product-flavor.entity.ts`) — not a TypeORM
  `@ManyToMany`, because the table carries a third column, `source`
  (`scrape`|`llm`, `FlavorSource`), and an implicit `@JoinTable` junction cannot.
  Nothing loads it as a relation; `ProductRepository` owns every row in raw SQL.
  Its `productId` points at the **bottling**, so one classification serves every
  store — which is what the `flavor-llm-import` migration was already doing by
  hand, keyed on the name.
  **The keyword pass now only ever adds links.** It used to delete and re-derive
  its `scrape` rows on every run, which was coherent only while each store owned
  its own product row; on a shared bottling a store whose listing does not
  happen to spell out "торф" would erase what another store's listing stated. A
  keyword hit is evidence _for_ a flavor, never against one, so
  `addScrapeFlavors` inserts with `ON CONFLICT DO NOTHING` and removes nothing.
  The cost is that a stale tag never clears on its own; the escape hatch is a
  data migration, as `flavor-taxonomy-cleanup` already is. `setLlmFlavors` still
  owns and replaces the `llm` rows, and a tag both passes found ends up owned by
  `llm` (the insert promotes it). Promoting the junction to
  an entity had to reproduce the implicit table's DDL exactly — `ON UPDATE
  CASCADE` on both FKs plus a plain index per join column, whose TypeORM-hashed
  names (`IDX_ffe61c…`, `IDX_22847b…`) the entity regenerates identically —
  otherwise `migration:generate` proposes dropping and recreating them. The
  split kept the canonical table named `product` precisely so all of that — the
  primary key, both hashed indexes, the entity's string relation — stayed
  untouched.
  `lastLlmFlavorAt` records when the classification pass last answered, **set
  even for an "unknown" answer**: that answer links no flavor, so without the
  marker it is indistinguishable from never having been asked and every run
  would re-ask (and re-pay) for the same products. It stays null when a batch
  failed, which is what makes `pnpm enrich-flavors` retry those items.
  **Out-of-stock offers are never deleted** — the persist pipeline flips
  `store_product.inStock` instead, so price history survives out-of-stock
  periods and a returning offer keeps its identity (`firstSeen`, and the
  bottling it is linked to). List reads
  (`findCurrentRows`, `/report/*`, `/meta` countries, `/store/:slug`
  `productCount`) filter on `inStock = true`; the single-offer history path
  (`findCurrentRowById`, `/report/history`) still returns flagged rows.
  **`name` holds the product alone — brand + expression.** The age, ABV and
  volume live in their own columns and are re-appended by the web client at
  render time (`entities/report/model/compose-name.ts`), so the user still
  reads "Aber Falls 40% 0,7л" while the database stores "Aber Falls". Two
  passes produce it, both at insert time only (`name` is never written on
  conflict, so manual edits and earlier values survive later scrapes):
  `LlmNameExtractionService` (`scrape/llm/`) for new SKUs when the LLM
  endpoint is configured, and `ProductNameUtils.clean` (`~utils`) as the
  deterministic fallback. `stripSpecs` also runs **over the LLM's answer**, so
  the result is the same whichever pass produced it.
  What the deterministic pass fixes is source formatting, and it is all
  evidence-driven — every rule below was added against a name in the
  catalogue: a stray look-alike letter (`Вiскi` with Latin `i`, `MaсArthur's`
  with Cyrillic `с`) folded back into its own script, but only when every
  minority letter has a look-alike, so a missing space (`ВіскіOld Virginia`)
  is left to the prefix rule; the dual name (`Віскі Боумор №1 / Bowmore №1`)
  resolved to the Latin side, decided on **words** with the specs and
  descriptors removed, because a Roman numeral in the transliteration
  (`Кінг Джордж V`) and the shared trailing `0.7л, в коробці` both fooled a
  letter count; the store product code anywhere in the string, four digits
  minimum so `(NAS)` and a vintage `(1968)` survive; a bundled **accessory**
  (`+ 2 склянки`, `з двома келихами`) dropped, while `+ <another bottle>` is
  kept, since a three-bottle set is its own product at its own price;
  multipack counts, packaging, and the comma that made `Aerstone, Land Cask`
  and `Aerstone Land Cask` two products.
  Two judgement calls are worth knowing. **A category word that heads a cask
  qualifier stays** — `Bushmills Bourbon Finish` names the maturation, and
  stripping `Bourbon` collided it with `Bushmills Rum Finish`; the guard is
  `bourbon` only, because extending it protected `Penelope Whiskey Barrel
  Strength`. **Region words are never stripped** (`Highland Park`, `Islay
  Barley`, and `Clan Denny Islay` is a different whisky from `Clan Denny
  Speyside`), only nationality tags at the very end (`Aber Falls Welsh`); the
  region case that _is_ a provenance tag is settled at catalogue level instead,
  by `collapseTags` in the backfill script.
  Because descriptors survive only in `nameOrig`, the report name
  filter and `resolveIdByTerm` match **both** columns. The report filter adds
  one more pass for a term ending in a number: it is split into a name part
  and an age (`Glenfiddich 12` -> `Glenfiddich` + 12) and matched against
  `product.age`, because the age is stripped from the canonical name and every
  store spells it differently (`12 yo`, `12 років`), so no single substring
  could reach `Glenfiddich Triple Oak`. The two passes are OR-ed
  (`SearchTermUtils.splitAge` + `findCurrentRows`) — a fallback would have kept
  hiding those rows behind the standard bottling the substring does match. Existing rows are
  rewritten by `pnpm clean-names` (`scripts/clean-product-names.ts`,
  `--dry-run` / `--no-llm` / `--store <slug>`), which is a script and not a
  migration on purpose: migrations gate every deploy and must not depend on an
  external API. It does overwrite manual name edits.
  The script owns the three decisions that need the whole catalogue rather
  than one name: **one LLM candidate per distinct `nameOrig`** (per-row
  candidates put the same source name in different chunks and it came back
  cleaned two ways — 66 times), `canonicalSpelling` (one spelling wins per
  group of variants that differ only in case, Latin accent, leading article or
  punctuation — measured on the catalogue, that key produced 65 groups and
  every one was a single product listed twice), and `collapseTags` (a trailing
  region/nationality tag comes off only when some store listed the shortened
  name too, which is what separates `Balblair Highland` → `Balblair` and
  `Bankhall British` → `Bankhall` from `Clan Denny Islay` and the
  `North British` distillery, where no bare `Clan Denny` or `North` exists).
  All three weigh the **whole** catalogue even under `--store`, which only
  narrows what is rewritten: deriving the evidence from one store let a
  one-store run undo a catalogue-wide decision.
  **`age` comes from the name only** (`extractAgeYears(snap.name)`), never from
  the haystack — a description's "N років" is brand history ("понад 250 років"),
  not maturation. Both engines get this right today, but early scraper versions
  did search the description, which recorded NAS bottlings as decades old
  ("Wild Turkey 101" → 60, "Jim Beam White" → 25, "Kilchoman 100% Islay 15th
  Edition" → 15 off the edition number), concentrated in the zakaz.ua chains
  whose listings carry long prose. **Insert-only writes mean those rows were
  never corrected**: 227 of the 2 764 aged rows in a production snapshot came
  from before the fix, and a `novus` dry run confirms the current engine now
  returns no age for exactly those products. `pnpm fix-age` applied the current
  rule retroactively and was **retired with the catalogue split**: age is now a
  component of a bottling's identity, frozen at creation, so a sweep can no
  longer change it. Run it on production _before_ the split migration, or a
  wrong age becomes a manual merge (`CURATION.md`).
  **The age reader and the name stripper are one vocabulary, and drift between them merges whiskies.** `ProductNameUtils` deletes the age token from the display name; `extractAgeYears` lifts it into `product.age` and into the match key. A spelling only one of them knows is the worst case of all: the age disappears from the name **and** is recorded nowhere, so `ProductMatchUtils.key` signs the bottling `|a0` and every age of that expression collapses onto one row. That is exactly what the Cyrillic transliteration `уо` did — Rozetka and MauDau spell it that way, and the 12, 15, 18 and 30 year old Dalmore became one bottling the catalogue served as `Dalmore 12yo 43% 0,7л`, the 30 year old among them at nearly half a million hryvnia. The same asymmetry hid an age typed with a look-alike letter of the other alphabet (`Chivas Regal 12 рокiв` with a Latin `i`), which the stripper folds before matching and the reader did not, so `extractAgeYears` now reads from `ProductNameUtils.foldScripts(text)` too. Adding an age spelling to either file means adding it to both; `test/scrape/normalize.spec.ts` pins the two Dalmore cases and the guards that must survive a wider pattern (a vintage `2013 рік` is not an age, nor is the number in `Vat 69`).
  **Fixing the reader does not fix the stored keys** — nothing on the scrape path re-keys an offer once its SKU is known — which is what the `age-regroup-cyrillic-yo` migration is for; see the migration list below.
  **`volumeMl` is the sum of a gift set's bottles.** `extractVolumeMl` used to
  take the first match in the name, so a set of three 0.7 л bottles was stored
  as 0.7 л — and because the report compares by volume, a three-bottle price
  landed beside single bottles as the worst deal on the page. It now sums the
  segments a `+` joins, via `ProductNameUtils.bundleSegments`, which returns
  null for an accessory bundle (`+ 2 склянки`) and for a brand spelled with a
  `+` (`Roe + Co`) — and strips the product code first, since several codes are
  themselves `+`-joined. `pnpm fix-volume` swept the stored rows (11 of the 12
  sets in a production snapshot were wrong) and was **retired with the
  catalogue split** for the same reason as `pnpm fix-age`: volume is part of a
  bottling's identity now.
  The same trap is why `LlmNameExtractionService` rejects an answer that drops a
  set's other bottles: told to return "the product", the model answered
  `Jura Journey` for a three-bottle set, and token validation passed it because
  every word it kept was in the raw name.
  **Filling a null is now what every sync does.** The canonical write is
  fill-if-null by construction — `fillMissing` only ever replaces a null, so a
  store that reads a spec page contributes to a bottling another store listed
  first, and a manual edit is safe from the next sync. What `pnpm backfill`
  (`scripts/backfill-nulls.ts`, `--dry-run` / `--store <slug>`, repeatable)
  still changes, running the real pipeline through
  `collectStore(slug, { backfill: true })`, is _which items a run looks at_: it
  waives the "new to this store" half of every enrichment gate, so stored
  offers get their detail pages fetched and their fields asked about again.
  **The other half of each gate is the catalogue**, and that is where the
  saving is: a detail page or a model call is bought only when the _bottling_
  is still missing something, not when this particular store is. A store
  onboarding a range the catalogue already covers now fetches almost nothing,
  where before each store paid for its own copy of the same facts.
  Age and volume are in none of it — they are identity, frozen at creation, so
  a backfill cannot change them (a NAS bottling also has no age to find, which
  is why the old gate excluded age even then).
  The detail gate additionally chases a bottling with complete specs but no
  flavor classification: the detail page is the only source of `rawAttrs`,
  which is the only grounding the flavor pass ever gets — the standalone
  `pnpm enrich-flavors` structurally cannot have it.
  The script mirrors the engine's
  progress events to stdout as timestamped lines (every listing page, every
  tenth detail page, the LLM passes, the persist) so a multi-hour run is
  observably alive, prints per-store and total
  before/after null counts, keeps going when one store fails, and **bypasses the
  `sync_log` lock** — nothing may sync those stores while it runs. It is a full
  scrape, so its sweep flags out-of-stock rows exactly as a normal sync does,
  and a full sequential pass over every store takes a few hours (no track
  parallelism, and the detail-page stores fetch far more pages than usual under
  the wider gate).
  Measured over a copy of production, 6 990 rows across the 17 stocked stores:
  `brandId` 1 533 → 187 (a column that no longer exists — see "The brand
  label"; backfill fills type, country and abv only now), `typeId`
  1 690 → 262, `countryId` 828 → 157, `abv`
  103 → 92, `volumeMl` 7 → 5. `age` barely moved (4 451 → 4 437) and that is
  the expected result — those rows are NAS bottlings, not gaps. Of what is
  left, roughly a third sits on out-of-stock rows the run never saw (only a
  listed product can be re-scraped); the rest are in-stock items neither the
  keyword pass nor the LLM could place — a bottler's own series with no brand
  in the catalogue, or a name that states nothing about type or origin.
  **Measured again for `silpo` alone** right after its adapter learned to read
  detail pages, over 831 rows on a copy of production (2026-08-11): `abv`
  778 → **3**, `age` 603 → 385, `typeId` 42 → 8, `countryId` 17 → 5,
  `volumeMl` 3 → 1, and the flavor widening took `lastLlmFlavorAt IS NULL`
  from 487 to 0 while tagged products went 384 → 803. The three rows still
  without an ABV are the ones that should not have one: a 50 ml
  `The Grouse & Cola` RTD and a `Набір Родина Jack Daniel's` gift set (both
  outside `parseAbvValue`'s 30–70 whisky range or having no single strength),
  and a bag of drink ice the store files under whisky. The whole run took
  ~32 minutes at `SCRAPE_DELAY_MULTIPLIER=0.3`. A normal sync straight
  afterwards left every one of those numbers unchanged and all 3 105 `llm`
  flavor links intact while its keyword pass collapsed the `scrape` links to
  5 — which is the check that the flavor widening, not the keyword pass, is
  what makes a stored row's tags durable.
  **Flavors are swept by a different script**, `pnpm enrich-flavors`
  (`scripts/enrich-flavors.ts`, `--dry-run` / `--store <slug>` / `--limit <n>`),
  because they are not a null-column backfill: `product_flavor` rows are
  re-derived on every sync, not insert-only, so nothing needs `COALESCE`
  semantics or a re-scrape. It reads the stored rows directly, classifies them
  through `LlmFlavorService`, and writes only flavor links — so unlike
  `pnpm backfill` it takes **no** sync lock and is safe to run while stores sync.
  Re-runnable: it selects only products with `lastLlmFlavorAt IS NULL`, and an
  answered product is stamped even when the answer was "unknown", so a second run
  neither re-asks nor re-pays for it; a failed batch leaves its items unstamped
  and they are retried. `--limit` exists to cost a model on one batch before
  committing, and the `--dry-run` report (high/low/unknown/unanswered/tagged plus
  15 samples) is what that decision is made on. Grounding is weaker here than in
  the pipeline pass — `rawAttrs` is never persisted, so a stored row offers only
  `nameOrig` + type + country, while a live scrape can also pass the zakaz/okwine
  description — so expect a higher `unknown`/`low` rate from the sweep.
- `price-snapshot` — `storeProductId`, `price`/`oldPrice?` (`NumericColumn`),
  `currency`, `inStock`, `promo`, `capturedOn` (date, default `CURRENT_DATE`).
  **One row per offer per day**, enforced by the unique index
  `(storeProductId, capturedOn)` + an atomic `INSERT ... ON CONFLICT DO UPDATE`;
  plus a plain index `(storeProductId, createdAt)`. `capturedOn` is the UTC calendar
  day (matches the existing `createdAt::date` report basis).
- `sync-log` — `storeId`, counters, `success?` (null = still running), `error?`,
  `finishedAt?`, `group?`/`trigger?` (`manual`|`cron`, denormalized at run
  start); the legacy `started_at`/`updated_at` map to the base `createdAt`/
  `updatedAt`. The concurrency lock is a **partial unique index**
  `sync_log_running_uindex` over `CASE WHEN group IS NOT NULL THEN 'g:'||group
  ELSE 's:'||storeId END` `WHERE success IS NULL` — at most one open run per
  group (or per store, group-less). `@Index(..., { synchronize: false })` keeps
  the expression index out of `migration:generate`.

Dropped vs legacy: `products.category` and `products.raw_attrs` (both only ever
consumed by the Python scraper/enrich utilities, never by the API).

### The knowledge base (`core/producer`) — the single source of truth

Four tables holding curated facts about **producers** rather than about
listings, plus a QA log of the disagreements between stores. They exist because
the catalogue had no authority at all: every fact was whatever a store or a
model said about one listing, so the same whisky disagreed with itself across
shops, and a model asked to recall a distillery's house style answered from the
semantic neighbourhood of the name. Measured on a production dump, among the 439
groups of identically-named bottlings, **59 disagreed on brand, 40 on type, 28
on country and 100 on the peat tags**. The reported symptom was `Tobermory 12`
tagged `smoky`: Tobermory is unpeated, its sibling brand Ledaig (same distillery)
is heavily peated, and the owner filters peat out — so his favourite malt was
silently missing from every result.

- `producer` — distilleries, named brands, blends and independent bottlers in
  one table, keyed by `slug`. Carries `countryId`, `region` (market convention,
  includes `islands`), `legalRegion` (the SWA five, `CHECK <> 'islands'`),
  `owner`, `defaultTypeName`, `peatProfile`, `parentId`, `bottlerId`, and the
  review fields `status`/`confidence`/`sourceUrls`/`note`/`verifiedAt`.
  **`parentId` is the fix for the reported bug**: `Ledaig` is its own row with
  its own peat level whose parent is Tobermory, and the resolver never inherits
  facts through it — a sibling brand exists precisely because its facts differ.
  `region` and `legalRegion` are separate because Tobermory, Talisker, Highland
  Park, Jura and Arran are legally Highland while every shop lists them as
  island malts, and one column cannot answer both questions.
  There is deliberately **no `typicalPpm`**: published phenol figures conflate
  the malt spec, the new-make spirit and the bottled product, which differ by
  three to ten times, so the number would be a fact-shaped guess. The ordinal
  band carries the same information honestly.
- `producer_alias` — every spelling that resolves to a producer, normalized by
  `KbKeyUtils.key`, unique across all producers. **This table is the only
  index anything matches a brand string against** — the resolver, the report's
  label, the blacklist and the autocomplete alike — because the strings shops
  print carry
  typos (`Isiay Mist`, `Douglas Laingcompany`), duplicate spellings (`Macallan`
  beside `The Macallan`) and secret labels (`An Orkney`, which is Highland
  Park) — all of which must reach one researched row. `scope`
  (`brand`|`name`|`any`) plus a five-character floor keeps a short alias from
  mis-firing as a substring: the catalogue holds `Elements of Islay`,
  `M&H Elements` and `Glenmorangie Elementa`.
- `producer_flavor` — curated house style for the thirteen non-peat tags
  (`baseline`|`require`|`forbid`). **`peated` may never appear here** (enforced
  by the importer and by a unit test): peat has exactly one source of truth and
  a second would reintroduce the disagreement. `smoky` is allowed, since
  non-peat smokiness is real — Jack Daniel's charcoal mellowing keeps its tag
  with no peat at all.
- `flavor_rule` — name-pattern overrides, either a peat rule or a tag rule
  (CHECK, never both). This is why `PeatProfile` needs no `variable` band:
  Bruichladdich is unpeated and `Port Charlotte`/`Octomore` in the name make a
  bottling heavy. Patterns are plain normalized strings, never regexes, so a
  rule stays reviewable; `matchMode: prefix` exists for Ukrainian inflection
  (`торф` → `торф'яний`). Priorities are load-bearing: negations sit at 100 so
  `Benromach Unpeated` beats its own light house profile, and `lightly peated` /
  `heavily peated` sit above the bare `peated` keyword so
  `Mac-Talla Flora Lightly Peated` is not over-stated.
  `flavor_rule_uindex` is `NULLS NOT DISTINCT` (PG 15+), created by hand and
  kept out of schema management with `synchronize: false`, exactly as
  `sync_log_running_uindex` is.
- `product_fact_conflict` — one row per (product, store, attribute) recording a
  store's claim that contradicts the catalogue, with `seenCount` bumped rather
  than a row per day. It must be written **during the scrape**: `rawAttrs` is
  never persisted, so no later script can reconstruct what a listing said.
  Only `type`, `country`, `brand` and `abv` are compared — `age` and `volumeMl`
  are components of the frozen match key, so a store stating a different one is
  describing a _different bottling_, and logging them would bury the real
  findings under hundreds of structural false positives.

`KbResolverService` (`scrape/kb/`) matches a bottling against the index and
returns the producer, the bottler, the peat level and the tag decisions.
Arbitration between the brand match and the in-name match is **data-driven, not
length-driven**: a bottler brand hands the distillery to the in-name match (the
IB path, `Gordon & MacPhail Ledaig Discovery`), and otherwise the recorded
`parentId` relationship decides. An earlier draft tie-broke on alias length,
which got `Bruichladdich Port Charlotte` right only by coincidence. Nothing
guesses: a name matching no alias resolves to nothing, and _nothing_ is an
answer that removes tags rather than inventing them.

`KbKeyUtils` (`~utils`) deliberately duplicates `NormalizeService.brandHaystack`
rather than reusing it, differing in one way: **Latin accents are folded**, so
`Mòine` and `Moine` are one key. `brandHaystack` must not gain the same folding
— it feeds the frozen `matchKey`. The folding is restricted to Latin base
letters, and that restriction is load-bearing rather than cautious: several
Cyrillic letters are composed, so stripping every combining mark turns
`Хайленд` into `хаиленд` and `Торф'яний` into `торфянии`. A unit test pins it.

### The knowledge base in operation

The schema landed first and sat empty; it is now seeded, applied to the
catalogue and wired into every sync. What each piece does and why:

- **The seed** is 796 producers, 1046 aliases, 45 house-style rows and 92 rules,
  shipped as four TSVs beside their importer migrations
  (`1787851000000`..`1787851300000`). It came from twenty parallel research
  agents whose raw output is checked in under `docs/kb-research/out/` and merged
  by `pnpm kb-merge <in> <out> [curation]`. The merge is re-runnable and the
  research is never edited in place: corrections live in
  `docs/kb-research/curation/` as `merge-slugs.tsv` (fold a duplicate producer)
  and `overrides.tsv` (set one field, with the reason), which is what keeps a
  disagreement auditable.
- **`KbGateUtils.status` (`~utils`) is the one auto-gate**, used by the seed
  merge and by `pnpm research-brands` alike. It is **asymmetric on purpose**: a
  wrong `none` only removes peat tags, which someone notices; a wrong positive
  removes a whisky from a filtered result silently. So `none` and `unknown`
  auto-apply on ordinary evidence while a positive claim also needs Islay, a
  peat word in the producer's own slug, or a citation from the producer's own
  domain. A `bottler` passes unconditionally — it carries no peat claim and the
  resolver refuses to put one in the producer slot at all, so withholding it
  buys no safety and costs the whole IB path. **329 of 796 rows are live; the
  rest are stored and ignored** until a person promotes them through
  `/product/review`.
- **`KbStatus` has a fourth value, `rejected`**, for a row that is not a whisky
  producer at all. The research input was `SELECT DISTINCT name FROM brand`, so
  the catalogue's own dirt came with it: `bayadera` (a retailer whose name
  leaked into the brand column), `valdespino` (a sherry bodega),
  `marc-de-champagne` (a brandy), `boulevardier` (a cocktail). It is a
  **decision, not a deletion** — the row stays, so the verdict is auditable,
  `pnpm research-brands` never pays to look the brand up again, and
  `pnpm kb-export --all` carries it to the next environment instead of letting
  a fresh seed resurrect it. Reversible from the review screen, because the
  button can be pressed by mistake. Nothing needed a migration: `status` is a
  `varchar(16)` with no CHECK constraint, and the resolver's index whitelists
  `verified`/`auto`, so a rejected row is inert by construction.
- **`KbReconcileService` (`scrape/kb/`) owns the pass itself** — load the
  index, plan, write — and three callers share it: `pnpm reconcile-flavors`,
  `POST /product/review/apply`, and **`PATCH /producer/:id`, which runs it
  inline**. That last one is the important one: recording a decision and
  applying it are one action, because a stored claim changes nothing a filter
  reads until the catalogue is re-resolved — promoting two producers and
  watching the review counts stay put is what proved it. Deferring buys
  nothing measurable: the pass is ~200 ms over 4057 bottlings, idempotent, and
  never touches a `manual` value. A store sync is not a substitute — it
  re-resolves only the bottlings that run touched. The pass fails closed on an
  empty knowledge base: reconciling against nothing would strip every peat tag
  with nothing to put back.
- **`KbApplyService` (`scrape/kb/`) owns "which link may survive"**, and both
  callers use it: `pnpm reconcile-flavors`, which repairs the whole catalogue,
  and `ScrapePersistService`, which applies the same rules to the bottlings one
  sync touched. Two implementations of that rule is the exact shape of defect
  this work removes — one edit to one of them and a nightly sync starts undoing
  what the reconciliation settled.
- **The sync order is load-bearing**: `logFactConflicts` → `fillMissing` →
  `addScrapeFlavors` → resolve → `setProducers` → `applyKbFacts` →
  `applyKbFlavors`, and all of it **after** `writeLlmFlavors`, so the pass can
  strip a peat tag the model just wrote.
- **Two ordering traps are already paid for.** A `kb`-owned link is never
  re-written (the plan would not be idempotent and the dry-run check could never
  come back clean), and **a required tag outranks the peat sweep**:
  `Grant's Triple Wood Smoky` is an unpeated blend whose own name requires
  `smoky`, so the sweep dropped the link and the rule restored it on the next
  run, forever. `peated` is explicitly exempt from that precedence — it has
  exactly one source of truth.
- **Coverage, measured**: `countrySource = 'legacy'` fell 3994 → 1649 and
  `typeSource` to 1844; peat-tag disagreement among identically-named bottlings
  went **108 → 0**; `age` (164) and `volumeMl` (254) disagreements are
  **unchanged**, as they must be — both are frozen identity components.
- **Scripts**: `pnpm reconcile-flavors` (`--dry-run`, `--out`, `--store`,
  `--brand`, `--keep-unknown-peat`, `--report-attr-conflicts`),
  `pnpm fact-conflicts` (read-only, with the per-shop disagreement rate),
  `pnpm rederive-name-facts`, `pnpm research-brands`, `pnpm kb-export`,
  `pnpm kb-verify-merge` (below).
- **The verification round** (2026-08-29) is why the queue is nearly empty:
  the seed brief told researchers to economize on the long tail, so 437
  producers sat withheld on honest `low` confidence. Twenty web-grounded
  agents (19 reach-ranked batches + a retry lane for quota/403 casualties)
  re-verified every row against producer domains — raw outputs, briefs and
  the resumable checkpoint live under `docs/kb-research/verify/`.
  `pnpm kb-verify-merge` folds `verify/out/*` through the same
  `KbGateUtils` policy (plus `verify/curation-overrides.tsv`, the documented
  escape hatch for producer-domain evidence the gate's URL heuristic cannot
  see — Longrow is documented on springbank.scot, `lagg` is a four-letter
  slug) into the TSV assets of the `kb-verification-import` migration, which
  updates rows **only `WHERE status = 'unverified'`** so a decision a person
  made meanwhile is never overwritten. Verdict: 423 auto, 19 unverified
  (world-is-silent own labels), 10 rejected; producer resolution went
  2802 → 3836 of 4062 bottlings (94%), country filter coverage 77% → 96%,
  type 78% → 81%.
- **The knowledge base applies itself after a deploy.** `KbBootApplyService`
  (`scrape/kb/`) runs the `KbReconcileService` pass once at every application
  bootstrap (`KB_APPLY_ON_BOOT`, default true; failures are logged, never
  fail the boot). A migration that ships KB rows therefore takes effect at
  the next boot with no manual reconcile — the same guarantee the review
  screen's inline apply gives a human edit. The pass stays idempotent: a
  `reconcile-flavors --dry-run` right after a boot reports zeros.
- **The regression gate** is `test/fixtures/kb-golden.tsv` (195 real
  `(name, brand)` pairs) plus `test/scrape/kb-golden.integration.spec.ts`, and
  the end-to-end acceptance is
  `test/integration/kb-report.integration.spec.ts`: it gives ten real whiskies a
  wrong `llm` peat tag, runs the sync's own apply pass, and asserts that
  `excludeFlavors=peated` removes all eight peated brands and keeps Tobermory.

### The brand label (2026-09-01) — `producer` is the brand

There is no `brand` table. A report's `brand` is
`COALESCE(producer.name, bottler.name)`, the blacklist names a producer, and
`/brand/search` searches producers through `producer_alias`. **The wire
contract is unchanged** — the field, the `brands` parameter and the route keep
the word a shopper uses — so `../web` needed no change; only what the values
mean is different.

Why the table went, measured on a restored production dump (709 rows, 4 068
bottlings): it was never curated. `ScrapePersistService` minted a row from
whatever string a shop printed, through an `INSERT ... ON CONFLICT (name) DO
NOTHING` whose unique index is case- and punctuation-sensitive, so one maker
accumulated several rows — `Macallan[104]` beside `The Macallan[20]`,
`M H[10]` beside `M&h Elements[4]`, `Chivas Regal[30]` beside `Chivas[13]`
beside `Chivas Brothers[8]`. One user had blacklisted `Chivas` and
`Chivas Regal` separately and still missed the eight filed under
`Chivas Brothers`. **685 of the 709 rows already resolved to a knowledge-base
producer**, and the 24 that did not carried two bottlings between them: the
table was a second, worse registry of something `producer` and
`producer_alias` already held.

A `brand_alias` table was the obvious fix and was rejected for that reason —
it would have been a second alias registry with a second normalization to keep
in step, and `ProducerRepository.findUnresolvedBrands` had already refused the
same shape once ("a second copy of what the alias table already states").
Folding through `producer_alias` also finds strictly more: 50 groups against
the 15 a string fold finds, including `M H` / `M&h Elements`,
`Douglas Laingcompany` / `Douglas Laing`, `Isle of Jura` / `Jura`, and
`Highiland Baron`, whose correct spelling existed nowhere in the table at all.

Four things are load-bearing:

- **The label is the distillery, not the bottler.** `COALESCE` puts
  `producer.name` first, so `Gordon & MacPhail Macallan 1988` reads `Macallan`
  — the bottler is already its own `ReportRow` field, and grouping every
  Macallan together is the point. `kind` never selects the label; the _slot_
  does, and `KbResolverService` guarantees a bottler never lands in the
  producer slot (0 of 4 068 bottlings do).
- **The blacklist tests both slots.** A rule naming Douglas Laing has to reach
  the eighty-one bottlings that carry it as `bottlerId`, not `producerId`.
  This is the predicate most likely to regress and has its own integration
  test.
- **18 bottlings lost their label, and for 17 that is correct.** They resolve
  to producers the knowledge base has already `rejected` with a cited note —
  `Vulson` (a rye eau-de-vie never rested in wood), `Yakusun`, `Undone`
  (labelled "THIS IS NOT WHISKEY"), `Spice Monkey`, `Marc De Champagne`,
  `Boulevardier`, `Bayadera`, `Kentucky`, `Moulin`. The eighteenth,
  `Ice Drive`, is merely unresearched. A `brandOrig` fallback was considered
  and dropped: it would have rescued exactly that one bottling and put the
  other seventeen back.
- **`product.brandOrig` is an observation, not a fact.** It holds the shop's
  own spelling and exists so the makers the knowledge base is still missing
  stay findable — a bottling with no `producerId` and a `brandOrig` is one row
  of the `/producer/unresolved` queue `pnpm research-brands` works through.
  Written on insert, filled when null, never displayed and never filtered.

The match keys were re-signed once to match (`brand-canonical-regroup`); see
"Brand identity comes from the knowledge base" under "Scraping engine" for how
the engine derives them now, and `FOLLOWUPS.md` item 7 for the `luxco` alias
this leaves as a landmine.

### Fact provenance (`product.<field>Source`)

Every fact column on `product` has a `varchar(16)` sibling recording where the
value came from (`FactSource`, `~enums/fact.enum.ts`), **ranked**:
`manual`(60) > `kb`(50) > `store`(40) > `name`(30) > `llm`(20) > `legacy`(10).

**Brand is not one of them any more.** It was, until the `brand` table was
retired: the label is now derived from the resolved producer, which carries
its own `producerSource`, and `product.brandOrig` is an observation rather
than a fact — one shop's spelling, never displayed, never filtered, never
ranked. `ProductFactField.BRAND` is gone with it, so `brand` is no longer a
value `/product/review/conflicts?attribute=` accepts.

**`fillMissing` is no longer fill-if-null.** It used to `COALESCE`, so whichever
store or model spoke first owned the value forever: an LLM guess made on the day
a bottling was discovered outranked a distillery's own spec page, and a
hand-typed correction was indistinguishable from that guess. A value is now
replaced when the incoming source outranks the stored one, and a `manual` value
is never replaced. The rank comparison is generated into the SQL from
`FACT_SOURCE_RANK` in TypeScript, so the ranking stays single-sourced in
`~enums` and the database gains no new object. The consequence to keep in mind:
**a stored fact can now change between syncs**, where before it could not.

Three further details are load-bearing:

- **The insert path stamps too** (`FIND_OR_CREATE_SQL`, `createUnmatched`). A
  fact created without a source ranks below everything, so the next sync would
  overwrite the values the row was created from — turning "first writer wins"
  into "last writer wins" rather than into a trust order. A source is only
  stored next to a value it describes; where the value is null, so is the
  source.
- **`ProductService.update` stamps `manual` on every field it writes**,
  including a field it _clears_. Without that stamp the knowledge-base pass or
  the very next sync would quietly undo the correction, and clearing is itself a
  decision — usually "what was here was wrong".
- **Provenance is decided in three files, not fourteen adapters**
  (`ProductSnapshot.factSources`). The passes run in a known order —
  `enrichDetail` before `normalize`, the LLM pass after — so "already set when
  normalization started" is an exact test for `store`. `NormalizeService` stamps
  `store` on entry and `name` on what it derives; `LlmEnrichmentService` stamps
  `llm`; persist defaults anything unstamped to `store`.

The backfill marked every pre-existing value `legacy`, deliberately rather than
inferring a better source: `legacy` states the truth (the provenance is
unknown), whereas inferring would lie — the catalogue holds rows whose age an
early scraper read out of a description. **The shrinking share of `legacy` is
the coverage metric** for this work: `SELECT "countrySource", count(*) FROM
product GROUP BY 1`.

Migrations: `1783840439247-init` (`user`, `permission`),
`1783840751031-whisky-domain` (all of the above), then the sync overhaul —
`store-config-group-engine`, `sync-log-lock`, `price-snapshot-captured-on` —
`product-in-stock` (the availability flag), `silpo-store` (a data
migration seeding the `silpo` store + config; its `down()` un-onboards the
store, cascading into its products and snapshots), then the flavor overhaul —
`flavor-llm-source` (`product_flavor.source` + `product.lastLlmFlavorAt`) and
`flavor-taxonomy-cleanup` (a data migration deleting every `flavor` row and link
outside the 15-tag vocabulary: 142 of 157 rows and 633 of 7 368 links on a
production copy, all of them left by the old unfiltered enrichment side effect
and all re-derivable, which is why its `down()` is a documented no-op) and
`flavor-llm-import` (the classified back-catalogue, see below), then
`sync-log-file`, `bayadera-store` and `fozzy-store` (data migrations seeding
the `bayadera` / `fozzy` stores + config, same shape and un-onboarding
`down()` semantics as `silpo-store`; the fozzy comment documents that the
first fill must run through `pnpm backfill --store fozzy`, because ~300
detail pages at the politeness delay blow the store sync timeout and a
timed-out run persists nothing), `alcomag-store` (the `alcomag` store +
config, same shape again; the first fill runs through
`pnpm backfill --store alcomag` for the same timeout reason — ~600 detail
pages), and `product-canonical-split` (the catalogue/offer split: renames
`product` to `store_product` keeping every row id — so the 346k-row
`price_snapshot` is never rewritten, only its column and constraint names —
creates the canonical `product` beside it, groups the store rows in TypeScript
through `ProductMatchUtils`, re-points `product_flavor`, and asserts the counts
before it commits; its `down()` is structurally exact but semantically
best-effort, documented in the file), and `winebutik-store` (the `winebutik`
store + config, same shape and un-onboarding `down()` semantics as the other
store seeds; its comment documents the `pnpm backfill --store winebutik`
first fill — ~550 detail pages at the politeness delay, past the store
timeout), `quick-filter`, and then the knowledge-base trio —
`product-fact-provenance` (the eight `<field>Source` columns plus the blanket
`legacy` backfill; it runs **first**, because the rank-aware write is
meaningless without it), `kb-schema` (`producer`, `producer_alias`,
`producer_flavor`, `flavor_rule`, and `product.producerId`/`bottlerId`) and
`product-fact-conflict` (the QA log) — all
applied, formatted per the `typeorm-migration-format` skill, and drift-free
against the entities.

After them, `age-regroup-cyrillic-yo` (2026-09-01) repairs the bottlings the
Cyrillic `уо` merged: the reader is fixed, but a match key is frozen at
creation and nothing on the scrape path re-keys a known SKU, so the stored
links had to be corrected on their own. It **works out what to do from the
data it finds** rather than from a shipped list of ids — production's
catalogue is not any other catalogue — and it asks `NormalizeService` for the
age instead of re-implementing its patterns, so the repair is by construction
what the fixed engine now derives. Three cases, and the boundary between them
is the whole design:

- **Split** — the group's offers state two or more ages, so the row is
  provably several whiskies. Each age-stating offer moves to the bottling
  carrying its age (created from the mixed row's own facts when absent);
  offers stating no age stay behind, because nothing can tell which age such
  a listing sells. The emptied source also gives up the age it inherited from
  the merge, or a plain `Dalmore` listed tomorrow would join it and be served
  as a 12 year old all over again.
- **Merge** — the group agrees on one age and a bottling with that exact key
  already exists: one whisky recorded twice because one shop spelled the age
  in a way the reader understood and another did not. The whole group moves
  onto it, flavour links copied (`ON CONFLICT DO NOTHING` — a tag is evidence
  _for_ a flavour, never against one) and favourites/blacklist entries
  following the offers.
- **Fact only** — the group agrees on one age, no such bottling exists, so the
  age is stored as a `name`-sourced fact and **the key is left alone**.
  Re-keying here would be a downgrade, not a fix: these are one shop stating
  an age seven others omit, so signing the row with it would push every silent
  listing off the bottling at the next sync and break the cross-store
  comparison the catalogue exists for. It is the one place where
  `product.age` and the key's `|aN` deliberately disagree; nothing reads the
  key after creation, so the divergence is inert.

**No `product` row is ever deleted** — a bottling no store lists is a shape
`/preference/details` already renders and removes, and deleting instead would
mean guessing which of a split's four targets a person's favourite meant. The
pass asserts its own invariant before committing (no bottling left holding
offers that state conflicting ages) and the run is one transaction, so a
failure rolls all of it back; it is idempotent, and `down()` is a documented
no-op because undoing it would re-merge whiskies that are genuinely different.
Measured on a production-shaped copy: 2 splits (Dalmore 12/15/18/30, West Cork
Bourbon Cask 3/5), 6 merges, 19 ages filled in, 27 offers re-linked (10 by
split, 17 by merge), 1 bottling created, 7 rows left with no offers; snapshot
and offer counts unchanged.

**`flavor-llm-import` ships its data as a CSV beside the migration.** Flavors
were classified per **distinct `product.name`**, not per product row: the same
bottling is listed by many stores, so 2 059 names cover all ~7 000 rows, and
every row of a name gets the same tags — which is also what makes the report's
flavor filter behave consistently across stores. The classification was done by
16 parallel Sonnet 5 agents over ~129 names each (batch inputs and the merged
result are throwaway; the CSV is the artifact). Result: 749 `high`, 972 `low`,
338 `unknown`, 367 distinct tag sets — the largest shared set covers only 52
names, which is the check that matters, because a per-category _template_ is the
failure mode a weaker model produces. Coverage went from 3 031 to 6 264 of 6 990
products (43% → 90%); `excludeFlavors=peated` now removes 736 of 6 294 in-stock
items instead of only those whose name happened to spell out "торф".
Load-bearing details:

- The CSV is `name,confidence,tags` (tags pipe-separated) with **no quoting**,
  which is safe only because no name in the catalogue contains a comma or a
  double quote — verified before generating it. The importer therefore requires
  exactly three fields per line and **fails the migration** on anything else,
  rather than importing a mis-split name that would silently match no product.
- `nest-cli.json` copies `migrations/**/*.csv` into `dist/migrations` as an
  asset. Without it the file would not exist in the production image at all (the
  runtime stage copies only `dist/`) and the migration would fail on deploy.
  `__dirname` then resolves it under both ts-node and the compiled image.
- The importer re-filters every tag against the 15-tag vocabulary. The
  classifier is not trusted to have obeyed it.
- Rows are written `source = 'llm'`, and a tag the keyword pass already found is
  **promoted** to `llm` rather than duplicated (the composite key allows one row
  per pair). That promotion is one-way: nothing records that the row used to be
  `scrape`, so `down()` deletes it instead of demoting it — a dev revert took
  `scrape` links from 6 735 to 2 919. Not a loss (the keyword pass re-derives
  them on the next sync) but the catalogue is under-tagged until then.
- Every classified name is stamped `lastLlmFlavorAt`, `unknown` included. Only
  one product is left unstamped: the single row whose `name` is null, which no
  name-keyed import can reach. Store onboarding is done this way on purpose: **every DB change —
  schema or data — ships as a migration**, never as ad-hoc SQL, so prod picks
  it up through the deploy's migrate gate.

The legacy SQLite importer (`scripts/sync-from-sqlite.ts`, and the
`better-sqlite3` devDependency with it) was **deleted with the catalogue
split**. It had already done its one job — the historical data has lived in
Postgres since the cutover — and it wrote the single-table `product` shape,
which no longer exists. Timestamp columns it left behind are `timestamp` (no
tz); legacy UTC ISO values shift by the local offset on display, so a tz policy
is still owed.

## Scraping engine (`src/scrape/`)

The in-process port of the Python scraper (`../scrapper`). A top-level
subsystem (peer of `core/`/`domain/`), not `lib/` (which is thin infra
wrappers): `scrape/` has its own internal layering.

- **Layering addendum**: `scrape/` may import `core/` modules and the leaf
  layers (`~types`/`~config`/`~utils`/`~constants`/`~errors`); `domain/` may
  import `scrape/`; `core/` must **not** import `scrape/`. Treat it like
  `domain/` for import-boundary purposes.
- Layout: `normalize/` (regex/keyword port of `normalize.py`; reuses
  `BrandUtils.canonical` + `ProductNameUtils.clean`, no `match_key`/exclude-
  flavors), `http/` (plain fetch / `impit` impersonation / retrying wrapper +
  `HTTP_STRATEGY_BY_SLUG`; the wrapper throws a typed `ScrapeHttpError`
  carrying the last status, which is what lets a walk tell a 404 past the end
  of a catalogue from a store having a bad minute — an end-of-catalogue status
  is also not retried, since it is an answer), `html/` (cheerio helpers for the
  SSR stores),
  `browser/` (Playwright stealth context, fresh context per page), `llm/`
  (an **OpenAI-compatible** chat-completions call via the `openai` SDK,
  pointed at any endpoint by `LLM_BASE_URL` — production uses OpenRouter, so
  the model is a provider slug in `LLM_MODEL`; `LlmClientService` owns the
  transport and the JSON-array unwrapping, and every pass stays disabled until
  a key **and** a model are set, since no model name is portable across
  providers. `askJsonArray` takes optional per-call `{model, reasoning}`
  overrides so one pass can run on a different slug than the rest. Three
  independent passes sit on top of it:
  `LlmEnrichmentService` fills missing abv/volume/type/country fields — for
  new SKUs only in a normal run, because the upsert writes those columns on
  insert alone, so a stored row's answer would be paid for and discarded
  (winewine's listing states no ABV, so before this gate every sync queued its
  whole 203-item catalogue),
  `LlmNameExtractionService` reduces the name to brand + expression for new
  SKUs, validated token-by-token against the raw name so a hallucinated word
  can never be persisted, and `LlmFlavorService` classifies the flavor profile;
  all three swallow every error and fall back to the deterministic pass.
  **`LlmFlavorService` is the odd one out — it is recall over a field no source
  states**, where the others only rewrite an input line, which is why it has its
  own `LLM_FLAVOR_MODEL`/`LLM_FLAVOR_REASONING` and why model choice matters
  here and nowhere else. It exists because the keyword pass can only find a
  flavor a listing spells out, leaving most of the catalogue untagged — and the
  report's main use is _excluding_ `peated`, which silently excludes nothing on
  an untagged product. Two guards keep it from making the data worse: the answer
  is filtered against `FLAVOR_TAGS` (the closed 15-tag vocabulary derived from
  `FLAVOR_KEYWORDS`, so the keyword pass and the LLM cannot disagree on what a
  valid tag is — a tag named in the prompt but missing from that constant is
  silently dropped, so the two are edited together), and a `confidence` of
  `unknown` forces an empty result. The prompt pushes hard toward `unknown`
  because a plausible-but-wrong `peated` is worse than no tag at all.
  **Model choice was measured, not assumed**: on the same 40 goodwine bottlings,
  `deepseek-v4-flash` returned a per-category _template_ — Jameson, Monkey
  Shoulder, Robert Burns and Chivas all got one identical tag set, Dalmore,
  GlenAllachie and Bunnahabhain another — missed `bourbon-cask` on a product
  named "West Cork Bourbon Cask", and answered `high` for all 40.
  `anthropic/claude-sonnet-5` discriminated per product (Dalmore → citrus/sherry,
  Arran 10 → maritime, both Bourbon Cask bottlings → `bourbon-cask`) and marked
  the obscure blends `low`. Neither model ever answered `unknown`, so the
  `unknown` path is under-exercised in practice — treat `low` as the real
  "don't trust this" signal.
  A **normal** run classifies **new SKUs only** (like name extraction and —
  since the winewine budget fix — the fields pass, all gated on the same
  `existingSkus` lookup, fetched once and shared). A bottling's flavor does not
  change between runs, so re-asking per sync would be pure spend. A **backfill**
  run waives the "new to this store" half of the gate — see `pnpm backfill`.
  Stored bottlings can also be swept by `pnpm enrich-flavors`, which needs no
  scrape but is therefore stuck with name-only grounding.
  **Reuse across stores is structural now, not a lookup.** The gate is
  `lastLlmFlavorAt IS NULL` on the _bottling_, so a listing whose key resolves
  to an already-classified whisky is simply never asked about, and its stored
  tags are what every store's row reads. That replaced a name-string lookup
  (`findLlmFlavorsByNames`) and is strictly stronger: the key folds spellings
  the string comparison missed (`The Glenlivet` and `Glenlivet`), which used to
  mean paying twice for one whisky and sometimes getting two different answers.
  It matters at scale — 1 273 bottlings are carried by more than one store,
  spanning 6 600-odd of the 8 418 offers. A bottling classified `unknown` has no
  links but _is_ stamped, so it is not re-asked; only a genuinely unclassified
  one reaches the model.
  **In-run grouping keys on the same identity**: one bottling is asked about
  once however many SKUs a store lists it under, so a boxed and a plain listing
  of the same bottle cost one call. Two _sizes_ are two bottlings and are asked
  about separately, which the old name-based grouping got wrong.
  **The stored back-catalogue was swept by the `flavor-llm-import` migration
  instead of by that script** (see "Whisky domain"), because deduplicating to
  2 059 distinct names cut the work by ~70% versus the script's per-row
  candidates, and shipping the answers as a checked-in CSV makes the result
  reviewable and reproducible on every environment rather than re-billed per
  deployment. `pnpm enrich-flavors` remains the tool for whatever the import
  missed and for any future gap — it selects on `lastLlmFlavorAt IS NULL`, which
  the import has already filled for every name it covered.
  **Reasoning is off by default (`LLM_REASONING`), and that is load-bearing**:
  both passes are mechanical rewrites, but on a reasoning model the chain of
  thought scales with the batch and eats the entire completion budget before
  the first answer token — measured on a 40-item chunk: 8192/8192 tokens spent
  reasoning, `finish_reason: length`, empty content, every item lost. The same
  chunk answers in ~350 tokens and 3 s with reasoning off. `LlmClientService`
  therefore sends OpenRouter's normalized `reasoning: {enabled: false}`, and an
  empty answer is diagnosed rather than reported as "no content".
  **`temperature: 0` / `top_p: 1` for the same reason**: both passes are
  extraction, so the answer is a function of the input line. At the provider
  default a re-run renamed products that had not changed, and one source name
  could come back two ways. It does not buy exact reproducibility — the
  provider is not bit-for-bit deterministic, and two full backfills of the same
  catalogue still disagreed on ~1 % of rows (mostly whether a vintage year is
  part of the name) — so anything that must be stable across runs belongs in
  the deterministic pass, not in the prompt.
  **`LlmBatchRunner` batches every pass (40), sends `LLM_CONCURRENCY` batches at
  a time, and halves a failing batch** down to the single item that fails alone.
  Halving began as a budget-error-only retry — an OpenRouter slug is served by
  several upstream providers and not all of them honour the reasoning switch —
  but a run then lost 40 names in silence to one malformed JSON array, so the
  rule became the simpler one: whatever the provider answers wrong costs one
  item, not a batch.
  **Which failures may be halved is the distinction to keep** (`LlmRetryPolicy`):
  halving suits an answer the model got wrong, because the halves are smaller
  questions, and is exactly wrong for a 429 or a 5xx, where the batch was never
  the problem and splitting it merely aims twice as many requests at whatever is
  already refusing them. Those are re-sent whole once, after a pause the entire
  pool observes (`Retry-After` when the provider sent one, else 2 s doubling to
  10 s), and a rejected key (401/403) stops the run outright instead of spending
  the budget rediscovering it forty items at a time. A cascade of halves stays
  inside the worker slot that discovered the failure, so the concurrency cap
  holds even mid-cascade.
  **Sending one batch at a time is what used to time syncs out.** A silpo run
  scraped its 1 069 items in 70 s, then spent the remaining 14 minutes of
  `SYNC_STORE_TIMEOUT_MS` on a sequential 802-item fields pass and failed with
  the catalogue already in memory. Two things caused it: the batches waited on
  each other, and `LlmClientService` built a client per call with the SDK's
  default 10-minute timeout and 2 retries, so one stalled call could outlast the
  whole budget on its own. The client is now built once with an explicit
  `LLM_TIMEOUT_MS`/`LLM_MAX_RETRIES` (lazily — the SDK constructor throws
  without a key, and running with the LLM off is supported), and the passes run
  `LLM_CONCURRENCY` batches at once. OpenRouter publishes no request-rate
  ceiling for a funded key (the old per-credit rule is gone and the key
  endpoint's `rate_limit` is deprecated), so that number is politeness rather
  than a limit to fit under; a real 429 is handled by the pool-wide pause.
  **Measured on `deepseek/deepseek-v4-flash`**: a batch of 40 takes ~13 s, so
  five chunks of it ran 64.7 s sequentially against 14.6 s at
  `LLM_CONCURRENCY=5` (4.4×, no 429s). Per-batch latency, not per-item cost, is
  what made the old sequential pass unaffordable — 21 batches × 13 s is already
  most of an HTTP store's budget before the other two passes have started. A
  full silpo dry-run (1 069 items, all three passes, nothing stored yet, so
  ~60 batches) now finishes in 7 m 40 s including the 70 s scrape, against a
  15-minute budget the fields pass alone used to exhaust.
  **The passes also observe a deadline** (`CollectOptions.deadline`, set by
  the orchestrator to the store's budget minus `SYNC_LLM_DEADLINE_MARGIN_MS`).
  They only fill secondary fields — an unanswered new SKU keeps its gap — so
  when the budget runs short the remaining batches are skipped, a
  `llm-deadline` line names the pass and the count in the run's log file, and
  the run goes on to persist what it scraped rather than failing a timeout. A
  batch already in flight finishes: its answer is paid for either way. The
  same signal also bounds detail enrichment (see "Detail pages" below), which
  is what used to be able to starve everything behind it.
  **The flavor pass asks once per distinct name within a run, not per SKU.**
  `ScrapeService` groups pending snapshots by the resolved name persist will
  write and sends one head per group, then copies the answer onto its siblings —
  two volumes of one bottling are two SKUs but one flavor profile, so asking
  twice both paid twice and risked the two rows disagreeing. An unanswered head
  leaves its whole group unchecked, so the group is retried rather than half of
  it recording a miss. This composes with the stored-answer reuse above: both
  key on the same resolved name, so a name is either reused for every SKU
  carrying it or asked about once. Prompts
  are English-only even though the data is Ukrainian; the enrichment prompt
  still asks for `country` **in Ukrainian** because persist matches it against
  `country.nameUa`), `adapters/`
  (base classes + `AdapterRegistryService` - one folder per store platform),
  `persist/` (one-store, one transaction write pipeline over the core
  services: upserts the in-stock items, then **flags** everything the run did
  not see in stock as `store_product."inStock" = false` — explicit out-of-stock
  SKUs and items missing from the listing alike; nothing is deleted.
  **The sweep is gated on the listing walk, not on a count** — see "Listing
  completeness" below), and `ScrapeService` (`collectStore(slug, { dryRun })`).
- **Listing completeness gates the sweep** (`ListingStop`, `~enums`;
  `ListingResult`, `~types`). Every walk reports _why_ it stopped, and
  `ScrapeAdapterBase.listing()` turns that into a verdict: running out of pages
  is completeness on its own for a source that states no count, and is
  reconciled against the count for one that does. Only a complete listing earns
  the sweep; an incomplete one flags the explicit out-of-stock SKUs alone and
  the orchestrator closes the run as **failed** with a `Listing incomplete
  (<stop>)` message (no new column — `success = false` carries it, counters
  intact so the partial write stays visible).
  This replaced a count heuristic (`PERSIST_SWEEP_GUARD_RATIO`, in-stock now vs
  in-stock before) that could not tell a store whose stock really collapsed
  from a scrape that broke, and got both cases wrong in opposite directions.
  **A store that legitimately shrank past the ratio froze**: the baseline is the
  _live_ in-stock count, which skipping the sweep is precisely what stops from
  falling, so every later run made the same comparison and skipped again.
  Silpo's whisky category fell from 1070 offers to 249 on 2026-08-22 — verified
  against the source, its API states `total: 249` and the vanished SKUs answer
  `stock: 0` — and 578 sold-out bottles would have been served as available
  indefinitely. In the other direction, a listing that broke after collecting
  60 % of itself cleared the ratio and flagged the other 40 % unavailable.
  The ratio survives as an **alert only** (`stock-drop`, logged, sweep still
  runs): the failure modes are not symmetric, since an offer wrongly flagged
  out of stock returns on the next run while one wrongly left in stock stays
  until someone notices.
  What each walk treats as reaching the end: silpo/zakaz/okwine reconcile
  against the item count their API states (`total` / `count` / `count`, the
  last two newly modelled); maudau uses `x-last-page` or the available prefix
  running out, and deliberately **not** its `x-total` (~2500), which counts the
  unavailable tail the walk never reaches; rozetka uses a page whose tiles are
  all already collected, because a page past the end **redirects to page 1**
  (verified live), while a page that rendered nothing is the Cloudflare
  challenge winning and reads as incomplete; the seven `PagedHtmlAdapterBase`
  stores use a 404/410 or a page with no new SKU — and `winebutik`
  additionally the first page carrying a known out-of-stock label, because
  its listing sorts purchasable items ahead of a sold-out tail, which makes
  that page the end of everything the walk is for (`pageEndsListing`).
  `MAX_PAGES` is incomplete everywhere.
  **The count is reconciled against what the source handed over, not against
  the snapshots that survived mapping** — a listing routinely repeats a SKU or
  carries one with no price, and reconciling on the kept ones would read such a
  store as permanently truncated, which is the exact failure being replaced.
- **Adapter base classes** (`adapters/`): `ScrapeAdapterBase` (spec, pacing,
  progress, snapshot defaults) → `HttpAdapterBase` (owns the HTTP client) →
  `PagedHtmlAdapterBase` (walk `cardSelector` pages until one yields no new
  SKU, or until a page declares itself the listing's end via the
  `pageEndsListing` hook — default never, overridden by winebutik whose
  sold-out tail is that marker; a page that fails ends the walk unless
  nothing was collected yet, in which case it throws — and whether that
  ending counts as reaching the end of the listing depends on the status, see
  "Listing completeness")
  → `WooCommerceAdapterBase` (shared card markup,
  `/whiskey/page/N/` pagination and specification table of the two WooCommerce
  stores). `BrowserAdapterBase` is the parallel branch for the browser tier.
- **Adapters** — every store the project scrapes now has one: `zakaz/` (one
  parameterized adapter for all 19 Zakaz.ua networks — chain and category come
  from `store_config`, prices are kopecks), `maudau/` (catalog JSON API,
  available items only, early stop after 2 pages without a new item; the Python
  RSC-payload fallback is deliberately not ported), `okwine/` (filter API,
  volume/age from the product's characteristics), `winewine/` and `wine-point/`
  (WooCommerce SSR via cheerio, `supportsDetail`; wine-point takes the
  single-bottle price only and never the 3+/6+ tiers), `goodwine/` (Magento
  `data-*` card attributes, `?p=N` pagination, `li.product-attr-item` details),
  `rozetka/` (browser tier), `silpo/` (catalog JSON API on
  `sf-ecom-api.silpo.ua` — the HTML site hides behind a Cloudflare Turnstile,
  but the API host answers plain requests, so the store is tier 1 despite the
  legacy tier-3 classification; a **real branch UUID** is queried,
  out-of-stock items stay listed with `stock: 0` and feed `inStock` directly,
  volume comes from `displayRatio`, brand from `brandTitle`.
  **The zero-UUID "guest" branch does not model stock at all** and must never
  come back: it answers `total: 1070` for the whisky category with every
  single item at `stock > 0`, where the real branch answers `total: 249` of
  which 22 are `stock: 0` (verified live 2026-08-23 — its 227 available
  listings are exactly what the store recorded that day). So from onboarding
  until 2026-08-22 the store logged ~600 sold-out bottles a day as available,
  which is what the dashboard then reported (see "Dashboard API" below). A
  branch is the assortment _and_ the availability, so which one is queried is
  a data-quality decision, not a default.
  **The listing states no strength, type, age or flavor whatsoever**, which is
  how the store reached 778 null `abv` rows out of 831 — every other store sat
  at 0–16 — so the adapter is `supportsDetail` and reads
  `/products/<sku>`, whose `attributeGroups` carry all of it:
  `alcoholcontent` → abv (100% of a 30-item live sample; it arrives as a JSON
  _number_ on some products and a string on others), `strokvytrymky` then
  `ageofcognac` → age, `vydviski` then `subspecies` → type, `country` then
  `krayinarozlyvu` → country, and `smakviski`/`taste`/`addtaste` plus the
  HTML `descriptionRich` into `rawAttrs` for the keyword and LLM flavor
  passes (measured on that sample: type 28/30, description 24/30, a flavor
  tag 26/30). Four details are load-bearing. Its `volume` attribute is a
  bucket range (`0,6-0,99`) and is **never** read — `displayRatio` already
  states the exact pack size. Each of the paired sources is canonicalized
  **before** the fallback is consulted, not after: `country` is filled on
  nearly every product but usually holds the umbrella `Велика Британія`, which
  `canonicalCountry` drops so the brand pass can refine it to `Шотландія`, so
  a raw `a ?? b` chain would consume the primary key and never reach
  `krayinarozlyvu`. An age **range** (`3-6 років`, ~50 products) is rewritten
  to its lower bound before parsing — `parseAgeValue` alone answers **6**,
  because its regex backtracks past the first number to the one the unit
  follows, and rewriting to `3 років` rather than reading the number directly
  is what keeps `18 місяців` rejected. And the response's top-level
  `description`, `brand` and `countryOfOrigin` are placeholders holding the
  literal strings `no desc yet` and `implement with filters` — they are
  deliberately absent from `SilpoDetail` so they cannot be read by accident.
  `descriptionRich` is flattened with a separator inserted at every element
  boundary, because cheerio's `.text()` glues `<p>…витонченості</p><p>Аромат…`
  into the made-up word `витонченостіАромат`), `bayadera/`
  (custom SSR platform, tier 1 via plain HTTP, `?page=N` — every listing card
  carries the whole item as JSON in the buy button's `data-product-info`
  attribute: `article` is the SKU, prices are kopecks, `volume` is the pack
  size, and the unlabeled `attributes` values go into `rawAttrs` so the
  keyword pass finds country and flavors; `data-is-in-stock` feeds `inStock`
  directly, the pre-discount price only exists as the struck-through
  `.goodCost.old` text, a brand value sometimes arrives category-prefixed
  (`Віскі Glenmorangie`) and the prefix is stripped, and the "top sales"
  slider is excluded by the `:not(.slide)` card selector because a page past
  the catalog end answers 200 with fallback products — the walk ends via SKU
  dedup, not an empty page), `fozzy/`
  (fozzyshop.ua, server-rendered `?page=N` listing behind Cloudflare that
  answers plain GETs; the card's `data-*` attributes carry id/name/prices,
  where `data-secondary-price` is the old price **only** when
  `data-price-type="promotion"` — every other type reuses it for the bulk
  case price, which must never surface as a strike-through; volume only in
  the rendered unit label (`0,7л`), only available items are listed, and the
  product page's characteristics list fills country/brand/ABV/age/type via
  `supportsDetail` — age through `parseAgeValue`, added because the field is
  a bare `12` no age regex matches), `alcomag/`
  (Bitrix/Aspro SSR via cheerio, `?PAGEN_1=N` pagination, `supportsDetail`;
  the article number is the SKU and may be non-numeric (`МТ10`), availability
  is a positive «Є в наявності» marker — an unknown label drops the card so a
  rewording cannot mass-flag the store, and out-of-stock cards carry a
  `1.00 грн` placeholder price, so an in-stock card at/below 1 is dropped too;
  the `properties__item` detail list fills abv/volume/type/country and — like
  okwine's spec field — the `Витримка` age, but **never the brand**: the
  page's `Виробник` is the legal producer (`Campari Group` for Old Smuggler —
  94 of 154 in-stock items at onboarding), so brand is left to the pipeline's
  brand-from-name pass (129/154 measured); the detail pass also stashes
  the page description into `rawAttrs.description` for the LLM flavor pass,
  and skips out-of-stock snapshots since only their SKU is persisted; a page
  number past the catalog end makes Bitrix serve page 1 again, which the
  no-new-SKU stop absorbs), and `winebutik/`
  (winebutik.com.ua — «Винний Бутик», Drupal 7 Commerce SSR via cheerio,
  plain nginx with no bot wall, so tier 1 plain fetch; the pager is
  **zero-based** — the first page is the bare listing URL and `?page=N` is
  page N+1. The listing sorts purchasable items strictly ahead of a sold-out
  tail spanning dozens of pages (~46 of ~82 pages purchasable at onboarding),
  so the walk ends via `pageEndsListing` — the `PagedHtmlAdapterBase` hook
  this store introduced — on the first page carrying a known out-of-stock
  label («Запитати», «У найближчому надходженні»): for this source the tail
  is the end-of-listing marker, so the stop reads as `EXHAUSTED`/complete and
  earns the sweep, while an unknown label only drops its card, so a relabel
  cannot end the walk with a completeness verdict it did not prove. Sold-out
  cards render no price at all and the store shows no strike-through prices
  anywhere, so `oldPrice` never fills; the SKU is the commerce `product_id`
  of the card's add-to-cart form (present on sold-out cards too); volume is a
  bare litre number (`0.75`), strength a `40.0%` field, and the card's short
  description («Купажований шотландський віскі …») goes to `rawAttrs`, which
  already feeds the keyword country pass. `supportsDetail`: the product
  page's «Факти» block fills type (the Ukrainian `link-type` first, the
  English `link-class` as fallback — each canonicalized before the next is
  consulted), country (the first `link-region` link — the field lists the
  country before the region — through `canonicalCountry`), abv/volume if
  still null, and the body description into `rawAttrs` for the LLM flavor
  pass. `link-producer` is **never** read: it names the legal producer
  (`Bardinet` for Sir Edwards, `Glen Turner` for Glen Clan) — the same trap
  as alcomag's «Виробник» — so brand is left to the brand-from-name pass).
  The registry
  resolves a specialized adapter by slug and falls back to `ZakazAdapter` for
  any store with a `retailChain`/`category`.
- **selectolax vs cheerio gotcha**: the Python adapters read text with
  selectolax's `text(strip=True)`, which strips **every descendant text node
  before joining** — cheerio's `.text()` concatenates them raw. Goodwine splits
  `Label:Value` out of markup where label and value are separate nodes, so the
  difference is a real parity bug. `html/html.util.ts` (`strippedText`,
  `firstText`, `firstAttr`) reproduces the selectolax semantics; use those, not
  `.text()`.
- **Browser tier** (`rozetka`): Playwright drives Chromium in-process. Rozetka
  blocks the second and later navigations inside one browser context, so every
  page is rendered in a **fresh stealth context** (`BrowserAdapterBase`
  `renderEval`/`renderHtml`), with one retry per page and the challenge-title
  wait.
  **Availability is read from a positive marker** — the tile's buy button
  (`button.buy-button`) — never from the absence of an out-of-stock phrase: the
  store has two such labels («Закінчився», «Немає в наявності») and the old
  negative rule knew only one, so sold-out tiles counted as available (see
  [`PARITY.md`](PARITY.md)). Since a positive marker fails closed, the extractor
  also reports whether a known out-of-stock label is present, and a page holding
  tiles with **neither** signal is retried once and then fails the run — the
  alternative is the persist sweep mass-flagging the store's products
  `inStock = false` on a markup change (recoverable, but the reports would be
  wrong until the next good run). Keep that invariant in mind before touching
  `EXTRACT_JS`; the
  golden test (`test/scrape/rozetka-extract.integration.spec.ts`) runs the real
  extractor in Chromium against captured tiles. The browser is launched lazily and closed by `adapter.close()` in
  `ScrapeService`'s `finally`.
  Infrastructure: the `service_run` Docker stage installs Chromium
  (`playwright install --with-deps chromium`, `PLAYWRIGHT_BROWSERS_PATH=
  /ms-playwright`) and drops to a non-root `appuser` (uid 10001) because
  Chromium's sandbox refuses to run as root; compose caps the container with
  `mem_limit: 2g`. Locally: `pnpm exec playwright install chromium` once.
  **Bumping `playwright` in `package.json` also requires bumping the
  `PLAYWRIGHT_VERSION` ARG in the Dockerfile** — that ARG is the whole cache
  key of the ~500 MB Chromium layer (`npx playwright@<v> install`), which is
  what keeps a code-only deploy from re-downloading the browser. A build-time
  assertion fails the build if the two drift apart.
- **Detail pages**: an adapter with `supportsDetail` gets `enrichDetail(snap)`
  calls from `ScrapeService`, paced with `adapter.sleep()` between items.
  Enrichment only ever fills fields that are still null, so listing values and
  manual edits win. **The gate is "in stock, new to this store, and the
  catalogue is still missing something"** — persist never upserts an
  out-of-stock item, a stored offer's own fields are not rewritten, and the
  canonical write fills only nulls, so any other fetch is politeness-delay
  spend whose result the database throws away.
  The last clause is the one the catalogue split added, and it is where the
  saving is: the gate asks about the _bottling_, not this store's row, so a
  store onboarding a range other stores already cover fetches almost nothing.
  (The `lastLlmFlavorAt IS NULL` case counts as missing: the detail page is the
  only source of `rawAttrs`, the flavor pass's only grounding.)
  The old Python-parity gate ("ABV not stored yet", any stock state) is exactly
  how winewine burned 12.5 of its 15 minutes every sync: its WooCommerce
  listing shows 117 sold-out ghosts that were never stored (persist skips
  them), so every run re-fetched all 117 detail pages, discarded the data, and
  left the LLM passes past their deadline — permanently. A backfill run waives
  the "new to this store" clause (see `pnpm backfill`). The pass also observes
  the
  run's soft deadline (`CollectOptions.deadline`): when the budget runs short
  it stops, a `detail-deadline` line records how many items were skipped, and
  the run persists the listing instead of dying on the store timeout — the
  skipped items' fields stay empty until a backfill run, which the log line
  says outright.
  Five stores' first full detail sweep exceeds `SYNC_STORE_TIMEOUT_MS` and so
  has to be seeded through `pnpm backfill --store <slug>` once: `fozzy`
  (~300 pages), `alcomag` (~600), `silpo` (778 stored rows missing ABV,
  ~60–110 min at its 4–8 s delay), `goodwine` (~724 SKUs the 30-page cap
  had been hiding, at an 8–15 s delay), and `winebutik` (~550 purchasable
  SKUs, heavy on collector bottlings the catalogue does not cover). After
  that the normal gate leaves only genuinely new SKUs to fetch, which fits
  the budget easily.
- **Parity harness**: `scripts/scrape-parity-diff.ts <slug> [--python <dump>]
  [--ts <dump>] [--out <dir>]` runs the legacy Python scraper
  (`scripts/scrape-parity-dump.py` through `../scrapper/.venv`) and the TS
  dry run back to back and diffs their pre-database snapshots by SKU. Both
  sides skip the LLM pass. Exit code 1 means the shared SKUs differ; SKU-set
  drift is reported but does not fail (stock flips between the two runs are
  normal). One clean run accepts a store's adapter; a release sweep re-runs
  every store on another day right before the cutover. Results and per-store
  state live in [`PARITY.md`](PARITY.md).
- **Brand identity comes from the knowledge base, not from a brand table.**
  Only three adapters (`goodwine`, `winewine`, `wine-point`) read a brand off the page, so `rozetka` and `okwine` state none at all — and the shops that do state one disagree with each other about how to spell it. `ScrapeService` loads `producers.loadAliasIndex()` once per run (it is passed per call rather than cached, since `NormalizeService` is a singleton and `runFullSync` collects stores concurrently) and `NormalizeService.resolveKeyBrand` answers the one question the identity layer needs: **which token does this bottling contribute to its match key**. A stated brand is matched whole against the alias index; a listing that states none has its _name_ searched, under the same scope rules and five-character floor `KbResolverService.matchInName` uses — both go through `KbAliasUtils`, so the two passes cannot answer differently.
- **The resolved token is the producer's `slug`, never its `name`.** Both are curated, but `producer.name` is a display string that `PATCH /producer/:id` rewrites, and a match key that moved whenever a reviewer tidied a spelling would be no more stable than the shop strings this replaces. The slug is unique and never edited for display. It is also shorter: measured over a production dump, folding to the name restated **204** keys against the slug's **71**, for the same 44 merges — `TBWC` would have become `thatboutiqueycompany` and `Signatory` `signatoryvintage`. A brand the knowledge base does not know falls back to its own canonical spelling, so an unresearched brand keeps working and simply stops improving.
- **`snap.brand` is now only what a shop said.** It used to be filled in from the product name too; that job moved to the knowledge base, which answers it twice over — for identity above and for the label below. What survives on the snapshot is the one thing neither records, and it is stored as `product.brandOrig`: the string a shop used, which is what puts an unresearched maker in the `/producer/unresolved` queue. `detectBrandInfo` still reads country and type off `BRAND_INFO`.
- **An alias that carries no identity of its own never reaches a matcher.** `CoreProducerService` filters every index it hands out through `KbAliasUtils.usable`, which asks `ProductMatchUtils.carriesIdentity` — the same `MATCH_STOP_TOKENS` vocabulary the match key is built from, because a fourth stop list is exactly the drift those paired vocabularies warn about. The filter runs **once per index load, never inside a matcher**: the test folds and tokenizes, and a linear find over a thousand aliases per bottling would pay for it on every comparison. The case it exists for is `& Whisky`, goodwine's own department label (`&wine` / `&whisky` / `&food`), which `KbKeyUtils.key` reduces to the bare noun `whisky` — six characters, so the five-character floor cannot catch it, and brand scope is exempt from the floor anyway. The `brand` table's copy of that defect was removed by `brand-whisky-artifact` and `kb-merge` refuses to write a new one, but `research-brands` writes aliases too, so the index guards itself rather than trusting every writer.
- **Regex gotcha**: JS `\b`/`\w` stay ASCII even under the `u` flag (Python's
  are Unicode). Cyrillic units use explicit lookaheads / classes — see the
  header of `normalize.service.ts`.
- **TypeORM `.query` gotcha**: `INSERT ... RETURNING` yields a flat rows array,
  but `UPDATE`/`DELETE ... RETURNING` yields `[rows, affected]`. Use the query
  builder's `.execute().affected` for update/delete counts.
- `SCRAPE_ADAPTER_FACTORY` DI token decouples `ScrapeService` from the registry
  (tests inject a fake). New env: `SCRAPE_DELAY_MULTIPLIER` (default 1),
  reuses `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL`. Config: `ScrapeConfig` in
  `config/parts/`.
- Integration tests need a live Postgres: `pnpm test:integration`
  (`*.integration.spec.ts`, excluded from `pnpm test`). Dry-run a store without
  writing: `ts-node -r tsconfig-paths/register scripts/scrape-dry-run.ts <slug>
  [--json]`.

## Sync orchestration (`domain/store`)

`SyncOrchestratorService` owns every sync run; `ScrapeService` only collects.

- `startStoreSync(slug, trigger)` validates the store (404 unknown, 400
  inactive / no config / `engine !== 'ts'`), then `tryStart` inserts the open
  `sync_log` row — that INSERT **is** the lock. A rejected insert becomes a 409
  whose message names the blocking store/group (the exception filter serializes
  only `error.message`, so nothing else survives). A `manual` run is
  fire-and-forget (the endpoint answers `202`); a `cron` run is awaited.
- `runStoreSync` races `collectStore` against `AbortSignal.timeout(
  SYNC_STORE_TIMEOUT_MS)` — or `SYNC_BROWSER_STORE_TIMEOUT_MS` when the store
  is `needsBrowser` — and closes the row in `finally`; closing it releases
  the lock, so it must happen exactly once, and the lock path is never wrapped
  in `@Transactional()` (the ALS context would leak into the background run).
  A timed-out collection is abandoned, not aborted: the row is already closed.
  It also hands the collection a **second, earlier signal** for its optional
  passes — detail enrichment and the LLM passes
  (`CollectOptions.deadline`, the same budget minus
  `SYNC_LLM_DEADLINE_MARGIN_MS`). Unlike the hard timeout that only ends the
  wait, this one is cooperative: detail enrichment stops fetching, the passes
  stop asking, the log file records which pass and how many items were left,
  and the run persists its catalogue — which is the difference between a sync
  that fills some fields next time and one that throws away a successful
  scrape (see "Scraping engine").
- `runFullSync()` splits active `ts` stores into tracks (`group ?? id`), runs
  tracks in `SYNC_MAX_PARALLEL_TRACKS`-sized chunks and the stores inside a
  track strictly sequentially; a store that cannot start is warned and skipped.
  It returns a `SyncRunReport` (per track, per store: duration, outcome or skip
  reason) purely so the cron can log a summary — nothing persists it.
- `onModuleInit` sweeps orphaned locks — single instance, so any open row at
  boot belongs to a dead process. `main.ts` calls `enableShutdownHooks()` and
  compose gives the container `stop_grace_period: 60s`. It also sweeps expired
  log files (below), so retention holds even where the cron never fires.
- **Per-sync log files** (`src/lib/sync-file-log/`) restore what the Python
  scraper's `logs.py` gave an operator: a human-readable file per run
  (`HH:MM:SS LEVEL message`, English), holding the pages walked, the LLM passes,
  the persist counters and — when the run failed — the stack trace, which the
  `sync_log` row cannot keep (it stores the message alone). stdout/pino logging
  is unchanged; this is additive.
  - **One file per store run, not per full sync**, named
    `<YYYY-MM-DD_HH-MM-SS>_<slug>.log`: tracks are collected concurrently, so a
    shared file would interleave up to `SYNC_MAX_PARALLEL_TRACKS` stores' lines,
    and a manual sync can start on top of that at any moment. `runFullSync`
    additionally writes a `_full-run.log` summary (per track, per store, with
    each store's own file named) — without it nothing says which track set the
    total duration.
  - The file name is built **before** `tryStart` so the same INSERT records it
    in the new `sync_log.logFile` column (a running row always names its file),
    but the file is opened only **after** the lock is won, so a run that loses
    the race leaves nothing on disk.
  - Lines come from the existing `ScrapeProgressEvent` stream, which grew
    `detail-failed`/`llm`/`persisted`/`listing-incomplete`/`stock-drop`
    members; `buildReporter`
    fans each event out to the file **and** the existing `sync_log` progress
    touch. `ScrapePersistService.persist` therefore takes an optional trailing
    `reporter`.
  - **Everything is best-effort by construction**: the first stream error
    disables the writer (one stdout warning, later lines dropped), `close()` is
    idempotent, time-boxed at 2 s, and flips its `closed` flag **synchronously**
    — which is what makes the timeout path safe, since a timed-out collection is
    abandoned rather than aborted and keeps emitting events after its row was
    closed. `runStoreSync` closes the row and the file in nested `finally`s, so
    neither is skipped because the other threw.
  - `SYNC_LOG_DIR` (default `./log`, empty disables file logging) and
    `SYNC_LOG_RETENTION_DAYS` (default 30, `0` = keep forever, swept by mtime at
    boot and after each full sync — the Python version never cleaned up).
    `0` meaning "keep forever" is what exposed the `BaseConfig.asNumber` bug
    fixed alongside this (see "Config").
  - Deployment: `docker-compose.yaml` bind-mounts `./log:/app/log` and forwards
    both vars; `scripts/deploy.sh` pre-creates the directory `chmod 777` because
    Docker would otherwise create the bind source as root-owned and the
    container's `appuser` (uid 10001) could not write to it.
- **Cron** (`SyncCronService`): one `@nestjs/schedule` job driving
  `runFullSync()`, defaults `0 12 * * *` `Europe/Kyiv`, **registered only when
  `SYNC_CRON_ENABLED` is true** — and it ships disabled (arming it in
  production is part of the cutover). Either way the boot log says which state
  the process is in. Details that are load-bearing:
  - The `@Cron` decorator cannot be used: its arguments are evaluated at class
    definition time and so cannot read runtime config. The job is built with
    `CronJob.from({ cronTime, timeZone, onTick })` (the positional
    `new CronJob(...)` form is legacy in `cron` 4.x) and `cron` is therefore a
    direct dependency pinned to the exact version `@nestjs/schedule` resolves,
    so there is only ever one copy. `SchedulerRegistry.addCronJob` only
    registers a job — `job.start()` after it is what arms the timer.
  - Registration happens in `onApplicationBootstrap`, **not** `onModuleInit`:
    Nest runs one module's `onModuleInit` hooks concurrently (`Promise.all`),
    so arming there could beat `SyncOrchestratorService`'s boot sweep. Every
    `onModuleInit` settles before any `onApplicationBootstrap` runs.
  - Shutdown needs no code here: `ScheduleModule`'s own
    `beforeApplicationShutdown` stops and drops every registered job (verified
    — a `SIGTERM`ed process exits immediately instead of waiting on the timer).
    A sync in flight at that moment is abandoned with its `sync_log` row open;
    the next boot sweep closes it. The job deliberately does **not** use
    `waitForCompletion`: `stop()` would then poll every 100 ms until the run
    ends, keeping the event loop alive long past shutdown, and overlap is
    already impossible via the row lock.
  - An unusable `SYNC_CRON_EXPRESSION` throws during bootstrap and fails the
    boot. That is deliberate — a schedule that silently never fires is the
    worse failure.
  - The job body never rethrows; it logs one summary line (a warning when
    anything failed or was skipped) plus one line per track with each store's
    duration, which is what makes it obvious in production that the browser-tier
    track sets the total run time.
  - `ScheduleModule.forRoot()` is registered in `app.module.ts` (it is a global
    module exporting `SchedulerRegistry`), scheduling being an app-wide concern.
- Endpoints: `POST /store/:slug/sync` (`202`, `[Resource.STORE, Action.SYNC]`),
  `GET /store/sync-status` (`@CacheControl('no-cache')`, polled by the web
  client) and `GET /store/:slug/sync-log/:id/file` — the run's log file as
  `text/plain`, 404 when the row is not that store's, wrote no file, or the file
  is gone. It is the one handler that takes the reply over (`@Res()`, no
  `passthrough`) instead of using `@Plain`: the outgoing validation the type
  decorators install expects a DTO instance and would reject a plain string, so
  permission metadata comes from the standalone `@Permission` decorator. The
  stored name is still resolved against `SYNC_LOG_DIR` and rejected if it
  escapes it. `sync-status` must stay declared **before** the `:slug` routes.

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

`user.lastActiveAt` is stamped by `AuthJwtGuard` on every authenticated
request (`AuthService.touchActivity` → `CoreUserService`), fire-and-forget so
neither its latency nor its failure reaches the response. The write is
throttled in SQL — the `UPDATE` carries its own `lastActiveAt < now() -
interval` guard, so outside the five-minute window Postgres matches no row and
writes nothing. Nothing wrote the column before this, which is why the admin
screen showed stale dates.

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
- **A string var that has a default must be read with `nonEmpty`, not
  `asString(...) ?? default`.** `asString` returns whatever the process holds,
  and the `environment` block below forwards an omitted host var as an _empty
  string_, so the name is always defined in a container and `??` hands that
  empty string on as if it were configured — the documented default becomes
  unreachable in production. `nonEmpty` treats empty and blank as unset, the
  way `asNumber` already does. This cost a production debugging session on
  `PUSH_VAPID_SUBJECT`, whose empty value `web-push` rejects, silently
  disabling push.
- Fields are `public readonly`, annotated with class-validator decorators;
  `BaseConfig` self-validates on construction (via `setImmediate`) and throws
  `ConfigurationError` on invalid values.
- **`asNumber` treats a configured `0` as a value, not an absence.** It used to
  read `env && Number(env) ? Number(env) : default`, so `0` (falsy) fell back to
  the default — which silently inverted any variable whose zero means something
  (`SYNC_LOG_RETENTION_DAYS=0` = "keep every log file forever" became 30 days).
  It now falls back only on an unset, empty or blank value (compose forwards an
  omitted host var as an empty string, so empty must keep meaning unset) and on
  a non-finite one, so a typo still surfaces as the default rather than `NaN`.
  Consequence to keep in mind: a zero that is nonsense for its field is now
  rejected loudly by that field's own validator instead of being swapped for the
  default — `DB_RETRY_ATTEMPTS=0` fails the boot against `@IsPositive()` rather
  than falling through to TypeORM's own default. Pinned by
  `test/base.config.spec.ts`.
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
`VALKEY_INJECT_KEY`); scrape vars (`SCRAPE_DELAY_MULTIPLIER` default 1,
`LLM_API_KEY` + `LLM_MODEL` — field enrichment, name extraction and flavor
classification, either unset = all three disabled; `LLM_BASE_URL` defaults to
`https://openrouter.ai/api/v1`, set it to `https://api.openai.com/v1` or any
other OpenAI-compatible gateway to switch provider; `LLM_REASONING` default
false — see the reasoning note under "Scraping engine"; `LLM_FLAVOR_MODEL` /
`LLM_FLAVOR_REASONING` default to `LLM_MODEL` / `LLM_REASONING` and redirect
**only** the flavor pass — they are not enable switches, and that pass is the
one place where the answer depends on the model actually knowing the bottling
rather than rewriting an input line, so it is worth a stronger slug than the
extraction passes (measured: `anthropic/claude-sonnet-5` discriminates per
product where `deepseek-v4-flash` returns a per-category template — see
"Scraping engine"); `LLM_CONCURRENCY` (5 — batches in flight per pass; a
politeness cap, since OpenRouter publishes no rate ceiling for a funded key),
`LLM_TIMEOUT_MS` (120000) and `LLM_MAX_RETRIES` (2) — the two SDK limits the
client used to leave at their defaults of ten minutes and two retries, which let
one stalled call outlast a whole sync; `LLM_APP_NAME` /
`LLM_APP_URL` — sent as OpenRouter's `X-Title` / `HTTP-Referer` attribution
pair, which fills the `App` column of its activity log. Default `Whisky dev`,
with `docker-compose.yaml` defaulting the deployed service to `Whisky prod`,
so a checkout and the prod container are told apart without either being
configured; `KB_APPLY_ON_BOOT` (default true) — whether `KbBootApplyService`
re-applies the knowledge base to the catalogue once at application bootstrap,
which is what makes a deploy that ships KB rows through a migration take
effect without a manual reconcile — see "The knowledge base in operation");
sync vars in
`SyncConfig` — `SYNC_CRON_ENABLED` (default false), `SYNC_CRON_EXPRESSION`
(default `0 12 * * *`), `SYNC_TIMEZONE` (default `Europe/Kyiv`),
`SYNC_MAX_PARALLEL_TRACKS` (4), `SYNC_STORE_TIMEOUT_MS` (1200000 — raised from
900000 on 2026-08-22 for `goodwine`, whose 61-page catalogue at an 8-15 s delay
is 8-15 minutes of listing walk alone, so an unlucky run did not fit and was
abandoned having written nothing),
`SYNC_BROWSER_STORE_TIMEOUT_MS` (2700000 — the budget for a `needsBrowser`
store, which needs ~20 min for a full pass and would never fit the HTTP one),
`SYNC_LLM_DEADLINE_MARGIN_MS` (120000 — how early the optional passes, detail
enrichment and the LLM ones, must stop so the run still has time to persist;
see "Scraping engine"),
`SYNC_LOG_DIR` (`./log`; empty disables per-sync log files) and
`SYNC_LOG_RETENTION_DAYS` (30; `0` keeps every file — see "Sync
orchestration").
`SYNC_CRON_ENABLED`/`SYNC_CRON_EXPRESSION`/`SYNC_TIMEZONE` are read by
`SyncCronService` at bootstrap (see "Sync orchestration"): with the flag unset
no job is registered at all, and changing any of the three needs a restart.
Push vars in `PushConfig` — `PUSH_ENABLED` (default false),
`PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` / `PUSH_VAPID_SUBJECT`
(generate with `node -e "console.log(require('web-push').generateVAPIDKeys())"`;
missing keys degrade to "push off" rather than failing the boot),
`PUSH_CONCURRENCY` (8), `PUSH_TTL_SEC` (86400) and `PUSH_LOG_RETENTION_DAYS`
(30) — see "Push notifications" under "API contract".
In production every `SYNC_*`/`PUSH_*` var is forwarded from the host `.env` by
the `environment` block of `docker-compose.yaml` — compose reads `.env` only to
interpolate `${...}` in that file, and the image carries no `.env` of its own
(`.dockerignore` excludes it), so a var that is not listed there never reaches
the process. Add any new config var to that block, or it will silently keep
its default in production.

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

## Resilience and observability (2026-08-30)

Added after a 68-minute production outage in which the API accepted
connections and answered none of them, while writing **nothing at all** to the
log. Both halves of that sentence are the design brief: bound every wait, and
make sure a stall says so.

### What the outage taught

Requests were stalling in `AuthJwtGuard`. Nest runs guards **before** every
interceptor, so `LogInterceptor` never ran: there was no "incoming request"
line, no error, no trace. The database went idle (PostgreSQL skipped its
five-minute checkpoints for 52 minutes) because no request ever reached it.
The only surviving evidence was outside the application — nginx's `while
reading response header from upstream`, and Valkey's own save timestamps,
which bracketed the window to the second.

Two rules follow, and new code is expected to keep them:

- **Every wait on anything external is bounded.** A default of "wait forever"
  is not a neutral default; it converts any dependency's bad minute into an
  unbounded outage of everything.
- **Anything on the request path ahead of `LogInterceptor` logs its own
  steps.** Nothing else will.

### Timeouts

| Layer    | Setting                             | Default | What it stops                          |
| -------- | ----------------------------------- | ------- | -------------------------------------- |
| Valkey   | `VALKEY_COMMAND_TIMEOUT_MS`         | 2000    | A session lookup that never returns    |
| Valkey   | `VALKEY_KEEP_ALIVE_MS`              | 10000   | A socket whose peer vanished silently  |
| Valkey   | `VALKEY_OFFLINE_QUEUE`              | `false` | Commands piling up while disconnected  |
| Postgres | `DB_ACQUIRE_TIMEOUT_MS`             | 5000    | Queueing forever for a drained pool    |
| Postgres | `DB_STATEMENT_TIMEOUT_MS`           | 60000   | A statement that never finishes        |
| Postgres | `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 120000  | An abandoned transaction holding locks |
| HTTP     | `APP_REQUEST_TIMEOUT_MS`            | 30000   | A handler chain that overruns → `503`  |
| HTTP     | `APP_REQUEST_DEADLINE_MS`           | 45000   | A request stalled **in a guard**       |
| HTTP     | `APP_KEEP_ALIVE_TIMEOUT_MS`         | 72000   | Racing the proxy's pool into `502`s    |

`TimeoutInterceptor` is registered **first** among the global interceptors so
its clock covers logging, validation and serialization. It cannot cover
guards, which is why `RequestDeadlineMiddleware` exists: middleware is the
earliest hook Nest offers, and it arms a deadline on the request's own socket
(lifted on `finish`, so idle keep-alive connections are never reaped — reaping
those is what turns a proxy's pooled connection into a spurious `502`).

`DbConfig.extra` is a **field, not a getter**: the config object is spread into
the TypeORM options and a spread copies own properties only.

### The heartbeat (`lib/watchdog`)

One line every `WATCHDOG_INTERVAL_MS` (10 s, on by default):

```
heartbeat: loop lag 0.9/1.6 ms (mean/max), rss 216 MB, heap 97 MB,
handles 4, db pool 1 open/1 idle/0 waiting, valkey 2 ms
```

Logged at `debug`, promoted to `warn` when the loop lags past
`WATCHDOG_LAG_WARN_MS`, when anyone is queued for a connection, or when the
Valkey ping does not answer within `WATCHDOG_PING_TIMEOUT_MS`. **A heartbeat
that stops is itself a diagnosis** — it means the event loop is gone.

Two details that are load-bearing:

- The ping is raced against its own deadline. The watchdog never trusts the
  client it is watching to come back.
- `monitorEventLoopDelay` records the whole sampling interval, so an idle loop
  reads back as the resolution; the resolution is subtracted before reporting.
  Without that every heartbeat would claim ~20 ms of lag that is not there.

### Tracing the auth path

`AuthSessionService.track()` logs **before** each cache command, not only
after. A command that never returns produces no completion line and no error,
so the line proving it was ever sent has to be written first — that is exactly
what was missing on 2026-08-30. `AuthJwtGuard` and `AuthService.authenticate`
trace each step with elapsed times at `verbose`.

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

## API contract

What a client must not guess: the endpoint inventory, the field maps and the
per-feature contracts. **Update this section alongside any API contract
change** — `../web` treats it as the source of truth, and `/docs-json`
describes shapes but not semantics.

Conventions that hold everywhere:

- **Field names are camelCase, exactly as stored in the database.** No
  snake_case adaptation layer.
- **No UI text in responses.** The API returns **structured** fields (`isNew`,
  `daysNew`, `daysDiscount`, `discountPct`, `referencePrice`) and the frontend
  composes any display text / i18n.
- **Filter options come from the database**, not hardcoded lists: `/meta`'s
  `flavors` and `types` are the `flavor` / `type` tables, `countries` are the
  countries actually referenced by products.
- **IDs are UUID v7 strings.**
- **Auth** is bearer-JWT + a refresh cookie; every non-public endpoint needs
  `Authorization: Bearer <access>`.
- Report defaults (`minPrice`, `maxPrice`, `NEW_DAYS`, …) are fixed server
  constants in `~constants/report.constants.ts`; an unset filter simply means
  "no constraint".

### Auth endpoints

| Endpoint                                                           | Notes                                                                                                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login` `{login,password}` → `{access}` + cookie        | Response key is `access`. Cookie is `refresh`, HttpOnly, `sameSite=strict`, `path=/`. Imported (pbkdf2) users log in with old passwords; the hash is upgraded to Argon2 on first login. |
| `POST /auth/refresh` (refresh cookie) → `{access}`                 | Rotates the refresh cookie.                                                                                                                                                             |
| `POST /auth/logout`                                                | Revokes the session. `204`.                                                                                                                                                             |
| `GET /auth/me` → `{id, sid, admin}`                                | Current user from the token.                                                                                                                                                            |
| `GET /auth/session[/:userId]`, `DELETE /auth/session/:userId/:sid` | Session listing / revocation.                                                                                                                                                           |

Access token payload: `sub` (user id), `sid` (session id), `admin`, `scope`
(space-separated `resource:action`). Admins bypass scope checks.

### Endpoint inventory

| Endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Auth                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `GET /meta`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | any logged-in user                           |
| `GET /report/{kind}` (`kind`: catalog\|drops\|low\|new\|best)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | any logged-in user                           |
| `GET /report/history?term=` — `term` takes a report row's id (a store offer), a canonical `productId` (resolved to that bottling's in-stock, most recently seen offer), or a name/URL substring. The series is always one store's price history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | any logged-in user                           |
| `GET /store` (sites + config) `store:list`, `GET /store/{slug}` `store:read`, `PATCH /store/{slug}` `{active}` `store:update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | admin in practice                            |
| `POST /store/{slug}/sync` — starts an on-demand sync, `202` + the open sync-log row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `store:sync`                                 |
| `GET /store/sync-status` — the syncs currently in flight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `store:list`                                 |
| `GET /store/{slug}/sync-log/{id}/file` — the run's log file as `text/plain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `store:read`                                 |
| `POST /product/update` `{id, name?, countryCode?, typeName?, age?, abv?, volumeMl?}` — edit product overrides (undefined fields untouched). `id` accepts a report row's id (a store offer) or a canonical `productId`; either way the edit writes the **bottling**, so it applies to every store listing it                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `product:edit`                               |
| `GET/POST /user`, `GET/PATCH/DELETE /user/:id`, `POST /user/password[/:userId]`, `GET/PUT /user/:userId/permissions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | admin                                        |
| `GET /dashboard/meta` — capture bounds + per-store snapshot coverage (data floor, per-store first/last day, listing counts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | any logged-in user                           |
| `GET /dashboard/summary?from&to&stores=` — KPI metrics as `{latest, baseline, delta, deltaPct}` pairs over the range's first/last data day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | any logged-in user                           |
| `GET /dashboard/series?from&to&stores=&byStore=&byCountry=&granularity=` — per-day metric series (total + optional per-store / per-country partitions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | any logged-in user                           |
| `GET /dashboard/breakdown?by=type\|country\|priceBucket\|flavor\|store&date=&stores=` — one day's in-stock assortment sliced by a dimension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | any logged-in user                           |
| `GET /dashboard/movers?from&to&stores=&limit=&minPrice=` — biggest price drops and rises over the range (first vs last snapshot per listing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | any logged-in user                           |
| `GET /dashboard/sync-activity?from&to&stores=` — sync runs, outcomes and persist counters per day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | any logged-in user                           |
| `GET /preference` — the caller's own favorites and blacklist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | any logged-in user                           |
| `GET /preference/{userId}` — another user's preferences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `preference:read` or self (admin bypasses)   |
| `POST /preference/favorites` `{productIds}` — add favorites (idempotent), `200` + the fresh preference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | any logged-in user                           |
| `DELETE /preference/favorites` `{productIds}` — remove favorites (body on DELETE)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | any logged-in user                           |
| `POST /preference/blacklist` `{productIds?, brands?}` — hide bottlings and/or brands; also drops those bottlings from the favorites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | any logged-in user                           |
| `DELETE /preference/blacklist` `{productIds?, brands?}` — un-hide; restores no favorite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | any logged-in user                           |
| `GET /preference/details` — the caller's own lists resolved to renderable entries, newest first (see "Preferences")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | any logged-in user                           |
| `GET /preference/{userId}/details` — another user's lists resolved to renderable entries, newest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `preference:read` or self (admin bypasses)   |
| `POST`/`DELETE /preference/{userId}/favorites` `{productIds}` — edit another user's favorites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `preference:update` or self (admin bypasses) |
| `POST`/`DELETE /preference/{userId}/blacklist` `{productIds?, brands?}` — edit another user's blacklist; the `POST` also drops those bottlings from their favorites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `preference:update` or self (admin bypasses) |
| `GET /push/config` — whether web push is on plus the VAPID public key to subscribe with (see "Push notifications")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | any logged-in user                           |
| `GET /push/subscription` — the caller's subscribed devices (no key material)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | any logged-in user                           |
| `POST /push/subscription` `{endpoint, p256dh, auth}` — register/refresh this browser's subscription, `200` + the fresh device list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | any logged-in user                           |
| `DELETE /push/subscription` `{endpoint}` — drop this browser's subscription (body on DELETE)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | any logged-in user                           |
| `POST /push/test` — send a test notification to every device of the caller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | any logged-in user                           |
| `POST /push/digest` `{capturedOn?}` — manually run the price-drop digest dispatch (idempotent per day)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `store:sync`                                 |
| `GET /quick-filter` — the caller's own saved filter sets (see "Quick filters")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | any logged-in user                           |
| `GET /quick-filter/user/{userId}` — another user's saved filter sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `quick_filter:read` or self (admin bypasses) |
| `POST /quick-filter` `{name, filters}` — save a new set, `200` + the caller's fresh list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | any logged-in user                           |
| `PATCH /quick-filter/{id}` `{name?, filters?}` — rename and/or replace the filters; an absent field is left alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | any logged-in user                           |
| `DELETE /quick-filter/{id}` — delete one of the caller's sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | any logged-in user                           |
| `GET /product/search?q=&limit=` — lightweight autocomplete over the whole catalogue, one item per bottling; **ignores the caller's blacklist** (see "Catalogue search")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | any logged-in user                           |
| `GET /brand/search?q=&limit=` — lightweight autocomplete over producer names, matched through their aliases (see "Catalogue search")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | any logged-in user                           |
| `GET /product/review/summary` — counters for the curation screen's tabs. `untrustedFacts` is the **distinct** number of bottlings with either fact untrusted; `untrustedTypes`/`untrustedCountries` are the per-field counts and must never be summed (892 bottlings carry both); `untrustedFactsUnresolved` is how much of that queue resolves to no producer at all — the half that is a symptom rather than work                                                                                                                                                                                                                                                                                                                                                              | `product:review`                             |
| `GET /product/review/producers?status=&name=&page=&perPage=` — producers by review status. The `unverified` page is ranked by `potentialReach` — how many bottlings would resolve to the row if the whole withheld queue went live — because `productCount` is structurally 0 for every withheld row and ranking by it ranks alphabetically. `potentialReach` is null on the other statuses, where `productCount` is a real answer. `name` is a case-insensitive substring of the producer's name or slug; rows carry the country's `countryName`/`countryIcon` beside the code                                                                                                                                                                                                  | `producer:read`                              |
| `GET /product/review/facts?field=type\|country&producer=resolved\|unresolved&name=` — bottlings whose type or country the filters no longer trust, worst-first by how many shops carry them. Each row carries the country's `nameUa`/`icon`, the resolved `producerSlug` (null when nothing resolved) and up to five `stores` links (one per shop, in-stock first) to the listings that produced the fact. **`producer` splits the queue into its two jobs**: roughly nine rows in ten resolve to no producer and are a symptom cured a producer at a time, while the rest have one and are here because their producer's range spans several types, so nothing but a person can settle it. `name` is a case-insensitive substring of the canonical name or any store's raw name | `product:review`                             |
| `GET /product/review/conflicts?attribute=&store=&name=` — unresolved cross-shop contradictions, worst-first by how often each was seen. `name` is a case-insensitive substring of the bottling's canonical name or any store's raw name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `product:review`                             |
| `POST /product/review/apply` — re-resolve the whole catalogue against the knowledge base and write what it implies (producers, country/type, flavour links), answering `200` with what was written. **This is the other half of every review decision**: promoting a producer stores a claim and changes nothing a filter reads until this runs, and a store sync applies it only to the bottlings that run touched. Shares `KbReconcileService` verbatim with `pnpm reconcile-flavors`; idempotent, so a second call reports zeros                                                                                                                                                                                                                                              | `product:review`                             |
| `POST /product/review/conflicts/resolve` `{productId, storeId, attribute}` — mark one settled, `204`. Records a decision, not a correction; the scrape un-resolves it if the claim arrives again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `product:review`                             |
| `GET /producer/unresolved?limit=` — brand keys nothing resolves, derived rather than stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `producer:read`                              |
| `GET /producer/:id/products` — the display names behind one producer row, **grouped by name** and alphabetical: for a live (`verified`/`auto`) producer, everything that resolves to it today in either slot (made by it or bottled by it — the bottler slot matters because a bottler's `productCount` is structurally 0); for a withheld one, the what-if list its `potentialReach` came from, so the counts always sum to the number the queue ranked by. Each row is `{name, productCount, inStock}` — `name` falls back to the longest raw store name, `productCount` is how many bottlings share it (volumes, ages, boxes), and `inStock` is true when any of them is stocked anywhere                                                                                     | `producer:read`                              |
| `POST /producer/:id/rule` — create one producer-scoped name-pattern rule **and apply it** (the catalogue is re-resolved in the same request; answers the reconcile summary). Body: `{pattern, matchMode?, priority?}` plus exactly one claim — `peatProfile` (never `unknown`) or `flavorName`+`effect` (`require`/`forbid`, never `baseline` — that belongs to the house style). The pattern is normalized via `KbKeyUtils.key`; an unknown flavour is 400, a duplicate `(producer, pattern, flavor)` is 409. Global rules cannot be created here — they stay migration-authored                                                                                                                                                                                                | `producer:update`                            |
| `DELETE /producer/:id/rule/:ruleId` — delete one of the producer's own rules **and apply the removal** (answers the reconcile summary). Scoped to the producer, so a global rule is unreachable by construction; a foreign or unknown rule id is 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `producer:update`                            |
| `GET /producer/:id` — one producer plus the things that override its facts: its child lines (`parentId`), its own name-pattern rules, and the global peat rules as read-only context. A peat band cannot be judged without them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `producer:read`                              |
| `PATCH /producer/:id` — edit a producer **and apply it**: the catalogue is re-resolved in the same request and the response is `{producer, applied}`, where `applied` is what the pass wrote. Storing the decision alone changes nothing a filter reads, so the two are one action; the pass costs ~200 ms, is idempotent and never touches a `manual` value. Nullable fields come in pairs (value + a `clear*` flag) so a reviewer fixing one field cannot silently wipe another, and `status` carries the verdict: `verified` promotes the row, `rejected` rules it out as not a whisky producer, `unverified` puts it back in the queue                                                                                                                                       | `producer:update`                            |

The frontend is hosted separately and reaches this API same-origin through a
`/api` proxy that strips the prefix; no global route prefix is used.

Report list responses are paginated: `{ data: ReportGroup[], total, limit,
offset }`. **One item is one bottling, not one store's offer, so
`total`/`limit`/`offset` count products** — see "Report groups" below.

The read endpoints (`GET /meta`, `GET /report/{kind}`, `GET /report/history`,
`GET /store`, `GET /store/{slug}`, every `GET /dashboard/*`) send
`Cache-Control: private, max-age=600` so the browser caches them for 10
minutes; a hard reload bypasses it. Mutations (`POST /product/update`,
`PATCH /store/{slug}`, `POST /store/{slug}/sync`) and `auth`/`user` endpoints
are uncached; `GET /store/sync-status` is explicitly uncacheable
(`private, no-cache, no-store, must-revalidate`) because the web client polls
it while a sync runs.

### Sync endpoints

`POST /store/{slug}/sync` (permission `store:sync`) starts a sync of one store
and returns `202` immediately with the freshly opened `sync_log` row — the
collection itself continues in the background. Failure cases: `404` unknown
slug; `400` when the store is inactive, has no scrape configuration, or is not
a `ts`-engine store; `409` when the store — or any store of its concurrency
`group` — is already syncing (the message names the blocker).

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

### Dashboard (2026-08-22)

Six read-only endpoints under `/dashboard`, all `Resource.AUTHENTICATED`.
The contract details a client must not guess:

- **Dates are UTC calendar days** (`YYYY-MM-DD`), matching
  `price_snapshot.capturedOn`; `from`/`to` are inclusive on both ends. Ranges
  are clamped server-side to the days that actually have data
  (`/dashboard/meta` names the bounds: `dataFloorDate` / `latestDate`), and
  the resolved range is echoed. A range longer than 732 days is a 400.
- **`stores` is a CSV of slugs** and scopes every metric of the response;
  `byStore`/`byCountry` additionally partition that same scope. The partition
  envelopes are separate from `total` because distinct counts and medians do
  not compose across partitions — never sum them.
- **Every metric describes what was _in stock_ that day**, out-of-stock
  snapshots included in neither the counts, the medians, the breakdowns nor
  the movers. A capture day can hold several syncs and some stores keep
  publishing a sold-out listing at a price, so "captured that day" and
  "available that day" are not the same set — the API answers the second. A
  client comparing a day's `inStockListings` against `/store/:slug` will see
  them agree on the latest day (before 2026-08-23 the dashboard could read
  ~600 listings higher for `silpo`).
- **Out-of-stock is derived, not scraped**:
  `oosListings(day) = max(0, tracked(day) - inStock(day))` with
  `tracked = COUNT(listings WHERE firstSeen <= day)`. On the latest day this
  equals the `inStock = false` listing count the store pages report. It
  cannot distinguish a delisted SKU from a temporary stock-out, and the very
  first data days are ramp-up artifacts (see `dataFloorDate`).
- **`granularity`**: `day` or `week`; an unpinned range longer than 120 days
  is downsampled to weeks and the response says so. Weekly buckets label
  themselves with the ISO week's Monday; level metrics take the bucket's last
  observed day, flow metrics (`newListings`, `departedListings`) sum.
- `departedListings` is structurally 0 on the latest day (a departure is only
  knowable once a later sync misses the listing), and `sync-activity.removed`
  attributes the same event to the sweep's day — one day later.
- `summary` metrics are `{latest, baseline, delta, deltaPct}` with
  `baselineDate`/`latestDate` echoed (the range boundary is not always a data
  day); `deltaPct` is null on a null or zero baseline. `promoShare` is a
  0..1 fraction.
- `breakdown` echoes the resolved `date` (an absent or out-of-bounds date
  resolves to the latest captured day). `by=flavor` sets `overlapping: true` —
  those buckets must not be rendered as parts of a whole. `priceBucket` keys
  are `width_bucket` ordinals with explicit `minPrice`/`maxPrice` bounds
  (null = open-ended).
- `movers` rows carry `storeProductId` (for `/report/history`) and
  `productId`, plus per-row `firstDate`/`lastDate` — the compared edges float
  inside the range when a listing appeared late or departed early.
- `sync-activity.itemsSeen` is the scrape-side `total` counter renamed: it
  counts everything the listing walk saw (including out-of-stock items that
  persist skips), so it is not `added + updated`.

### Report groups (2026-08-12)

A report item is a **bottling with its offers**, not one store's offer. Every
field in the `ReportRow` table below still means exactly what it did — it is
now the **cheapest offer's** value — and the item carries one added field:

| Field    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offers` | the bottling's selected offers, **price ascending, never empty**. `offers[0]` is the primary one, and every top-level field of the item equals it. Offer fields: `id`, `sku`, `url`, `nameOrig`, `storeSlug`, `storeName`, `price`, `oldPrice`, `currency`, `promo`, `inStock`, `previousPrice`, `referencePrice`, `discountPct`, `isNew`, `daysNew`, `daysDiscount`, `firstSeen`, `capturedDate`. The bottling's own fields (`productId`, `name`, `age`, `abv`, `volumeMl`, `brand`, `type`, `country*`, `flavors`) are stated once, on the item |

Which offers a group holds depends on the kind:

| Kind      | `offers`                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog` | every in-stock offer of the bottling                                                                                                                                                                                      |
| `new`     | only the offers that qualified — a whisky two stores just started listing holds exactly those two, not the stores that have had it for months                                                                             |
| `drops`   | only the discounted offers (after `minDiscount` and the discount-day window)                                                                                                                                              |
| `low`     | one item **per qualifying offer**, each with a single offer. Two stores at their own window low stay two items, so two items can share a `productId`                                                                      |
| `best`    | every in-stock offer of the bottling (2026-08-22), one item per multi-store bottling, led by the winning offer. Each offer's `discountPct` is its own price move; the winner's is the item's saving against the runner-up |

Consequences worth knowing:

- **The primary offer is always the cheapest one**, even when a pricier store
  advertises a deeper cut: 1000 at −10 % leads over 1100 at −15 %, and `drops`
  ranks groups by the primary offer's `discountPct`. The deeper cut is visible
  inside the group.
- **Offer-level filters restrict the array**, not just the page: `stores` and
  `minPrice`/`maxPrice` leave a group holding only its matching offers, so the
  headline price is the cheapest _matching_ offer. A bottling appears whenever
  at least one of its offers survives.
- **`best` is the exception to the price bounds** (2026-08-22): it compares a
  bottling's offers against each other, so it is given every offer whatever it
  costs, and `minPrice`/`maxPrice` then filter the **winning** offer — the only
  price the item quotes as its own. Its `offers` array therefore lists stores
  above the ceiling, which is the point: they are what the saving is measured
  against. With the bounds applied in SQL instead, a runner-up above the
  ceiling was dropped before the comparison, the group fell under the two-store
  guard, and the affordable offer vanished with it (1699 at rozetka against
  3299 at maudau disappeared from `maxPrice=2000`).
- **`name` search behaves the same way.** The term is matched against the
  bottling's `name` **or** an offer's `nameOrig`, so a raw-name term like
  «в коробці» yields a group of just the offers that spell it out.
- **`id` (not `productId`) is still the item key**, and what `/report/history`
  and `POST /product/update` take. A store may appear twice in one group (two
  SKUs of one bottling, e.g. boxed and plain), so `offers.length` counts offers,
  not stores.
- **`GET /report/history` carries no group**: its `product` is a plain `ReportRow`
  with no `offers` — a single offer's history has no group.
- **`best` offer grouping** reads the persisted `productId` — the offers of one
  bottling — rather than recomputing a key at read time. The key itself
  (normalized name + brand + volume + age, no ABV) is derived once, when a
  store first lists a SKU, and then frozen; a mismatch is corrected by hand and
  the correction sticks. The intent: the same bottling carried by ≥2 stores,
  cheapest. Two guards remain — a group must span at least
  two stores (one store can list the same bottling twice), and a winner far
  below the runner-up is dropped as an implausible deal. Bottlings with no known volume participate too.

### ReportRow (report item fields + `history.product`)

| Field                       | Notes                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (uuid)                 | the **store offer** — one row per store × SKU. Unchanged by the catalogue split; still what `/report/history` and `/product/:id` take                                                                                                    |
| `productId` (uuid)          | the **bottling** this row is an offer of. Rows from different stores sharing it are the same whisky: that is how `best` groups them, and an edit through any of them applies to all                                                      |
| `storeName`                 |                                                                                                                                                                                                                                          |
| `storeSlug`                 |                                                                                                                                                                                                                                          |
| `sku`                       |                                                                                                                                                                                                                                          |
| `name`                      | the product alone — brand + expression (see the note below the table); **nullable** — `null` when cleaning left nothing, fall back to `nameOrig`                                                                                         |
| `nameOrig`                  | raw scraped name, always present; the display fallback for `name` and the value shown (read-only) in the edit modal                                                                                                                      |
| `url`                       |                                                                                                                                                                                                                                          |
| `price`                     |                                                                                                                                                                                                                                          |
| `previousPrice`             | price of the immediately previous snapshot                                                                                                                                                                                               |
| `referencePrice`            | the value the discount is measured against (previous observed price / window max / competing offer); report-specific, always from our own price history, never `oldPrice`                                                                |
| `oldPrice`                  | store strike-through price from the latest snapshot                                                                                                                                                                                      |
| `discountPct`               |                                                                                                                                                                                                                                          |
| `age`                       |                                                                                                                                                                                                                                          |
| `abv`                       |                                                                                                                                                                                                                                          |
| `volumeMl`                  |                                                                                                                                                                                                                                          |
| `type`                      |                                                                                                                                                                                                                                          |
| `brand`                     | `COALESCE(producer.name, bottler.name)` — the knowledge base's curated name, not a shop's spelling of it (see "The brand label"). Null only when the bottling resolves to no producer at all. Equal to `distillery` whenever that is set |
| `countryName`               |                                                                                                                                                                                                                                          |
| `countryCode`               |                                                                                                                                                                                                                                          |
| `countryIcon`               |                                                                                                                                                                                                                                          |
| `currency`                  |                                                                                                                                                                                                                                          |
| `inStock`, `promo`          | `promo` comes from the latest snapshot. `inStock` is the offer's current availability: list endpoints only ever return `true` (out-of-stock products are filtered out, not deleted), `/report/history` can return `false`                |
| `flavors` (string[])        |                                                                                                                                                                                                                                          |
| `firstSeen`, `capturedDate` | `YYYY-MM-DD`                                                                                                                                                                                                                             |
| `isNew`                     |                                                                                                                                                                                                                                          |
| `daysNew`                   |                                                                                                                                                                                                                                          |
| `daysDiscount`              | days the current price has held (days since it was last higher); `drops` only, null elsewhere                                                                                                                                            |

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

`stores`, `minPrice`, `maxPrice`, `minVolume`, `maxVolume`, `flavors`,
`excludeFlavors`, `types` (a CSV; `unknown` matches typeless products),
`countries` (also accepts `unknown`), `regions`, `excludeRegions`,
`verifiedFacts`, `minDiscount`, `name`, `window`
(today|yesterday|week|month|year), `sort`, `order` (asc|desc), `page`,
`perPage`, `favoritesOnly` (`true`/`false`, see "Preferences"). Multi-value
params are comma-separated
(e.g. `stores=maudau,novus`).
`window` drives the `low`/`drops` lookback with `week|month|year`; for the `new`
report `today`/`yesterday` instead narrow listings to that added-on day (`/meta`
`windows` still lists only the period values). The `new` report measures recency
(`daysNew`, the `NEW_DAYS`-day window, and `today`/`yesterday`) against the real
current date — not the latest snapshot date — so ages are true elapsed days and
the report is empty when nothing has appeared in the last `NEW_DAYS` days. The
`drops` report likewise carries `daysDiscount` — how long the current price has
held (days since it was last higher), measured against the same real current
date; `null` on every other report.

**`discountWindow`** narrows `drops` by that `daysDiscount`: `today`/`yesterday` keep only the prices that took effect on
that day, any other value keeps them all. It exists because `window` is already
spent on the report's price-reference lookback, so the `new` report's trick of
repurposing `window` for a day filter has no room here. The web mobile `drops`
tab surfaces it as the "Знижено" picker, mirroring "Додано" on `new`.

`sort` values (ReportRow fields): `storeName`, `name`, `type`, `countryName`,
`age`, `abv`, `volumeMl`, `previousPrice`, `price`, `discountPct`,
`daysDiscount`. Nulls sort last. The offer-level fields (`storeName`, `price`,
`previousPrice`, `discountPct`, `daysDiscount`) order groups by the **primary
(cheapest) offer's** value; the rest are the bottling's own. Equal keys break
ties on the item id, so paging is stable. Omitting `sort` keeps the report's
natural order (e.g. `drops` by discount desc); the web `drops` tab defaults its
view to `sort=daysDiscount&order=asc` (freshest price drops first).

### Preferences (2026-08-22)

`GET /preference` answers
`{ favorites: string[], blacklistProducts: string[], blacklistBrands: string[] }`,
and so does every mutation — the client replaces its cached copy from the
response and needs no follow-up read. Both reads are
`private, no-cache, no-store, must-revalidate`.

Four things are easy to get wrong:

- **Favorites and the product blacklist take the canonical `productId`** — a
  report group's `productId`, **not** an offer's `id`. Sending an offer id
  answers `400 Unknown product`. (`POST /product/update` deliberately accepts
  either id; this endpoint does not, because a favorite is a whisky rather than
  one shop's listing of it.)
- **Brands are names in both directions**, spelled as the report's `brand`
  field spells them. An unknown name is `400 Unknown brand` listing the
  offenders — it never coins one.
  Since 2026-09-01 a rule names a **producer** (see "The brand label"): the
  names are `producer.name`, matched case-insensitively, and the rule is
  tested against a bottling's distillery **and** its bottler, so hiding
  `Douglas Laing` hides what it released. One consequence is visible to a
  client: a maker can no longer be hidden twice under two spellings, so a
  user who had blacklisted both `Chivas` and `Chivas Regal` now reads one
  entry, `Chivas Regal`.
- **A blacklist call must name something**: `{}` or two empty arrays is
  `400`. An empty `productIds` on the favorites endpoints is a documented
  no-op, so a client may post whatever selection it holds.
- **Adding a product to the blacklist removes it from the favorites**, in one
  transaction. Blacklisting a _brand_ does not: the report hides such a
  favorite while the rule stands, so lifting the rule restores it.

The blacklist filters every report kind, for that user, in SQL. Products whose
brand never resolved survive a brand rule (there is no unknown brand to hide).
The single-item paths — `GET /report/history` and the price history behind it —
are deliberately **not** filtered, so the product card that just hid a bottling
keeps working and the entry stays inspectable while removal is API-only.

Because `/report/*` is cached `private, max-age=600` and its rows are now
per-user, a client must bypass that cache after a preference mutation before
invalidating its report queries — otherwise the user's own change is masked
for up to ten minutes. The web client does this two ways: `forceFreshWindow()`
covers the refetches of report queries mounted at mutation time, and
`markReportsStale()` busts each report URL one-shot on its next fetch, which
covers a report page opened however long after the mutation (e.g. after
editing the lists on the settings screen).

**`GET /preference/details` (2026-08-22)** is the settings screen's read: the
same three lists resolved to renderable entries, newest first. Products come
as `{ productId, name, nameOrig, brand, age, abv, volumeMl, inStock,
addedOn }` and brands as `{ name, addedOn }`. It exists because the bare-id
read cannot be rendered — the reports unconditionally hide blacklisted
bottlings, so their names are resolvable nowhere else. Details worth knowing:
`name` can be null (display falls back to `nameOrig`), `nameOrig` can be null
too (a bottling no store lists — still shown, still removable), `inStock`
means "some offer of the bottling is in stock", and `addedOn` is the UTC
calendar day while the ordering keys on the full timestamp. Same
`private, no-cache` headers as the other preference reads.

**Per-user admin variants (2026-08-23)** exist so the users screen can read
and edit another user's lists: `GET /preference/{userId}/details` plus
`POST`/`DELETE` on `/preference/{userId}/favorites` and
`/preference/{userId}/blacklist`. Bodies, responses, and semantics are
identical to the own routes above — including "blacklisting a product drops
its favorite" — and an unknown `userId` is `404` rather than empty lists or a
foreign-key `500`. Reads require `preference:read`, writes `preference:update`
(or self; admins bypass both). One honest caveat: the **target** user's
browser HTTP cache cannot be busted from here. `/preference*` is `no-cache`,
so their next read is fresh, but `/report/*` is `private, max-age=600` — the
edited user may keep seeing pre-change report rows for up to ten minutes.

### Push notifications (2026-08-23)

Web-push digests of price drops on favorited whiskies, sent right after a sync
run. The contract the pieces rely on:

- **A "drop" is observed history, never marketing.** Today's
  `price_snapshot.price` must be lower than the offer's previous _existing_
  snapshot (out-of-stock gaps are looked across, up to
  `PUSH_MAX_PREVIOUS_GAP_DAYS = 30`; beyond that a returning listing is a new
  price, not a discount). The store's advertised `oldPrice` is never read —
  the same rule as `/report/drops`. Note the deliberate difference from that
  page: the digest compares against the _previous_ price ("cheaper than
  yesterday?"), the page against the _window maximum_ ("how good is this
  price?"), so their percentages may legitimately differ.
- **One digest per user per dispatch**, covering all their favorites that
  dropped: best percentage per bottling across stores, at most 5 named plus
  «та ще N». A single-drop digest links to `/product/{id}`, a multi-drop one
  to `/drops?favoritesOnly=true`. Blacklisted bottlings/brands are excluded
  with the same predicates the reports use.
- **Dedup is a claimed log**, `push_digest_log (userId, storeProductId,
  capturedOn)`: a dispatch atomically claims drops it is about to announce
  (`INSERT … ON CONFLICT DO NOTHING RETURNING`), so a second dispatch the same
  day sends only _newly found_ drops and concurrent dispatches split the work
  instead of duplicating it. Rows are pruned after
  `PUSH_LOG_RETENTION_DAYS = 30`.
- **Dispatch triggers**: the end of `runFullSync()` (once per run, not per
  store) and the completion of a _manual_ single-store sync. `POST
  /push/digest` runs the same pass by hand — being idempotent per day, it is
  safe to call any time.
- **Subscriptions are per browser, unique on `endpoint`**; a re-subscribe (or
  the same browser signing into another account) upserts and reassigns the
  owner. Dead endpoints (404/410 from the push service) are deleted during
  each dispatch. The payload carries fully rendered Ukrainian text
  (`{title, body, url, count}`) because the service worker has no API access.
- **Configuration**: `PUSH_ENABLED` + `PUSH_VAPID_PUBLIC_KEY` /
  `PUSH_VAPID_PRIVATE_KEY` / `PUSH_VAPID_SUBJECT` (generate with
  `node -e "console.log(require('web-push').generateVAPIDKeys())"`), optional
  `PUSH_CONCURRENCY` (8), `PUSH_TTL_SEC` (86400), `PUSH_LOG_RETENTION_DAYS`
  (30). Missing keys degrade to "push off" — `GET /push/config` answers
  `{enabled: false}` and the client renders its switch disabled. Rotating the
  public key invalidates every stored subscription.

### Quick filters (2026-08-27)

Per-user **named saved filter sets** for the catalogue. `GET /quick-filter`
answers a flat array of `{ id, name, filters, createdAt, updatedAt }`, ordered
case-insensitively by name, and **so does every mutation** — the client
replaces its cached copy from the response and needs no follow-up read (the
`/preference` convention). Both reads are `private, no-cache`.

The one thing a client must not guess:

- **`filters` is an opaque object the backend never interprets.** Its keys are
  the client's own filter dimensions; unknown keys are stored and returned
  **verbatim**. This is the whole point of the design: shipping a new filter
  dimension (Scotland regions, distilleries, a peat scalar) needs no backend
  change, an older backend still accepts a newer client's payload instead of
  answering 400, and an older client reading a newer set does not destroy what
  it cannot parse. The backend validates only the payload's _shape_ — at most
  32 top-level keys, values are scalars or **flat** arrays of scalars (≤200
  elements, strings ≤256 chars), no nesting, ≤4096 bytes serialized. Per-
  dimension semantics are validated by `/report/{kind}`, on the request that
  actually consumes them.
- **A rename must send `name` alone.** `PATCH` treats an absent field as
  absent (`exposeUnsetFields: false`), so a client that cannot parse a newer
  dimension can safely rename a set; sending `filters` replaces the payload
  wholesale, which is correct for an explicit "overwrite" but destructive for
  a rename.
- **Names are unique per user**, compared case-insensitively and stored
  whitespace-normalized (`trim`, internal runs collapsed). A collision is
  `409` naming the existing set; a race that slips past the check is caught by
  the `quick_filter_user_name_uindex` index and answers `409` too, never 500.
  Two different users may hold the same name.
- **A set id belonging to another user is `404`, not `403`** — ownership is a
  `WHERE` clause, so nothing confirms the set exists. An unknown `userId` on
  the admin read is `404` as well, rather than a plausible empty list.
- **Cap: 20 sets per user**, enforced inside the write transaction; the 21st
  is a `400` naming the cap. Name length ≤64. An **empty** payload is valid —
  "show everything" is a legitimate set.
- Deleting a user cascades their sets.
- Permission for the admin read is `quick_filter:read` (a new `Resource`, so
  it appears in the permissions matrix on its own); the own routes are plain
  `Resource.AUTHENTICATED`.

Storage note: `quick_filter.filters` is the schema's **first `jsonb` column**.
The payload is read whole and never queried into, and future dimensions are not
uniformly arrays of strings, so a normalized child table would have rebuilt
JSON relationally. `jsonb` (not `json`/`text`) also means a future key rename is
one `WHERE filters ? 'oldKey'` data migration — which is why there is no
`version` column. If the client ever renders its filter panel generically, the
natural next step is a `meta.filterDefinitions` payload served from a backend
code registry; with the payload stored as `jsonb` that is purely additive.

### Filters the knowledge base added (2026-08-28)

Three report params, and one rule that changes what two existing ones mean.

- **`regions` / `excludeRegions`** — a CSV of Scotland's regions by the
  **market convention**, `islands` included, matched against the resolved
  producer. `/meta` serves both `regions` (the six to build chips from) and
  `legalRegions` (the protected five). The two lists are separate because one
  column cannot answer both questions: Talisker, Highland Park, Tobermory, Jura
  and Arran are all legally Highland and are listed by every shop as island
  malts, so **the filter's label must say "common"**. The exclusion is the half
  that earns the feature — "everything except Islay" is how a peat-averse
  drinker shops.
- **`verifiedFacts=true`** — show only bottlings whose type _and_ country both
  come from a trusted source. Opt-in, and stricter than the rule below: that
  one refuses to _match_ an untrusted value, this refuses to show the bottling
  at all.
- **The strict rule, which is on by default.** `types` and `countries` now
  answer only from `TRUSTED_FACT_SOURCES` — `manual`, `kb`, `store`, `name` —
  and send `llm` and whatever `legacy` remains to the filter's `unknown` bucket
  (`countries` gained one, mirroring the pattern `types` already had). A filter
  makes a promise the rest of the app does not: a user excluding a country is
  entitled to believe the results are from somewhere else, and a model's
  recollection cannot carry that promise. **The values are still shown and
  still editable — they are demoted as filter evidence, not deleted**, which is
  why `ReportRow` carries `factSources`: without it the client could not explain
  why a whisky it displays as Scotch does not appear under Scotland.

Measured when the rule went on: type filters answered from 51% of in-stock
offers and country filters from 57%. Promoting producers and applying the
knowledge base took that to **78% / 77%** by 2026-08-29 with no scraping at
all; `pnpm backfill` and normal syncs raise it further by re-stamping
`store`-source values.

`ReportRow` also gained **`distillery`**, **`region`** and **`bottler`** from
two `producer` joins. A non-null `bottler` **is** the independent-bottling flag;
there is no separate boolean.

### Catalogue search (2026-08-22)

`GET /product/search?q=&limit=` and `GET /brand/search?q=&limit=` are the
lightweight autocomplete reads behind the settings screen's pickers. `q` is a
case-insensitive substring of at least 2 characters; `limit` defaults to 10,
capped at 20. Both answer flat arrays (product items as in
`/preference/details` minus `addedOn`; brands as `{ name }`) and are cached
`private, max-age=600` — they are not user-scoped.

**These are, with `GET /report/history`, the only catalogue reads that ignore
the caller's blacklist.** That is the point, not an oversight: the picker's
job includes finding an already-hidden bottling (or brand) so it can be
un-hidden, and a search filtered by the lists it edits would make such an
entry unfindable. Product matching mirrors the report's name search — the
canonical name OR any store's raw name, plus the trailing-age pass
(`Glenfiddich 12`) — with in-stock bottlings ranked first, then prefix
matches, then the shortest name. Out-of-stock bottlings are deliberately
included (a favorite is a property of the bottle, not of today's stock).

**`/brand/search` searches producers, through their aliases** (2026-09-01).
The route, the `{ name }` shape and the ranking are unchanged; what it reads
is `producer.name` matched against the name **or** any `producer_alias.key`,
restricted to `verified`/`auto` — a `rejected` producer is not a maker, and a
withheld one is invisible to the resolver, so hiding it would hide nothing.
Two things follow. Typing a spelling only the aliases carry now finds the
maker (`isle of jura` offers `Jura`, `m&h` offers `M&H`), which is what the
blacklist picker needed. And the picker can no longer offer two rows for one
maker, which is how a user came to blacklist `Chivas` and `Chivas Regal`
separately and hide neither properly.

### `/meta`

Filter options and fixed client constants in one payload: `stores[]`
(`slug`, `name`, `color`, `active`, `needsBrowser`), `types` (the `type`
table, plus `unknown` for typeless products), `flavors` (the `flavor` table),
`countries[]` (`code`, `nameUa`, `icon` — only the countries products
actually reference), `allCountries[]` (every country, for the edit
dropdowns — a superset of `countries`), `perPageOptions`, `defaultPerPage`
and `windows`.

### Store detail (`GET /store/:slug`)

Fields: `slug`, `name`, `baseUrl`, `createdAt`, `productCount` (in-stock
offers only), `lastSync`, `recentSyncs`, `color`, `active`, `tier`,
`needsBrowser`, `retailChain`, `category`, `group`, `engine`.

`group` (from `store_config.group`, nullable) is the sync-concurrency group:
stores sharing a non-null group never sync at the same time; today only the 19
Zakaz.ua networks are grouped as `zakaz`. `engine` (from `store_config.engine`,
`python` \| `ts` \| `python-api`, default `python`) is which scraper owns the
store; the `be/` sync path only acts on `ts` stores. Both also appear on the
`GET /store` list items.

Sync-log entry fields: `added`, `removed`, `updated`, `total`, `success`,
`error`, plus `id`, `storeId`, `createdAt`, `updatedAt`, `finishedAt`,
`group`, `trigger` (`manual` \| `cron`; null on rows written before the sync
overhaul).

## Current state / known gaps

The project builds, `tsc`/`eslint` are clean, and 772 unit tests (60 suites)
plus 141 integration tests (15 suites, live Postgres) pass. Done:

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
  best-offer grouping) in `ReportService`. **List items are product groups**
  (2026-08-12): each kind still selects its offers exactly as before and then
  groups them by the persisted `productId`, so a page of 50 is 50 distinct
  bottlings (3 099 groups over 7 673 in-stock offers) and every top-level field
  is the cheapest offer's, with the rest in `offers` (price ascending).
  `catalog` and `best` group every in-stock offer, `new`/`drops` only the
  offers that qualified, and `low` keeps its per-offer selection as
  single-offer groups (two stores at their own window low are two items).
  `best` carried its winner alone until 2026-08-22, on the grounds that
  `referencePrice` already stated the comparison — but a price names neither
  the store asking it nor the page to open, and the client renders a group's
  offers anyway. Only its winner is enriched against the runner-up; the other
  offers read as the catalog's do, against their own previous price.
  The grouping is JS-side, over the same `findCurrentRows` query — the
  per-kind rules read values that never existed in SQL (window extremes, the
  real current date, `minDiscount`), so pushing `LIMIT` down would have forked
  them. **`best` is the one kind whose price filter does not run in SQL**
  (2026-08-22): it compares a bottling's offers against each other, so the
  candidates are selected without `minPrice`/`maxPrice` and the bounds are
  applied to the winning offer instead. With them in SQL, a runner-up above
  the ceiling was dropped before the comparison, the group fell under the
  two-store guard, and the affordable offer took the fall with it — a whisky
  at 1699 (rozetka) against 3299 (maudau) vanished from `maxPrice=2000`, and
  the groups that survived had their saving measured against whichever
  runner-up happened to fit. The candidates it keeps are also what its
  `offers` array lists, so a `best` group legitimately shows stores above the
  ceiling. Every other predicate still filters in SQL:
  volume, country, type and flavors answer identically for every offer of one
  bottling, and `stores` is meant to narrow the comparison.
  See "Report groups" under "API contract". Response DTOs are camelCase (DB field
  names), carry no UI text (structured `isNew`/`daysNew`/`discountPct`/
  `referencePrice` instead of the legacy `note`). Whisky types/flavors come from
  the `type`/`flavor` tables, never hardcoded. The whisky core graph is wired
  via the aggregate `CoreWhiskyModule` (`~core/core-whisky.module`) so all
  related entities register together under `autoLoadEntities`. The GET read
  endpoints (`/report/*`, `/store`, `/store/:slug`, `/meta`) send
  `Cache-Control: private, max-age=600` via the `@CacheControl` decorator
  (`~decorators/http`), so the browser caches them for 10 minutes and a hard
  reload bypasses it; mutations and `auth`/`user` endpoints stay uncached.

- **Dashboard API is built** (`domain/dashboard`, 2026-08-22): six read-only
  endpoints under `/dashboard` (`meta`, `summary`, `series`, `breakdown`,
  `movers`, `sync-activity`), all `Resource.AUTHENTICATED` +
  `@CacheControl(600)`, powering the web dashboard's time-series charts. The
  contract lives in "API contract" → "Dashboard"; the load-bearing decisions:
  - **All dashboard SQL keys on `price_snapshot.capturedOn`** (the column with
    the one-row-per-offer-per-day unique index and, since
    `dashboard-captured-index`, a plain index for date-range scans) — never on
    the `createdAt::date` the legacy report queries use. The two agree on
    every existing row, but `capturedOn` carries the semantic guarantee; see
    `FOLLOWUPS.md`.
  - **In-stock(day) counts snapshot rows flagged `inStock`, never rows**, and
    every dashboard query therefore carries `AND ps."inStock"` (in
    `DAILY_WHERE` / `DAY_WHERE`, the boundary query's own filter, and the
    movers' `bounds` CTE). A row used to imply availability, and that is what
    broke: a store whose listing carries its sold-out items at a price (silpo,
    once its adapter read a real branch instead of the guest one) writes a row
    for each of them, and an offer that sells out between two runs of one day
    keeps the row the earlier run wrote — so a day read as the high-water mark
    of its availability, not its close. Silpo reported 827 listings in stock on
    a day it closed with 227, against a `/store/:slug` legend saying 227. The
    write side of the invariant is `markOutOfStockForDay`, called by
    `ScrapePersistService.persist` after the sweep; the pre-fix silpo history
    (2026-08-09..22, ~600 rows/day) was repaired by a one-off `UPDATE`.
    **Out-of-stock is derived**:
    `max(0, tracked(day) − inStock(day))`,
    `tracked = COUNT(store_product WHERE firstSeen <= day)`. Measured against
    a production dump this lands exactly on `COUNT(WHERE NOT "inStock")` for
    the latest day (1,034 on 2026-08-21), i.e. it agrees with `/store/:slug`.
    The tempting `lastSeen >= day` variant collapses to 0 on the latest day —
    the comparison table lives in `DashboardMetricsUtils.deriveOos`'s JSDoc,
    and a unit test pins the identity. The formula cannot tell a delisted SKU
    from a stock-out, and it clamps a one-day retention artifact at the data
    floor (snapshots exist on 2026-06-12 for offers whose `firstSeen` is the
    13th).
  - **Left-censoring**: ~46% of listings share `firstSeen = 2026-06-13` and
    only 3 stores have data on 06-12, so the first days are ramp-up, not
    market growth; four stores (silpo, fozzy, alcomag, bayadera) only start
    2026-08-09/10. Ranges are clamped to `[MIN(capturedOn), MAX(capturedOn)]`
    server-side; `/dashboard/meta` exposes the bounds and per-store first/last
    days so the client can annotate instead of misreading steps as trends.
  - **Aggregates stay in SQL, composition in TypeScript**: repositories keep
    their own grain (`price-snapshot` owns the daily/boundary/breakdown/mover
    aggregates, `store-product` the `firstSeen`/`lastSeen` lifecycle,
    `sync-log` the per-day run stats), and `DashboardMetricsUtils` (~utils,
    pure static) merges the sides, derives OOS, downsamples weeks (levels =
    last observed day, flows = summed) and does the KPI delta arithmetic —
    unit-testable without a database. No rollup table on purpose: distinct
    counts and medians do not compose across partitions, and the worst full
    query measures ~350 ms; revisit only past ~12 months of retention with a
    materialized view refreshed after `runFullSync`.
  - Query DTO composites added for it: `@IsoDate()` (bare `YYYY-MM-DD` only —
    `@IsDateString` would accept timestamps whose day is timezone-ambiguous)
    and `@BoolQuery()` (explicit `'true'`/`'false'` mapping, since
    `@Type(() => Boolean)` turns `'false'` into `true`).

- **Per-user preferences are built** (`core/preference`, `domain/preference`,
  2026-08-22): favorites and a blacklist of bottlings and/or brands, six
  endpoints under `/preference` (contract in "API contract"), and three
  predicates inside `findCurrentRows` that make every report kind personal.
  The load-bearing decisions:
  - **Three composite-keyed tables** (`favorite`, `blacklist_product`,
    `blacklist_producer`), all `(userId, <target>)` with a `createdAt` and no
    `updatedAt` — a membership row has nothing to update. They follow the
    `product_flavor` pattern: an explicit entity so `migration:generate` stays
    drift-free, but every row is written in raw SQL by one repository
    (`PreferenceRepository`, which extends TypeORM's `Repository` directly
    since composite-keyed rows do not satisfy `EntityBase`).
  - **Everything targets the bottling** (`product.id`), never a store offer, so
    a favorite lights up in every shop carrying the whisky and a blacklist
    entry hides it everywhere. Brand entries store `brand.id` while the API
    speaks canonical names, resolved by a new find-only
    `CoreBrandService.findIdsByName` — `resolveByName` **creates** missing
    brands, so a request path must never use it or one user's typo mints a row
    every other user's filters read.
  - **Blacklisting a product drops it from the favorites, in one transaction;
    blacklisting a brand does not.** A favorite is a specific bottling somebody
    chose and a brand rule is a broad filter, so the two are revoked
    independently — the report hides such a favorite while the rule stands, and
    lifting the rule restores it instead of having silently destroyed it. An
    integration test proves the atomicity by failing the second statement on a
    foreign key and asserting the favorite survived.
  - **The report predicates are bottling-level, which is what makes them
    safe**: a group is either wholly present or wholly gone, so `best`'s
    two-store comparison and its `selectionFilter` spread need no special case
    (contrast the offer-level price bounds, whose trap is documented above).
    The brand predicate tests **both producer slots**
    (`bp."producerId" IN (p."producerId", p."bottlerId")`), or a rule naming an
    independent bottler would hide none of what it released; it is UNKNOWN when
    neither is filled, so a bottling the knowledge base cannot place survives
    every brand rule — correct, since there is no "unknown maker" to hide. `ReportFilter.userId` is **required**, deliberately: an optional
    field would let a future caller silently serve an unfiltered catalogue.
  - **`/report/history` and the single-offer path stay unfiltered by
    construction** — they take no `ReportFilter` — so the product card that
    just hid a bottling keeps working while un-hiding is API-only. Equally
    deliberate: `/dashboard/*`, `/meta` countries and `/store/:slug`
    `productCount` are assortment analytics, not the user's catalogue, and are
    not personalized.
  - **`PermissionEntity.resource`/`action` now state `type: 'varchar'`
    explicitly.** They relied on reflection metadata, which serializes an
    enum-typed property to `Object` under per-file transpilation (ts-jest with
    `isolatedModules`) — TypeORM then refuses to build the metadata at all,
    which is why the entity could not be registered in a Jest-hosted graph.
    That surfaced the moment `CorePreferenceModule` had to import
    `CoreUserModule` (its entity relates to `user`), which drags in the
    permission entity as the inverse side of `UserEntity#permissions`.
  - **Report responses are now per-user while still `private, max-age=600`.**
    `private` keeps proxies out, and `Vary: Authorization` would be useless
    here (the access token rotates on refresh, defeating caching entirely), so
    the client owes a cache bypass after any preference mutation and on
    login/logout — see "API contract" → "Preferences".

- **Web-push price-drop digests are built** (`config/parts/push.config.ts`,
  `lib/web-push`, `core/push`, `domain/push`, 2026-08-23): after a sync, each
  user with subscribed devices gets one digest push naming their favorited
  bottlings whose price dropped that capture day. The full contract (drop
  definition, dedup claim, endpoints, env) lives under "API contract" →
  "Push notifications". The load-bearing decisions:
  - **The claim is one CTE statement** (`PushRepository.claimDrops`): detect
    drops against the previous _existing_ snapshot, join favorites minus
    blacklists, and atomically claim per `(userId, storeProductId,
    capturedOn)` into `push_digest_log` with `ON CONFLICT DO NOTHING
    RETURNING` — which is what makes a dispatch idempotent per day and lets
    concurrent dispatches split rather than duplicate the work.
  - **Hooks live in the orchestrator**: awaited at the end of `runFullSync()`
    (once per run), fire-and-forget after a _manual_ `startStoreSync` — never
    inside `runStoreSync`, or a full sync would push once per store. Nothing
    in the dispatch is `@Transactional()` (the background-run ALS caveat), and
    `dispatchAfterSync()` swallows every failure — a sync never pays for
    notifications. This required the repo's first domain→domain import
    (`domain/store` → `domain/push`); it is one-directional, so
    `import-x/no-cycle` holds.
  - **The payload arrives fully rendered (Ukrainian)** — the service worker
    has no bearer token and can call nothing, so `push.constants.ts` is the
    single place backend user-facing copy exists. Digest arithmetic is pure
    (`PushDigestUtils` in `~utils`): best pct per bottling, 5 named + «та ще
    N», a byte-budget trim under the 4 KB push limit.
  - **`GET /push/config` only hands out the VAPID public key while sends can
    actually happen** (`WebPushService.enabled`), so the client switch and the
    key can never disagree; a missing/rejected key degrades to "push off" at
    boot instead of failing it.

- **Saved filter sets are built** (`core/quick-filter`, `domain/quick-filter`,
  2026-08-27): named per-user catalogue filter sets with CRUD, five endpoints
  under `/quick-filter` (contract in "API contract" → "Quick filters"). The
  load-bearing decisions:
  - **The payload is opaque and stays that way.** `filters` is a `jsonb`
    column — the schema's first — and `FilterPayload` (`~decorators/fields`,
    the codebase's first `ValidatorConstraint`) validates only its shape. It is
    deliberately a **leaf** class-validator property on both the request DTO
    and the response type: `@IsObject()` with no `@ValidateNested()`, so
    neither the incoming pipe's `forbidNonWhitelisted` nor the outgoing
    `ValidationInterceptor`'s `whitelist` ever enumerates the payload's keys.
    Declaring a typed payload class would silently break both halves and
    delete a newer client's dimensions on the way through.
  - **Adding a filter dimension therefore touches zero code here**, which is
    the requirement the feature exists to satisfy. The one manual
    `@ApiProperty({ type: 'object', additionalProperties: true })` in the
    codebase lives on that decorator, because the Swagger CLI plugin cannot
    infer a schema for an index-signature type and the generated client would
    otherwise type the field `unknown`.
  - **Uniqueness and the cap are transactional.** `uniqueFields` on
    `CoreBaseService` is left empty on purpose — it enforces _global_
    uniqueness while a set's name is unique only per user. The service does a
    case-insensitive pre-check for the message the client shows, the
    `quick_filter_user_name_uindex` index catches the race, and `23505` is
    re-thrown as `DuplicateError` so a second tab gets 409 rather than 500.
  - **Ownership is a `WHERE` clause, not a check**, so a foreign id matches no
    row and answers 404 — nothing confirms the set exists.

The endpoint inventory and every field map live in **"API contract"** above —
update that section alongside any API contract change; `../web` reads it as the
source of truth.

**OpenAPI / security.** The `@nestjs/swagger` CLI plugin is enabled in
`nest-cli.json` (auto-`@ApiProperty` on DTOs/entities). The `@Plain` /
`@Paginated` type decorators also emit the `@ApiOkResponse` schema (paginated
endpoints get the `{ data, total, limit, offset }` envelope with `data` items
`$ref`-ing the item DTO), so `/docs-json` fully describes every response. The
web frontend generates its client by fetching `/docs-json` over HTTP at deploy
(`../web/scripts/deploy.sh`), so **prod must run with `SWAGGER_ENABLED=true`** (the
route is gated by that flag — see `main.ts` — and blocked publicly by nginx +
iptables). `pnpm openapi` (server up) still snapshots it to a git-ignored local
`./openapi.json` for manual inspection. `@fastify/helmet` is registered in `main.ts`, but with
`contentSecurityPolicy` / `strictTransportSecurity` / `xFrameOptions` /
`xContentTypeOptions` / `referrerPolicy` **disabled**: the reverse proxy
sets all five with `always`, and `location /api/` inherits them, so
helmet only appended a second copy (with a conflicting
`X-Frame-Options`). Helmet still owns what nginx does not send -- the
cross-origin isolation pair, `Origin-Agent-Cluster` and the legacy `X-*`
headers. Reaching the API without the proxy (dev via the Vite proxy, or
Swagger UI on 127.0.0.1) therefore gets none of the five. No global
route prefix is used — the SPA reaches the API same-origin via a `/api` proxy
that strips the prefix.

**Python → TypeScript scrape migration (in progress).** The scraper is being
moved out of `../scrapper` into `src/scrape/` (plan:
`~/.claude/plans/hazy-greeting-pearl.md`, 12 steps). Done: feasibility spike
(GO — every store reachable from a datacenter IP), the schema overhaul
(`group`/`engine`/`capturedOn` + `sync_log` lock), the core write path, the
scrape engine (`normalize`/`http`/`html`/`browser`/`llm`/`persist` +
`ScrapeService.collectStore`), the sync orchestrator + on-demand/status
endpoints (see "Sync orchestration"), and **every adapter** — the 19 Zakaz.ua
networks, `maudau`, `okwine`, `winewine`, `wine-point`, `goodwine`, `rozetka`,
`silpo` (added 2026-08-09, straight to the TS engine via its open catalog
JSON API — no Python counterpart ever ran it in production), `bayadera`
(added 2026-08-10, also TS-only — a brand-new store with no legacy history),
`fozzy` (added 2026-08-10, TS-only as well — fozzyshop.ua, SSR HTML;
first fill via `pnpm backfill --store fozzy`, see the migration list),
`alcomag` (added 2026-08-10, TS-only as well — Bitrix SSR, see "Adapters";
its first full detail sweep exceeds `SYNC_STORE_TIMEOUT_MS` too, so seed the
fields with `pnpm backfill --store alcomag` once after deploy), and
`winebutik` (added 2026-08-26, TS-only too — Drupal Commerce SSR with an
availability-sorted listing the walk stops at, see "Adapters"; seed the
fields with `pnpm backfill --store winebutik` once after deploy) —
with golden tests and the parity harness, and the internal daily cron — which **ships disabled**
(`SYNC_CRON_ENABLED` unset), so the Python system cron still owns the schedule.
Pending: the web "Sync" button and the Python decommission. **The cutover is
done** — as of 2026-08-08 every production store runs `store_config.engine =
'ts'`, so the TypeScript engine is the live writer everywhere and the parity
gate no longer blocks behavioral fixes.

**Deferred defects live in [`FOLLOWUPS.md`](FOLLOWUPS.md)** — read it before
touching the scrape engine. It currently holds `goodwine`'s truncating page cap,
the never-built browser Docker stage, and `rozetka`'s full-catalog walk for a
7-page in-stock prefix. They are held back because the migration requires
byte-identical output from both engines, not because they are acceptable. One more follow-up is flagged in code
only: `HTTP_STRATEGY_BY_SLUG` (in `scrape/http/http-client.factory.ts`) should
move to a `store_config` column.

Still open:

- **The grounded flavour re-pass (P3.6) has not been run.** `pnpm
  enrich-flavors` **must** have `LLM_FLAVOR_MODEL` pointed at a strong slug
  (`anthropic/claude-sonnet-5`) before a full sweep: a run that fell back to
  `LLM_MODEL` (`deepseek-v4-flash`) returned the per-category templates
  documented under "Scraping engine" — the largest shared tag set went from 52
  names to 285 products, `floral` and `maritime` each lost 86% — and was rolled
  back with `pnpm restore-flavor-import`. **Peat was never at risk**
  (`LLM_FLAVOR_TAGS` excludes it, and the counts were identical before and
  after), so this is a quality gap in the other thirteen tags, not a
  correctness one. 1117 bottlings the restore CSV does not cover are already
  re-opened (`lastLlmFlavorAt IS NULL`) and will be re-asked first.
- **Two operational steps of the knowledge-base work are the owner's to run**,
  not code gaps. `pnpm backfill` (a live sweep of all ~20 shops, several hours)
  is what re-stamps `store`-source type and country values; until it runs,
  about 45% of in-stock offers sit in the type/country filters' `unknown`
  bucket, and that share falls on its own as normal syncs re-stamp. And the
  legal type taxonomy (`blended malt` / `single grain` / `blended grain`)
  re-labels ~800 products **and rewrites the `types` value inside users' saved
  quick filters**, whose payload the backend deliberately never interprets — so
  it needs an explicit decision rather than a migration written on spec.
- **The unverified queue is down to 19 producers** (2026-08-29 evening, from
  454 that morning). A fleet of 20 web-grounded verification agents
  re-evidenced every withheld row (`docs/kb-research/verify/`, shipped by the
  `kb-verification-import` migration): 752 producers are now `auto`, 30
  `verified`, 10 `rejected` (not whisky at all — cocktails, a grape brandy, a
  non-alcoholic drink, retailer gift sets), and the remaining 19 are rows the
  web is genuinely silent about (own-label ghosts like `dalmahoy`,
  `drummers-reserve`, `manhattan`) — each carries its verification note on
  the review screen, and leaving them withheld costs recall on at most a
  couple of bottlings apiece. The per-row human items the fleet flagged
  (ownership murk, conflicting third-party smoke notes) live in
  `docs/kb-research/verify/CHECKPOINT.md` and the batch notes.
- **`BRAND_INFO` / `BRAND_KEYS` / `INDEPENDENT_BOTTLERS` / `detectBrandInfo`
  cannot be deleted yet, but the gate is close.** 226 of 4062 bottlings
  resolve to no producer (2026-08-29 evening, down from 1448 the same
  morning), and for those `detectBrandInfo` is still the only thing supplying
  a country or type. `pnpm research-brands` fills the tail as new brands
  appear.
- There is still no owned seed for `store`/`store_config`/`country`, so a fresh
  database cannot be populated from scratch — the legacy SQLite importer that
  used to fill that gap has been deleted (see "Whisky domain").
- The React frontend (`../web`) has replaced the legacy Python-served UI (which
  was removed) and consumes this API per "API contract" (login returns
  `{ access }`, fields are camelCase, `/meta` keys renamed, etc.).
  The original Python implementation (now scraper-only, in `../scrapper`) is the
  functional reference for the eventual feature set, but its code style and
  structure are NOT to be copied.
