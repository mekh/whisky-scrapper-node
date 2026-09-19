# `/product/review` — redesign of the curation screen

Status: **design approved on 2026-09-17** — T1 table, E1 side panel,
two-line rows; every decision is recorded in §8, none is open. Nothing here
is implemented yet. The interactive mockup is published as an Artifact
("Whisky Review Queue", v8, with all of the owner's comments applied); this
document is the specification, and the work order with the kickoff prompt is
[`REVIEW-REDESIGN-PLAN.md`](REVIEW-REDESIGN-PLAN.md).

The brief, in one line: the current screen is replaced wholesale. None of its
four tabs, its predicates or its flows survive. The owner works this screen
personally and has ruled it either broken, misleading or beside the point; that
verdict is the input to this document, not something it argues with.

---

## 1. What the screen is for

One person verifies, by hand, data that arrived from scraping ~20 shops or that
is wrong in the database, and **commits** a correction. After a commit the
bottling never comes back to this screen on its own.

A bottling (a `product` row, never a `store_product`) needs a person when:

1. it entered the database for the first time (a sync created it);
2. it has no producer, or its producer cannot be identified;
3. it lacks a required fact: `abv`, `volumeMl`, `countryId`, `typeId`;
4. its producer row is wrong (a `blend` that is really a `brand` or a
   `distillery`), which is a producer problem surfaced through its bottlings;
5. — added by the analysis below — its name is a Cyrillic transliteration or
   carries packaging leftovers, it is a probable duplicate of another
   bottling, a fact contradicts its own raw name, its ABV puts it outside
   whisky, it resolves to a producer already ruled "not whisky", or a shop
   contradicts one of its facts.

A producer (a `producer` row) needs a person when it entered the database for
the first time, when nothing can ever resolve to it, or when its own facts look
wrong.

Everything the person needs to decide has to be on this screen, and every fix
— including creating the producer that does not exist yet — has to be
committable here, without a second page.

---

## 2. What the data says (dump of 2026-09-17, local)

3 971 bottlings, 3 213 of them with at least one in-stock offer; 811
producers, all created by the seed of 2026-08-24; 125 bottlings `pending`
(121 from the `vina-mira` onboarding on 2026-09-15, 4 from the 17th), 1
`verified`, 3 845 `null` (predate the queue).

### 2.1 Census of problems on stocked bottlings

| Problem class                                           | Bottlings | Notes                                                                             |
| ------------------------------------------------------- | --------: | --------------------------------------------------------------------------------- |
| `reviewStatus = pending`                                |       125 | 34 of them have nothing else wrong — "new only"                                   |
| no producer and no bottler                              |       114 | 97 genuinely unresolved; 17 resolve to a producer already `rejected` (not whisky) |
| `abv` null                                              |        23 | all but a handful from `vina-mira`, whose listing states no strength              |
| `typeId` null                                           |        19 |                                                                                   |
| `countryId` null                                        |        14 |                                                                                   |
| `volumeMl` null                                         |         5 |                                                                                   |
| type contradicts the name (`Jim Beam Rye` → `bourbon`)  |        42 | 26 of them KB-sourced: the producer's `defaultTypeName` overrode the expression   |
| ABV outside 35–70 %                                     |        29 | whisky liqueurs, RTDs, flavoured Jim Beam at 32.5 %                               |
| Cyrillic-only canonical name                            |         7 | `Джек Деніелс`, `Ханки Баністер` ×3 spellings — no alias can ever match           |
| packaging left in the name (`під. +2 ст`)               |         2 |                                                                                   |
| identity duplicate (same folded name, volume, age)      |         1 | `Malt B` twice; the `vina-mira` row has no `matchKey` at all                      |
| region word in the name, country elsewhere              |         2 | `Hamiltons Islay` filed under England by the shop                                 |
| `llm`-sourced type or country                           |         6 | the whole content of today's "facts" tab                                          |
| raw name states an age, row has none                    |        14 |                                                                                   |
| age stated by one store's spec page only                |         4 | `VAT 69` 4 y, `Jim Beam Black` 4 y, `Grant's Triple Wood` 3 y — all NAS bottlings |
| unresolved cross-shop conflicts                         |       391 | 790 rows; 517 of them are a shop disagreeing with a **KB** value (mostly noise)   |
| producer kind `blend` but the bottling is a single malt |        48 | 13 producers (`mac-talla`, `finlaggan`, `cailleach`, `clan-denny`, …)             |

Union of the hard classes (everything but conflicts): **289** stocked bottlings.
With conflicts: 629. Conflict-only rows: 340.

The 125 pending rows, one by one, fall into these buckets (a row can be in
several): 34 nothing wrong, 67 no producer, 15 no ABV, 3 Cyrillic-only ×
several volumes, 2 packaging leftovers, ~10 wrong type (`blend` for
`Lambay Irish Malt`, `Hamiltons Islay Single Malt`, `Clan Cola Single Malt`;
`bourbon` for `Jim Beam Rye`, `Wild Turkey Rye`; `rye` for
`The Whistler Dopplebock Rye Cask Finish`), 2 liqueurs (`Kolonat's Choice`
30 %, `The Dubliner Irish and Honeycomb` 30 %), 1 duplicate.

### 2.2 Why each class exists (the mechanics, verified in code)

- **No producer, part 1 — the raw name names the brand and nothing reads it.**
  `vina-mira` writes `(Країна, ТМ Brand)` at the end of every listing —
  `ТМ Cotswold`, `ТМ Hyde`, `ТМ Woven`, `ТМ Moon Harbour` — and the name
  cleaner strips the parenthetical. The resolver never sees `nameOrig`, so
  the brand is present in the data and unused. 60 of the 67 unresolved
  pending rows carry such a token.
- **No producer, part 2 — an alias that can never fire.** `matchByBrand`
  needs a stated brand and compares whole strings; `matchInName` excludes
  `scope = brand` aliases and applies a five-character floor. So `hyde`
  (4 letters, brand-scoped) and `hamiltons`, `dubliner`, `kura`, `element`,
  `bouteille` (brand-scoped) cannot match any bottling of a shop that states
  no brand. Measured: 8 live producers whose every alias is unreachable by
  name, 21 unresolved stocked bottlings carrying their word — 11 of them
  `Hyde`. The producer exists; the fix is one alias edit or one bulk pin.
- **No producer, part 3 — the producer does not exist.** `Black & White`,
  `Cotswolds`, `Titanic`, `Woven`, `Kinahan's`, `Rebel Yell` (as a brand),
  `Moon Harbour`. Creation must be inline.
- **No producer, part 4 — the producer is `rejected`.** `Yakusun`, `Vulson`,
  `Undone`, `Boulevardier`, `Bayadera` … 17 stocked bottlings resolve to a
  producer a person has already ruled not whisky, yet they carry
  `reviewStatus = null` and stay in every report with no label. The
  bottling-level verdict was never recorded.
- **Wrong type from the KB.** `APPLY_KB_FACTS_SQL` writes the producer's
  `defaultTypeName` to every bottling unconditionally except `manual`, so
  `Jim Beam Rye` and `Wild Turkey Rye` are `bourbon`, and `Templeton Rye`'s
  cask-finish siblings follow the house default. Name-derived type is the
  right tie-breaker and nothing applies it.
- **Wrong type from the shop.** `vina-mira`'s detail page hands over a type
  the adapter canonicalizes to `blend` for single malts (`Lambay Irish Malt`,
  `Hamiltons Islay Single Malt`). The raw name says otherwise, in words.
- **Cyrillic names.** `Віскі Джек Деніелс 0,7 л` cleans to `Джек Деніелс`,
  which no alias, no identity and no key can ever join to `Jack Daniel's`.
  The only fix is a rename, which `ProductService.update` already turns into
  a merge by identity when the Latin twin exists.
- **Missing ABV.** The listing states none and the detail page was skipped
  or lacked it. The value is knowable from the store page (link) or from the
  catalogue itself: `Canadian Club Original` is 40 % in seven other shops.
- **Ages that should not exist.** `fozzy`'s spec page states a bare number
  the adapter reads as years (`VAT 69` → 4, `Grant's Triple Wood` → 3). Age
  is identity, so the wrong value creates a second bottling beside the NAS
  one; the fix is an edit that the identity merge folds away.
- **Duplicates.** `Malt B` from `vina-mira` was inserted with no `matchKey`
  and never compared by identity against the `maudau` row; merges by
  identity happen only on a person's edit. The queue must show the twin.
- **Conflicts.** 517 of 790 open rows pit a shop's coarse label against a KB
  value (`goodwine` says `Велика Британія`, the KB says `Шотландія`; `rozetka`
  says `bourbon` for `Black Ram Bourbon Cask Finish`). The remaining 273
  contest a `name`/`store`/`legacy` value and some are real
  (`Balvenie Portwood 21` stored 42 % from a name, four shops say 40 %;
  `Caperdonich Peated 25` stored 45.5 %, two shops say 58.1 %). A resolved
  conflict **un-resolves on the next sighting**, so the current "Вирішено"
  button is a decision the next sync discards unless the fact is also
  stamped `manual`.
- **Producer kind.** `mac-talla`, `finlaggan`, `cailleach` are independent
  single-malt brands seeded as `blend`; all their bottlings are single malts.
  A `blend` producer whose bottlings are mostly single malts is the signal.
- **Nothing lists producers with a real problem.** 0 producers are
  `unverified` today, so the first tab of the current screen is empty; the
  18 with no alias, the 8 with unreachable aliases and the 13 with a
  suspicious kind are invisible.

### 2.3 What is structurally missing in the API today

From the backend inventory: no endpoint lists bottlings with a null producer
on its own; none lists null `abv`/`volumeMl`; nothing can set
`producerId`/`bottlerId` by hand (no `producerSource = manual` write path
exists, although `SET_PRODUCERS_SQL` already respects it); no single-product
resolution trace; no bulk fact write; no bulk conflict handling; conflict
resolution does not stop the conflict from being re-logged; `POST
/product/review/producers` sits behind `producer:read` while its siblings sit
behind `product:review`.

---

## 3. The model

### 3.1 One queue of bottlings, each row carrying its reasons

The screen has one primary list: **bottlings that need a person**. A row is
in the queue when it is not `verified` and not `rejected` **and** at least one
reason fires. `pending` is itself a reason, so every new bottling appears
even when nothing else is wrong; a legacy (`null`) bottling appears only when
a detector fires. The 3 000 clean legacy rows never enter.

Reasons are computed server-side and returned on every row as
`issues: ReviewIssue[]` — `{ code, severity, field?, detail? }` — so the table
can say _why_ without the person opening anything.

| Code                | Severity | Fires when                                                                                                                                                                | Stocked today | Fix on this screen                                                               | Stops firing when                   |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | -------------------------------------------------------------------------------- | ----------------------------------- |
| `new`               | info     | `reviewStatus = 'pending'`                                                                                                                                                |           125 | any commit                                                                       | status leaves `pending`             |
| `producer-rejected` | critical | no producer/bottler and the what-if resolution (index including `rejected`) hits a rejected producer                                                                      |            17 | **Reject** (not whisky), or link/create the real producer                        | commit                              |
| `no-producer`       | error    | `producerId IS NULL AND bottlerId IS NULL`                                                                                                                                |           114 | alias (all bottlings with that spelling) / pin (this one) / create / set bottler | producer or bottler set             |
| `cyrillic-name`     | error    | `name !~ '[A-Za-z]'`                                                                                                                                                      |             7 | rename → identity merge                                                          | name carries Latin                  |
| `duplicate`         | error    | another bottling shares `identityOf(name)`, `volumeMl`, `age`; or same producer + folded name + volume, one age null                                                      |             1 | **Merge into …**                                                                 | merged                              |
| `missing-<fact>`    | error    | `abv` / `volumeMl` / `countryId` / `typeId` null                                                                                                                          |    23/5/14/19 | fill, with suggestions (siblings, store page, KB)                                | filled                              |
| `producer-withheld` | error    | what-if resolution hits an `unverified` producer                                                                                                                          |             0 | promote the producer inline                                                      | producer live                       |
| `type-vs-name`      | warn     | type word in name/raw name ≠ `typeId`, `typeSource ≠ manual`; `bourbon cask`/`rye cask` excluded                                                                          |            42 | set type (→ `manual`)                                                            | `manual`, or values agree           |
| `country-vs-name`   | warn     | Scotch region word in the name, country ≠ `GB-SCT`, `countrySource ≠ manual`                                                                                              |             2 | set country                                                                      | `manual`                            |
| `abv-range`         | warn     | `abv < 35 OR abv > 70`, `abvSource ≠ manual`                                                                                                                              |            29 | **Reject** (liqueur/RTD) or confirm (→ `manual`)                                 | `manual`                            |
| `name-leftover`     | warn     | packaging tokens in `name` (`під.`, `+2`, `кор.`, `тубус`, `набір`, `склян`, `бокал`)                                                                                     |             2 | rename                                                                           | clean                               |
| `age-in-raw`        | warn     | `age IS NULL` and a raw name states `N років/years/yo/уо`                                                                                                                 |            14 | set age (→ merge) or verify as NAS                                               | verified                            |
| `age-single-store`  | info     | `ageSource = store` and one shop lists the bottling                                                                                                                       |             4 | confirm or clear age                                                             | verified                            |
| `untrusted-fact`    | warn     | `typeSource`/`countrySource` ∈ (`llm`, `legacy`)                                                                                                                          |             6 | confirm (→ `manual`) or change                                                   | `manual`                            |
| `conflict`          | warn     | an **unacknowledged** `product_fact_conflict` row (`resolvedAt IS NULL`); the 790 rows open today are stamped at release, since the owner has already worked through them |  0 at release | accept the claim or confirm the stored value — both → `manual`                   | commit resolves the bottling's rows |

Three things about this table are decisions rather than mechanics:

- **Every conflict queues its bottling, but only once.** The owner has
  already worked through the 790 rows open today, so the release stamps them
  acknowledged and they do not enter the queue; a toolbar checkbox
  («переглянуті розбіжності») brings those bottlings back on demand. A
  conflict logged after the release queues its bottling as `warn`, which the
  default severity sort puts below the errors. To make "already seen" stick,
  the conflict upsert stops clearing `resolvedAt` on a re-sighting — it bumps
  `seenCount` and `lastSeenAt` only. (CLAUDE.md documents the opposite rule;
  the owner reversed it here.)
- **The default sort is severity, then newest.**
- **`producer-kind` is a producer reason, not a bottling reason.** The 48
  bottlings show a hint on their producer cell; the 13 producers are what the
  person fixes, once each, on the producers tab.

Detector predicates live in one SQL fragment in `ProductRepository`
(`REVIEW_ISSUES_SQL`), which also drives the `issue=` filter and the per-code
counts of the summary, so the chip a person filters by and the chip on the row
cannot disagree.

### 3.2 "Never comes back" — the commit rule and its two exceptions

A commit is one request that records everything the person decided and stamps
the verdict. After it:

- `verified` bottlings are excluded from the queue whatever the detectors say.
  Facts the person edited are `manual`, so no sync and no KB pass can change
  them; facts the person left alone keep their source and may still improve.
- `rejected` bottlings are excluded from the queue and from the catalogue, as
  today, and stay reversible on the "Рішення" tab.

**Nothing automatic re-opens a `verified` bottling** — the owner's decision
(2026-09-17). The only way back into the queue is a person pressing
"Повернути в чергу" on the Рішення tab or the product card. The consequence
to know: when a later sync or KB pass changes a non-manual fact on a verified
bottling, the change lands silently; the product card shows the sources, and
the person can re-queue it by hand. A new conflict against a verified bottling
is likewise shown as evidence and queues nothing.

Conflicts on commit: every open conflict row of the bottling gets
`resolvedAt = now()`; for the attributes the person edited or explicitly
confirmed, the `manual` stamp also stops `logFactConflicts` from writing
them again. This is what the current "Вирішено" button lacks.

There is no defer verdict. The owner asked what it would add over simply
leaving a row alone; with a queue of a few hundred rows and a severity sort,
the honest answer is a marker and nothing more, so it is dropped until the
queue proves it is needed.

### 3.3 The producers queue

A second tab, same shape: producers that need a person, with reasons.

| Code                | Severity | Fires when                                                                                                        | Today |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ----: |
| `unverified`        | info     | `status = unverified` (a new row from `pnpm research-brands`)                                                     |     0 |
| `no-alias`          | error    | zero `producer_alias` rows — nothing can resolve to it                                                            |    18 |
| `alias-unreachable` | error    | live, every alias is `brand`-scoped or under five characters, and ≥1 unresolved stocked bottling carries the word |     8 |
| `unlinked-mentions` | warn     | the producer's name or an alias word appears in unresolved bottlings' raw names (the `ТМ` token, `1770 Original`) |     ? |
| `kind-suspect`      | warn     | `kind = blend` and more than half of its bottlings are single malts                                               |    13 |
| `no-region`         | warn     | Scotch distillery with no `region`                                                                                |     5 |
| `no-default-type`   | info     | not a bottler, `defaultTypeName` null                                                                             |   166 |
| `brand-no-parent`   | info     | `kind = brand`, no `parentId`                                                                                     |    88 |
| `peat-unknown`      | info     | not a bottler, `peatProfile = unknown`                                                                            |   174 |

Membership: `unverified`, or `auto` with an error/warn reason. `verified`
producers are not queued on completeness alone; info-only rows are reachable
by filter. `PATCH /producer/:id` with `status: verified` is the producer's
commit and already applies the knowledge base inline.

### 3.4 Every action states its reach before it runs

Many fixes on this screen change more than the open bottling: an alias
reaches every bottling that carries the spelling, a producer's kind or
default type flows into every bottling resolved to it, a bulk action touches
its whole selection, a merge moves offers. The owner's rule: **before
committing, the person sees how many other bottlings the action touches,
which ones, and what happens to each — with a link to every one of them.**

The mechanism already exists. `ProducerReachService` builds a hypothetical
alias index and re-resolves the whole catalogue in about 130 ms to rank the
withheld producers; the same what-if pass, fed the action the person is about
to take, is the preview. `POST /product/review/preview` takes the same body as
`commit`, applies the change to an in-memory copy of the index, runs
`KbReconcileService.run({ dryRun: true })` and diffs the plan against the
stored rows. It answers:

- `affected[]` — every bottling whose producer, type or country the action
  would change: `{ productId, name, volumeMl, age, stores[], inQueue,
  reviewStatus, changes: { producer?: {from, to}, type?: {from, to},
  country?: {from, to} } }`, grouped in the UI as **вийдуть з черги**,
  **змінять факти** and **змінять виробника з X на Y** — the last group is
  the false-positive warning and is drawn in red;
- for an alias action, the same counts for **each match scope** the alias
  could have (`brand`, `lead`, `any`), so the person picks the narrowest
  scope that fixes the queue without stealing other producers' bottlings.

The two numbers the UI shows per option are defined exactly, because the
owner asked what "changes producer" means for a bottling that had none:
**«вийдуть з черги»** counts bottlings that currently resolve to no producer
(or carry another reason the action clears) and would leave the queue — the
open bottling included, so «Лише ця пляшка» reads `1`; **«перейдуть від
іншого виробника»** counts bottlings that today resolve to a _different_
producer and would be re-pointed — the danger number, `0` in every option
for `hyde`, `16` for `blue` anywhere in the name. A bottling gaining its
first producer belongs to the first column only, never to the second.

The counts are real. Measured on the dump for the alias `hyde`: at the start
of a name it frees 11 bottlings and steals none; anywhere in the name, the
same 11 and still none (21 already resolve to Hyde). For `blue` the two
scopes diverge — 2 stolen at the start of a name, 16 anywhere (every
`Johnnie Walker Blue Label`) — which is exactly why the scope is decided per
alias by a person looking at these numbers and never by a global rule.

After the commit the toast repeats the reach («ще 10 пляшок вийшли з
черги · Показати 10») and the affected rows leave the queue in the same
refetch. A verdict on a single bottling with no side effects shows no impact
line at all.

**Why the short-alias class needs this and not a resolver change.** 163 of
the 1 035 live aliases are brand-scoped and 31 are shorter than five
characters; none of them can ever match a name today, by design — `tbwc`,
`artist`, `the singleton`, `spey`, `blue` would otherwise take bottlings that
belong to distilleries. So a four-letter producer that appears tomorrow hits
the same wall, and the honest answer is not to lower the wall but to give
the person a per-alias switch with the numbers in front of them. Two generic
changes make that switch rarely needed: the `vina-mira` adapter hands over
its `ТМ <brand>` token as the stated brand (whole-string brand matching has
no floor and no scope problem — that alone resolves every Hyde row from that
shop), and `producer_alias.scope` gains a third value, **`lead`**: the alias
matches only at the start of a name, exempt from the five-character floor,
safer than `any` for short words and enough for the brand-first way shops
write names. The manual pin (`producerSource = manual`) stays for the case
it fits — one bottling that genuinely belongs to a producer no spelling
would reach — and is no longer the answer to the short-alias class.

---

## 4. Flows, on the real rows

Each flow ends in one commit and names the controls it needs.

| Row (real)                                   | Reasons                                         | What the person sees                                                                                                         | What they do                                                                                                                                         | Controls                                                                     |
| -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Hamiltons Islay` (vina-mira)                | new, no-producer, type-vs-name, country-vs-name | raw name with `Single Malt`, `Англія`, `ТМ Hamiltons` highlighted; suggestion: producer `Hamiltons` exists, alias brand-only | click "Розширити аліас на назву" (→ `scope any`), click `→ single malt`, `→ Шотландія`, save                                                         | evidence card, per-issue fix buttons, producer combobox with link mode radio |
| `Export Bourbon Cask` (vina-mira)            | new, no-producer                                | `ТМ Cotswold`; no producer matches                                                                                           | open "Створити нового виробника": name Cotswolds, distillery, England, default single malt, aliases `cotswold`, `cotswolds`; create → selected; save | inline producer form (reuses `ProducerFields`), alias tag input              |
| `Джек Деніелс` 0,7 л (vina-mira)             | new, cyrillic-name, no-producer, missing-abv    | suggestion: duplicate candidate `Jack Daniel's Old No.7 · 0,7 л` (12 shops)                                                  | "Обʼєднати з …" → pick candidate; the offer moves, the shell is deleted                                                                              | merge picker (product search), one-click candidate                           |
| `Ханки Баністер` ×4 spellings (vina-mira)    | new, cyrillic-name, no-producer                 | producer suggestion `Hankey Bannister` (verified); no twin for 2 л                                                           | rename to `Hankey Bannister` (merge where a twin exists), producer resolves by name, save; or select all 4 → bulk producer                           | rename field, bulk bar                                                       |
| `Malt B` (vina-mira)                         | new, duplicate, type-vs-name                    | duplicate `Malt B · 0,7 л · MauDau`                                                                                          | merge into the MauDau row                                                                                                                            | merge                                                                        |
| `Canadian Club Original` 5 y 1 л             | new, missing-abv                                | siblings of the same name: 40 % in 7 shops                                                                                   | click the suggested 40, save                                                                                                                         | suggestion chip on the ABV field                                             |
| `Jim Beam Rye`, `WILD TURKEY RYE`            | new, type-vs-name, missing-abv                  | type from KB default; raw says Rye; store page link                                                                          | `→ rye`, open the store page for ABV, type 40, save                                                                                                  | store link, numeric field                                                    |
| `Kolonat's Choice` 30 %                      | new, abv-range, missing-country, no-producer    | raw name `Whisky-Likor`                                                                                                      | **Відхилити · не віскі**                                                                                                                             | reject button                                                                |
| `Grants` (fozzy, today)                      | new, age-single-store                           | URL slug `grant-s-triple-wood`; age 3 from the spec page                                                                     | rename `Grant's Triple Wood`, clear age → identity merge with the NAS row if present, save                                                           | URL hint in evidence, clear-age control                                      |
| `S.EDWARDS` ×6, `Penderyn` ×7, `Wolfburn` ×4 | new                                             | nothing wrong                                                                                                                | select the group → "Підтвердити 6"; or `V` per row                                                                                                   | bulk bar, row-level ✓                                                        |
| `Yakusun Classic` (3 shops)                  | producer-rejected                               | "resolves to Yakusun — rejected, not whisky"                                                                                 | Reject the bottling                                                                                                                                  | reject                                                                       |
| `Balvenie Portwood` 21                       | conflict (stored 42 % from a name)              | four shops say 40                                                                                                            | accept 40 (→ `manual`), save                                                                                                                         | per-claim accept button                                                      |
| `Bulleit 95 Rye`, `Templeton Rye`            | type-vs-name / conflict                         |                                                                                                                              | `→ rye` / confirm `rye` (→ manual)                                                                                                                   |                                                                              |
| 11 × `Hyde …` (vina-mira, rozetka)           | new, no-producer                                | producer `Hyde` exists, alias `hyde` is 4 letters and brand-only; the impact preview shows `lead` scope frees 11, steals 0   | pick «Аліас «hyde» → на початку назви · 11 пляшок», check the list of the other 10, save — all eleven leave the queue                                | alias scope picker with per-scope counts, impact list with links (§3.4)      |
| `Mac-Talla …` ×6                             | (hint) producer kind                            | producers tab: `mac-talla` kind-suspect, 6/6 single malt                                                                     | `→ brand`, save the producer                                                                                                                         | producer kind segmented control                                              |

Keyboard, because the person clears dozens of rows in a sitting: `↑`/`↓`
(or `J`/`K`) move, `Enter` opens, `V` verifies a row that has only `new`, `R`
rejects, `M` merges, `S` defers, `⌘⏎` saves and advances, `Esc` closes, `?`
shows the sheet.

---

## 5. API changes

### 5.1 Reads

- **`GET /product/review/queue`** (rebuilt) —
  `?issue=a,b&store=&name=&status=open|verified|rejected&sort=severity|newest|reach&page&perPage`.
  Returns `{ data: ReviewQueueRow[], total, limit, offset }`. A row carries the
  bottling's facts with their sources, `producer`/`bottler` as
  `{ id, slug, name, kind, status } | null`, `producerSource`, `brandOrig`,
  `matchKey`, `flavors`, `offers[]` (`id, storeSlug, storeName, storeColor,
  nameOrig, url, inStock, price`), `conflicts[]` (`storeSlug, attribute,
  claimed, stored, seenCount`), `issues[]`, `reviewStatus`, `reviewedAt`,
  `createdAt`. Default `status=open`, default sort severity then newest.
  Stocked bottlings only unless `includeUnstocked=true`.
- **`GET /product/review/summary`** (rebuilt) — `{ open, verifiedToday,
  rejected, conflictOnly, byIssue: Record<code, number>, producers: { open,
  byIssue } }`. Drives the filter chips and the tab counts.
- **`GET /product/review/:id/suggestions`** (new, lazy on open) —
  `producers[]` (`{ producer, via: 'brandOrig'|'tm-token'|'name-word'|
  'unreachable-alias'|'similar', spelling, score }`), `duplicates[]`
  (`{ productId, name, volumeMl, age, storeCount, via: 'identity'|
  'near-identity'|'transliteration' }`), `siblings` (`abv/type/country`
  value distributions over bottlings of the same folded name), `storeHints`
  (URL slug tokens). The `ТМ|TM <brand>` extraction is one utility
  (`BrandHintUtils`, `~utils`), also worth wiring into the `vina-mira`
  adapter so the token reaches `brandOrig` at scrape time.
- **`GET /producer/review`** (new) — the producers queue with `issues[]`,
  `?issue=&status=&kind=&name=&page`. Rows are `ProducerReviewRow` plus
  `issues`, `aliasCount`, `unresolvedMentions`.
- **`POST /product/review/preview`** (new, §3.4) — the body of `commit`
  without `verdict`; runs the what-if pass and answers `{ affected[],
  aliasScopes?: { brand: {frees, steals}, lead: {…}, any: {…} } }`. Read-only,
  writes nothing, bumps nothing. The same shape is accepted by
  `PATCH /producer/:id` and the alias routes as `?preview=true`, so the
  producers tab can show the reach of a kind or scope change before it runs.

### 5.2 Writes

- **`POST /product/review/commit`** (new; replaces the facts-tab "confirm",
  the conflicts "resolve" and the queue's verify for a single row) —
  ```
  { productId, verdict: 'verified'|'rejected',
    patch?: { name?, typeName?, countryCode?, abv?, volumeMl?, age?, flavors? },
    confirm?: ('type'|'country'|'abv'|'volume'|'age')[],   // stamp manual without changing
    producer?: { mode: 'pin', producerId|null, bottlerId|null }
             | { mode: 'alias', producerId, spelling, scope?: 'brand'|'lead'|'any' }
             | { mode: 'widen-alias', aliasId, scope: 'lead'|'any' }
  }
  ```
  One transaction: patch (each field → `manual`), confirm (→ `manual`),
  producer (pin writes `producerId/bottlerId` with `producerSource = manual`
  — **the new write path**; alias/widen write `producer_alias` and run
  `KbReconcileService` after commit), flavors (→ `flavorsCuratedAt`),
  resolve every open conflict of the bottling, `mergeTwins`, stamp the
  verdict on the survivor, cache bump. Answers
  `{ productId, merged, created, issuesLeft, affected[] }` — `affected` is
  the same list the preview showed, so the toast can repeat the reach.
- **`POST /product/review/merge`** `{ sourceId, targetId }` (new) —
  `mergeInto` with an explicit survivor, for a duplicate with many offers
  where `relink` (one offer) is the wrong tool. Answers the survivor row.
- **`POST /product/review/bulk`** `{ productIds, patch: { typeName? |
  countryCode? | producer?: { mode: 'pin', producerId } } }` (new) — the
  `S.EDWARDS`/`Hyde` cases; every write `manual`; ≤ 200 ids.
- **`POST /product/review/status`** (kept) — bulk `verified`/`rejected`/
  `pending`; `verified` now also resolves open conflicts.
- **`POST /product/review/apply`** (kept) — the toolbar's "База знань".
- **`PATCH /producer/:id/alias/:aliasId`** `{ scope }` (new) — the one-click
  "widen to name" on the producers tab; runs the KB pass like its siblings.
- **`POST /producer`, `PATCH /producer/:id`, `POST /producer/:id/alias`**
  (kept) — the inline producer form posts here; `ProducerCreateDto.aliases`
  should report skipped collisions instead of dropping them silently.

### 5.3 Removed

`GET /product/review/producers`, `GET /product/review/facts`,
`GET /product/review/conflicts`, `POST /product/review/conflicts/resolve`.
Their questions are answered by `issues[]`, `conflicts[]` and `commit`.

### 5.4 Persistence changes

- `producerSource = manual` write path (pin). `SET_PRODUCERS_SQL` already
  skips it; `KbApplyService` needs no change.
- Conflict acknowledgement: `logFactConflicts`' upsert drops the
  `"resolvedAt" = NULL` reset (a re-sighting bumps `seenCount`/`lastSeenAt`
  only), and a one-off data migration stamps every row open at release
  `resolvedAt = now()` with a note naming this decision. `down()` is a
  documented no-op.
- No re-open write anywhere: `reviewStatus` leaves `verified` only through
  `applyReviewStatus` called by a person.
- `producer_alias.scope` gains `lead` (`ProducerAliasScope`): `matchInName`
  tests it against the start of the normalized name only and skips the
  five-character floor for it; `brand` and `any` are unchanged. A
  `varchar(16)` with no CHECK, so no migration. `KbAliasUtils`, the
  what-if pass and `pnpm kb-export` learn the value in the same change.
- The `vina-mira` adapter reads the `(Країна, ТМ <brand>)` token into
  `snap.brand`, so it reaches `brandOrig` and whole-string brand matching;
  `BrandHintUtils` (§5.1) is the one place the regex lives.
- `REVIEW_ISSUES_SQL` — a CTE over `product` joined to `type`, `producer`,
  a raw-name aggregate and an `EXISTS` over conflicts; the name-derived type
  is a `CASE` on regexes shared with `NormalizeService` through one constant
  table so the two cannot drift (the age-reader/name-stripper lesson).
- `logFactConflicts` unchanged: it already skips `manual`-sourced attributes.

---

## 6. UI design

Desktop only. Route stays `/product/review`, gated by `product:review`;
producer writes need `producer:create`/`producer:update` and hide their
controls otherwise. On a phone viewport the route renders a one-line "desktop
only" notice and stays absent from the mobile navigation, as `/producers` is.

### 6.1 Frame

Full-height like the catalogue (`handle: FULL_HEIGHT`), TanStack Table with
sticky header, the catalogue's `Table`/`Chip`/`Button`/`Tooltip` kit and its
column conventions: a leading **№** column (`offset + index + 1`, muted),
country as `CountryFlag` (the flag alone, the name on hover), type as
`TypeBadge` (`SM`/`BL`/`BRB`/`R`…), the `Pagination` nav centred under the
table («Назад · 1 2 3 … 13 · Далі») with «Знайдено N» and the per-page
select at the toolbar's right edge. Rows are 46 px and carry the canonical
name plus the raw store name beneath (the owner's choice; ~11–12 rows at
1366 × 768, ~14–15 at 1440 × 900).

Header: `Пляшки [289] · Виробники [≈40] · Рішення` tabs, then the
summary (`лише розбіжності 340 · сьогодні +4 · база знань застосована 09:25`).
The top row holds the tabs on the left and, on the right, the counters
(«сьогодні +4 · база знань застосована 09:25»), the «↻ База знань» button and,
on the producers tab, «+ Виробник». The toolbar beneath is **search and
filters only**: search (name, raw name, URL), store select, sort select
(severity by default), and **one «Проблеми» dropdown** in place of a row of
chips — the reasons grouped by severity (Критичні / Помилки / Сумнівне /
Інформація), each a checkbox with its live count, plus a «Показати також»
group holding «переглянуті розбіжності», and an «усі проблеми» tri-state
checkbox at the top that selects every reason or, when all are selected,
clears them. The button label carries the active count («Проблеми: 2»). At the right edge, «Знайдено N» and the per-page
select, as on the catalogue. A bulk bar appears when rows are checked; its
reject action reads «Не віскі», as every reject control on the screen does.
Fact columns are sized so nothing overlaps (ABV 72 px, volume 78, age 58,
type 56, country 60, shops 110, added 72); the value's source is a tooltip on
the number, with `manual` tinted primary and `llm`/`legacy` dotted-underlined,
not a badge beside it. A producer's name in the table is a link that opens
the producer modal (§6.5).

### 6.2 Table treatments — T1 chosen

- **T1 · a "Проблеми" column.** Severity-coloured chips (critical → info),
  three visible plus `+N`; fact cells stay clean, a missing value is a red
  `—`. Fast to scan; the name column is narrower.
- **T2 · the problem lives in the cell.** No chips column: a 3 px severity
  stripe at the row's edge, a count badge beside the name, and each affected
  cell carries the reason under its value (dashed red frame = missing,
  dotted amber underline = suspicious, `≠ 40 · Rozetka ×21` under a contested
  ABV). More room for names and raw names; the problem is where the fix is.

Recommendation: **T1** for the queue (a row's reasons read in one glance,
and the chips are the same objects the filter uses) with T2's cell marks kept
as a secondary cue in both. The mockup shows both.

### 6.3 Editor placement — E1 chosen

- **E1 · side panel (recommended).** 540 px panel beside the table; the
  table collapses to name / problems / producer / shops. `↑`/`↓` swap the
  bottling with the panel open, `⌘⏎` saves and advances. Nielsen Norman
  Group's argument against modals for row editing (they hide the neighbours
  the reviewer compares against) and Retool's/Airtable's row-select-to-panel
  pattern both point here.
- **E2 · expanded row.** The editor opens full-width under the row in three
  columns (evidence · why · card) — the pattern the catalogue already uses
  for offers. Context stays, but the expanded row moves with the selection.
- **E3 · modal.** The current product-card dialog rebuilt with evidence and
  `↑`/`↓`; consistent with the catalogue's edit, hides the table.

### 6.4 Editor anatomy (all three placements share it)

1. **Head** — name, spec, `matchKey` in monospace, the row's chips,
   prev/next/close.
2. **Докази** — one card per offer: shop monogram, the raw name with the
   telling tokens highlighted (type words, country, `ТМ …`), "Відкрити в
   магазині ↗", SKU, price, first seen, whether a brand was stated. For a
   multi-offer bottling each card has "цю пропозицію → інша пляшка"
   (`relink`).
3. **Чому в черзі** — a two-column grid: the reason chip on the left, its
   fix buttons on the right, aligned row by row. **The explanation is the
   chip's tooltip** (`Збережено blend (магазин). У сирій назві — «Single
   Malt».`), shown on hover and focus — the same tooltip the chip carries in
   the table and in the panel header, so the sentence exists once. The
   suggested fix is an outline button with a primary-tinted border, the
   alternatives plain outline; nothing here is filled amber. A type fix shows
   the `TypeBadge` alone («→ SM»). **The producer row offers exactly one
   thing: the candidate** («🇮🇪 Hyde · distillery → обрати», or
   «+ Створити виробника «Cotswold»» when nothing matches); choosing it
   fills the producer field below. How the link is made, and whom it
   reaches, is decided in one place only — the binding block in the card.
4. **Картка пляшки** — the form. Name (Latin check); **producer** as a
   searchable combobox over name/slug/alias, and directly beneath it the
   **«Привʼязка пляшки» sub-section** — a titled block with the same
   uppercase header style as «Докази» and «Картка пляшки», kept inside the
   card because it changes with the producer chosen above it. It is full
   width so no option clips: one radio per way of linking — alias at the
   start of the name, alias anywhere in the name, this bottling only — each
   stating the same two numbers in two aligned columns («спосіб» ·
   «вийдуть з черги» · «перейдуть від іншого виробника», §3.4), followed by
   the list of the other bottlings the chosen option frees, each with a shop
   monogram, its status and a link that opens it in the panel. When the
   candidate does not exist, the combobox's empty state offers «Створити
   виробника «X»» and the field turns into an inline **new-producer
   sub-form** (the shared `ProducerFields`, aliases pre-filled from the
   `ТМ` token or `brandOrig`) with its own binding block; there is no
   standalone "create" accordion when a producer is already chosen. Bottler
   combobox; type as a badge-only picker, country as a flag-and-name picker
   (both closed searchable comboboxes replacing the native selects); ABV /
   volume / age with source badges and suggestion chips; flavours as the
   existing chip picker, unlabelled and left-aligned. Changed fields are
   highlighted and the header counts them.
5. **Actions** — one row, left to right: `Не віскі` · `Пропустити`, a gap,
   `Обʼєднати з…` · `Підтвердити` (the only filled button; it saves and
   verifies). The `?` icon sits in the **head's right column, directly under
   the `✕`** (the nav column is a 3-wide grid: `↑ ↓ ✕` on the first row, `?`
   on the second, right-aligned), and holds the guarantee ("the bottling
   leaves the queue and does not return on its own") and the keyboard
   sheet; the shortcuts are not printed inside the buttons. `✕` and `Esc`
   close the panel — covered by a test, since the owner asked for it
   explicitly.

   **Help rule, screen-wide:** a `?` opens a **popover on click** (Radix
   Popover, not Tooltip): it stays open when the pointer leaves it, closes
   on a click anywhere outside it or on `Esc`, and scrolls internally when
   its content is taller than ~240 px, with the text formatted one point per
   line. Hover tooltips are reserved for one-liners — a reason chip, a fact's
   source, a country flag.

   **Focus rule, app-wide (owner's standing complaint):** a focus border or
   ring must disappear the moment the user has made a pointer selection in
   any picker — dropdown, select, combobox, segmented control, popover
   trigger. The catalogue's currency switcher, which stays outlined in amber
   after a pick, is the canonical defect; the fix lands in the shared
   primitives (W0 in the plan) so it covers the catalogue too. Keyboard users
   keep the ring.

   **Button rule, screen-wide:** anything with a text label is a visible
   button — `outline` by default, `danger`-tinted when destructive («Не
   віскі», «Видалити · −21»), amber only for the one main action. The
   `ghost` variant is reserved for icon-only controls (`↑ ↓ ✕ ↗ ✓`). A
   "Скасувати" or "Скинути" rendered as plain text is a defect.

Field control rules: closed vocabularies (`kind`, country, type, region,
peat, alias scope) are searchable pickers; semi-open text (`owner`, aliases)
suggests from existing values and accepts free text (`OwnerInput` already
does this); producer/bottler/merge target are server-search comboboxes with a
creatable last item. The shared `Combobox` gains the creatable footer once;
nothing else in the kit needs to change.

Feedback: mutations invalidate and refetch (no optimistic removal — the
queue is server-ordered); a toast confirms the commit and offers "Повернути в
чергу" as the cheap undo. A full field-level undo is not promised: merges are
not reversible.

### 6.5 Producers tab

Same frame and the same toolbar treatment as the queue: search, kind and
status selects, one grouped «Проблеми» dropdown with counts, «Знайдено N»
and the per-page select at the right; «+ Виробник» sits in the top row beside
«↻ База знань». Columns: №, name + slug + the reason sentence, chips, kind,
country flag, region, default type as a badge, peat, bottlings, aliases,
status.

**The producer modal.** A producer is edited in a modal, reached from three
places: a row on this tab, the producer's name in the queue table, and the
producer chip in the panel. **The mockup's modal is the target layout, and
the project's `ProducerFields` is redrawn to match it** (the owner's
decision of 2026-09-18, after the app's freehand-mirrored version was
rejected): a two-column form — left Назва, Країна, Материнська, Власник,
Торф; right Вид, Регіон, Ботлер, Тип за замовч., Статус — with `kind`,
`peatProfile` and `status` as equal-width segmented controls, then full-width
rows for Аліаси (each alias with its scope, «→ на початку назви · N пляшок»
and «Видалити · −N»), Правила торфу і смаків (own rules and «+ правило»,
the global rules behind the `?` popover), Джерела and Нотатка, and a footer
«Не виробник віскі» ·· reach sentence · «Зберегти». Because `ProducerFields`
is shared, `/producers/:id` and the create dialog take the same layout; a
second layout for the same fields is exactly the drift the shared component
exists to prevent. The content the review work adds: **owner with
autocomplete over existing owners and free text allowed**, the alias list with each alias's scope and a one-click widen button
carrying its reach («→ на початку назви · 11 пляшок»), the counts
(bottlings, aliases, children), **the rules panel** (the existing
`ProducerRulesPanel`, trimmed: only the producer's own name-pattern rules —
pattern, match mode, priority, and the peat level or tag effect each sets —
plus «+ правило», which opens the add form inline. The 27 global peat and
tag rules and the mechanics ("higher priority wins; a producer's rule beats
its «Торф» field") are **not** listed on the card: they sit behind a `?`
at the right edge of the rules header row, shown only while the producer
has a rule or one is being added, and the tooltip is **formatted** — one
rule per line, priority first: `100 · non peated, unpeated, неторф* → none`,
`60 · heavily peated → heavy`, `50 · peated, peat, peaty, торф* → heavy`,
`40 · smoky … → тег smoky`. The add form's right edge (the effect picker)
lines up with the right edge of the «Додати» button beneath it.
The house style — the 13 non-peat tags as baseline/require/forbid; peat
never appears there — lives in the same `?`), and a footer «Не виробник
віскі» ·· «Зберегти» with the reach of the save stated beside it
(«перерахунок 21 пляшки»). Saving runs the KB pass inline, as `PATCH
/producer/:id` already does. Every destructive control names its reach:
the alias row's delete reads «Видалити · −21» with a tooltip saying that 21
bottlings would lose the producer and return to the queue; adding a rule
reads «Додати · перерахунок 21 пляшки». Segmented controls (kind, peat,
status) are built with equal-width parts.

### 6.6 Рішення tab

The verified/rejected log, newest first, searchable; each row has
"Повернути в чергу". It exists so that a rejection made by mistake is one
click from reversal, and so the person can see what last night's syncs
re-opened.

---

## 7. Best-practice grounding (what the research supports)

- Reasons as discrete severity chips, worst first, and severity doubling as
  the filter — the DQOps warning/error/fatal escalation, Dependabot's
  severity ordering, Baymard's "every visible attribute is a filter".
- A concrete reason next to every chip, never a bare glyph — Stripe Radar's
  risk insights, Google Merchant Center's named policy per disapproval.
- Side panel over modal for row editing — Nielsen Norman Group ("Data
  Tables: Four Major User Tasks"), Retool's row-select-to-drawer, Airtable's
  record-review layout.
- One-click resolve per reason and a "nothing wrong — confirm" fast path —
  OpenRefine's per-cell match/new/none, Wikidata Mix'n'match's Set Q / New
  item / N/A, Open Food Facts' one-decision-per-screen moderation.
- Ranked candidates with a visible "why", and "create new" one click away —
  OpenRefine reconciliation scores, Senzing's match explanations, shadcn's
  combobox-with-create-in-empty-state, Notion's inline tag creation.
- Closed pickers vs. suggest-and-accept text as two components, not one flag —
  Ant Design's `Select` vs `AutoComplete`.
- Keyboard-first triage — Linear and Superhuman (J/K, one-letter verdicts,
  `?` sheet).
- Rejection as a durable, reversible status shown beside its undo path —
  Wikidata N/A, Discogs' graded review.
- Defer instead of forcing a verdict — Sentry's "ignore until".
- Consistent verb-labelled actions across every sub-queue — the Discourse
  review-queue failure where "Yes" meant opposite things on two tabs.

---

## 8. Decisions

Decided by the owner on 2026-09-17:

1. **Table**: T1, the chips column. **Editor**: E1, the side panel.
   **Rows**: two lines, name plus raw store name.
2. **Re-open rule**: never automatically; only "Повернути в чергу" by hand.
3. **Conflicts**: every conflict queues its bottling, sorted by severity —
   except the 790 open at release, which the owner has already worked
   through: they are acknowledged, hidden, and reachable through the
   «переглянуті розбіжності» checkbox.
4. **Defer verdict**: dropped (asked what it adds over ignoring a row; the
   answer is a marker only).
5. **Producer-rejected bottlings**: handled through the UI — the `Не віскі?`
   filter chip, select all, «Не віскі» in the bulk bar. No one-off script.
6. **Legacy `null` rows with no detected problem** stay out of the queue.

Comments on the v1 mockup, all applied in v2: the app's `TypeBadge` chips
for whisky types; `CountryFlag` for the country column; a leading `№`
column; the catalogue's `Pagination` under the table; «Не віскі» instead of
«Відхилити»; reason explanations as tooltips on the chips; fix buttons and
action buttons aligned in one grid / one row; the commit guarantee moved
into a `?` tooltip; amber fill reserved for the single main action.

Comments on the v3 mockup, all applied in v4: «↻ База знань» moved to the
top row, the toolbar left to search and filters; the reason chips replaced
by one grouped «Проблеми» dropdown that also holds «переглянуті
розбіжності»; the alias decision collapsed into a single binding block with
one phrasing for every option («11 пляшок» / «0»), the duplicate «Лише ця
пляшка» / «Інший…» buttons and the stray «Створити виробника» accordion
removed; the new-producer sub-form shown only when nothing matches; footer
order «Не віскі · Пропустити ·· Обʼєднати з… · Підтвердити»; type pickers
show the badge alone; the flavour block lost its label; fact columns widened
and the source moved into a tooltip; a producer's name opens the producer
modal; the producers tab got the same toolbar and the «+ Виробник» button.

Comments on the v4 mockup, applied in v5 and in this plan: segmented
controls with equal-width parts; an «усі проблеми» tri-state checkbox in the
dropdown; the binding block's second column renamed and defined (§3.4); the
`?` help moved to the panel head; `✕`/`Esc` closing covered by a test. The
owner also asked where the peat keyword rules and their weights live: in the
producer modal's rules panel (§6.5), which the earlier mockup had left out.

**Base.** This design builds on the producers CRUD that landed just before
the session (commit `ec62cba`: `GET /producer` listing, `POST /producer`,
`GET`/`PATCH /producer/:id`, the alias routes, the `/producers` pages and
the shared `ProducerFields` / `ProducerPicker` / `OwnerInput` /
`ProducerRulesPanel` components). Everything producer-side here reuses it;
what the redesign adds on top is the `lead` alias scope, `PATCH
/producer/:id/alias/:aliasId`, `GET /producer/review`, the preview, and the
modal as a third entry point. The `/producers` listing page itself is not
touched.

7. **Short and brand-only aliases** (the owner asked whether a future
   four-letter producer hits the same wall — it does, by design, see §3.4):
   solved generically by the `lead` alias scope chosen per alias from the
   impact preview, and by `vina-mira` handing over its `ТМ` token as the
   brand. The manual pin (`producerSource = manual`) stays only for one-off
   bottlings no spelling would reach.
8. **Reach before commit**: every action that touches other bottlings shows
   how many, which ones and what changes, with a link to each (§3.4). The
   toast repeats the list after the commit.

Nothing is open. Implementation starts on the owner's go.

---

## 9. Implementation plan

The work order — checkpoints, files, acceptance and the kickoff prompt for a
fresh session — lives in [`REVIEW-REDESIGN-PLAN.md`](REVIEW-REDESIGN-PLAN.md).
This document stays the specification; the plan carries the Status column.
