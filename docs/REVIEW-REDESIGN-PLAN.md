# `/product/review` rebuild — implementation plan

Companion to [`REVIEW-REDESIGN.md`](REVIEW-REDESIGN.md), which holds the
analysis, the decisions and the UI specification. This file is the work
order: what to build, in which order, in which files, and how each step is
known to be done. Keep the **Status** column current as steps land.

Design approved by the owner on 2026-09-17 (T1 table, E1 side panel,
two-line rows; every decision recorded in the design doc §8). Mockup:
Artifact "Whisky Review Queue", v8.

---

## 0. Ground rules for whoever runs this

- **Run straight through.** Do not pause for a progress report after each
  step. Stop only for a decision that changes the shape of the work, a
  conflict with a documented decision, a destructive or outward-facing
  action, or a blocker (see the owner's execution protocol).
- **Sub-agents on Sonnet 5**, read-only exploration or review only.
- **No commits and no pushes without the owner's explicit authorization in
  the session**; never bypass hooks. Working-tree changes are fine.
- Docs and code comments in English; UI copy in Ukrainian (`uk`) with `en`
  keys alongside, as the rest of the web app does. Follow the repo's
  `code-style`, `nestjs-code-style` and `english-only-docs` skills.
- **Nothing of the old screen survives**: not its four tabs, not their
  predicates, not their endpoints, not their widgets. Reuse is allowed only
  for the producer-side components and endpoints that predate it (the
  producers CRUD, `ProducerFields`, `ProducerPicker`, `OwnerInput`,
  `ProducerRulesPanel`, `TypeBadge`, `CountryFlag`, `Pagination`, `Table`,
  `Combobox`).
- Local infrastructure: Postgres on `localhost:5431` (`db`/`user`/`1`),
  Valkey on `6378`; the dump of 2026-09-17 is what every count below was
  measured on. `pnpm test` (unit) and `pnpm test:integration` (live DB) in
  `be/`; `pnpm lint`, `pnpm test`, `pnpm schema && pnpm codegen` in `web/`.
- Update `be/CLAUDE.md` "API contract" and "The new-product queue" alongside
  the code (B7), and this file's Status column as you go.

---

## 1. Backend (`be/`)

Order matters: B9 first (the resolver gains `lead`), then B1 → B2 → B8 →
B3 → B4 → B5 → B6, B7 last.

| #  | Checkpoint                                  | Status |
| -- | ------------------------------------------- | ------ |
| B9 | `lead` alias scope; `ТМ` token as the brand | done   |
| B1 | Issue detectors, rebuilt queue and summary  | done   |
| B2 | Suggestions endpoint                        | done   |
| B8 | Preview (what-if reach)                     | done   |
| B3 | Commit endpoint                             | done   |
| B4 | Merge, bulk, status                         | done   |
| B5 | Producers queue, alias scope patch          | done   |
| B6 | Conflict acknowledgement                    | done   |
| B7 | Retire old endpoints, docs, green suite     | done   |

### B9 — `lead` alias scope and the `ТМ` token

- `src/enums/kb.enum.ts`: `ProducerAliasScope` gains `LEAD = 'lead'`
  ("matches only at the start of a normalized name, exempt from the
  five-character floor"). `varchar(16)` column, no CHECK → no migration.
- `src/scrape/kb/kb-resolver.service.ts` `matchInName`: `lead` aliases are
  tested with `KbKeyUtils.matchesPrefix`-style start-of-string containment
  on the normalized name (`" key "` at position 0) and skip
  `KB_NAME_ALIAS_MIN_LENGTH`; `brand`/`any` unchanged. `matchByBrand`
  keeps excluding `name`-scoped aliases only (a `lead` alias is also a
  valid stated brand).
- `src/utils/kb-alias.util.ts`, `scripts/kb-export.ts`, the
  `ProducerAliasDto` validators and the web `vocabLabel` tuples learn the
  value.
- `src/utils/brand-hint.util.ts` (new, `BrandHintUtils.fromRawName`):
  extracts `(… , ТМ|TM <brand>)` from a raw listing name. Unit-tested on
  the real `vina-mira` names in the design doc §2.
- `src/scrape/adapters/vina-mira/*`: when the card states no brand, set
  `snap.brand` from `BrandHintUtils` so it reaches `brandOrig` and
  whole-string brand matching.
- Tests: `test/scrape/kb-resolver*.spec.ts` cases — `hyde`/`lead` matches
  `Hyde #6 Special Reserve`, does not match `Johnnie Walker Blue Label` for
  `blue`/`lead`; `test/scrape/kb-golden.integration.spec.ts` still green.

### B1 — Issue detectors, rebuilt queue and summary

- `src/core/product/product.repository.ts`: one CTE, `REVIEW_ISSUES_SQL`,
  computing per bottling `issues text[]` and `severity int` from the
  predicates in the design doc §3.1 (`new`, `producer-rejected`,
  `no-producer`, `cyrillic-name`, `duplicate`, `missing-abv|volume|
  country|type`, `producer-withheld`, `type-vs-name`, `country-vs-name`,
  `abv-range`, `name-leftover`, `age-in-raw`, `age-single-store`,
  `untrusted-fact`, `conflict`). The type-word and region-word regexes live
  in `src/constants/review.constants.ts` as one table shared with the
  TypeScript side; a unit test asserts SQL and TS agree on a fixture list
  (the age-reader/name-stripper lesson).
- Membership: stocked bottlings (or `includeUnstocked`), `reviewStatus IS
  DISTINCT FROM 'verified' AND IS DISTINCT FROM 'rejected'`, at least one
  issue; `conflict` counts only `resolvedAt IS NULL` rows unless
  `includeAcknowledged`. `status=verified|rejected` lists the decisions.
- `findReviewQueue(filter)` returns the row shape of the design doc §5.1
  (facts with sources, producer/bottler `{id, slug, name, kind, status}`,
  `producerSource`, `brandOrig`, `matchKey`, `flavors`, `offers[]`,
  `conflicts[]`, `issues[]`, `reviewStatus`, `reviewedAt`, `createdAt`),
  filters `issue=a,b`, `store`, `name`, `status`, `sort=severity|newest`,
  paging. `countReviewIssues()` feeds the summary.
- `src/domain/product`: `ReviewQueueQueryDto`, `ReviewQueueRowType`,
  `ReviewIssueType`, `ProductReviewSummaryType` rebuilt (`{ open,
  verifiedToday, rejected, acknowledgedOnly, byIssue, producers: { open,
  byIssue } }`). Permission `product:review`.
- Tests: `test/integration/review-issues.integration.spec.ts` seeds one
  row per detector and asserts exactly its codes; a smoke test on the dump
  prints the census and asserts the queue is non-empty.

### B2 — Suggestions

- `GET /product/review/:id/suggestions` → `{ producers[], duplicates[],
  siblings, storeHints[] }` (design doc §5.1). Producer candidates from:
  `brandOrig` exact key; the `ТМ` token key; name words against alias keys
  **ignoring scope and floor** (flagged `via: 'unreachable-alias'`, this is
  the Hyde case); producer name `ILIKE` a token. Each candidate carries the
  per-scope reach from B8. Duplicates: identity twins
  (`findIdentityTwins`) plus same producer + folded name + volume with one
  age null (`via: 'near-identity'`). Siblings: value distributions of
  `abv`/`type`/`country` over bottlings sharing the folded name.

### B8 — Preview

- `POST /product/review/preview` with the `commit` body minus `verdict`;
  `?preview=true` on `PATCH /producer/:id`, `POST /producer/:id/alias`,
  `PATCH /producer/:id/alias/:aliasId`, `DELETE …/alias/:aliasId`.
- Mechanism: build a hypothetical alias index (the `ProducerReachService`
  what-if pattern), run `KbReconcileService.run({ dryRun: true })`, diff
  `plan.producers`/`plan.facts` against stored rows → `affected[]`
  (`productId, name, volumeMl, age, stores[], inQueue, reviewStatus,
  changes {producer?, type?, country?}`) and, for alias actions,
  `aliasScopes: { brand, lead, any: { frees, steals } }` with the exact
  semantics of the design doc §3.4 (`frees` = bottlings that leave the
  queue, the open one included; `steals` = bottlings re-pointed from a
  different producer).
- Read-only, no cache bump. Integration test on the dump: `hyde`/`lead`
  → frees 11, steals 0; `blue`/`any` steals ≥ 10.

### B3 — Commit

- `POST /product/review/commit` (design doc §5.2), `product:review`. One
  transaction in `ProductReviewService.commit`: patch (every written field
  → `manual`), `confirm[]` (→ `manual` without a value change), producer
  (`pin` → new `CoreProductService.setProducerManual(productId,
  producerId|null, bottlerId|null)` writing `producerSource = 'manual'`;
  `alias`/`widen-alias` → `producer_alias` writes), flavors
  (`setManualFlavors`, `flavorsCuratedAt`), resolve every open conflict of
  the bottling, `mergeTwins`, `applyReviewStatus(verdict)` unconditional,
  cache bump. After commit, when an alias was written: `KbReconcileService
  .run()` (the `PATCH /producer/:id` precedent). Answers `{ productId,
  merged, created, issuesLeft, affected[] }` (`affected` from the B8 diff
  computed before the write).
- `verdict: 'rejected'` skips the patch and only stamps; `SET_PRODUCERS_SQL`
  already respects `producerSource = 'manual'` — verify with a test that a
  pinned bottling survives a full reconcile.

### B4 — Merge, bulk, status

- `POST /product/review/merge { sourceId, targetId }` →
  `CoreProductService.mergeInto(sourceId, targetId)`; answers the survivor
  row. `POST /product/review/bulk { productIds ≤ 200, patch: { typeName? |
  countryCode? | producer?: { mode: 'pin', producerId } } }` → every write
  `manual`, one transaction, cache bump. `POST /product/review/status`
  kept; `verified` also resolves the bottlings' open conflicts.

### B5 — Producers queue and alias scope patch

- `GET /producer/review?issue=&status=&kind=&name=&page` — the design doc
  §3.3 detectors as SQL (`unverified`, `no-alias`, `alias-unreachable`,
  `unlinked-mentions`, `kind-suspect`, `no-region`, `no-default-type`,
  `brand-no-parent`, `peat-unknown`); rows are `ProducerReviewRow` +
  `issues[]`, `aliasCount`, `unresolvedMentions`. `producer:read`.
- `PATCH /producer/:id/alias/:aliasId { scope }` (`producer:update`), runs
  the KB pass inline like its siblings; `DELETE …/alias/:aliasId` answers
  its reach (bottlings that lose the producer) via `?preview=true`.
- `ProducerCreateDto.aliases` collisions are reported as
  `skippedAliases[]` instead of dropped silently.

### B6 — Conflict acknowledgement

- `logFactConflicts` upsert: drop `"resolvedAt" = NULL`; a re-sighting
  bumps `seenCount`/`lastSeenAt` only.
- Migration `fact-conflict-acknowledge`: `UPDATE product_fact_conflict SET
  "resolvedAt" = now() WHERE "resolvedAt" IS NULL`, with a comment naming
  the owner's decision; `down()` a documented no-op. Format per the
  `typeorm-migration-format` skill.
- Queue: `includeAcknowledged=true` also lists bottlings whose only
  conflicts are acknowledged.

### B7 — Retire, document, green

- Remove `GET /product/review/producers`, `GET /product/review/facts`,
  `GET /product/review/conflicts`, `POST /product/review/conflicts/resolve`
  and their now-unused service/repository methods and types.
- `be/CLAUDE.md`: rewrite the "The new-product queue" section and the
  `/product/review*` rows of the "API contract" table; note the reversed
  conflict rule and the `lead` scope. Update `.env.example` if any setting
  was added (none is expected).
- `pnpm lint`, `pnpm test`, `pnpm test:integration` green; `pnpm openapi`
  snapshot regenerated for the web codegen.

---

## 2. Web (`web/`)

Order: W0 → W1 → W2 → W3 → W4 → W5 → W6 → W7 → W8.

| #  | Checkpoint                                                | Status |
| -- | --------------------------------------------------------- | ------ |
| W0 | Shared-kit prerequisites (focus ring, popover, combobox…) | done   |
| W1 | Page shell, table, toolbar, filters, keyboard             | done   |
| W2 | Side panel: head, evidence, reasons, card, actions        | done   |
| W3 | Producer field, binding block, new-producer form, modal   | done   |
| W4 | Bulk bar                                                  | done   |
| W5 | Producers tab                                             | done   |
| W6 | Рішення tab and toast                                     | done   |
| W7 | Mobile guard, i18n, codegen, deletions, green             | done   |
| W8 | Mockup alignment pass against `review-mockup.html`        | done   |

### W8 — Mockup alignment pass

Added after the owner compared the built screen against
`web/references/review-mockup.html` and listed what diverged. The pass is
recorded here rather than folded into W1–W7 because two of its outcomes are
decisions rather than corrections.

What the screen took from the mockup: the «Проблеми» column dropped from both
tables (the information is in the panel, which has to be opened anyway), the
column order and the select-all checkboxes, store monograms instead of a
count, the panel's section rules with their right-hand notes, the evidence
card's layout, the reasons grid with a fixed chip column, the label-left
bottling card with its source badges and struck-through previous values, the
flavour chips, and «Обʼєднати з…» in the action bar.

What it deliberately did **not** take:

- **Two-letter store monograms.** The catalogues draw one letter and one
  colour, from `/meta`; a second alphabet for the same shops would be a
  second thing to keep in step.
- **A type control that shows only the abbreviation.** `SM` alone is a
  crossword clue; the control states the name and the badge, and the badge
  carries the colour.
- **Region among the three-across pickers.** It is not a bottling fact at
  all — it comes from the resolved producer — so it stands beside the
  bottler, the card's other read-only row, and the two selects get the width
  the mockup's abbreviation did not need.
- **A bottler picker.** The commit carries no bottler, so an editable field
  there would write nothing.

### W0 — Shared-kit prerequisites

- **Focus ring rule (owner's standing complaint, applies app-wide):** a
  focus border or ring must disappear the moment the user has made a
  selection with the pointer. The canonical defect: pick a currency in the
  catalogue's currency switcher and the trigger stays outlined in amber.
  `src/shared/ui/dropdown-menu.tsx` already tries to keep focus off the
  trigger on a pointer close and the defect persists, so: reproduce it,
  find the actual cause (Radix focusing the trigger on `pointerdown`, the
  `Button`'s `focus-visible:ring-*`, or `onCloseAutoFocus` not firing), fix
  it **in the primitive** — after a pointer pick, `blur()` whatever ended up
  focused, or return focus with the ring suppressed — and apply the same
  rule to `Combobox` (blur on pick), native `<select>` (`blur()` in
  `onChange`), the segmented control and the new `Popover`. Keyboard users
  keep the ring. Add a `@testing-library` test per primitive: after a
  pointer selection the trigger is not `document.activeElement` (or does
  not match `:focus-visible`).
- `Popover` primitive (`@radix-ui/react-popover`, shadcn style) for the
  `?` help: opens on click, stays open until an outside click or `Esc`,
  `max-h` with internal scroll, `whitespace-pre-line` body.
- `Combobox`: a creatable footer item («Створити виробника «X»») rendered
  when the server search is empty, via an `onCreate` callback; a
  closed-vocabulary mode for type and country (client-side filtering of
  `meta.types` / `meta.allCountries`, badge/flag rendering).
- `Segmented` control with equal-width parts (kind, peat, status, alias
  scope, match mode).
- `Toast` (Radix Toast or `sonner`; pick one and note it in the design doc)
  with an action slot («Показати N», «Повернути в чергу»).
- A `Tooltip`-wrapped `IssueChip` (severity colour from a closed map, label
  and explanation from `review.ts`).

### W1 — Page shell, table, toolbar, filters, keyboard

- Route `product/review` gets `handle: FULL_HEIGHT`; `AdminRoute` stays;
  gate mutations on `product:review`, producer writes on
  `producer:create/update` (hide, do not disable, controls the user lacks).
- Page head: title, tabs «Пляшки [N] · Виробники [N] · Рішення», right
  side «сьогодні +N · база знань застосована HH:MM», `↻ База знань`
  (`POST /product/review/apply`), `+ Виробник` on the producers tab.
- Toolbar: `SearchInput` (name, raw name, URL), store select, sort select,
  the «Проблеми» dropdown (grouped by severity with counts, tri-state «усі
  проблеми», «Показати також → переглянуті розбіжності»), `Знайдено N`, the
  per-page select — all URL-driven via `useSearchParams` like the
  catalogue.
- Table: TanStack Table, `STICKY_TABLE_HEADER`, fixed column widths from
  the design doc §6.1 (`№` 44, issues 250→200 with the panel open,
  producer 170→150, type 56, country 60, ABV 72, volume 78, age 58, shops
  110, added 72), two-line name cell (name + spec, raw store name beneath),
  `IssueChip`s (3 + `+N` with a tooltip listing the rest), producer name as
  a link opening the producer modal, `TypeBadge`, `CountryFlag`, numbers
  with the source as a tooltip (`manual` primary-tinted, `llm`/`legacy`
  dotted), store monograms, row `✓` for rows whose only issue is `new`.
  `Pagination` centred beneath. Row select opens the panel; `↑`/`↓`
  (`J`/`K`) move selection; `Enter` opens; `V` verifies a `new`-only row;
  `R` rejects; `M` opens merge; `⌘⏎` saves and advances; `Esc`/`✕` closes
  (test).

### W2 — Side panel

- 540 px `aside` beside the table (the table hides its secondary columns
  while it is open). Head: name, spec, `matchKey` in mono, chips with
  tooltips, right column as a 3-wide grid — `↑ ↓ ✕` then `?` under `✕`
  (the `Popover` with the guarantee text and the key sheet).
- «Докази»: one card per offer (monogram, raw name with type/country/`ТМ`
  tokens highlighted, «Відкрити в магазині ↗», SKU, price, first seen,
  whether a brand was stated); «цю пропозицію → інша пляшка» (`relink`) on
  multi-offer bottlings.
- «Чому в черзі»: two-column grid, chip | fixes; the explanation lives in
  the chip's tooltip; the suggested fix is a primary-tinted outline button,
  alternatives plain outline; type fixes show the badge alone; the
  producer row offers exactly one candidate button.
- «Картка пляшки»: name; producer field (W3); bottler; type (badge-only
  picker), country (flag + name picker), region (read-only, from the
  producer); ABV / volume / age with source badges and suggestion chips
  (siblings, store page); flavours as the existing chip picker, unlabelled,
  left-aligned. Changed fields highlighted, count in the section header.
- Actions row: `Не віскі` · `Пропустити` ·· `Обʼєднати з…` · `Підтвердити`
  (the only filled button). Every text-labelled control is an outline
  button; `ghost` only for icon-only controls.
- Data: `GET …/queue` row + lazy `GET …/:id/suggestions`; `POST …/commit`;
  invalidate and refetch (no optimistic removal); after commit advance to
  the next row.

### W3 — Producer field, binding block, new-producer form, modal

- Producer combobox (search over name/slug/alias, `ProducerPicker` base)
  with the creatable footer. Beneath it the **binding block**: one radio
  per option, full width — «Аліас «x» на початку назви», «Аліас «x»
  будь-де в назві», «Лише ця пляшка, без аліаса» — each with two aligned
  columns «вийдуть з черги» / «перейдуть від іншого виробника» fed by
  `POST …/preview`, then the list of the other affected bottlings
  (monogram, name, spec, status, `↗` that opens the row in the panel).
- When nothing matches: the field turns into the inline **new-producer
  sub-form** (`ProducerFields`, aliases pre-filled from the `ТМ` token or
  `brandOrig`, scope per alias) with its own binding block; created
  together with the commit.
- **Producer modal** (`Dialog`, ~880 px): `ProducerFields` (owner via
  `OwnerInput`), aliases with scope, «→ на початку назви · N пляшок» and
  «Видалити · −N» (reach from preview), the trimmed `ProducerRulesPanel`
  (own rules + «+ правило»; the global rules and the mechanics behind a `?`
  popover shown only while a rule exists or is being added; the add form's
  right edge aligned with the «Додати · перерахунок N» button), status
  segmented, footer «Не виробник віскі» ·· «Зберегти» with the save's
  reach. Opened from the table's producer cell, the producers tab row and
  the panel's producer chip.

- **Layout decision (owner, 2026-09-18): the mockup's producer modal is
  the target, not the current `ProducerFields`.** Redraw `ProducerFields`
  to the mockup: a two-column form (left Назва · Країна · Материнська ·
  Власник · Торф; right Вид · Регіон · Ботлер · Тип за замовч. · Статус),
  `kind`/`peatProfile`/`status` as equal-width `Segmented` controls, then
  full-width Аліаси (scope, «→ на початку назви · N пляшок», «Видалити ·
  −N»), Правила (own rules + «+ правило», global rules behind the `?`
  popover shown only while a rule exists or is being added), Джерела,
  Нотатка, footer «Не виробник віскі» ·· reach · «Зберегти». The change is
  in the shared component, so `/producers/:id` and the create dialog follow.
  Reference: `web/references/review-mockup.html` (v11), producer modal.
  **Landed 2026-09-18 (design session):** `ProducerFields` is now the
  two-column form with `status` as a segmented control (`withStatus`) and a
  `between` slot; `ProducerEditModal` and `ProducerCard` render the aliases
  and the trimmed `ProducerRulesPanel` in that slot, with the footer «Не
  виробник віскі» ·· reach · «Зберегти»; the global rules sit behind the
  `?` popover shown only while a rule exists or one is being added; the form
  model carries `status` and `buildProducerPatch` sends it when the control
  moved. `tsc`, `eslint`, `dprint` and the producer-form tests are green;
  the one remaining `tsc` error is in `review-panel.tsx` (`ProducerField`
  now requires `value`), which belongs to the W3 binding-block work.

  **Second pass, same day (owner's screenshot diff against the mockup):**
  the form is **one** two-column grid of `ProducerFieldRow`s in interleaved
  order (Назва | Вид, Країна | Регіон, Материнська | Ботлер, Власник | Тип,
  Торф | Статус), so the rows of the two columns share a baseline and the
  type hint pushes the whole row; the two regions share the «Регіон» row
  under an `SWA` caption; the three segmented controls show the raw
  vocabulary values in the mockup's order (`unknown none light medium
  heavy`, `unverified auto verified rejected`) with the translated label as
  each part's title; the heading is `ProducerHeading` (name · slug · kind
  and status as outlined chips · the three counts, left to right); the
  aliases are the mockup's «Аліаси» row — unbordered lines, «→ на початку
  назви», «Видалити · −N», a dashed «+ написання» opening the add row with a
  scope `Segmented` — and `ProducerAliasesPanel` is gone, the page uses the
  same `ProducerAliases`; the rules are the «Правила торфу і смаків» row —
  «Власних правил немає.» · dashed «+ правило» · `?` at the right, the form
  as one line (pattern · слово|префікс · priority · one claim select with
  `peat:` / `require:` / `forbid:` values) and «Скасувати · Додати ·
  перерахунок N пляшок» under it, `productCount` passed in for the N. The
  widen button carries its count after all: `GET
  /producer/:id/alias/:aliasId/preview?scope=lead` (added the same day)
  answers the rescope with no bottling in focus, through the pass the
  binding block's preview runs, and `review-commit.integration.spec.ts`
  pins that the two give one number. The `Segmented` primitive gained the
  mockup's hairline dividers and `minmax(max-content, 1fr)` tracks, so a
  part is never narrower than its label; `fit` sizes an inline one by its
  labels alone.

  The mockup itself (artifact v12, both `web/references` copies) gained live
  controls in the producer modal: every `.segs` part toggles on click, the
  rule row and the alias row take real input and «Додати» appends a line —
  the owner had found the rule row inert, which was a static placeholder.

### W4 — Bulk bar

- Appears when rows are checked: «N вибрано», `✓ Підтвердити N`, `Не
  віскі`, `Виробник →`, `Тип →`, `Країна →` (pickers), «Обʼєднати в одну
  пляшку», «Зняти вибір». Backed by `POST …/status`, `…/bulk`, `…/merge`.
  The `Не віскі?` filter + select-all + «Не віскі» is how the 17
  producer-rejected bottlings are handled.

### W5 — Producers tab

- Same toolbar shape (search, kind, status, «Проблеми» dropdown,
  `Знайдено`, per-page); columns per the design doc §6.5; row click opens
  the producer modal; «+ Виробник» in the head. Data: `GET
  /producer/review`.

### W6 — Рішення tab and toast

- Verified/rejected log, newest first, searchable, «Повернути в чергу» per
  row (`POST …/status` with `pending`). Toast after every commit: outcome,
  reach («ще 10 пляшок вийшли з черги · Показати 10»), «Повернути в чергу».

### W7 — Mobile guard, i18n, codegen, deletions, green

- On `useIsMobile()` the route renders a one-line desktop-only notice;
  navigation unchanged (absent on mobile).
- `src/shared/i18n/locales/{uk,en}/review.ts` rewritten for the new
  screen (issue labels + explanations, binding block, help texts, actions).
- `pnpm schema && pnpm codegen` against the B7 server; delete
  `src/widgets/review/*`, `src/pages/review/*` internals, the old
  `entities/review` hooks and their tests; `pnpm lint`, `pnpm test` green;
  `tsc --noEmit` clean.

---

## 3. Acceptance (A1)

On the local dump, through the new screen only:

1. The 125 `pending` bottlings are drained; the queue's open count reaches
   0 with the default filters.
2. Every flow of the design doc §4 is exercised at least once: alias widen
   (Hyde, 11 leave together), producer create (Cotswolds, Export Reserve
   leaves with it), Cyrillic rename → merge (Джек Деніелс), duplicate merge
   (Malt B), sibling ABV fill (Canadian Club), type fix (Jim Beam Rye),
   reject not-whisky (Kolonat's Choice, Yakusun via bulk), age clear →
   merge (Grants), bulk verify (S.EDWARDS ×6), conflict accept (Balvenie,
   via «переглянуті розбіжності»), producer kind fix (mac-talla → brand).
3. A verified bottling does not reappear after `pnpm reconcile-flavors`
   and after a `scrape-dry-run`-fed persist of its store.
4. No focus ring lingers on any picker after a pointer selection — on this
   screen and on the catalogue's currency switcher.
5. Screenshots of the queue, the panel (Hamiltons, Hyde, Cotswold), the
   producer modal and the producers tab attached to the final report.

---

## 4. Kickoff prompt for a fresh session

Paste as the first message of a new Claude Code session opened in
`/Users/mekh/Projects/mech/whisky-scrapper/be`:

```
Implement the rebuild of the `/product/review` curation screen exactly as
specified in `docs/REVIEW-REDESIGN.md` (analysis, decisions, UI spec) and
`docs/REVIEW-REDESIGN-PLAN.md` (work order). Read both in full first, then
`CLAUDE.md` sections "Layering rules", "The new-product queue", "The
knowledge base in operation", "The producers section" and "API contract".

Scope: backend checkpoints B9, B1, B2, B8, B3, B4, B5, B6, B7 in `be/`,
then web checkpoints W0–W7 in `../web`, then acceptance A1 on the local
dump (Postgres localhost:5431, db/user/1). The old screen is replaced
wholesale: none of its tabs, predicates, endpoints or widgets survive; the
producers CRUD and the shared producer components from commit ec62cba are
reused. Every decision is already made and recorded in §8 of the design
doc — do not reopen them; if you hit a genuine conflict with a documented
decision, stop and ask, otherwise run straight through without progress
pauses. Update the Status column of the plan as each checkpoint lands, and
update `be/CLAUDE.md` in B7.

Rules: sub-agents only on Sonnet 5 and only for read-only exploration or
review; no `git commit` or `git push` unless I say so explicitly in this
session, never bypass hooks; docs and comments in English, UI copy in
Ukrainian with English keys; follow the `code-style`, `nestjs-code-style`,
`english-only-docs` and `typeorm-migration-format` skills; every text-
labelled control is an outline button, help icons are click popovers, and
no focus ring may remain on a picker after a pointer selection (fix it in
the shared primitives so the catalogue's currency switcher is fixed too).

Definition of done: `pnpm lint`, `pnpm test` and `pnpm test:integration`
green in `be/`; `pnpm lint`, `pnpm test` and `tsc --noEmit` green in
`../web` after `pnpm schema && pnpm codegen`; the A1 checklist completed
with screenshots; a final report listing what shipped, what was measured,
and anything left in `FOLLOWUPS.md`.
```
