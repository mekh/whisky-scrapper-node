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
  `category?`, `group?` (sync-concurrency group; `zakaz` for the Zakaz.ua
  networks — **11 of them in production**, 19 in the older local database seeded
  from the legacy SQLite import, see [`PARITY.md`](PARITY.md)), `engine`
  (`python`|`ts`|`python-api`, default `python`) — this is scrape-config,
  unrelated to product category.
- `product` — `storeId`, `sku`, `url`, `name`, `age?`, `abv?`, `volumeMl?`,
  FKs `brandId?`/`typeId?`/`countryId?`, `inStock` (bool, default true —
  current availability), `firstSeen`/`lastSeen` (date). Unique
  `(storeId, sku)`. Flavors hang off the **explicit** `product_flavor` join
  entity (`core/product/product-flavor.entity.ts`) — not a TypeORM
  `@ManyToMany`, because the table carries a third column, `source`
  (`scrape`|`llm`, `FlavorSource`), and an implicit `@JoinTable` junction cannot.
  Nothing loads it as a relation; `ProductRepository` owns every row in raw SQL.
  **`source` is what makes LLM flavors survive a sync**: `setFlavors` re-derives
  the keyword pass's links on every run and so deletes and reinserts only
  `source = 'scrape'`, while `setLlmFlavors` owns the `llm` rows and the sync
  never touches them. A tag both passes found ends up owned by `llm` (the insert
  promotes it), so the sync's replace cannot remove it. Promoting the junction to
  an entity had to reproduce the implicit table's DDL exactly — `ON UPDATE
  CASCADE` on both FKs plus a plain index per join column, whose TypeORM-hashed
  names (`IDX_ffe61c…`, `IDX_22847b…`) the entity regenerates identically —
  otherwise `migration:generate` proposes dropping and recreating them.
  `lastLlmFlavorAt` records when the classification pass last answered, **set
  even for an "unknown" answer**: that answer links no flavor, so without the
  marker it is indistinguishable from never having been asked and every run
  would re-ask (and re-pay) for the same products. It stays null when a batch
  failed, which is what makes `pnpm enrich-flavors` retry those items.
  **Out-of-stock products are never deleted** — the persist pipeline flips
  `inStock` instead, so price history survives out-of-stock periods and a
  returning product keeps its identity (`firstSeen`, manual edits). List reads
  (`findCurrentRows`, `/report/*`, `/meta` countries, `/store/:slug`
  `productCount`) filter on `inStock = true`; the single-product history path
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
  filter and `resolveIdByTerm` match **both** columns. Existing rows are
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
  returns no age for exactly those products. `pnpm fix-age`
  (`scripts/fix-product-age.ts`, `--dry-run` / `--store <slug>`) applies the
  current rule retroactively — keep an age only where the name states it, or
  where the store lists it in a spec field (only the `okwine` adapter reads
  one). Idempotent, no API key; **production still has to be swept once.**
  Clearing is one-way: a cleared age is **not** re-derived by a later scrape
  unless the name carries it, so only clear what no source supports.
  **`volumeMl` is the sum of a gift set's bottles.** `extractVolumeMl` used to
  take the first match in the name, so a set of three 0.7 л bottles was stored
  as 0.7 л — and because the report compares by volume, a three-bottle price
  landed beside single bottles as the worst deal on the page. It now sums the
  segments a `+` joins, via `ProductNameUtils.bundleSegments`, which returns
  null for an accessory bundle (`+ 2 склянки`) and for a brand spelled with a
  `+` (`Roe + Co`) — and strips the product code first, since several codes are
  themselves `+`-joined. Insert-only again, so `pnpm fix-volume`
  (`scripts/fix-bundle-volume.ts`, `--dry-run` / `--store <slug>`) sweeps the
  stored rows; 11 of the 12 sets in a production snapshot were wrong.
  The same trap is why `LlmNameExtractionService` rejects an answer that drops a
  set's other bottles: told to return "the product", the model answered
  `Jura Journey` for a three-bottle set, and token validation passed it because
  every word it kept was in the raw name.
  **Insert-only also froze the gaps of every earlier parser**, and those gaps
  cannot be re-derived from the row — a country the row never had is not in the
  row. `pnpm backfill` (`scripts/backfill-nulls.ts`, `--dry-run` /
  `--store <slug>`, repeatable) therefore re-runs the real collection pipeline
  with `collectStore(slug, { backfill: true })`, which changes exactly three
  things: `ProductRepository` uses `BACKFILL_UPSERT_SQL`, whose update clause
  adds `name`/`typeId`/`countryId`/`age`/`abv`/`volumeMl` as
  `COALESCE(product.x, EXCLUDED.x)` — the stored value always wins, so this is
  a fill, never an overwrite; the detail-page gate becomes `skusWithCoreDetails`
  (ABV **and** volume **and** type **and** country stored) instead of
  `skusWithAbv`; and the LLM enrichment trigger adds a still-null type or
  country to `needsLlm`. **Age is deliberately in neither widening**: a NAS
  bottling has no age to find, so including it would re-fetch and re-ask about
  the same items on every run forever. The script prints per-store and total
  before/after null counts, keeps going when one store fails, and **bypasses the
  `sync_log` lock** — nothing may sync those stores while it runs. It is a full
  scrape, so its sweep flags out-of-stock rows exactly as a normal sync does,
  and a full sequential pass over every store takes a few hours (no track
  parallelism, and the detail-page stores fetch far more pages than usual under
  the wider gate).
  Measured over a copy of production, 6 990 rows across the 17 stocked stores:
  `brandId` 1 533 → 187, `typeId` 1 690 → 262, `countryId` 828 → 157, `abv`
  103 → 92, `volumeMl` 7 → 5. `age` barely moved (4 451 → 4 437) and that is
  the expected result — those rows are NAS bottlings, not gaps. Of what is
  left, roughly a third sits on out-of-stock rows the run never saw (only a
  listed product can be re-scraped); the rest are in-stock items neither the
  keyword pass nor the LLM could place — a bottler's own series with no brand
  in the catalogue, or a name that states nothing about type or origin.
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
- `price-snapshot` — `productId`, `price`/`oldPrice?` (`NumericColumn`),
  `currency`, `inStock`, `promo`, `capturedOn` (date, default `CURRENT_DATE`).
  **One row per product per day**, enforced by the unique index
  `(productId, capturedOn)` + an atomic `INSERT ... ON CONFLICT DO UPDATE`;
  plus a plain index `(productId, createdAt)`. `capturedOn` is the UTC calendar
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
`flavor-llm-import` (the classified back-catalogue, see below) — all
applied, formatted per the `typeorm-migration-format` skill, and drift-free
against the entities.

**`flavor-llm-import` ships its data as a CSV beside the migration.** Flavors
were classified per **distinct `product.name`**, not per product row: the same
bottling is listed by many stores, so 2 059 names cover all ~7 000 rows, and
every row of a name gets the same tags — which is also what makes the report's
flavor filter behave consistently across stores. The classification was done by
16 parallel Sonnet 5 agents over ~129 names each (batch inputs and the merged
result are throwaway; the CSV is the artifact). Result: 749 `high`, 972 `low`,
338 `unknown`, 367 distinct tag sets — the largest shared set covers only 52
names, which is the check that matters, because a per-category *template* is the
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
  `HTTP_STRATEGY_BY_SLUG`), `html/` (cheerio helpers for the SSR stores),
  `browser/` (Playwright stealth context, fresh context per page), `llm/`
  (an **OpenAI-compatible** chat-completions call via the `openai` SDK,
  pointed at any endpoint by `LLM_BASE_URL` — production uses OpenRouter, so
  the model is a provider slug in `LLM_MODEL`; `LlmClientService` owns the
  transport and the JSON-array unwrapping, and every pass stays disabled until
  a key **and** a model are set, since no model name is portable across
  providers. `askJsonArray` takes optional per-call `{model, reasoning}`
  overrides so one pass can run on a different slug than the rest. Three
  independent passes sit on top of it:
  `LlmEnrichmentService` fills missing abv/volume/type/country fields,
  `LlmNameExtractionService` reduces the name to brand + expression for new
  SKUs, validated token-by-token against the raw name so a hallucinated word
  can never be persisted, and `LlmFlavorService` classifies the flavor profile;
  all three swallow every error and fall back to the deterministic pass.
  **`LlmFlavorService` is the odd one out — it is recall over a field no source
  states**, where the others only rewrite an input line, which is why it has its
  own `LLM_FLAVOR_MODEL`/`LLM_FLAVOR_REASONING` and why model choice matters
  here and nowhere else. It exists because the keyword pass can only find a
  flavor a listing spells out, leaving most of the catalogue untagged — and the
  report's main use is *excluding* `peated`, which silently excludes nothing on
  an untagged product. Two guards keep it from making the data worse: the answer
  is filtered against `FLAVOR_TAGS` (the closed 15-tag vocabulary derived from
  `FLAVOR_KEYWORDS`, so the keyword pass and the LLM cannot disagree on what a
  valid tag is — a tag named in the prompt but missing from that constant is
  silently dropped, so the two are edited together), and a `confidence` of
  `unknown` forces an empty result. The prompt pushes hard toward `unknown`
  because a plausible-but-wrong `peated` is worse than no tag at all.
  **Model choice was measured, not assumed**: on the same 40 goodwine bottlings,
  `deepseek-v4-flash` returned a per-category *template* — Jameson, Monkey
  Shoulder, Robert Burns and Chivas all got one identical tag set, Dalmore,
  GlenAllachie and Bunnahabhain another — missed `bourbon-cask` on a product
  named "West Cork Bourbon Cask", and answered `high` for all 40.
  `anthropic/claude-sonnet-5` discriminated per product (Dalmore → citrus/sherry,
  Arran 10 → maritime, both Bourbon Cask bottlings → `bourbon-cask`) and marked
  the obscure blends `low`. Neither model ever answered `unknown`, so the
  `unknown` path is under-exercised in practice — treat `low` as the real
  "don't trust this" signal.
  The pipeline classifies **new SKUs only** (like name extraction, gated on the
  same `existingSkus` lookup, fetched once and shared); stored rows are swept
  once by `pnpm enrich-flavors`. A bottling's flavor does not change between
  runs, so re-asking per sync would be pure spend.
  **A new SKU still reuses an answer stored under the same name before it asks**
  (`findLlmFlavorsByNames`, keyed on `ProductNameUtils.resolve` so the key is
  exactly the name persist will write). The SKU gate alone cannot cover this:
  724 names are carried by more than one store, spanning 5 527 of 6 990 rows, so
  a store listing a bottling for the first time would otherwise pay for a call
  whose answer is already in the table — and could get *different* tags than the
  sibling row, leaving one product tagged two ways depending on which store you
  looked at. Measured on the current catalogue, 1 721 of 2 059 names are
  reusable. A name classified `unknown` has no links, so it is indistinguishable
  from unasked here and does get re-asked; that is the deliberate second chance,
  and the only remaining case that reaches the model.
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
  **The passes also observe a deadline** (`CollectOptions.llmDeadline`, set by
  the orchestrator to the store's budget minus `SYNC_LLM_DEADLINE_MARGIN_MS`).
  They are the one optional part of a collection — an unanswered item keeps its
  gap and is asked about again next run — so when the budget runs short the
  remaining batches are skipped, a `llm-deadline` line names the pass and the
  count in the run's log file, and the run goes on to persist what it scraped
  rather than failing a timeout. A batch already in flight finishes: its answer
  is paid for either way.
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
  not see in stock as `product."inStock" = false` — explicit out-of-stock SKUs
  and items missing from the listing alike; nothing is deleted. A run whose
  in-stock count falls below `PERSIST_SWEEP_GUARD_RATIO` of the store's
  current in-stock count is treated as a truncated listing: the sweep is
  skipped with a warning and only the explicit out-of-stock SKUs are flagged),
  and `ScrapeService` (`collectStore(slug, { dryRun })`).
- **Adapter base classes** (`adapters/`): `ScrapeAdapterBase` (spec, pacing,
  progress, snapshot defaults) → `HttpAdapterBase` (owns the HTTP client) →
  `PagedHtmlAdapterBase` (walk `cardSelector` pages until one yields no new
  SKU; a page that fails ends the walk unless nothing was collected yet, in
  which case it throws) → `WooCommerceAdapterBase` (shared card markup,
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
  legacy tier-3 classification; the zero-UUID "guest" branch is queried,
  out-of-stock items stay listed with `stock: 0` and feed `inStock` directly,
  volume comes from `displayRatio`, brand from `brandTitle`). The registry
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
  calls from `ScrapeService`, gated on `products.skusWithAbv` (only items whose
  ABV is not stored yet) and paced with `adapter.sleep()` between items — the
  same gate and pacing as the Python `collect_site._enrich_details`. Enrichment
  only ever fills fields that are still null, so listing values and manual
  edits win.
- **Parity harness**: `scripts/scrape-parity-diff.ts <slug> [--python <dump>]
  [--ts <dump>] [--out <dir>]` runs the legacy Python scraper
  (`scripts/scrape-parity-dump.py` through `../scrapper/.venv`) and the TS
  dry run back to back and diffs their pre-database snapshots by SKU. Both
  sides skip the LLM pass. Exit code 1 means the shared SKUs differ; SKU-set
  drift is reported but does not fail (stock flips between the two runs are
  normal). One clean run accepts a store's adapter; a release sweep re-runs
  every store on another day right before the cutover. Results and per-store
  state live in [`PARITY.md`](PARITY.md).
- **Brand from the name.** Only three adapters (`goodwine`, `winewine`,
  `wine-point`) read a brand off the page, so `rozetka` and `okwine` stored none
  at all. `ScrapeService` now loads the catalogue's brand names once per run and
  hands `NormalizeService.normalize` a match index; a snapshot without a brand
  gets one from its name (longest key first, both sides space-wrapped so a key
  only matches whole words, apostrophes stripped on both sides so
  `Jack Daniels` finds `Jack Daniel's`). The index is built from the **`brand`
  table**, not from `BRAND_KEYS`: those keys are already stripped, and
  title-casing one back would mint a second row beside the spelling the
  catalogue uses. It is passed per call rather than cached on the service —
  `NormalizeService` is a singleton and `runFullSync` collects stores
  concurrently. Only the brand is new; `detectBrandInfo` still reads country and
  type off `BRAND_INFO`, and now benefits from the brand being filled first.
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
  It also hands the collection a **second, earlier signal** for the LLM passes
  alone (`CollectOptions.llmDeadline`, the same budget minus
  `SYNC_LLM_DEADLINE_MARGIN_MS`). Unlike the hard timeout that only ends the
  wait, this one is cooperative: the passes stop asking, log which pass and how
  many items were left, and the run persists its catalogue — which is the
  difference between a sync that fills some fields next time and one that throws
  away a successful scrape (see "Scraping engine").
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
    `detail-failed`/`llm`/`persisted`/`sweep-guarded` members; `buildReporter`
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
configured); sync vars in
`SyncConfig` — `SYNC_CRON_ENABLED` (default false), `SYNC_CRON_EXPRESSION`
(default `0 12 * * *`), `SYNC_TIMEZONE` (default `Europe/Kyiv`),
`SYNC_MAX_PARALLEL_TRACKS` (4), `SYNC_STORE_TIMEOUT_MS` (900000),
`SYNC_BROWSER_STORE_TIMEOUT_MS` (2700000 — the budget for a `needsBrowser`
store, which needs ~20 min for a full pass and would never fit the HTTP one),
`SYNC_LLM_DEADLINE_MARGIN_MS` (120000 — how early the LLM passes must stop so
the run still has time to persist; see "Scraping engine"),
`SYNC_LOG_DIR` (`./log`; empty disables per-sync log files) and
`SYNC_LOG_RETENTION_DAYS` (30; `0` keeps every file — see "Sync
orchestration").
`SYNC_CRON_ENABLED`/`SYNC_CRON_EXPRESSION`/`SYNC_TIMEZONE` are read by
`SyncCronService` at bootstrap (see "Sync orchestration"): with the flag unset
no job is registered at all, and changing any of the three needs a restart.
In production every `SYNC_*` var is forwarded from the host `.env` by the
`environment` block of `docker-compose.yaml` — compose reads `.env` only to
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

The project builds, `tsc`/`eslint` are clean, and 285 unit tests (24 suites)
plus 22 integration tests (3 suites, live Postgres) pass. Done:

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
(`../web/scripts/deploy.sh`), so **prod must run with `SWAGGER_ENABLED=true`** (the
route is gated by that flag — see `main.ts` — and blocked publicly by nginx +
iptables). `pnpm openapi` (server up) still snapshots it to a git-ignored local
`./openapi.json` for manual inspection. `@fastify/helmet` is registered in `main.ts` (its CSP is relaxed
for the Swagger UI; the SPA's own CSP belongs on the reverse proxy). No global
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
and `silpo` (added 2026-08-09, straight to the TS engine via its open catalog
JSON API — no Python counterpart ever ran it in production) —
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
