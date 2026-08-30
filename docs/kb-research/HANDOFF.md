# Whisky knowledge base — handoff #4

Give this file to a fresh session. It supersedes handoff #3, whose opening —
nine questions from using `/product/review` — is answered and acted on.

**Read in this order:**

1. This file, completely.
2. `be/docs/kb-research/PROGRESS.md` — the append-only checkpoint log. The last
   entries are the most current record of what is in the tree, and they
   outrank this file wherever the two disagree.
3. `be/CLAUDE.md` and `web/CLAUDE.md` — project conventions. The knowledge
   base, the filters it changed, the review screen and the scripts are all
   documented there.
4. `~/.claude/plans/sprightly-nibbling-squirrel.md` — the approved plan, for
   the reasoning behind a decision you are tempted to reopen.

Skills that apply and are not optional: `code-style`, `nestjs-code-style`,
`typeorm-migration-format`, `english-only-docs`, `llm-prompt-language`,
`git-flow`. The repo also carries `web/.claude/skills/local-browser-testing`,
which grants standing authorisation to run the local stack and to create
throwaway `qa-` accounts — use it, and verify screens in a real browser rather
than reasoning about them.

---

## Where the work stands

Phases P1–P6 of the plan are complete except three items named at the end. The
knowledge base is seeded, applied to the catalogue, wired into every sync,
surfaced in the report, and **its review screen is a working tool**: a
reviewer can rank the queue by what matters, edit a producer, rule one out, see
what overrides a peat band, and have every decision reach the catalogue in the
same click.

**Nothing is committed.** ~126 changed files in `be/`, ~20 in `web/`, all on the
default branch, across three sessions. `git-flow` requires the owner's explicit
per-request authorisation for a commit or a push — do not commit unasked.

**Everything is green.** `be/`: 772 unit tests (60 suites), 141 integration
(15 suites), `tsc`, `lint`, no schema drift (`pnpm migration:generate x --
--dryrun` finds nothing). `web/`: 512 tests (68 files), `tsc`, `lint`.
`dprint check` reports 19 files in `be/` and 1 in `web/`, every one of them
already unformatted at `HEAD` before this work began.

**The acceptance criterion passes as an automated test.**
`test/integration/kb-report.integration.spec.ts` gives ten real whiskies a
wrong `llm` `peated` tag, runs the sync's own apply pass, and asserts that
`GET /report?excludeFlavors=peated` returns Tobermory and excludes Ledaig,
Ardbeg, Laphroaig, Lagavulin, Caol Ila, Port Charlotte, Smokehead and Big Peat.

### Numbers — a moving snapshot, 2026-08-29 08:28

**The owner is actively working the queue, so these move.** Re-measure rather
than trusting them:

```sql
SELECT status, count(*) FROM producer GROUP BY status;
SELECT count(*) FROM product WHERE "producerId" IS NOT NULL;
```

|                                                                  |                      |
| ---------------------------------------------------------------- | -------------------- |
| producers / aliases / house styles / rules                       | 796 / 1046 / 45 / 92 |
| producer status: `auto` / `unverified` / `verified` / `rejected` | 329 / 454 / 9 / 4    |
| bottlings with a resolved producer                               | 2609 of 4057 (64%)   |
| untrusted facts (either fact)                                    | 1302                 |
| of those: no resolved producer / resolved                        | 1173 / 129           |
| in-stock offers a type filter can answer from                    | 5626 of 7199 (78%)   |
| in-stock offers a country filter can answer from                 | 5508 of 7199 (77%)   |
| peat-tag conflicts among identically-named bottlings             | **108 → 0**          |
| `age` / `volumeMl` group conflicts (identity — must not move)    | 164 / 254, unchanged |

Coverage rose from 72% / 69% during this session purely by promoting producers
and applying — no scraping involved.

---

## What the review screen does, and why each piece is shaped that way

All nine of the owner's questions were answered before any code was written;
the answers and the measurements are in PROGRESS.md under "Session 3 opens".
Six were real defects. Two more were found by measuring rather than reported.

- **The withheld queue is ranked by potential reach.** `productCount` is
  structurally zero for every withheld producer — the resolver's index only
  loads `verified`/`auto` — so ranking by it ranked alphabetically and the
  queue opened with `15-stars`, `36-south`, `aberdour`.
  `ProducerReachService` answers "how many bottlings would resolve to this row
  if the whole withheld queue went live": one resolve pass with every withheld
  alias in the index, ~300 ms, **nothing stored**. Three implementations were
  measured before choosing (PROGRESS.md has the table); the pure-SQL one is
  wrong for a sixth of the queue because it cannot see a producer named inside
  a product name.
- **Confirming a producer applies itself.** `PATCH /producer/:id` runs the
  catalogue pass inline and answers `{producer, applied}`. Deferring it was the
  original design and it was wrong: a stored decision changes nothing a filter
  reads, so promoting two producers left every count untouched. Nothing
  justified the delay — the pass is ~200 ms over 4057 bottlings, idempotent,
  and never touches a `manual` value.
- **The pass exists once**, in `KbReconcileService`, shared by
  `pnpm reconcile-flavors`, `POST /product/review/apply` (the manual re-run,
  for changes arriving from outside the screen) and the inline apply above.
- **A producer can be edited**, and the form sends a **diff**, never the whole
  thing — the API distinguishes an absent field from a deliberately emptied one
  (four `clear*` flags), and posting everything would wipe values the reviewer
  never looked at.
- **The modal shows what overrides a peat band** — child rows, the producer's
  own rules, and the global peat rules — via `GET /producer/:id`. Without them,
  "what do I pick for Bruichladdich?" is unanswerable.
- **`KbStatus.rejected`** rules a row out as not whisky, reversibly. No
  migration: `status` is `varchar(16)` with no CHECK, and the resolver's
  whitelist makes a rejected row inert by construction.
- **The facts tab is two jobs and says so.** Measured: of the untrusted rows,
  ~90% resolve to **no producer** — a symptom, cured on the producers tab where
  one confirmation supplies both facts with citations for every bottling that
  producer makes — and the rest have a producer and are the real hand work
  (its range spans several types, so it states no `defaultTypeName`). Three
  segment chips carry the sizes.
- **«Підтвердити» on a fact sends only the distrusted field.** `manual`
  outranks `kb`, so confirming a knowledge-base-supplied value would freeze it
  above the knowledge base and no later correction there could reach the
  bottling.
- **The facts badge counts distinctly** (not `type + country`, which
  double-counts the bottlings carrying both), the country renders as a flag
  with its name, the bottle name links to the bottling's own screen **in a new
  tab** (the queue's paging is component state), and up to five shop monograms
  link to the listings that produced the fact, one per shop.
- **The quick-filter control never hides itself.** It renders inert with a
  tooltip when there is nothing to save or nothing saved — the owner confirmed
  that was the whole of "the quick filters are gone".

---

## What I would do next, in this order

1. **Work the queue.** It is ranked, editable and applies itself; 454 rows are
   waiting and `docs/kb-research/curation/review-dossier.md` §3b lists the
   twelve where withholding is most visibly wrong. **Every confirmation that
   reaches the catalogue can move a row in `test/fixtures/kb-golden.tsv`** —
   that is the fixture working, not a break. Read the diff, confirm the new
   answer is right, update the row. It has happened twice already
   (`benromach`, then `Хайленд Парк` once the promotions were applied).
2. **Decide how runtime decisions travel to production.** Promotions and
   rejections live in one database. The documented path is
   `pnpm kb-export --all` plus a new pair of importer migrations, which is also
   the project's own rule that every data change ships as a migration. Until
   then production knows nothing about any of it.
3. **Decide on the resolver's missing bottler path.** `bottlerOf` documents two
   ways a bottler is found and implements one; `KbProducerFacts.bottlerId` is
   loaded into the index and read **nowhere**, and the plan specified the line
   (`if (!bottler && producer.bottlerId) bottler = producer.bottlerId`). It
   costs a handful of bottlings their IB flag — `Big Peat` among them, the
   example both the plan and the JSDoc name — and grows as withheld rows are
   promoted. It is four lines, but `kb-golden.tsv` has **frozen the defect as
   the expected answer** for `Big Peat Small Batch`, so implementing it flips a
   reviewed row. A decision, not a cleanup. Measurements in PROGRESS.md.
4. **Consider URL-backed paging on the review screen.** `page`, the producer
   status tab and the facts segment are component state, which contradicts this
   app's own convention that the URL owns sort/page/search. It is why the
   bottle-name link opens a new tab rather than navigating in place — a
   workaround, not the fix.
5. **P3.6, the grounded flavour re-pass**, still unrun; see the deploy steps.

---

## Deploy and operational steps — the owner's to run

Nothing here is a code gap; all of it needs a person to decide or to spend
something.

1. **Deploy at all.** Nothing in this work is committed, let alone deployed.
   Several earlier features are also committed-but-not-deployed per the project
   memory. Establish what production is actually running before diagnosing
   anything as missing — that is what made the quick-filter question hard to
   answer.
2. **`pnpm migration:run`** ships five migrations from the seeding session: the
   four seed importers (`1787851000000`..`1787851300000`, each with its `.tsv`
   beside it — `nest-cli.json` already copies `migrations/**/*.tsv` into
   `dist`) and `1787851400000-llm-flavor-restamp`. This session added none.
3. **`pnpm reconcile-flavors --dry-run`** on production first, read the diff,
   then apply — or press «Застосувати до каталогу» on the review screen, which
   is the same pass. It is idempotent: a dry run straight after applying must
   report `producer writes 0, fact changes 0, flavor links +0 / -0`.
4. **`pnpm backfill`** — a live sweep of ~20 shops, several hours. It
   re-stamps `store`-source type and country, and is the other half of the
   filter-coverage story (promotions raised it to 78% / 77% without scraping).
5. **`pnpm enrich-flavors` with `LLM_FLAVOR_MODEL=anthropic/claude-sonnet-5`.**
   Do not run it without that variable set — a run that fell back to
   `LLM_MODEL` returned per-category templates and was rolled back with
   `pnpm restore-flavor-import`. 1117 bottlings are already queued
   (`lastLlmFlavorAt IS NULL`); costing a batch with `--limit` first is what
   that flag is for. Peat was never at risk and still is not.
6. **`GET /docs-json` must be reachable** for the web client codegen
   (`SWAGGER_ENABLED=true`), as before.

**A restart is not optional after backend changes.** The frontend hot-reloads
and the backend does not, so a running compiled `dist` serving a hot-reloaded
SPA is a broken pair — the facts tab sends query params an older DTO rejects
with 400 under `forbidNonWhitelisted`. This cost time twice in one session.

---

## Traps already paid for — do not undo these

- **A bottler is never a producer.** `matchProducer` moves it to the bottler
  slot. Without it, `Allt-a-Bhainne - Old Malt Cask` read its country, type and
  peat off a company that owns no still.
- **A required tag outranks the peat sweep, and `peated` is exempt.**
  `Grant's Triple Wood Smoky` is unpeated but its own name requires `smoky`;
  the sweep dropped the link and the rule restored it, forever. `peated` must
  never be requirable by a rule — it has exactly one source of truth.
- **A `kb`-owned link is never re-written**, or the plan is not idempotent and
  the dry-run check can never come back clean.
- **`setLlmFlavors` will not take over a `kb` link** (`WHERE source <> 'kb'`).
  Without it the model repossesses knowledge-base tags one product at a time,
  silently, because the _tag_ does not change — only its owner.
- **The alias index's status whitelist is a safety gate, not a parameter.**
  `findAliasIndex` hard-codes `verified`/`auto`; the review screen's what-if
  computation reads the withheld aliases through a _separate_ method and
  combines them in one place that writes nothing. Do not merge the two into a
  parameterised read.
- **A merged alias list must be re-sorted longest-key-first.** `matchInName`
  takes the first alias whose key appears in the name, so concatenating two
  sorted lists resolves to the wrong producer — silently.
- **Confirming a fact must send only the distrusted field.** `manual` outranks
  `kb`; stamping a knowledge-base-supplied value `manual` freezes it above the
  knowledge base and no later correction there can reach the bottling.
- **The patch builder must omit a key it cannot narrow, not set it
  `undefined`.** The modal decides whether anything changed by counting the
  patch's keys, so a key holding `undefined` sends an empty request that stamps
  the row reviewed for no edit at all.
- **Wishart is a review trigger, not an authority.** Its `Smoky` is a 0–4
  tasting-panel score; read as bands it calls Macallan and Glenfiddich smoky
  and Bruichladdich _peated_.
- **The uuid cast in conflict queries must be guarded by value shape**, not by
  attribute name — Postgres may evaluate the cast before the predicate meant to
  exclude it, and one ABV row aborts the whole query.
- **Opening a real Radix `Dialog` in jsdom hangs `vitest run`.** That is why
  the producer patch builder is a pure function with its own unit test, and why
  no test mounts the modal.
- **An agent given the live database can change it.** Six producers were
  promoted by a test agent's exploration this session; the golden set caught it
  and they were reverted through the app's own `PATCH` route. Brief a research
  agent as read-only and say so, or point it at a scratch database.

---

## Deliberately not done

- **P3.6 — the grounded flavour re-pass.** Needs a strong model; see the deploy
  steps.
- **P6.3 — the legal type taxonomy** (`blended malt`, `single grain`,
  `blended grain`). Re-labels ~800 products **and rewrites the `types` value
  inside users' saved quick filters**, whose `jsonb` payload the backend
  deliberately never interprets. Reaching into it breaks the one guarantee the
  quick-filter design makes. Needs an explicit decision.
- **P6.4 — deleting `BRAND_INFO` / `BRAND_KEYS` / `INDEPENDENT_BOTTLERS` /
  `detectBrandInfo`.** The plan gates it on the unresolved-producer count being
  low. It is falling as the queue is worked (1706 → ~1448 during this session),
  but for every unresolved bottling `detectBrandInfo` is still the only source
  of a country or type. The gate is right and it is not open yet.
- **The resolver's second bottler path** — see "What I would do next", item 3.
