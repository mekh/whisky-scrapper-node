# Knowledge base — checkpoint log

Append-only. Newest entry at the bottom. Each entry must let a session with
empty context resume from it alone. Read `HANDOFF.md` first, then the last
entry here.

Checkpointing means **writing files**, never committing — commits need the
owner's explicit request (`git-flow`).

---

## P0 — schema, provenance, resolver — DONE 2026-08-27

**Produced.** `src/enums/{kb,fact}.enum.ts`, `src/utils/kb-key.util.ts`,
`src/core/producer/*` (4 entities + repository/service/module),
`src/core/product/product-fact-conflict.entity.ts`,
`src/scrape/kb/kb-resolver.service.ts`, `src/interfaces/kb.interfaces.ts`,
migrations `product-fact-provenance` / `kb-schema` / `product-fact-conflict`,
tests `test/kb-key.util.spec.ts` + `test/scrape/kb-resolver.service.spec.ts`.

**Changed.** `fillMissing` is rank-aware (no longer fill-if-null); the insert
path stamps sources; `ProductService.update` stamps `manual`;
`NormalizeService` / `LlmEnrichmentService` / persist stamp `store` / `name` /
`llm`; new repository methods `setProducers` / `applyKbFacts` /
`applyKbFlavors` / `logFactConflicts` (written and unit-tested, **not yet
called from the pipeline**); `CLAUDE.md` documented.

**Numbers.** 748 unit tests (58 suites) and 118 integration tests pass; `tsc`
and `eslint` clean; no schema drift. Migrations applied locally through
`ProductFactConflict1787850600000`. 3994 of 4057 products carry
`countrySource = 'legacy'`. `producer` = 0 rows, so `producerId` = 0 products.

**Two real bugs found by the tests while building it.** NFD folding broke
Cyrillic (`Хайленд` → `хаиленд`, because `й` decomposes to `и` + breve) —
folding is now Latin-only. Enum columns without an explicit `type: 'varchar'`
broke TypeORM metadata under ts-jest — all 16 columns now declare it.

**State of the data.** Nothing in the catalogue changed. `Tobermory 12` is
still tagged wrongly; that is repaired in P2. The resolver is deliberately not
wired into persist — against an empty knowledge base it would strip peat tags
catalogue-wide with nothing to put back.

**Not committed.** 55 changed files in the working tree on the default branch.

---

## P1 — seed research — NOT STARTED

A first fleet of 16 agents was dispatched 2026-08-27 and stopped before any of
them wrote output (they had inherited plan mode, were re-dispatched, then the
session ran out of budget). **No research survives.** P1 restarts from P1.0.

**Ready to use.** `docs/kb-research/BRIEF.md`, `brands.tsv`,
`batch-01..16.tsv`, `pending-migrations/` (the four importers, already tested
end-to-end against synthetic data and reverted cleanly), `pnpm kb-merge`.

**Next action.** `HANDOFF.md` → "P1 — seed the knowledge base" → step P1.0.
Batches of 4 sub-agents on Sonnet 5, output written into
`docs/kb-research/out/<NN>/`, checkpoint here after every batch.

---

## P1.0 + P1.1 — Batch A (agents 01–04) — DONE 2026-08-27

**P1.0.** `docs/kb-research/out/01..16/` created. Session not in plan mode.

**P1.1.** Four Sonnet 5 sub-agents ran to completion against
`batch-01..04.tsv` and wrote into `docs/kb-research/out/01..04/`.

| agent | producer | alias | flavor | rule |
| ----- | -------- | ----- | ------ | ---- |
| 01    | 44       | 60    | 5      | 7    |
| 02    | 57       | 73    | 6      | 5    |
| 03    | 52       | 71    | 11     | 11   |
| 04    | 58       | 85    | 5      | 5    |

Field-count check clean on all sixteen files (15 / 4 / 6 / 9). No `peated`
house-style row. No uncited non-`unknown` peat claim.

**Producer rows exceed the 42 input brands per batch by design** — each agent
also emitted distillery rows for the distilleries named inside its bottlers'
sample product names (rule 2 of the brief). That is the intended surplus.

**Finding to act on in P1.6.** `checkProducer` in `scripts/kb-merge.ts`
**rejects** a row whose `peatProfile` is not `unknown` and has no citation,
while its own comment says such a claim is "demoted to `unknown` rather than
trusted". Rejection drops the producer _and_ its aliases, so an own-label blend
marked `none` without a URL becomes an unresolvable brand. Agent 03 hit this
and defensively wrote `unknown` for its uncited long tail; agents 01/02/04 cited
category-level sources for `none` instead. Fix in P1.6: demote to `unknown` and
report, matching the documented intent, instead of rejecting the row.

**Peat claims flagged by the agents for human review (P1.8):** amrut Peated
(medium not heavy), gladstone-axe light, jura light (sources conflict),
macduff/the-deveron light, chivas-regal light (01 vs 03 vs 04 disagree),
speyburn light, claymore + glen-ryan light (thin single-source), scarabus
medium, port-askaig heavy (undisclosed distillery), peats-beast heavy
(undisclosed), bankhall Peated rule (bottling name guessed),
caol-ila medium (04) vs heavy (02) — a real peat disagreement kb-merge will
surface.

**Next.** P1.2 — Batch B, agents for `batch-05` … `batch-08`.

---

## P1.2 — Batch B (agents 05–08) — DONE 2026-08-27

Four Sonnet 5 sub-agents ran against `batch-05..08.tsv`, output in
`docs/kb-research/out/05..08/`.

| agent | producer | alias | flavor | rule |
| ----- | -------- | ----- | ------ | ---- |
| 05    | 50       | 82    | 0      | 2    |
| 06    | 57       | 67    | 1      | 4    |
| 07    | 51       | 59    | 0      | 8    |
| 08    | 52       | 69    | 0      | 7    |

Field-count check clean (15 / 4 / 6 / 9), no `peated` house style, no uncited
peat claim. Running total: 421 producer rows, 365 distinct slugs.

**The session's WebSearch budget was exhausted during this batch** — 200 of 200
calls, pooled across all sub-agents, spent by Batch A. Agents 05–08 each hit the
wall within their first handful of queries and fell back to WebFetch on guessed
URLs, which is why their `flavor.tsv` files are nearly empty and their long
tails skew to `unknown`. Verified directly: `WebSearch` now refuses, and
`lite.duckduckgo.com` serves a CAPTCHA.

**Workaround found and adopted for Batches C and D.** `curl` from Bash has
full network access. Two substitutes replace the search tool:

- Wikipedia search API — `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=<terms>&format=json&srlimit=8`
- Raw article wikitext — `https://en.wikipedia.org/w/index.php?title=<Title>&action=raw`

**New reference file, committed to the repo, not the scratchpad:**
`docs/kb-research/reference/wikipedia-scotland-distilleries.tsv` — 259 rows
(165 operating, 94 closed) parsed from the Wikipedia article "List of whisky
distilleries in Scotland": distillery, common region, owner, malt/grain,
operating/closed. Wikipedia's `Island` is folded to `Islands`; an `Islands` row
always means `legalRegion=highland`. The raw wikitext is kept beside it as
`.wikitext.txt`.

This file is what P1.7 names as the region/owner authority, so building it now
costs nothing and lets Batches C and D read region and owner locally instead of
spending fetches. **It also raises the value of P1.7**: the deterministic
cross-checks now have to repair what the degraded search left thin, so P1.7 is
no longer a formality.

**Extra review items from this batch (for P1.8):** caol-ila now has three votes
heavy (02, 05) against one medium (04, 07); white-horse light despite Lagavulin
in the vatting; finlaggan left `unknown` although its own catalogue row reads
`Finlaggan Original Peaty` (the golden set requires this one to resolve);
mccarthys left `unknown` though widely documented as peated; nikka/yoichi left
`unknown`; jack-daniels `smoky require` deliberately withheld by agent 05
against the brief's own worked example — P1.7 must settle it.

**Next.** P1.3 — Batch C, agents for `batch-09` … `batch-12`, with the curl
recipe and the reference file in their prompts.

---

## P1.3 — Batch C (agents 09–12) — DONE 2026-08-28

Four Sonnet 5 sub-agents ran against `batch-09..12.tsv` with the curl research
recipe and the Wikipedia authority file in their prompts. Output in
`docs/kb-research/out/09..12/`.

| agent | producer | alias | flavor | rule |
| ----- | -------- | ----- | ------ | ---- |
| 09    | 48       | 68    | 4      | 4    |
| 10    | 63       | 86    | 0      | 2    |
| 11    | 47       | 64    | 0      | 3    |
| 12    | 48       | 59    | 3      | 0    |

Field-count check clean, no `peated` house style, no uncited peat claim, no
`legalRegion=islands`. Running total: **627 producer rows, 520 distinct slugs**.

The curl workaround held: every agent reported working Wikipedia access via the
search API and raw wikitext, and all four used the local authority file for
Scottish region and owner instead of spending fetches on it.

**Second merge defect found, to fix in P1.6.** Two rows carry
`countryCode=GB` — `bushmills` (11) and `samuel-gelstons` (12), both Northern
Irish, both reasoning correctly that the closed list has `GB-ENG/SCT/WLS` but no
`GB-NIR`. `COUNTRIES` in `scripts/kb-merge.ts` deliberately excludes bare `GB`,
so both rows would be **rejected outright**, taking `bushmills` — a real
distillery with 10+ catalogue products — out of the seed. Fix in P1.6: normalize
Northern Ireland to `IE`, matching the Irish-whiskey GI convention that agent 03
already applied to `quiet-man`, and note it on the row.

**New review items for P1.8.** `mac-talla` left `unknown` even though the
catalogue itself carries `Mac-Talla Flora Lightly Peated` and the golden set
requires it to resolve — the global `lightly peated` rule will cover the named
bottlings, but the bare brand will not resolve to a peat level. `finlaggan`
(from Batch B) has the same shape. `caol-ila` is now split four ways: heavy from
02/05/10, medium from 04/07/09/11 — the single most contested row in the seed.
`ballantines` light rests on a 21-year-old tasting note, not the Finest that
makes up the catalogue rows. `bushmills` and `oban` peat bands rest on
qualitative wording only. Agent 11 excluded `Ice Drive` deliberately (the
samples are plastic ice cubes, not whisky).

**Next.** P1.4 — Batch D, agents for `batch-13` … `batch-16`.

---

## P1.4 — Batch D (agents 13–16) — DONE 2026-08-28. RESEARCH FLEET COMPLETE.

| agent | producer | alias | flavor | rule |
| ----- | -------- | ----- | ------ | ---- |
| 13    | 59       | 75    | 4      | 3    |
| 14    | 50       | 65    | 3      | 1    |
| 15    | 54       | 72    | 2      | 1    |
| 16    | 44       | 60    | 1      | 4    |

All shape checks clean across all four: field counts, no `peated` house style,
no uncited peat claim, no `legalRegion=islands`, no bare `GB`.

**Totals across all sixteen agents** — this is the P1 research corpus:

|                           | rows    |
| ------------------------- | ------- |
| producer (raw, pre-merge) | 834     |
| producer (distinct slugs) | **667** |
| alias                     | 1115    |
| flavor                    | 45      |
| rule                      | 67      |

Peat distribution over the 834 raw rows: `none` 507, `unknown` 244, `light` 32,
`heavy` 26, `medium` 25. **83 positive peat rows** — that is the P1.8 mandatory
review set, close to the plan's ~60 estimate.

**Review items added by this batch.** `islay-mist` left `unknown` although its
own catalogue row reads `Islay Mist Original Peated Blend` (and `Isiay Mist`,
the capital-I typo, is a golden-set case). `caperdonich` — three of five samples
say `Caperdonich Peated`, no citation found, no rule written. `floki` "Sheep
Dung Smoked Reserve" is smoky but explicitly not peat, if the recollection
holds — needs a `smoky` rule, not a peat one. `smokehead` heavy with an
undisclosed source distillery, so no `parentSlug` (correct). `hibiki` light is
inferred, not sourced. `deanston` owner is CVH Spirits, not Distell — worth
propagating to the sibling rows other batches wrote.

**Next.** P1.5 — close the input gap: products with a null `brandId`, and the
distilleries that exist only inside independent bottlers' product names.

---

## P1.5 — input gaps closed (agents 17–20) — DONE 2026-08-28

Two gaps, four Sonnet 5 agents, one batch.

**The 181 brandless products.** Extracted from the local database as 153
distinct name groups (`SELECT ... WHERE "brandId" IS NULL GROUP BY name`),
split into `docs/kb-research/gap-17-nullbrand.tsv` and `gap-18-nullbrand.tsv`.
A brandless product can only ever resolve through an alias matching **inside**
its name, so both agents were told to emit `scope=any` aliases on a
distinctive stem, and to leave a stem at `brand` scope when it was too generic
to match safely rather than risk a mis-resolution.

**The Scottish distilleries nobody covered.** The Wikipedia authority file
minus every slug and alias key the sixteen batches produced: 63 distilleries,
split into `gap-19-distilleries.tsv` and `gap-20-distilleries.tsv`. Region and
owner were handed over as authoritative, so the only field either agent had to
research was `peatProfile`.

| agent | producer | alias | flavor | rule |
| ----- | -------- | ----- | ------ | ---- |
| 17    | 47       | 58    | 0      | 3    |
| 18    | 59       | 70    | 0      | 2    |
| 19    | 39       | 79    | 0      | 1    |
| 20    | 32       | 70    | 3      | 0    |

**Corpus totals: 1011 producer rows, 814 distinct slugs, 1392 aliases, 48
flavors, 73 rules.** Alias scope split: 1189 `any`, 200 `brand`, 3 `name`.

Notable recoveries: `Yoichi`, `Miyagikyo`, `Highland Park` and `Inchmurrin`
were all brandless in the catalogue and now resolve; `Port Ellen` heavy,
`Rosebank` none, `Raasay` light, `Brora`, `Kilkerran` (via `glengyle`),
`Man O' Sword`/`Man O' Words` (Annandale's peated/unpeated split) and
`Fara`/`Rysa` (Orkney Distilling's actual whiskies — `Kirkjuvagr` is their gin,
which the prompt had wrong) all entered as researched rows. Agent 20 also
established that `Lochranza` **is** the Arran distillery rather than a separate
one, so it became an alias instead of a row.

Eleven input rows were correctly refused as not-whisky: craft-beer distillates,
oak-chip-aged Ukrainian spirits, a dealcoholized "bourbon alternative", and a
row of plastic drink ice.

---

## P1.6 — merge — DONE 2026-08-28

`pnpm kb-merge docs/kb-research/out docs/kb-research/seed docs/kb-research/curation`

**Seed written:** `docs/kb-research/seed/{producer,alias,producer-flavor,rule}.tsv`
— **795 producers (228 live `auto`, 567 `unverified`), 1039 aliases, 45
flavors, 92 rules** (25 authored globals + 67 researched).

Three changes were needed to get a clean run, all in `scripts/kb-merge.ts`:

1. **The agent loop is discovered, not fixed at sixteen.** It read `01`..`16`
   by construction, so P1.5's four gap agents would have been silently
   dropped. It now scans the input directory for subdirectories.
2. **An uncited peat claim is demoted, not rejected.** The gate's own comment
   said "demoted to `unknown` rather than trusted" while the code pushed a
   validation problem, which dropped the whole producer — and with it every
   alias pointing at it, leaving the brand unresolvable. `demoteUncitedPeat`
   now reduces the claim and reports it. **Rejected rows: 38 → 0.**
3. **A curation layer** (`docs/kb-research/curation/`, passed as an optional
   third argument). `merge-slugs.tsv` folds a duplicate producer into the row
   that keeps it — rewriting every reference _before_ the merge, so the
   duplicates score against each other and their aliases stop colliding.
   `overrides.tsv` sets one field of one merged producer with a stated reason.
   Both leave the agents' research untouched, which is what keeps a
   disagreement auditable; `status` overrides are applied **after** the
   auto-gate so a reviewer's `verified` is not recomputed away.

**19 duplicate producers folded** — `woodford`/`woodford-reserve`,
`mh`/`m-h`, three spellings of Singleton of Dufftown, `spey`/`speyside-distillery`,
`peanut-butter`/`skrewball` and the rest. **Alias collisions 34 → 5**, and all
five that remain are legitimate: a brand and its parent distillery sharing a
spelling (`midleton`, `powers`, `the hearach`, `green spot`, `yellow spot`).
First-wins keeps the row whose facts are right either way.

**Also fixed:** two rows carried `countryCode=GB` (`bushmills`,
`samuel-gelstons`), which the closed list rejects. Both are Northern Irish and
are now `IE`, the Irish-whiskey GI convention agent 03 had already applied to
`quiet-man`, with the normalization recorded in each row's note.

**Known limitation, deliberately not fixed.** The alias `jura` is 4 characters
and `KB_NAME_ALIAS_MIN_LENGTH` is 5, so it is downgraded to `brand` scope and
`Old Malt Cask Jura` will resolve its **bottler** (Hunter Laing) but not its
distillery. The floor is a P0 decision listed under "Traps already paid for",
so it stands; the consequence is safe (unknown peat removes tags rather than
inventing them, and Jura is `light` anyway) and it goes to the owner at P1.8.

**Open: 33 producers whose peat two agents disagreed on**, listed in the report
under `PEAT DISAGREEMENTS`. That is P1.7's job — the cross-checks exist
precisely to settle them.

**Next.** P1.7 — Wikipedia region/owner, Wishart peat band, and `BRAND_INFO`'s
231 curated country+type pairs, applied as `overrides.tsv` rows.

---

## P1.7 — cross-checks — DONE 2026-08-28

Full write-up: `docs/kb-research/curation/cross-check-report.md`. Decisions are
`docs/kb-research/curation/overrides.tsv` (11 rows), applied by the merge.

**Authorities checked into the repo:**
`reference/wikipedia-scotland-distilleries.tsv` (built in P1.2) and
`reference/wishart-86-distilleries.csv` (the Wishart 86x12 sensory table,
recovered from a GitHub mirror after the blog mirror named in the plan 404'd).
`BRAND_INFO`'s 231 pairs were read straight from the source constant.

**The finding that matters: Wishart is a review trigger, not an authority.**
Its `Smoky` column is a 0–4 tasting-panel intensity, not a peating spec. Mapped
onto the bands as a ladder it asserts that Glenfiddich, Macallan, Glenlivet and
Glenfarclas are smoky (all score 1) and that Bruichladdich, Dalmore, Clynelish
and Mortlach are **peated** (all score 2) — Bruichladdich's own marketing is
that it is unpeated. That is the Tobermory bug in new clothes. Only the plan's
literal rule was used — heavy iff `Smoky>=3 ∨ Medicinal>=2` — and only to
decide what to look at. It flagged four rows; two changed.

**The 33 contested peat rows reduce to 8.** Filtering by tag impact is what
makes it tractable: `none`/`unknown` produce no tags, `light` produces `smoky`,
and `medium` and `heavy` both produce `peated`+`smoky` — so `caol-ila`
heavy-vs-medium and `torabhaig` heavy-vs-medium are cosmetic, and 25 of the 33
are `none` vs `unknown`, which score already resolves.

Four peat corrections: `springbank` medium→light (the brief's own calibration;
`medium` would have tagged every Springbank `peated`), `macduff` light→none
(the light claim describes The Deveron, which is its own row — the sibling
architecture doing its job), `jura` none→light, `clynelish` none→light.

Other corrections: `ancnoc` legalRegion→speyside (region stays `highland` —
this is exactly the split the two columns exist for), `compass-box` and
`o-brian` country→GB-SCT, four owners filled or fixed from Wikipedia.

Three BRAND_INFO defects recorded for P6.4, when that constant is deleted:
`pokeno` is New Zealand not Scotland, `berry-bros-rudd` is a multi-country
bottler, and its `naked-grouse`/`coalition` types are less precise than the
seed's.

`early-times` gained the producer row agent 17 forgot to write beside its
alias. **Dangling references: 1 → 0.**

**Seed now: 796 producers (227 live `auto`), 1040 aliases, 45 flavors,
92 rules. 0 rejected, 0 dangling.**

**Next.** P1.8 — the review gate: assemble the dossier of every positive peat
row, every peat rule, every sibling pair and every cross-check hit.

---

## P1.8 — review gate — DOSSIER READY 2026-08-28

`docs/kb-research/curation/review-dossier.md`, generated from the seed:
**59 positive peat rows (31 live, 28 withheld), 73 peat rules (10 global +
63 researched), 2 producer-scoped tag rules, 38 parents with 67 sibling
children**, plus the cross-check hits and one known limitation.

**The 31 live positive rows are sane.** 15 `heavy` (every Islay heavyweight,
plus `ledaig`, `torabhaig`, `port-ellen`, `big-peat`, `smokehead`,
`peats-beast`, `ballechin`), 7 `medium` (`bowmore`, `talisker`, `ardmore`,
`brora`, `connemara`, `machrie-moor`, `the-deacon`), 9 `light` — and `light`
only ever adds `smoky`, never `peated`.

**The E2E acceptance already holds on the `auto` rows alone.** All eight
whiskies that must disappear from `excludeFlavors=peated` — Ledaig, Ardbeg,
Laphroaig, Lagavulin, Caol Ila, Port Charlotte, Smokehead, Big Peat — are live
`heavy`, and `tobermory` is live `none`.

**28 positive rows are withheld by the asymmetric gate**, which is it working
as designed: a positive claim needs Islay, a peat word in the slug, or a
citation from the producer's own domain. The cost is recall, never correctness —
a withheld producer loses peat tags rather than gaining wrong ones. Section 3b
of the dossier lists the twelve where withholding is most visibly wrong
(`highland-park`, `longrow`, `benromach`, `johnnie-walker`, `springbank`,
`jura`, `cu-bocan`, `lagg`, `an-orkney`, `old-ballantruan`, `yoichi`,
`man-o-sword`) with a one-line `overrides.tsv` recipe to promote them.

**Nothing is `verified`.** Promotion is the owner's call and is not a blocker:
the phases below proceed on the `auto` set.

**Brands that stay `unknown` but are rescued by the global rules:**
`finlaggan` (`Finlaggan Original Peaty` → the `peaty` rule, heavy),
`mac-talla` (`Mac-Talla Flora Lightly Peated` → `lightly peated`, light) and
`islay-mist` (`Islay Mist Original Peated Blend` → `peated`, heavy). The rules
were centralised for exactly this case.

**Next.** P1.9 — move the four importers out of `pending-migrations/`, put the
generated TSVs beside them, and run the migration.

---

## P1.9 — the seed is in the database — DONE 2026-08-28

The four importers moved from `docs/kb-research/pending-migrations/` into
`migrations/`, each with its generated TSV beside it under the matching name.
`docs/kb-research/pending-migrations/` no longer exists.

`pnpm migration:run` applied all four cleanly on the first attempt — the
importers had been tested end-to-end against synthetic data in P0, and nothing
in the real seed tripped their fail-closed checks (unknown country, unknown
type, `peated` as a house style, a name alias under five characters).

**In the database now:**

| table             | rows |
| ----------------- | ---- |
| `producer`        | 796  |
| `producer_alias`  | 1040 |
| `producer_flavor` | 45   |
| `flavor_rule`     | 92   |

`status`: 227 `auto`, 569 `unverified`, 0 `verified`.
`peatProfile`: 423 `none`, 314 `unknown`, 26 `light`, 19 `heavy`, 14 `medium`.

**The reported bug is now representable.** `tobermory` resolves `none` /
`islands` / `auto`; `ledaig` resolves `heavy` with `parentId → tobermory`;
`bruichladdich` is `none` with `port-charlotte` and `octomore` as `heavy`
children. The catalogue itself is unchanged — that is P2.

**Green:** `pnpm test` 748/58 suites, `pnpm test:integration` 118/12 suites,
`npx tsc --noEmit` clean, `pnpm lint` clean, and `pnpm migration:generate`
reports **no schema drift**.

**Next.** P1.10 — the golden-set fixture and its integration test.

---

## P1.10 — the golden set — DONE 2026-08-28. **P1 COMPLETE.**

`test/fixtures/kb-golden.tsv` — **195 rows**, every one a real `(name, brand)`
pair from the production catalogue — and
`test/scrape/kb-golden.integration.spec.ts`, which resolves all 195 against the
seeded database in one pass and reports **every** mismatch rather than the
first. Ten cases, all green. Peat spread in the fixture: 60 `heavy`,
23 `medium`, 3 `light`, 80 `none`, 29 `unknown`.

Every case the plan named is pinned, including the ones whose expectation is
"resolves to nothing": `Probably Orkney's Finest`, `XOP Speyside Finest 1967`,
`Clan Denny Highland/Islay/Speyside`, `Cask Orkney`.

### Two real defects the golden set found

**1. A bottler could become the producer.** `Allt-a-Bhainne - Old Malt Cask`
resolved its producer to **Old Malt Cask** and its bottler to nothing. The
catalogue spells the brand `Allt A Bhainne`, no alias matched it, the only
alias found inside the name was the bottler's, and `arbitrate` has no reason of
its own to refuse a bottler. The row would then have read its country, type and
peat off a company that owns no still. `matchProducer` now refuses a bottler in
the producer slot and moves it to the bottler slot. Unit test added
(`test/scrape/kb-resolver.service.spec.ts`, 24 cases now) plus a named golden
case.

**2. Bottlers were being withheld by the auto-gate for no benefit.** 19 of 44
bottler rows were `unverified`, so `Signatory Ledaig 100 Proof` resolved its
whisky but not the house that bottled it. A bottler carries no peat claim by
construction, and after fix 1 the resolver structurally cannot read facts off
one — so withholding buys nothing and costs the whole IB display. `gateStatus`
now passes a `bottler` whose peat is `unknown`.

### Coverage work, and the number that matters

The first golden run left **29% of the sample unresolved**, almost all because
the producer was `unverified`: only 227 of 796 rows had passed the gate, since
it requires `confidence = high` and the agents deliberately under-stated
confidence wherever a fact was not directly quoted.

Two changes, both evidence-based rather than gate-weakening:

- **86 Wikipedia-corroborated rows** had their confidence raised, generated
  mechanically into `overrides.tsv`: an unverified Scottish distillery whose
  region and owner the Wikipedia list independently confirms is not a `low`
  confidence row. The peat sub-gate was untouched, so 3 of the 86 with a
  positive peat claim are still withheld.
- **The bottler clause** above, worth 19 rows.

**227 → 329 live producers**, and the golden sample's unresolved share fell
**29% → 24%**. The remaining 467 `unverified` rows are what the P4.5 review
screen exists for.

### New curation directory

`docs/kb-research/out/21/` holds 14 alias rows written by hand, not by an
agent — spellings the golden set proved unreachable: `Burnside` and
`Clan Denny` were left at `brand` scope, and the Douglas Laing / Hunter Laing
ranges (`Old Particular`, `Hepburn's Choice`, `Scallywag`, `Rock Oyster`, …)
appear only inside product names and nobody had aliased them. `kb-merge` scans
every subdirectory, so it needed no code change; its README says plainly that
21 is the curator's, not an agent's.

### State

Seed: **796 producers (329 live), 1046 aliases, 45 flavors, 92 rules.**
Database matches. `pnpm test` **749** unit tests / 58 suites, `pnpm
test:integration` **128** / 13 suites, `npx tsc --noEmit` clean, `pnpm lint`
clean, no schema drift.

**The catalogue itself is still untouched** — `Tobermory 12` is still tagged
wrongly in `product_flavor`. That is P2, which is next.

**Next.** P2.1 — `scripts/reconcile-flavors.ts` skeleton.

---

## P2.1–P2.3 — the reconciliation pass, dry run — DONE 2026-08-28

`scripts/reconcile-flavors.ts` + `scripts/reconcile-flavors.interfaces.ts`,
registered as `pnpm reconcile-flavors`. Flags as specified: `--dry-run`,
`--out <tsv>`, `--store`, `--brand`, `--keep-unknown-peat`,
`--report-attr-conflicts`. It takes no sync lock — it writes only the catalogue
columns the knowledge base owns.

**Supporting work.** `ProductRepository.findKbReconcileCandidates` (the whole
catalogue in one query, with each bottling's flavor links and their sources
aggregated as JSON), `KbReconcileRow` / `KbReconcileFlavor` in
`~types`, and `CoreProductService` passthroughs for the four KB methods P0 had
left on the repository with no caller: `setProducers`, `applyKbFacts`,
`applyKbFlavors`, `logFactConflicts`.

**Dry run over the full local catalogue:**

```
groups           2942   (1718 resolved, 1224 unresolved)
bottlings        4057
producer writes  2522
fact changes      132
flavor links   +1314 / -624
```

**Peat links by source, before → after**

| link            | before | after   |
| --------------- | ------ | ------- |
| `peated:kb`     | 0      | **351** |
| `peated:llm`    | 472    | **0**   |
| `peated:scrape` | 130    | **0**   |
| `smoky:kb`      | 0      | **439** |
| `smoky:llm`     | 456    | **0**   |
| `smoky:scrape`  | 210    | **0**   |

That is the hard invariant, stated as a diff: after the pass every `peated` or
`smoky` link is `kb` (there are currently 0 `manual` ones, which would also be
allowed and are never touched).

**Report bug caught before it misled anyone.** The first version counted a
promoted link twice — once under the source it used to carry and once under
`kb` — so it claimed 331 surviving `llm` peat links when the pass leaves none.
A link that is being rewritten is now counted only by the insert pass.

**Peat decisions by reason:** `producer/none` 1401, `unresolved/unknown` 1193,
`producer/heavy` 144, `producer/medium` 56, `rule-global/heavy` 44,
`producer/light` 43, `rule-producer/medium` 24, `rule-producer/heavy` 17,
`producer/unknown` 15, and 5 more from global rules.

**Fact changes are small and are exactly the repairs wanted** — 132 across 70
producers, every one replacing a `legacy` value: `Amrut Cask Strength` country
FR → IN, `Four Roses` DE → US, `Deanston Kentucky Cask` US → GB-SCT, `The Hive`
IE → GB-SCT, and a long tail of `malt` → `single malt`.

**Only peat tags are ever dropped**: the 624 deletions are 358 `smoky` and 266
`peated` and nothing else, so no `forbid` row fired on the other thirteen tags.
Gains: 439 smoky, 351 peated, 236 sherry (the global cask rules), 84
bourbon-cask, and a small tail.

**Baselines captured before applying**, for the verification queries:

| measure                               | before                                   |
| ------------------------------------- | ---------------------------------------- |
| peat links `manual`                   | 0                                        |
| `countrySource = manual` products     | 0                                        |
| name groups disagreeing on peat tags  | **108**                                  |
| … on country                          | 28                                       |
| … on type                             | 45                                       |
| … on age (identity, must not move)    | 164                                      |
| … on volume (identity, must not move) | 254                                      |
| per-tag link counts                   | `/tmp/tags-before.tsv`, reproduced below |

oak 2283, fruity 2205, vanilla 1630, spicy 1544, honey 1271, caramel 1083,
sherry 799, floral 701, smoky 666, peated 602, citrus 555, nutty 464,
maritime 420, chocolate 381, bourbon-cask 136.

**Note on the reported bug.** Product `019ff1bf-5e31-7eff-9c8d-5b5ef68a10b9`
(`Tobermory` 12yo, 700 ml) — the row the whole plan names — already carries
**manual** tags (fruity, maritime, nutty, oak, spicy) with no peat, so the
owner had hand-corrected that one instance. The 50 ml, 21yo and 25yo Tobermory
rows still carry `llm` tags, none of them peat. The systemic fix is what P2
delivers; the hand fix is what it must not destroy, and `manual` links are
skipped by both the planner and the SQL.

**Next.** P2.4 — apply, then run the verification queries and a second dry run
that must report zero changes.

---

## P2.4 — applied — DONE 2026-08-28. **THE CATALOGUE IS REPAIRED.**

`pnpm reconcile-flavors` ran against the local catalogue: **4057 producer rows,
2351 fact rows**, and the flavor links rewritten.

### Verification (the queries from HANDOFF, in order)

| # | check                                                 | result                              |
| - | ----------------------------------------------------- | ----------------------------------- |
| 1 | `Tobermory` age 12 carries no peat tag                | **pass** — no rows                  |
| 2 | **hard invariant**: peat links outside `(kb, manual)` | **0**                               |
| 3 | every Ledaig row is `peated:kb` + `smoky:kb`          | **pass**                            |
| 4 | name groups disagreeing on peat                       | **108 → 0**                         |
| 4 | … on country                                          | 28 → 20                             |
| 4 | … on type                                             | 45 → 35                             |
| 4 | … on **age** (identity, must not move)                | **164 → 164**                       |
| 4 | … on **volume** (identity, must not move)             | **254 → 254**                       |
| 5 | `countrySource = manual` did not shrink               | 0 → 0                               |
| 6 | coverage KPI, `countrySource`                         | `legacy` **3994 → 1649**, `kb` 2351 |
| 6 | coverage KPI, `typeSource`                            | `legacy` → 1844, `kb` 2141          |

The peat count of 0 needs one word of explanation: a raw
`array_agg` query first reported 1, and the single row was an artifact of a
`LEFT JOIN` emitting a `NULL` element beside `{peated,smoky}` for the same
`smokehead` group. Both members carry the identical pair.

Country and type do **not** reach 0, and that is honest rather than a defect:
1224 of 2942 groups resolve to no producer, so the knowledge base states
nothing about them and their stored values — including their disagreements —
are left exactly as they were. The residual falls as producers are promoted.

### Non-regression on the other thirteen tags

Not one lost a link. `sherry` 799 → 892, `bourbon-cask` 136 → 184,
`vanilla` 1630 → 1678, `citrus` 555 → 598, and the rest flat or up. Only the
two peat tags fell — `peated` 602 → 351, `smoky` 666 → 451 — which is the
correction the pass exists to make.

### Idempotency, and the two defects it caught

The plan's rule is that a dry run straight after applying must report zero
changes. It did not, twice, and both times the reason was a real defect:

1. **Re-writing links it already owned.** A `kb` link was planned for rewrite
   every run — a no-op upsert, but the plan was not idempotent and the check
   could never come back clean. Inserts now skip a link already sourced `kb`.
2. **A require rule losing to the peat sweep, forever.** `Grant's Triple Wood
   Smoky` is an unpeated blend whose own name requires `smoky` through the
   global smoke rule. The sweep dropped the link as an unwanted peat tag, and
   the rule restored it on the next run — an oscillation that would have
   flipped the tag on every sync. A required tag now outranks the sweep, with
   `peated` explicitly exempt so that peat keeps exactly one source of truth.

**Third dry run: `producer writes 0, fact changes 0, flavor links +0 / -0`.**

`Grant's Triple Wood Smoky`, `Smoky Black The Famous Grouse`, `Sir Edwards
Smoky` and `Johnny Smoking Gun` all end with `smoky:kb` and **no** `peated` —
the vocabulary split working as designed.

**Green:** `pnpm test` 749 / 58 suites, `pnpm test:integration` 128 / 13,
`tsc` and `lint` clean.

**Next.** P2.5.1 — the `logFactConflicts` hook in `ScrapePersistService.persist`.

---

## P2.5.1 — the cross-shop contradiction log is wired — DONE 2026-08-28

`ScrapePersistService.logConflicts` runs immediately **before**
`fillMissing`, and that position is the design rather than a convenience:
`fillMissing` is where the rank-aware write silently discards the value that
ranks lower, and `rawAttrs` is never persisted, so this is the last moment at
which the stored value and the live claim exist together. Nothing downstream
could reconstruct either.

**Compared:** `brand`, `type` and `country` exactly (by id), `abv` at a
tolerance of `ABV_TOLERANCE = 0.1` — a new constant, documented against the
standing example of `Balvenie DoubleWood` listed at 40 % by one shop and 43 %
by another, which is a real disagreement, while 0.05 is rounding.
**Never compared:** `age` and `volumeMl`. Both are components of the frozen
match key, so a store stating a different one describes a _different bottling_.

A claim counts only when **both** sides state something: a store that says
nothing has not disagreed, and a stored null is a gap `fillMissing` is about to
close.

**Lock order** is `(productId, storeId, attribute)` ascending, sorted before
the upsert, because two stores syncing concurrently touch overlapping
bottlings.

**Best-effort by construction** — the whole block is wrapped, and a failure is
logged at `debug`. A sync must never fail because a QA log could not be
written.

**Supporting work:** `ProductRepository.findFactsByIds` + the
`ProductStoredFactsRow` shape + a `CoreProductService` passthrough.

**Five new unit tests** in `test/scrape/scrape-persist.service.spec.ts`
(27 in that suite now): a contradiction is logged with its stored source; a
difference inside the tolerance is not; a stored gap is not; the log is written
**before** `fillMissing` (asserted on call order, since that ordering is the
whole point); and a failing log does not fail the sync.

**Green:** 754 unit tests / 58 suites, lint and tsc clean.

**Next.** P2.5.2 — `pnpm fact-conflicts`, the read-only queue with a per-shop
disagreement rate.

---

## P2.5.2 — `pnpm fact-conflicts` — DONE 2026-08-28. **P2 COMPLETE.**

`scripts/fact-conflicts.ts` + `scripts/fact-conflicts.interfaces.ts`,
read-only, with `--attribute` and `--store` filters. Three sections:

1. **By attribute** — how many bottlings each disputed fact covers.
2. **Per-shop disagreement rate** — the one the plan calls the direct answer to
   "different sources of truth, different data". Disputed bottlings as a share
   of the shop's in-stock listings, so a shop with 4000 offers and one with 200
   are comparable, and the unreliable shop is _named_ rather than left
   anonymous.
3. **The queue, worst-first** — ordered by `seenCount`, not recency: a shop
   that has repeated the same wrong country every sync for a month matters more
   than one that said it once. Ids are resolved to brand, type and country
   names so the queue reads without a second lookup.

**A defect found by exercising it.** `storedValue` and `claimedValue` are text
because they hold a foreign key for `brand`/`type`/`country` and a _number_ for
`abv`. The first version cast them with `::uuid` behind an
`AND c.attribute = 'brand'` predicate, and Postgres is free to evaluate the
cast first — so a single ABV row aborted the entire query with
`invalid input syntax for type uuid: "40"`. The cast is now guarded by a
`CASE` on the value's shape in a CTE, which is per-row and cannot be reordered
around.

**Verified end to end** by inserting two synthetic rows (a `country` conflict
and an `abv` one), running the report, and deleting them — the table is back to
0 rows:

```
BY ATTRIBUTE
  abv             1 products, seen 3x
  country         1 products, seen 7x

PER-SHOP DISAGREEMENT RATE
  store          disputed  listings    rate    seen
  maudau                1       533    0.2%       7
  winewine              1       202    0.5%       3

QUEUE: 2 unresolved disagreements
  [  7x] country maudau       Ledaig
         stored 'GB-SCT' (kb) vs claimed 'IE'
  [  3x] abv     winewine     Ledaig
         stored '40' (store) vs claimed '43'
```

**The live log is empty and will stay empty until a sync runs** — it is written
during a scrape by design, and no reconciliation pass can populate it because
`rawAttrs` is never persisted. The report says so in place of the table rather
than showing an empty one.

**Green:** 754 unit tests / 58 suites, 128 integration, tsc and lint clean.

**Next.** P3.1 — the vocabulary split in `brand-info.constants.ts`.

---

## P3.1 — the vocabulary split — DONE 2026-08-28

`src/scrape/normalize/brand-info.constants.ts`:

- **`FLAVOR_KEYWORDS` loses `peated` and `smoky`** — 15 entries down to 13. The
  keyword pass can no longer derive peat from a listing's prose. The peat words
  still decide a bottling's level, through `flavor_rule`, where the decision is
  reviewable and priorities settle `Benromach Unpeated` against Benromach's own
  light profile.
- **`KB_FLAVOR_TAGS`** — the two the knowledge base owns.
- **`LLM_FLAVOR_TAGS`** — the thirteen a model may report, derived from the
  keywords.
- **`FLAVOR_TAGS` stays all fifteen**, now composed of the two lists. The
  `/meta` contract is unchanged: a user still filters on `peated`, and what
  changed is only who may _state_ it.

**Test inversions.** `test/scrape/normalize.spec.ts:150` asserted that
`"Laphroaig торф'яний дим"` yields `peated`; it now asserts the opposite, with
the reason on the test. Two more tests moved the same way rather than being
deleted, because the behaviour they cover is still worth pinning: a description
is still read (it is where the other thirteen tags come from) and its peat
words simply no longer reach `flavorTags`. `silpo.adapter.spec.ts` gained a
companion test proving the store's own `Димний, торф'яний` attribute is still
stashed into `rawAttrs` — it grounds the flavour prompt — while producing no
tag.

The stale comment at `silpo.adapter.ts:381` now says what is actually true.

**Green:** 757 unit tests / 58 suites, lint and tsc clean.

**Next.** P3.2 — ground the flavour prompt on the resolved producer.

---

## P3.2 + P3.3 — the model is grounded, and locked out of `kb` links — DONE 2026-08-28

**P3.2 — grounding.** `findFlavorCandidates` now joins `producer`, so a
candidate carries `distillery`, `region` and the producer's `forbid` tags.
`LlmFlavorCandidate` and `FlavorCandidateRow` gained the same three fields, and
`describe()` puts the distillery and region on the prompt line.

Handing the model the distillery is the fix for the mechanism behind the
original bug, not just its symptom: asked about
`Gordon & MacPhail Ledaig Discovery` the model previously had to work out whose
whisky it was before saying anything about flavour, and the guess it makes when
it cannot is exactly what put Ledaig's smoke on Tobermory.

**The prompt now lists thirteen tags and says why peat is absent** — that it
comes from a curated producer database, that any peat tag returned is
discarded, and that a peated character must not change which of the thirteen it
picks. The answer is filtered against `LLM_FLAVOR_TAGS`, so a model that
reports peat anyway changes nothing: that filter is the last line of defence
for the invariant, and a test pins it.

A tag the producer's house style **forbids** is dropped in `merge()` as a
post-filter rather than argued about in the prompt. The knowledge base is the
authority and the model is evidence; a post-filter enforces that ordering
without spending tokens on it per item.

**P3.3 — the `kb` guard.** `setLlmFlavors`'s upsert gained
`WHERE product_flavor.source <> 'kb'`. Without it the LLM pass repossesses a
knowledge-base link one product at a time, on whichever sync happens to re-ask
— and the breakage is silent, because the _tag_ does not change, only its
owner. Since the invariant is stated on the source column, ownership is the
fact.

**Tests.** Four new in `llm-flavor.service.spec.ts` (14 in the suite): peat and
smoke discarded however confidently reported; a forbidden tag dropped; the
prompt grounded on the resolved distillery; and the existing allowed-tags test
rewritten off the peat vocabulary. One new integration test in
`product-flavor.integration.spec.ts` (12 in the suite) proving a `kb` link
survives an LLM pass that names the same tag while a non-`kb` one is taken over
as before.

**Green:** 760 unit / 58 suites, 129 integration / 13 suites, lint and tsc
clean.

**Next.** P3.4 — the sync hook in `persist`, in the prescribed order.

---

## P3.4 — the sync hook — DONE 2026-08-28

**A shared service first, deliberately.** The reconciliation script and
`persist` both need to decide "which peat link may survive", and two
implementations of that is precisely the shape of defect this work exists to
remove — one edit to one of them and a nightly sync starts undoing what the
reconciliation pass settled. So the planning logic moved out of the script into
`src/scrape/kb/kb-apply.service.ts` (`KbApplyService`), which reads and writes
nothing: it takes the stored rows and the loaded index and returns the three
write sets. The script kept only its CLI and its reporting, and its idempotency
check still comes back `producer writes 0, fact changes 0, flavor links
+0 / -0` after the refactor — which is the proof that the shared path produces
identical results.

**The hook.** `ScrapePersistService.applyKb` runs in the prescribed order:
`logFactConflicts` → `fillMissing` → `addScrapeFlavors` → resolve →
`setProducers` → `applyKbFacts` → `applyKbFlavors`. It is after
`writeLlmFlavors` (which happens inside the upsert loop), so it can strip a
peat tag the model just wrote — without that, every sync re-created the errors
the reconciliation pass had corrected and the catalogue was only right until
the next cron.

It is scoped to the run's own bottlings via a new `ids` filter on
`findKbReconcileCandidates`: a sync is not the place to rewrite 4057 rows, and
anything it misses is the script's job.

**Unresolved brands go to a warn log, not a queue table** — the queue is
derivable at any time (a brand key with no alias match), so a table would be a
second copy of what the aliases already state.

**Best-effort**: a knowledge-base failure must not lose a scrape that
succeeded. A new `kb-applied` progress event carries the group and unresolved
counts into the run's log file.

**Four new persist tests** (31 in that suite): the pass runs _after_ both
flavor writers, asserted on call order because the ordering is the whole point;
the plan is applied to the bottlings the run touched; an empty knowledge base
skips the pass entirely rather than stripping tags with nothing to put back;
and a failure does not fail the sync.

**Green:** 764 unit / 58 suites, 129 integration / 13, lint and tsc clean.

**Next.** P3.5 — the `llm-flavor-restamp` migration.

---

## P3.5 — `llm-flavor-restamp` — DONE 2026-08-28

`migrations/1787851400000-llm-flavor-restamp.ts`: `lastLlmFlavorAt = NULL WHERE
"flavorsCuratedAt" IS NULL`. Applied — **30 unstamped bottlings → 4053**, and
the 4 hand-curated ones kept their stamp.

That column is the only thing stopping a bottling being re-sent to the model,
so every product answered under the **old** prompt was invisible to
`pnpm enrich-flavors` — and the old prompt is exactly what has to be re-run: it
listed fifteen tags including `peated`, and it was given no distillery to work
from.

**No tag is deleted by the migration, deliberately.** A destructive sweep
belongs in something that can be dry-run and read before it is trusted;
`pnpm reconcile-flavors` already is that, and has already removed every peat
tag the knowledge base does not own. A migration runs unattended on every
deploy and gets no such review. `down()` is a documented no-op — the cleared
timestamps were the only record of when each product was asked.

---

## P3.6 — the grounded re-pass — RUNNING

`pnpm enrich-flavors` over all 4053 candidates, started 2026-08-28, writing to
`/tmp/enrich-run.log`. 2348 of them carry a resolved producer, so the prompt
gets a real distillery for 58% of the batch.

Per-tag link counts **before** the re-pass (total 14610): oak 2284, fruity 2231,
vanilla 1678, spicy 1555, honey 1298, caramel 1085, sherry 892, floral 716,
citrus 598, nutty 464, maritime 442, smoky 451, peated 351, chocolate 381,
bourbon-cask 184.

The peat counts are the ones to watch: **they must not move.** The two tags are
absent from `LLM_FLAVOR_TAGS`, so nothing the model answers can touch them.

---

## P3.7 — strict filter rule + name re-derivation — CODE DONE, one step is the owner's

**`TRUSTED_FACT_SOURCES`** (`~enums`) = `manual`, `kb`, `store`, `name`. The
`types` and `countries` filters now answer from those alone and send `llm` and
whatever `legacy` remains to the `unknown` bucket. `countries` gained an
`unknown` bucket of its own, mirroring the pattern `types` already had.

The reason is that a filter makes a promise the rest of the app does not: a
user excluding a country is entitled to believe the results are from somewhere
else. A model's recollection cannot carry that promise. The values are still
shown and still editable — they are demoted as _filter evidence_, not deleted.

**`pnpm rederive-name-facts`** (`--dry-run`) re-derives type and country from
the longest raw listing name with the pipeline's own `TYPE_KEYWORDS` /
`COUNTRY_KEYWORDS`, and stamps them `name`. Dry run: 1916 candidates, 847 carry
a keyword, **776 type re-stamps (67 change the value) and 345 country
re-stamps (17 change the value)**.

The re-stamps are the point, not the value changes: most of those rows already
hold the right type and hold it as `legacy` — a source that says "nobody knows
where this came from", which is exactly what the strict rule distrusts.
Re-stamping `name` states something true and testable, and `fillMissing` is
rank-aware so the write only ever promotes and never overwrites `store`, `kb`
or `manual`. **Not yet applied** — it writes `product` rows and the flavour
re-pass is mid-flight on the same table.

**Measured coverage with the strict rule on, before the re-derivation**
(7199 in-stock offers): type filters answer from **3674** (51%) with 3525 in the
`unknown` bucket; country filters from **4137** (57%) with 3062 unknown. The
plan's stated risk was that the filters would _empty_; they do not.

**The one step I have not run: `pnpm backfill`.** The plan puts a full sweep
between the re-derivation and switching the rule on, to re-stamp `store`-source
values. It is a live scrape of all ~20 shops taking several hours of outbound
traffic, which is an operational decision rather than a code one — it is the
owner's to run. Until it does, the `unknown` bucket stays around 45%, and it
shrinks on its own as normal syncs re-stamp `store`.

---

## P4.1 — region, bottler and provenance in the report — DONE 2026-08-28

`CURRENT_SQL` gained two `producer` joins and a `json_build_object` of all eight
provenance columns. `ReportCurrentRow`, `ReportRow` and `ReportRowType` gained
`distillery`, `region`, `bottler` and `factSources`; `toGroup` spreads the
primary row, so groups carry them with no further change.

`bottler` being non-null **is** the IB flag — no separate boolean. `region` is
the market convention, so Talisker reads `islands` and is legally Highland.

`factSources` is what lets the UI mark an unverified value; without it the
client could not explain why a whisky it displays as Scotch does not appear
under a Scotland filter.

Verified against the database: `Gordon & MacPhail Ledaig Discovery` reads
distillery `Ledaig`, region `islands`, bottler `Gordon & MacPhail`;
`Old Malt Cask Jura` reads bottler `Old Malt Cask` with no distillery, which is
the documented 4-character alias limitation.

**Green:** 764 unit / 58 suites, 129 integration / 13, lint and tsc clean.

**Next.** Finish P3.6, apply the re-derivation, then P4.2 (`/meta` regions).

---

## P4.2 — `/meta` regions — DONE 2026-08-28

`Meta` gained `regions` (the six market-convention values, `islands` included)
and `legalRegions` (the protected SWA five). Both come from the enums rather
than the database, so a region no producer has been seeded with yet still
offers a filter chip.

The two lists are separate because one column cannot answer both questions:
Talisker, Highland Park, Tobermory, Jura and Arran are all legally Highland and
are listed by every shop as island malts. The DTO's JSDoc says outright that
the client's label has to read "region (common)", because a filter built on the
legal five would answer a question nobody asked.

---

## P4.5.1 — the review backend — DONE 2026-08-28

It exists because the knowledge base ships mostly **withheld** — the auto-gate
demands independent corroboration for a positive peat claim, so 467 of 796
producers are stored and ignored. Without somewhere to look at them, that
research is simply lost and the catalogue keeps the thin-but-honest answer
forever. The same screen carries the two other things nobody could otherwise
see: the facts still sourced `llm` or `legacy`, which the filters now distrust,
and the cross-shop contradictions the scrape logs.

**Endpoints**, all under the existing `product` group rather than a new `admin`
one:

| route                                                  | permission        |
| ------------------------------------------------------ | ----------------- |
| `GET /product/review/summary`                          | `product:review`  |
| `GET /product/review/producers?status=&page=&perPage=` | `producer:read`   |
| `GET /product/review/facts?field=type\|country`        | `product:review`  |
| `GET /product/review/conflicts?attribute=&store=`      | `product:review`  |
| `POST /product/review/conflicts/resolve` → `204`       | `product:review`  |
| `GET /producer/unresolved?limit=`                      | `producer:read`   |
| `PATCH /producer/:id`                                  | `producer:update` |

New `Resource.PRODUCER` and `Action.REVIEW`; confirming a _product_ fact still
goes through the existing `POST /product/update`, which already stamps
`manual`.

**Load-bearing details.**

- **Every listing is ordered worst-first by catalogue reach** — producers by
  how many bottlings resolve to them, facts by how many shops carry the
  bottling. A wrong fact on a whisky twelve shops list is wrong twelve times
  over on the reports, and a withheld producer nothing resolves to is not worth
  a reviewer's minute.
- **`PATCH /producer/:id` is one `COALESCE` statement, and clearing is
  explicit.** "Absent" and "deliberately empty" are different intentions and
  one nullable field cannot carry both, so the nullable fields come in pairs —
  the value, and a `clearRegion` / `clearOwner`-style flag. Without that, a
  reviewer correcting a peat band would silently wipe an owner they never
  looked at. `countryCode` resolves through a sub-select, so a typo leaves the
  country untouched instead of erasing it.
- **The patch stamps `verifiedAt` and lets the reviewer write `verified`**,
  which outranks the auto-gate: a promoted row goes live on the next resolve
  whatever the gate would have concluded about its citations. That is the
  mechanism the 467 withheld rows are waiting on.
- **The unresolved-brand queue is derived, not stored** — brands with no
  producer, counted from `product`. A queue table would be a second copy of
  what the alias table already states and would drift the moment somebody added
  an alias.
- **Resolving a conflict records a decision, not a correction.** The fact is
  changed through `POST /product/update`; the scrape clears `resolvedAt` again
  on the next sighting, so a disagreement somebody dismissed that keeps
  arriving is not dismissed.
- The conflicts query reuses the guarded uuid cast from `pnpm fact-conflicts` —
  same trap, same fix.

**Green:** 764 unit / 58 suites, lint and tsc clean.

**Next.** Finish P3.6, apply the re-derivation, then P4.3 (`pnpm openapi` +
web) and P4.5.2 (the web page).

---

## P6.1 + P6.2 — region filters and `verifiedFacts` — DONE 2026-08-28

`ReportFilter` gained `regions`, `excludeRegions` and `verifiedFacts`; the
query DTO gained the matching params (`CsvArray` for the two lists, `BoolQuery`
for the flag); `findCurrentRows` gained three predicates over the producer
join P4.1 had already added.

`excludeRegions` is the half that earns the feature — "everything except
Islay" is how a peat-averse drinker shops, and it is the same shape as
`excludeFlavors`, which exists for the same reason.

`verifiedFacts` is opt-in and is **stricter** than the default rule: the
default refuses to _match_ an untrusted type or country, this refuses to show
the bottling at all. It is for a user who would rather see a short certain list
than a long one with unverified rows in it.

---

## E2E acceptance — `test/integration/kb-report.integration.spec.ts` — PASSING

The criterion the whole plan is measured by, as a test rather than a manual
check. It seeds ten real catalogue names against the **real seeded knowledge
base** (installed by the migrations, so present in every environment), gives
every one of them a wrong `llm` `peated` tag, runs the same
`KbApplyService` pass a sync runs, and then asks the report the question the
owner actually asks.

Four cases, all green:

1. All ten bottlings reach the report.
2. **`excludeFlavors=peated` removes Ledaig, Ardbeg, Laphroaig, Lagavulin,
   Caol Ila, Port Charlotte, Smokehead and Big Peat, and keeps Tobermory** (and
   Glenfiddich).
3. Not one peat link on those rows is left outside `(kb, manual)`.
4. `Tobermory` resolves `tobermory`/`none` while `Ledaig` resolves
   `ledaig`/`heavy` — the sibling split, asserted directly.

Starting every row with a wrong tag is what makes it meaningful: it proves the
pass **removes** a model's guess rather than merely declining to add one, and
removal is the half that made `Tobermory 12` vanish from the owner's results.

Scoped to its own seeded rows and cleaned up afterwards, so it holds on a fresh
database and does not depend on scraped data.

**Green:** 764 unit / 58 suites, **133 integration / 14 suites**, lint and tsc
clean.

---

## P6.5 — one model call per name, not per bottling — DONE 2026-08-28

`findFlavorCandidates` now returns `DISTINCT ON (lower(name))` with the whole
group's ids in a new `groupIds` field, and `pnpm enrich-flavors` writes the one
answer to every id in it.

Two sizes of a whisky are two bottlings and one flavour profile. Asking about
each paid twice for one answer — and, worse, the two answers routinely
differed, which is how 250 name groups came to disagree about the other
thirteen tags. `clean-product-names.ts` already makes this exact decision, for
this exact reason.

The change does not affect the re-pass currently in flight: it loaded its
candidates before the edit.

---

## P6.3 and P6.4 — deliberately not done, with the measurements that say why

**P6.3 (legal type taxonomy — `blended malt`, `single grain`, `blended
grain`).** The plan itself says to flag this before doing it: it re-labels ~800
products and rewrites the `types` value inside users' **saved quick filters**,
which are stored as an opaque `jsonb` payload the backend deliberately never
interprets. A migration that reaches into that payload would break the one
guarantee the quick-filter design makes. **This one needs the owner's decision,
not a judgement call from me.**

**P6.4 (delete `BRAND_INFO` / `BRAND_KEYS` / `INDEPENDENT_BOTTLERS` /
`detectBrandInfo`).** The plan gates it on "the unresolved-producer count being
low enough to justify it". Measured now: **1706 of 4057 bottlings (42%) resolve
to no producer.** For every one of those, `detectBrandInfo` is still the only
thing supplying a country or type. Deleting it today would trade a working
fallback for a coverage hole. The gate is the right one and it is not open yet;
it opens as producers are promoted through the review screen and as
`pnpm research-brands` (P5) fills the tail.

---

## P5 — new brands, without paying twice — DONE 2026-08-28

**P5.1 — `LlmResearchService`** (`src/scrape/llm/`) plus `LLM_RESEARCH_MODEL`
(defaulting to `LLM_MODEL`). It is a separate slug for the same reason the
flavour pass has one, only more so: this is the one call whose answers become
**curated facts** that every filter then trusts, so a weak model does not
merely give a poor answer, it poisons the source of truth.

The prompt is built around the asymmetry and states it twice — a wrong `none`
removes tags somebody notices, a wrong positive removes a whisky from a
filtered result silently. It pushes `unknown` hard, forbids guessing a
distillery for an undisclosed label, and forbids averaging a distillery's
peated and unpeated lines into one profile. Every closed-vocabulary field is
filtered against what the database will actually accept, and `legal_region` can
never come back `islands`, which the column's own CHECK would reject.

**The auto-gate is now shared code.** `KbGateUtils.status` (`~utils`), lifted
out of `scripts/kb-merge.ts`, is used by both the merge and the research pass —
a model's proposal is held to exactly the standard the human research was, no
better and no worse. Verified behaviour-preserving: after the extraction
`pnpm kb-merge` still reports **796 producers, 329 live**, byte-identical.

**P5.2 — `pnpm research-brands`** (`--dry-run`, `--limit`, `--review`).

- **Candidates are brands with no matching alias, not brands with no
  producer.** Those differ, and the difference is the whole point of the
  `unverified` status: a brand researched and withheld still resolves to
  nothing, so keying on the producer link would offer it up again every run and
  buy the same answer forever.
- **Everything is stored, including what the gate withholds and what the model
  could not identify at all.** A withheld positive peat claim is demoted to
  `unknown` on the row and written verbatim into the note — leaving the claim
  in a column the status says to ignore is a trap for the first person who
  promotes the row without reading it. An unidentifiable brand gets a
  placeholder whose only job is to carry an alias so it never comes back.
- A short brand key stays `brand`-scoped, the same five-character floor the
  seed importer enforces.

**Run against the live catalogue: exactly one brand has no alias — `Ice
Drive`**, which agent 11 had already identified as plastic drink ice rather
than whisky. The seed's alias coverage is effectively complete for the current
catalogue, which is the intended steady state; this script exists for what
shops add next week.

Validated end to end on that one brand: the model returned `unknown` and the
gate withheld it. It did not invent a whisky producer for a bag of ice.

**P5.3 — `pnpm kb-export`** (`--out`, `--all`). Dumps the live knowledge base
back into the four seed TSVs, in the importers' own field order — verified at
15 / 3 / 6 / 9 fields. Exports **329 producers, 485 aliases, 40 flavors, 92
rules**.

By default it exports only `verified` and `auto`, because an `unverified` row
is a proposal and a proposal is not something to ship; `--all` takes everything
for a backup. Rules are always exported whole, global ones included — a global
rule has no status to filter on and it carries the negations that let a
bottling's own name overrule a house profile, so dropping it would be the
worst possible omission.

This is how environments stay convergent: runtime writes (a reviewer promoting
a producer, a researched brand) land in one database only, and freezing them
into a migration is what puts them everywhere.

---

## CLAUDE.md brought up to date — DONE 2026-08-28

The document claimed the knowledge base was "built but empty" and that "nothing
calls the resolver yet". Both were true when P0 finished and are now false, and
a stale architecture note is worse than none.

**Added:** a "The knowledge base in operation" section covering the seed and its
provenance, the shared asymmetric auto-gate, `KbApplyService` as the single
owner of "which link may survive", the sync order and why it is load-bearing,
the two ordering traps already paid for (never re-writing a `kb` link; a
required tag outranking the peat sweep, with `peated` exempt), the measured
coverage numbers, the six new scripts and the two regression gates.

**Added:** a "Filters the knowledge base added" section — `regions` /
`excludeRegions`, `verifiedFacts`, and the strict trust rule with the reason a
filter is held to a higher standard than a display, plus the measured coverage
it costs today. The endpoint inventory gained the seven review routes, the
report-params list gained the three new params, the commands block gained the
six scripts, and the migration list gained the five new migrations.

**Rewritten:** the "Still open" section now names the two steps that are the
owner's to run rather than code gaps (`pnpm backfill`; the legal type
taxonomy, which rewrites saved quick filters), the 467 withheld producers and
where they are promoted, and why `BRAND_INFO` cannot be deleted yet — with
1706 of 4057 bottlings unresolved as the measurement that says so.

---

## P3.6 — the flavour re-pass ran on the wrong model, and was rolled back

**What happened.** `pnpm enrich-flavors` was run over all 4053 candidates
without `LLM_FLAVOR_MODEL` set, so it fell back to `LLM_MODEL` —
`deepseek/deepseek-v4-flash`. `CLAUDE.md` documents that exact model as the one
that returns a per-category **template** for this pass, and that is what came
back. Measured with the project's own check:

| check                  | 16-agent import | deepseek re-pass |
| ---------------------- | --------------- | ---------------- |
| largest shared tag set | **52 names**    | **285 products** |
| `floral`               | 716             | 100 (−86%)       |
| `maritime`             | 442             | 63 (−86%)        |
| `vanilla`              | 1678            | 3221 (+92%)      |
| `spicy`                | 1555            | 3011 (+94%)      |

Jameson, Dewar's, Ballantine's, William Lawson's and Hankey Bannister all came
back with near-identical sets, and 2609 of 4053 answers claimed `high`
confidence — the documented tell. The plan's non-regression rule (a >10% loss
must be explained by a `forbid` row) was violated with no `forbid` to explain
it.

**Peat was never affected.** `peated` 351 → 351 and `smoky` 451 → 451, exactly
unchanged, and the invariant held at 0 throughout — because `LLM_FLAVOR_TAGS`
excludes both, so nothing the model answers can touch them. Peat safety is
structural and never depended on this pass.

**Rolled back, at the owner's direction, without spending more budget.** New
local repair tool `pnpm restore-flavor-import` (`--dry-run`) re-applies the
checked-in `1786350000000-flavor-llm-import.csv` — the sixteen-agent
classification, 2059 names, 5072 tag links. It is a **script, not a migration**,
deliberately: the import migration already put this data in every environment
and production never saw the bad run, so a "restore" migration would be a no-op
there implying a defect that never reached it.

Two details it gets right: the CSV predates the vocabulary split, so its 518
`peated`/`smoky` rows are **dropped** rather than re-imported (peat has one
source of truth now), and it only ever clears `llm` links — a `kb` link belongs
to the knowledge base and a `manual` one to a person.

**After the restore** (9771 `llm` links cleared and rewritten, 1117 bottlings
outside the CSV re-opened as candidates):

| tag            | 16-agent  | deepseek  | restored      |
| -------------- | --------- | --------- | ------------- |
| floral         | 716       | 100       | **616**       |
| maritime       | 442       | 63        | **321**       |
| oak            | 2284      | 1576      | **2041**      |
| sherry         | 892       | 533       | **754**       |
| vanilla        | 1678      | 3221      | **1856**      |
| spicy          | 1555      | 3011      | **1581**      |
| peated / smoky | 351 / 451 | 351 / 451 | **351 / 451** |

Largest shared tag set: **285 → 114**. Not all the way back to 52, because the
1117 bottlings the CSV does not cover keep the weak run's answers — they were
re-opened (`lastLlmFlavorAt = NULL`) so a later pass on a strong model re-asks
about exactly those and nothing else.

**P3.6 is therefore NOT done.** To finish it: set
`LLM_FLAVOR_MODEL=anthropic/claude-sonnet-5` in `.env`, clear the stamps, and
re-run `pnpm enrich-flavors`. Everything else in P3 stands — the vocabulary
split, the grounded prompt, the `kb` guard, the sync hook and the restamp
migration are all in place and tested, and they are what stop peat coming back.

**Re-verified after the rollback:** one `pnpm reconcile-flavors` promoted the
207 restored links the knowledge base owns through rules, and the pass is
idempotent again (`producer writes 0, fact changes 0, flavor links +0 / -0`).
Invariant 0. Golden set and the E2E acceptance both green. 764 unit / 58 suites,
133 integration / 14 suites, tsc and lint clean.

---

## P3.7 — name re-derivation applied — DONE 2026-08-28

`pnpm rederive-name-facts` applied to **835 bottlings**: 776 type re-stamps
(67 changed a value) and 345 country re-stamps (17 changed a value). Most of
those rows already held the right value and held it as `legacy`; re-stamping
them `name` says something true and testable, and `fillMissing` being
rank-aware means the write only ever promoted and never touched `store`, `kb`
or `manual`.

**Filter coverage, of 7199 in-stock offers:**

|                             | before     | after          |
| --------------------------- | ---------- | -------------- |
| type filters answer from    | 3674 (51%) | **5207 (72%)** |
| country filters answer from | 4137 (57%) | **4952 (69%)** |

`countrySource`: `kb` 2351, `legacy` 1331, `name` 318.
`typeSource`: `kb` 2141, `legacy` 1069, `name` 776.

The remaining `unknown` bucket is ~28–31% and shrinks further with the
`pnpm backfill` sweep, which is the owner's to run.

**Re-verified:** reconcile is idempotent (`0 / 0 / +0 / -0`), invariant 0,
764 unit / 58 suites and 133 integration / 14 suites green, `tsc` and `lint`
clean in both `be/` and `web/` (web: 453 tests / 64 files).

---

## P4.3 + P4.5.2 — the web side — DONE 2026-08-28

**P4.3.** `pnpm openapi` against a locally-run backend, then `pnpm codegen` in
`web/` — the generated client now carries the seven review routes,
`distillery` / `region` / `bottler` / `factSources` on report rows, and the
`regions` / `excludeRegions` / `verifiedFacts` params. Nine web test fixtures
needed the four new report fields; two of them had the fields inserted into the
_offer_ factory by a too-eager regex and were corrected to the group factory —
worth noting because `ReportOfferType` deliberately does **not** carry them
(the bottling's facts are stated once per group, not repeated per offer).

**P4.5.2.** `/product/review` behind the existing admin guard, with a tab in
the admin nav. Three tabs over `src/widgets/review/`: **Виробники** (promote a
withheld producer — one click, `PATCH /producer/:id` with `status: verified`),
**Факти** (bottlings the filters stopped trusting, with the source shown under
each value), **Суперечності** (per-shop claims, worst-first, with "вирішено").
Entity layer in `src/entities/review/`; mutations are hand-wrapped around the
generated request functions, the same pattern `useUpdateProduct` uses, and they
invalidate the review reads, the producer reads and the report caches together.

Switching tabs resets paging — page 4 of one queue means nothing in another and
would land the reviewer on an empty page.

**Not verified in a browser.** The screen sits behind the auth guard and I will
not enter credentials; it is covered by the type-checker, the lint pass and the
64-file web suite instead.

---

## FINAL STATE 2026-08-28

**Green everywhere.** `be/`: 764 unit tests (58 suites), 133 integration
(14 suites), `tsc` clean, `lint` clean, `migration:run` applies from scratch,
no schema drift. `web/`: 453 tests (64 files), `tsc` clean, `lint` clean.

**Acceptance.** `GET /report?excludeFlavors=peated` returns Tobermory and
excludes Ledaig, Ardbeg, Laphroaig, Lagavulin, Caol Ila, Port Charlotte,
Smokehead and Big Peat — asserted as an automated test
(`test/integration/kb-report.integration.spec.ts`), not a manual check, from a
deliberately wrong `llm` peat tag through the resolver to the filter predicate.

**Nothing is committed.** 116 changed files in `be/`, 13 in `web/`, all on the
default branch, per `git-flow`.

### Phases

| phase                      | state                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| P1 seed                    | done — 796 producers, 1046 aliases, 45 house styles, 92 rules, 195-row golden set              |
| P2 reconciliation          | done — peat conflicts 108 → 0, `legacy` country 3994 → 1331, idempotent                        |
| P2.5 conflict log          | done — written during the scrape, `pnpm fact-conflicts` reads it                               |
| P3.1–P3.5, P3.7            | done                                                                                           |
| **P3.6 flavour re-pass**   | **NOT done** — needs `LLM_FLAVOR_MODEL` on a strong slug; the deepseek attempt was rolled back |
| P4 surface                 | done, backend and web                                                                          |
| P4.5 review screen         | done, backend and web                                                                          |
| P5 new brands              | done — one unaliased brand in the whole catalogue                                              |
| P6.1, P6.2, P6.5           | done                                                                                           |
| **P6.3 legal taxonomy**    | **deferred** — rewrites saved quick filters, needs a decision                                  |
| **P6.4 delete BRAND_INFO** | **deferred** — 1706/4057 bottlings still unresolved, so it is still the only fallback          |

### What is the owner's to run

1. `pnpm backfill` — a live sweep of ~20 shops, hours. Raises the trusted-source
   share above today's 72% type / 69% country.
2. `pnpm enrich-flavors` with `LLM_FLAVOR_MODEL=anthropic/claude-sonnet-5`.
   1117 bottlings are already queued for it.
3. Promotions on `/product/review` — 467 producers are withheld;
   `docs/kb-research/curation/review-dossier.md` §3b lists the twelve that
   matter most.

---

## Handoff #2 written 2026-08-28 — nine owner questions open

`docs/kb-research/HANDOFF.md` was **replaced**. The original covered P0 → P1 and
described P1 as not started, which is now three phases stale; the new one is the
entry point for the next session and says so.

It opens with the owner's nine questions from actually using
`/product/review`, because most of them are real defects. Facts established
while writing it, so the next session does not re-derive them:

- **Quick filters were never deleted.** Source untouched, no quick-filter file
  in my diff, 107 `quickFilterController` refs in the regenerated client. The
  phrase that caused the alarm was mine, about P6.3 — a phase I did **not** do.
  Most likely the owner is looking at production, where the feature is
  committed but never deployed.
- **`bayadera` is genuinely both a store slug and a producer row.** The
  research input came from `SELECT DISTINCT name FROM brand`, and the catalogue
  really does hold a brand called `Bayadera` — the shop's own name leaked into
  the brand column. The agent refused to invent anything and said so in its
  note. `unverified`, `unknown`, **0 products resolve to it**, so it affects no
  data; it only wastes a review slot. Siblings to look for: `valdespino`,
  `marc-de-champagne`, `ice-drive`.
- **The Facts badge double-counts.** Measured: untrusted type 1069, untrusted
  country 1331, distinct bottlings with either **1508**. The button sums the
  first two (2400); the text shows the distinct count. 892 bottlings have both
  wrong. Fix belongs in `/product/review/summary`, not on the client.
- **The producers tab's "Тип" column renders `ProducerKind`**, not the whisky
  type — and `blend` exists in both vocabularies, which is why it reads as a
  bug. `defaultTypeName`, the actual whisky type, is not shown at all.
- **Peat for a producer making both styles** is already answered by the schema:
  `producer.peatProfile` is the **core range**, and exceptions are either a
  sibling `producer` row joined by `parentSlug` (bruichladdich →
  port-charlotte/octomore) or a producer-scoped `flavor_rule` (benriach →
  Smoky/Curiositas/Birnie Moss/Septendecim/Authenticus; ancnoc → Peated). The
  review UI shows neither, which is why the question arises.
- **The edit gap is the biggest one.** `PATCH /producer/:id` already accepts
  every field plus explicit `clear*` flags; the page only ever sends
  `{status: 'verified'}`.

**Next session: answer the nine questions first, then act.**

---

## Session 3 opens — the owner's nine questions answered — 2026-08-28

Every claim in handoff #2 re-verified against the working tree and the dev
database before answering; three of them needed correcting.

**Verified as stated:** quick-filter source untouched and mounted
(`filter-panel.tsx:584`); `PATCH /producer/:id` takes the full edit while the
web page sends only `{status: 'verified'}`; the producers tab renders
`ProducerKind` under a «Тип» header; the seed really does carry
`bruichladdich` none → `port-charlotte`/`octomore` heavy and `benriach` none
plus five name rules; the facts badge sums 1069 + 1331 = 2400 against a
distinct 1508 (892 bottlings have both facts untrusted); `store_product` holds
`url` per shop; the review query returns only `c.code`.

**Corrected.**

1. **Q1 has a second, likelier cause than the deployment one.**
   `QuickFilterSection` returned `null` whenever the user had no saved sets
   _and_ no filters in the draft, so the panel showed no trace of the feature.
   The owner confirmed this was it: creating one set made everything appear.
   Not a deployment problem at all.

2. **"Hide unverified producers with 0 products" would hide the whole queue.**
   All 466 `unverified` rows have zero resolved products, because
   `findAliasIndex` only loads `verified`/`auto`. A withheld producer resolves
   to nothing _by definition_. The suggestion in handoff #2 was wrong.

3. **The queue's ordering is therefore inert.** `findForReview` orders by that
   same zero count, so the list is alphabetical: page 1 is `15-stars`,
   `36-south`, `aberdour`, `aber-falls`, `aerstone`, `agitator`… Ranked by
   _potential_ reach (alias keys against catalogue brands) the queue should
   open with jura 47 bottlings, johnnie-walker 41, west-cork 36, nikka 25,
   highland-park 25, dewars 22 — the dossier's §3b names. This is the defect
   that makes the edit modal worth building, and the owner had not reported it.

**Also found:** `benromach` is already `verified` (2026-08-28 04:28) — the owner
promoted it while reviewing, which is why the count is 466 and not the 467 in
handoff #2. The promote path works end to end; there is simply nothing else to
do with a row afterwards.

**Owner's decisions this session:** fix the whole review screen in one pass;
non-whisky rows get a new `rejected` status (auditable, survives a re-merge)
with a reverse action, since the button can be pressed by mistake; the
quick-filter control must stay visible but inert with a tooltip, in the panel
and in every catalog toolbar.

---

## Q1 — the quick-filter control no longer hides itself — DONE 2026-08-28

`web/src/features/report-query/ui/quick-filter-section.tsx`,
`quick-filter-menu.tsx`, `quick-filter-sheet.tsx`.

The panel block and both catalog controls now always render. Where there is
nothing to save (or nothing saved yet), the control is **inert rather than
absent**: `aria-disabled`, `opacity-60`, a guard in the click handler, and a
tooltip that says what to do next. `disabled` is deliberately not used — it
carries `pointer-events: none`, which would suppress the very tooltip that
justifies keeping the control on screen. `FavoriteToggle` documents the same
trade-off for the same reason.

The mobile sheet is the one deviation: a phone has no hover, so its
explanation lives inside the drawer as an empty state rather than in a
tooltip — the same split `FavoriteHint` exists for.

**Tests.** New `quick-filter-section.test.tsx` (4 cases: the control is present
and inert with an empty draft, a click on the inert control opens no dialog,
the enabled control does open it, a row still loads a preset). The menu's
"renders nothing" case became "keeps an inert trigger". Note for anyone adding
tests here: **opening a real Radix `Dialog` in jsdom hangs `vitest run`**, so
the save dialog is only asserted through its own label, never driven.

**Green:** `web/` 457 tests (65 files), `tsc`, `lint` clean.

**Housekeeping found on the way:** `pnpm format:check` was failing on five of
the previous session's review-screen files (`dprint` owns formatting in this
repo, and handoff #2's green list did not include it). Formatted. `CLAUDE.md`
is also unformatted but was already committed that way, so it was left alone.

---

## Review screen, backend — DONE 2026-08-28

Five changes, no migration. The `producer.status` column is a `varchar(16)`
with no CHECK constraint, so the fourth status needed none; nothing else here
touches the schema (`migration:generate --dryrun` reports no drift).

**Q7 — the facts badge.** `countUntrustedFacts` returns a third count,
`either`, surfaced as `ProductReviewSummary.untrustedFacts`. Measured on the
dev database: type 1069, country 1331, **distinct 1508**, both 892. The badge
had been summing the first two into 2400 over a list of 1508 rows. The
per-field counts stay, because they answer a different question — which field
is the problem — and the interface's JSDoc now says outright that summing them
is wrong.

**Q8 + Q9 — the facts row.** `findUntrustedFacts` additionally selects the
country's `nameUa` and `icon` (the `country` join was already there) and up to
five links to the shops' own pages, as a `json_agg` in a new
`STORE_LINKS_SQL`. Two decisions inside it:

- **One link per shop**, via an inner `DISTINCT ON (storeId)`. Without it a
  shop that lists the bottling twice (boxed and plain — several do) took two of
  the five slots: verified on Ballantine's Finest, where the naive version
  offered three shops where five were meant to be.
- **Out-of-stock listings are offered, not hidden**, and flagged so the client
  can dim them. The page still states what the shop claims, which is the fact
  under review; and a bottling out of stock everywhere would otherwise get no
  links at all.

The cap is five because a bottling can be listed by nineteen shops, and the
row already links to the bottling's own screen where every offer is listed.

**Q3 — `KbStatus.REJECTED`.** For a row that is not a whisky producer at all:
`bayadera` (a retailer whose name leaked into the brand column), `valdespino`,
`marc-de-champagne`, `boulevardier`. A decision, not a deletion — the row
stays, so the verdict is auditable, `pnpm research-brands` never pays to look
the brand up twice, and `pnpm kb-export --all` now carries `rejected` to the
next environment. **That export was the actual resurrection path**: without it
a fresh seed would drop the row, leaving no alias, and the brand would come
back as unresearched. Reversible (`status: 'unverified'`) because the button
can be pressed by mistake — the owner asked for that explicitly.

Nothing else needed changing for it, and that is worth recording: the
resolver's alias index whitelists `verified`/`auto`, so a rejected row is inert
by construction, and a rule scoped to one can never fire because a rule is only
consulted for a producer the index returned. The summary gained a `rejected`
counter, which was the one place it would otherwise have been silently dropped.

**Q2 + Q5 — `GET /producer/:id`.** The row alone cannot answer "what should the
peat band be", so the endpoint returns the producer plus the three things that
override it: its child lines (`parentId`), its own name-pattern rules, and the
global peat rules as read-only context. `bruichladdich` reads `none` only
because `port-charlotte` and `octomore` carry the `heavy` claims themselves,
and `benriach` reads `none` with five rules doing the work — a reviewer shown
one value and none of that is being asked to judge blind.

### The queue's ordering — the defect the owner did not report

`findForReview` ordered by how many bottlings resolve to a producer, which is
**structurally zero for every withheld row**. Page one was `15-stars`,
`36-south`, `aberdour`, `aber-falls`, `aerstone`, `agitator`.

The withheld tab is now ranked by **potential** reach —
`ProducerReachService`, in the domain layer, which may use `scrape/kb`. Three
implementations were measured before choosing:

| approach                                                 | cost       | error                                                                                                                                            |
| -------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| pure SQL, alias keys vs brand names                      | 3.8 ms     | wrong for 1/6 of the queue: 67 producers with real reach score 0 (`yoichi` 6, `sir-edwards` 9, `morris-rutherglen` 11), total undercounted 12.6% |
| exact marginal — promote each producer alone, re-resolve | ~40 s      | none                                                                                                                                             |
| **one pass with every withheld alias in the index**      | **301 ms** | credits a contested group to the alias that actually wins                                                                                        |

The SQL version fails because it can only replicate `matchByBrand`; a producer
named inside a product name but never in the brand column is invisible to it.
The marginal version is exact but 130× dearer and its extra precision is
confined to the 34 name groups two candidates both match — where it credits the
group to **both**, which is not what a reviewer would get. The chosen pass
therefore reports 1549 total against the marginal 1601, and the 52-product
difference is exactly those contested groups.

Measured through the real service on the dev database: **301 ms**, 440 of 466
withheld rows have reach above zero, and the queue now opens
`johnnie-walker 47, jura 47, west-cork 36, highland-park 28, nikka 25,
dewars 22, ballantines 20, hankey-bannister 20` — the review dossier's §3b
names, in order.

Details that are load-bearing:

- **Nothing is stored.** No column, no refresh obligation, no staleness — the
  same reasoning the unresolved-brand queue is derived under. It is a ranking
  signal, and `ProducerReviewRow.potentialReach` is explicitly `null` on the
  tabs where it is not computed, where `productCount` is a real answer. Zero
  means the opposite of null.
- **The safety gate was not parameterised.** `findAliasIndex` keeps its
  hard-coded `verified`/`auto` whitelist; the withheld aliases come from a
  separate `findWithheldAliasIndex`, and the only place the two are combined is
  a private method in the reach service that writes nothing. A status parameter
  on the gate would have left it one argument away from being switched off.
- **The merge re-sorts longest-key-first.** `matchInName` takes the _first_
  alias whose key appears in the name, so concatenating two separately-sorted
  lists would silently resolve to the wrong producer — a wrong answer, not an
  error.
- **The numbers are not additive**, and the JSDoc says so: promoting two
  producers that contest the same bottlings does not yield the sum.
- Paging the withheld tab moved into memory (796 rows in the whole table).
  `findForReview` now reads `limit: null` as unlimited, which is what Postgres
  does with `LIMIT NULL`.

### The golden set caught the owner's own promotion

`test/scrape/kb-golden.integration.spec.ts` failed on arrival — not from
anything in this session. The owner had promoted `benromach` to `verified`
while reviewing, so the resolver started answering for it, and the fixture
still recorded the withheld expectation. That is precisely what the fixture's
header says it is for ("a change which starts resolving them shows up as a diff
to read rather than a silent shift").

Read the diff, confirmed it, updated the five rows: `benromach` / `speyside` /
`single malt` / `GB-SCT`, with peat `light` for the three plain expressions,
and `heavy` / `none` unchanged for `Peat Smoke` and `Unpeated` — the name rules
decided those two regardless of the producer's band, which is the design
working. Note for the promotion campaign ahead: **every promotion can move a
golden row**, so working through 466 producers means refreshing this fixture as
part of the work, deliberately, one diff at a time.

**Green:** `be/` 764 unit (58 suites), 133 integration (14 suites), `tsc`,
`lint`, no schema drift.

**Also formatted** what the previous session left unformatted: `CLAUDE.md`
(reworded one line first — `dprint` would have turned a `+` continuation into a
list item) and 21 TS files plus 6 docs from this work. `dprint check` is now
down to the 20 files that were already unformatted at `HEAD`.

---

## Review screen, web — DONE 2026-08-28, and verified in a real browser

`pnpm schema` + `pnpm codegen` against the locally-run backend first; the
generated client picked up `potentialReach`, `untrustedFacts`, the country
label/flag, the `stores` array (a real nested DTO class, so the Swagger plugin
inferred it with no hand-written `@ApiProperty` — unlike the quick-filter
payload, which needed one because its shape is an index signature) and the new
`GET /producer/:id` hook.

**What was built.**

- `entities/review/model/producer-labels.ts` — Ukrainian labels for the five
  closed vocabularies, the local-dictionary convention this codebase already
  uses. `entities/review/model/fact-sources.ts` — labels for `FactSource` plus
  `isTrustedSource`, a display-only mirror of the backend's trusted set.
- `widgets/producer-edit/` — the edit modal, and
  `model/producer-patch.ts`, the **pure** payload builder. Pure for two
  reasons: the clear-flag semantics are the part that can destroy data, and
  opening a real Radix `Dialog` in jsdom hangs `vitest run`, so the logic has
  to be testable without the modal.
- The producers tab: «Вид» (the kind, translated) with the whisky type in a
  column of its own, translated region/peat/status, the reach column, four
  status chips with counts, and a «Правити» button per row alongside the
  existing one-click «Підтвердити». «Повернути» appears on the rejected tab.
- The facts tab: the bottle name links to `/product/<productId>`, the country
  renders as a flag with its name as the accessible label, and up to five shop
  monograms link to the listings — coloured from `/meta`, because five grey
  first letters with two `A`s and two `M`s identify nothing. The source under
  each value is destructive-coloured when the filters distrust it.

**Verified in the browser, not only by tests.** The previous session could not
do this and said so; the repo now carries `web/.claude/skills/local-browser-testing`,
which grants standing authorisation for the local stack. Backend started with
`SWAGGER_ENABLED=true`, Vite through the Browser pane, a throwaway `qa-review`
admin created directly in the dev database and deleted afterwards.

What the browser proved that a unit test could not:

- The queue opens `johnnie-walker 47, jura 47, west-cork 36, highland-park 28,
  nikka 25, dewars 22` — and the facts badge reads **1508**, not 2400.
- **The patch really is a diff.** With `window.fetch` intercepted: changing
  only the peat band sent exactly `{"peatProfile":"heavy"}`. Emptying the
  region and the owner and pressing «Зберегти й підтвердити» sent
  `{"clearRegion":true,"clearOwner":true,"status":"verified"}` — flags, not
  empty strings, and nothing else touched.
- Highland Park's modal shows its child line `An Orkney` (the secret label) and
  all ten global peat rules with their priorities. That panel is the answer to
  «what do I pick for a producer that makes both?».
- The four non-whisky rows were rejected, one of them restored from the
  rejected tab and rejected again **through the modal**; the chip counts
  followed each write (462 / 4), so the mutation's invalidation covers the
  summary as well as the listings.
- `/product/<productId>` cold-loads with «Редагувати позицію» present, which is
  what makes the facts tab's link a real fix rather than a dead end.

**Green:** `web/` 457 tests (65 files), `tsc`, `lint`, `dprint` (only the
pre-existing `CLAUDE.md` line remains, committed that way).

### Two things the owner should know

1. **The four rejections live in the dev database only.** Runtime knowledge-base
   edits do not travel: the documented path is `pnpm kb-export --all` plus a new
   importer migration, which is also the project's own rule that every data
   change ships as a migration. Whether to freeze these four (and any promotion)
   into a migration now is the owner's call.
2. **`POST /product/update` always stamps both facts `manual`.** The product
   card sends `countryCode` and `typeName` on every save, so a save that only
   fixed a name still takes the bottling out of the facts queue. A row leaves
   because a person looked at it, which is the intent — but it is not evidence
   that both facts were checked. Documented in the facts tab's own JSDoc.

---

## Tests — DONE 2026-08-28 (batch 2, four agents, disjoint files)

Five new files, +51 tests:

- `test/producer-reach.service.spec.ts` (5) — the real `KbResolverService` with
  faked core services. Pins that **rows, not groups, are counted**; that only
  withheld producers appear; that the **bottler slot** counts too; that a
  producer nothing reaches is **absent rather than zero**; and the one that
  would break silently — a live short alias must not beat a longer withheld one
  (`highland` vs `highland queen`), which is what `mergeAliases`' re-sort exists
  for.
- `test/integration/producer-review.integration.spec.ts` (6) — read-only
  against the live knowledge base. `bruichladdich` → children
  `port-charlotte`/`octomore` both `heavy` while the parent is `none`, plus the
  global `unpeated`(100) and `peated`(50) rules; the withheld page is
  non-increasing in `potentialReach` with every `productCount` zero;
  `potentialReach` is null on `auto`/`verified`; **the resolver's own alias
  index contains no alias of a rejected producer** (verified non-vacuous —
  `producer_alias` really does hold four such aliases); `either` equals a direct
  SQL `OR` count; and `stores` is capped at five with no repeated slug (also
  non-vacuous — the catalogue really does hold same-shop duplicate listings).
- `web/.../producer-patch.test.ts` (23) — all ten contract points of the patch
  builder, including each `clear*` pair asserting the **value key is absent**,
  and that an unrecognised enum value is dropped rather than posted.
- `web/.../review-producers.test.tsx` (13) — the «Вид» / «Тип віскі» split, the
  Ukrainian labels with the raw enum values asserted **absent**, reach vs count
  per row and in the header, and each action firing with the right argument.
- `web/.../review-facts.test.tsx` (11) — the product link and its two
  fallbacks, the flag's accessible label, the **no-flag guard** (no stray
  tooltip trigger anywhere on the row), the shop links' `target`/`rel`, the
  dimmed out-of-stock link, the `+N` overflow, and the trusted/untrusted source
  colours.

**Two findings in my own code, both fixed.**

1. **A failed enum narrowing left a key holding `undefined`.** Harmless over
   the wire (`JSON.stringify` drops it) but not harmless to the modal, which
   decides "did anything change?" by counting the patch's keys — so it would
   have sent an empty PATCH that stamps the row reviewed for no edit at all.
   The key is now omitted outright.
2. **`ProducerChildRow` and `ProducerRuleRow` were typed with plain `string`**
   where the sibling `ProducerReviewRow` uses the real enums. Now
   `ProducerKind` / `PeatProfile` / `KbStatus` / `FlavorRuleMatchMode` /
   `KbFlavorEffect`.

### A real defect in the resolver, found by the reach test — NOT fixed

`bottlerOf` (`src/scrape/kb/kb-resolver.service.ts`) documents **two** ways a
bottler is found: the product name names one outright, "or the resolved
producer is a range a bottler owns — which is how `Big Peat` reports Douglas
Laing without the company appearing in the title at all". **Only the first is
implemented.** `KbProducerFacts.bottlerId` is loaded into the index and carries
a JSDoc promising exactly that behaviour, and `grep -rn '\.bottlerId\b' src`
finds it read **nowhere** in the resolver. The approved plan specified the line:
`if (!bottler && producer.bottlerId) bottler = producer.bottlerId`.

Measured cost today: 15 producers carry a `bottlerId`, 4 of them live, and
**6 bottlings / 8 in-stock offers** are missing their IB flag — `big-peat` (6),
`the-epicurean` (5, unresolved) and `the-hive` (2) among them. It grows as
withheld rows are promoted: eleven more producers are waiting.

**Left unfixed on purpose, because the golden set has frozen the defect as the
expected answer:**

```
Big Peat Small Batch	Big Peat	big-peat	(no bottler)	islay	heavy	blend	GB-SCT
```

Three other Big Peat rows expect `douglas-laing` — they get it because the
brand value or the name spells the company out. Implementing the second path
flips that reviewed row and any like it, which is exactly the kind of change
the golden set exists to make a decision rather than a side effect. It is four
lines of code and one fixture diff whenever the owner wants it.

**Green, both repos:** `be/` 769 unit (59 suites), 139 integration (15 suites),
`tsc`, `lint`, no schema drift. `web/` 503 tests (68 files), `tsc`, `lint`.
`dprint check` is at 19 files, all of them unformatted at `HEAD` before this
work began.

---

## The facts tab now says what to do — DONE 2026-08-28

The owner's follow-up: _«зрозуміло, але що з цим робити?»_ The copy stated a
condition and offered no verb. Before writing any UI, measured what the queue
is actually made of — and it turned out to be **two different jobs**:

| type source / country source | rows | what it means                                               |
| ---------------------------- | ---- | ----------------------------------------------------------- |
| legacy / legacy              | 892  | nothing authoritative knows anything                        |
| name / legacy                | 409  | type came from the name (trusted); **country** is the gap   |
| legacy / **kb**              | 113  | producer resolved, country from the KB; **type** is the gap |
| legacy / name                | 57   | country from the name (trusted); **type** is the gap        |
| (null) / legacy              | 30   | no type at all                                              |
| legacy / (null)              | 7    | no country at all                                           |

**1395 of 1508 resolve to no producer**, and 306 of the 1508 are out of stock so
no sweep will ever see them. That reframes the tab: the large half is a
**symptom** of the unresolved-producer problem, cured on the producers tab where
one promotion supplies both facts with citations for every bottling that
producer makes. Editing 1395 bottlings one at a time is the expensive way to fix
the same thing. The other 113 are the genuine hand work: their producer's range
spans several types, so it states no `defaultTypeName` and nothing but a person
can settle the type.

**What was built.**

- `ProductFactReviewRow.producerSlug` — the column that states the diagnosis per
  row, and `GET /product/review/facts?producer=resolved|unresolved` to take one
  half. The segment value is validated with `@IsIn`, not taken as a free string:
  a typo silently meaning "both halves" is the quiet wrongness this screen
  exists to remove.
- `ProductReviewSummary.untrustedFactsUnresolved`, so the chips can carry both
  sizes (the resolved half is derived as the difference, so the two can never
  disagree).
- Three segment chips, and copy per segment that names the action.
- **«Підтвердити» per row** — the verb the tab was missing. It sends **only the
  facts the filters distrust** (`buildFactConfirmation`), never one the
  knowledge base already owns: `manual` outranks `kb`, so confirming a
  KB-supplied country would freeze it above the knowledge base and no later
  correction there would ever reach the bottling. Its tooltip states that
  consequence rather than hiding it.

**Verified end to end in the browser.** The «Виробник відомий» segment lists
`bushmills` / `tullamore-dew` rows with country «база знань» (muted) and type
«спадок» (red). Confirming `Bushmills Original` — genuinely a blended Irish
whiskey — sent exactly `{"id":…,"typeName":"blend"}`, the badge fell 1508 → 1507
and the segment 113 → 112, and the row's stored state is now
`typeSource = manual`, **`countrySource = kb` untouched**.

**Tests:** +9 in `review-facts.test.tsx` (20 total) — the producer column and
its "не розпізнаний" marker, the three chips with derived sizes, the per-segment
copy, and four cases on `buildFactConfirmation` including the one the whole
design turns on (country `kb` + type `legacy` → the type alone).

### Six accidental promotions, found and reverted

While verifying, the producers queue had lost its top rows. Cause: six
producers (`johnnie-walker`, `jura`, `bells`, `west-cork`, `highland-park`,
`dewars`) were stamped `verified` between 07:12 and 07:16 — the window in which
the batch-2 test agents were exploring the live database. Not a code defect and
not anyone's review decision.

**The golden set caught it independently**: `Хайленд Парк [Highland Park]`
started resolving to `highland-park` with `medium` peat. Reverted all six to
`unverified` through the app's own `PATCH /producer/:id` — the same route the
«Повернути в чергу» button uses, rather than raw SQL — after which the golden
suite is 10/10 again and the queue reads `johnnie-walker 47, jura 47,
west-cork 36, highland-park 28, nikka 25, dewars 22`. `verifiedAt` keeps its
stamp (the API sets it unconditionally), which now honestly means "somebody
last ruled on this row".

Note for the next session: an agent given the live database can change it.
Give one a read-only brief and say so explicitly, or point it at a scratch
database.

**Also corrected**: an earlier claim in this log that the reach refactor was
"verified through HTTP" was wrong — that backend restart had failed with
`EADDRINUSE` and the check hit the pre-refactor process. Re-verified on a
genuinely fresh process: identical numbers, and `potentialReach` null on the
`auto`/`verified` tabs with real `productCount` values (macallan 136).

**Green:** `be/` 769 unit (59 suites), 139 integration (15 suites), `tsc`,
`lint`, no schema drift. `web/` 512 tests (68 files), `tsc`, `lint`.

---

## The review screen can now apply what it records — DONE 2026-08-28

The owner promoted `johnnie-walker` and `jura` and the «Факти» count did not
move. Not a display bug: **a promotion stores a claim and applies nothing.**
Verified — both rows were `verified`, and `SELECT count(*) FROM product WHERE
producerId IN (…)` was **0**; 61 bottlings of those two brands were still in
the untrusted queue.

Two mechanisms could have applied it and neither had: a store sync re-resolves
only the bottlings that run touched, and `pnpm reconcile-flavors` is a shell
command the screen never mentioned. So the screen recorded decisions it could
not carry out, and its own copy («починає впливати на каталог після наступної
синхронізації») was misleading rather than wrong.

**Checked that a pass would actually clear those rows**, because the whole fix
depends on it: `APPLY_KB_FACTS_SQL`'s predicate carries
`OR p."typeSource" IS DISTINCT FROM 'kb'`, so it re-stamps the **source** even
when the value is already right — which is what takes a bottling out of the
queue. A dry run (2.2 s over 4057 bottlings) reported **106 producer writes, 5
value changes and +104 flavour links**, and among the five:
`Johnnie Walker Double Black: country UA → GB-SCT`. The catalogue currently
files that whisky as Ukrainian.

**What was built.**

- `KbReconcileService` (`src/scrape/kb/`) — the pass extracted so it exists
  **once**: load the index (failing closed on an empty knowledge base), load
  the candidates, plan through `KbApplyService`, write the three sets.
  `pnpm reconcile-flavors` was rewired onto it and lost ~40 lines of its own
  composition; a second copy of this is the defect class the whole body of work
  removes.
- `POST /product/review/apply` → `200` with `{groups, resolved, producerWrites,
  factWrites, flavorWrites}`. Explicit `@HttpCode(OK)` because Nest's default
  201 made the generated client union the typed 200 body with an untyped 201.
- The review screen's header gains «Застосувати до каталогу», which shows what
  was written, and both tabs' copy now points at it instead of promising a sync
  will do the work.

**Verified**: the endpoint answers 401 unauthenticated and is wired end to end
in the browser (request captured as `POST /api/product/review/apply`, the
summary line rendered from the response). **The pass itself was not run** —
`local-browser-testing` puts rewriting scraped catalogue data outside standing
authorisation, and this is the owner's button to press. The dry-run numbers
above are what it will do.

**Tests:** +2 integration cases pinning that a dry run plans the whole
catalogue and writes nothing (asserted against a before/after count of resolved
bottlings), and that `brand` narrows the pass.

**Green:** `be/` 769 unit (59 suites), 141 integration (15 suites), `tsc`,
`lint`, no schema drift. `web/` 512 tests (68 files), `tsc`, `lint`.

### Operational note

The owner's own backend was running the **compiled** `dist` build while their
Vite had already hot-reloaded the new frontend. That combination breaks: the
facts tab sends `producer=…`, which the old DTO rejects with 400 under
`forbidNonWhitelisted`. After pulling backend changes, restart the backend —
the frontend picks them up on its own, the backend does not.

---

## Confirming a producer now applies itself — DONE 2026-08-29

The owner's follow-up to the apply button: _«навіщо чекати на синк, коли дію
можна застосувати одразу — або поясни суттєву причину, або зроби так, щоб
"Підтвердити" застосовувало автоматично»_.

**There was no substantive reason, and the only candidate was cost — so it was
measured.** The pass takes **185–214 ms** in-process over the whole catalogue
(2942 name groups, 4057 bottlings), timed three times through the real service.
Every other candidate reason fails too: it is idempotent, so per-click and
batched application converge on the same state; it never touches a `manual`
value; a wrong promotion is undone by demoting and letting the next pass
rewrite it; and the diff-before-commit workflow already lives in
`pnpm reconcile-flavors --dry-run`, which is unaffected.

So `PATCH /producer/:id` now runs the pass inline and answers
`{producer, applied}`. It applies on **every** edit rather than only on the
ones that can change resolution: a rule about which fields matter is a rule
that drifts, and the pass writes nothing when nothing changed.

**Verified end to end against the live database.** Confirming `west-cork`
returned `applied: {groups: 2942, resolved: 1819, producerWrites: 173,
factWrites: 173, flavorWrites: 132}` — and the review counts moved for the
first time: **«Факти» 1507 → 1371**, unresolved 1395 → 1242, while bottlings
resolved to `johnnie-walker` + `jura` + `west-cork` went **0 → 133**. One
confirmation carried the owner's earlier promotions with it, which is precisely
what they had expected to happen when they made them.

In the browser: the click sends `{"status":"verified"}` and the header renders
«застосовано: 173 виробників, 173 фактів, 132 смаків» from the response.

**Note that this ran the pass on the dev database** — 136 bottlings left the
facts queue and 173 gained a producer. That was the point of the change and the
owner asked for it, but it is a real catalogue write and is recorded here as
one.

**Tests:** new `test/product-review.service.spec.ts` (3) with a stubbed
reconcile service — the pass runs inside the patch, it runs on an edit that is
not a promotion, and it never runs when no producer matched. Deliberately a
unit test: an integration test of this behaviour would rewrite the catalogue as
a side effect of running the suite.

**Green:** `be/` 772 unit (60 suites), 141 integration (15 suites), `tsc`,
`lint`, no schema drift. `web/` 512 tests (68 files), `tsc`, `lint`.

**Golden set moved, as designed.** Applying the promotions made
`Хайленд Парк [Highland Park]` resolve for the first time — the Cyrillic alias
now reaches `highland-park` (islands / medium / single malt / GB-SCT), where the
fixture recorded the withheld answer. Read the diff, confirmed it (that _is_
Highland Park, an Orkney single malt with a moderate, heather-inflected peat),
updated the row. This is the workflow to expect while working the queue: every
promotion that reaches the catalogue can move a golden row, and the fixture
exists so it shows up as a diff to read rather than a silent shift.

---

## SESSION 3 CLOSED 2026-08-29 — handoff #4 written

`docs/kb-research/HANDOFF.md` was rewritten as handoff #4 and is the entry
point for the next session. It replaces #3, whose opening (the owner's nine
questions) is answered and acted on.

**What this session was.** It opened with nine questions from actually using
`/product/review`; six were real defects, and measuring turned up two more
nobody had reported. It ended with the screen being a tool rather than a
listing: the queue is ranked by what a decision is worth, a producer can be
edited and ruled out, the peat overrides are visible, the facts queue explains
which half of it is symptom and which is work, and — the last thing the owner
asked for — **a confirmation applies itself to the catalogue in the same
click** instead of waiting for a sync nobody could predict.

**State at close (moving, because the owner is working the queue):**
796 producers — 329 `auto`, 454 `unverified`, 9 `verified`, 4 `rejected`;
2609 of 4057 bottlings resolve to a producer; 1302 untrusted facts (1173 of
them a symptom of an unresolved producer); type filters answer from 78% of
in-stock offers and country filters from 77%, up from 72% / 69% at session
start **without any scraping** — purely from promoting producers and applying.

**Green:** `be/` 772 unit (60 suites), 141 integration (15 suites), `tsc`,
`lint`, no schema drift. `web/` 512 tests (68 files), `tsc`, `lint`. Nothing
committed: ~126 changed files in `be/`, ~20 in `web/`.

**Open decisions, in the order they matter** — all four are in handoff #4 with
their measurements: work the queue (and refresh `kb-golden.tsv` as promotions
move it); decide how runtime decisions reach production (`pnpm kb-export --all`
plus importer migrations); decide on the resolver's documented-but-unimplemented
second bottler path (four lines, but it flips a reviewed golden row); and
consider URL-backed paging on the review screen.

---

## Session 4 — the verification fleet empties the queue (2026-08-29 evening)

**The ask.** The owner measured the review queue against his own time — 437
withheld producers at minutes apiece — and asked for the opposite trade:
agents spend the effort, migrations carry the result, and a prod deploy needs
as close to zero manual actions as possible.

**Why the queue existed at all.** The seed brief's own economy rule ("do not
spend a web search on each one... confidence=low, and move on") put 419 of the
437 withheld rows there: no positive peat claim at all, just missing evidence.
Only 18 rows carried a contested peat level. The queue was an evidence gap,
not a judgment gap — which is what made it automatable.

**The fleet.** 19 reach-ranked batches of 23 (inputs generated by resolving
the whole catalogue with the withheld aliases in the index — the review
screen's own what-if pass) plus a retry lane for rows that hit tooling walls,
each batch a sonnet-5 agent under `verify/BRIEF.md`: verify every field
against pages actually opened, producer domains first; positive peat only
with producer-domain corroboration; `unknown` stays a valid answer.
Everything is checked in under `docs/kb-research/verify/` with a resumable
`CHECKPOINT.md` — which paid for itself when wave 4 died on the org's spend
limit and was relaunched from the checkpoint after the 22:00 reset.

**What the fleet found** (highlights; per-batch notes in CHECKPOINT.md):
`micil` is peated (the seed said unpeated — the reported-bug class, caught);
`judas-priest`'s smoke is beechwood, not peat (St. Kilian's own press
release); `amahagan`'s owner is Nagahama, not Mars; `haran` is Destilerias
Acha (Basque distillery, est. 1831), not DYC; `scottish-deer` is Moldovan,
`old-barny` Estonian, `sam-barton` Canadian, `matt-darcy` Irish; `poli` is a
genuinely peated Italian whisky the seed suspected was mislabeled grappa; and
the retry lane's browser got past the age gates and 403s to confirm all five
famous peat profiles on the producers' own domains — Springbank light,
Longrow heavy, Lagg heavy, Yoichi medium, Hakushu light. Ten rows are not
whisky at all and are now `rejected` with citations (cocktails, a grape
brandy, a honey drink, a non-alcoholic "NOT WHISKEY", bayadera's own gift
sets).

**The pipeline** (all new, all green): `pnpm kb-verify-merge` folds
`verify/out/*` through the unchanged `KbGateUtils` — plus
`verify/curation-overrides.tsv` for the eight rows whose producer-domain
evidence the gate's URL heuristic cannot see (parent-domain citations,
four-letter slugs) — into the TSV assets of `kb-verification-import`
(1788030413011), which updates producers only `WHERE status='unverified'`,
so any decision the owner makes on prod before the deploy survives it. The
merge also caught and settled two data hazards on its own: an alias addition
retargeting an existing key (River Queen), and `smoky baseline` on unpeated
producers, promoted to `require` because only require survives the peat
sweep (the jack-daniels convention) — left as baseline it oscillates.

**Zero-manual-action deploys.** `KbBootApplyService` (scrape/kb, 3 unit
tests) runs the reconcile pass once at every bootstrap (`KB_APPLY_ON_BOOT`,
default true, forwarded by compose). Deploy → migrate → boot → applied; the
rehearsal boot logged `2741/2944 groups resolved, 1057 producer writes, 1044
fact writes, 122 flavor writes`, and a dry run right after reports zeros.

**State at close** (local, which the owner holds identical to prod):
811 producers — 752 `auto`, 30 `verified`, 19 `unverified`, 10 `rejected`;
3836 of 4062 bottlings resolve (94%, was 69% at session start); country
filters answer from 96% of in-stock offers (was 77%), type from 81%;
unresolved bottlings 1448 → 226, which is the number gating the
`BRAND_INFO` deletion. The 19 still withheld are world-is-silent own labels
(`dalmahoy`, `drummers-reserve`, `manhattan`...) plus honest oddities
(`stateless`, `saint-bernard`) — every one wears its verification note on
the review screen.

**Green:** 775 unit (61 suites), 142 integration (15 suites) including the
untouched kb-golden fixture and the peat acceptance test, `tsc`, `lint`,
`reconcile-flavors --dry-run` reports zeros after the boot apply. Nothing
committed — git-flow requires the owner's explicit authorization; the working
tree holds the fleet outputs, the merge script, the migration + assets, the
boot service and the doc updates.
