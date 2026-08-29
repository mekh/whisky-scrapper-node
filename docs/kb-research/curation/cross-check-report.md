# P1.7 — cross-checks over the merged seed

Three deterministic checks were run over `docs/kb-research/seed/`. Each one is
an independent authority the research never saw, so where it disagrees the
disagreement is evidence rather than noise. What each check concluded is
recorded here; what it changed is in `overrides.tsv`, one row per decision.

The authorities are checked into the repository beside this file:
`reference/wikipedia-scotland-distilleries.tsv` (259 rows) and
`reference/wishart-86-distilleries.csv` (the Wishart 86 x 12 sensory table).
`BRAND_INFO` is read straight out of
`src/scrape/normalize/brand-info.constants.ts` — 231 curated country+type
pairs.

## A. Wikipedia — region and owner

**3 region disagreements, 1 real.**

- `ancnoc` — seed `highland`, Wikipedia `speyside`. Both are right about
  different questions, which is what the two columns exist for: Knockdhu sits
  inside the protected Speyside region and markets itself as a Highland malt.
  `region` stays `highland`, `legalRegion` becomes `speyside`.
- `adelphi` and `burnside` are false positives. The seed rows are the Adelphi
  _bottler_ and the teaspooned Balvenie brand; Wikipedia's rows are two closed
  distilleries that happen to share those names. Nothing changed.

**34 owner disagreements, 4 real.** The rest are cosmetic: the seed writes
`Chivas Brothers (Pernod Ricard)` where Wikipedia writes `Chivas Brothers`.
`owner` is a reference field — no filter, no resolution, no derived tag reads
it — so restating 30 rows to match a second spelling would be churn. What was
worth taking: three empty owners filled (`daftmill`, `kilchoman`, `nc-nean`)
and one wrong one corrected (`clydeside` named the distillery, not Morrison
Glasgow Distillers). `deanston` was left as the seed has it: agent 16 read the
distillery article, which says CVH Spirits, and the list article still says
Distell.

**84 Wikipedia distilleries have no seed row.** Every one is either closed or
brand new with nothing in the catalogue — P1.5 already added the 63 operating
ones that were missing.

## B. Wishart — peat band. **A review trigger, never an authority.**

This is the check whose interpretation matters most, and applying it naively
would have been the single most damaging thing in this phase.

Wishart's `Smoky` is a **0–4 sensory intensity from a tasting panel**, not a
peating specification. Read as a band ladder — `1` = light, `2` = medium — it
asserts that Glenfiddich, Macallan, Glenlivet, Glenfarclas, Aberlour and 30
others are smoky (all score `Smoky 1`), and that Bruichladdich, Dalmore,
Clynelish, Mortlach, Dalwhinnie and Glendronach are **peated** (all score `2`).
Bruichladdich's own marketing is that it is unpeated. That is the Tobermory bug
wearing a different hat: a fact-shaped number turned into a tag.

So only the plan's actual rule was applied — **heavy iff `Smoky >= 3` or
`Medicinal >= 2`** — and only as a signal to look at a row, never as a value to
write. It flagged four:

| slug            | seed  | decision                                                                                                                                                                                                                                                                    |
| --------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bruichladdich` | none  | **kept none.** The classic range is unpeated by the distillery's own statement; `port-charlotte` and `octomore` are separate rows with `heavy`. The Wishart sample predates that split.                                                                                     |
| `clynelish`     | none  | **changed to light.** `Smoky 3 / Medicinal 3` is the strongest signal in the table for a row the seed called unpeated, and Clynelish's waxy coastal smoke is well attested. `light` records smoke without claiming peat. Its heavily peated neighbour Brora is its own row. |
| `jura`          | none  | **changed to light**, agreeing with the three agents who cited a lightly peated core.                                                                                                                                                                                       |
| `oban`          | light | **kept light.** Already smoky, not peated.                                                                                                                                                                                                                                  |

**21 Wishart distilleries have no seed row** — all closed or absent from the
catalogue.

## C. BRAND_INFO — country and type

**5 country disagreements, 2 taken.** `compass-box` and `o-brian` adopt
`GB-SCT`: the column describes where the whisky is from, and a London blender's
Scotch is Scotch. Three are BRAND_INFO defects rather than seed defects, worth
recording now because P6.4 deletes that constant:

- `pokeno` — BRAND_INFO says Scotland; Pokeno is a New Zealand distillery.
- `berry-bros-rudd` — a London merchant bottling several countries' whisky; a
  single country on a bottler row states nothing, and the resolver never reads
  it anyway (a bottler hands the facts to the in-name distillery).

**2 type disagreements, 0 taken.** `naked-grouse` is a blended malt, which this
taxonomy spells `malt`, where BRAND_INFO says `blend`; `coalition` is a rye,
where BRAND_INFO says `bourbon`. The seed is more precise in both.

**40 BRAND_INFO keys resolve to no producer** — mostly stripped brand keys
(`glen`, `mac`) that were never spellings a catalogue row uses.

## D. The peat disagreements the merge reported

33 producers had two agents claim different peat levels. Filtering them by
whether the disagreement changes a **tag** — `none` and `unknown` produce no
tags, `light` produces `smoky`, and `medium` and `heavy` both produce
`peated` + `smoky` — leaves **8 that matter**. The other 25 are `none` versus
`unknown` (the informed value already wins on score) or `medium` versus `heavy`
(`caol-ila`, `torabhaig` — identical tags either way).

| slug          | claims                 | resolution                                                                                                                                                                             |
| ------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `springbank`  | light / medium         | **light.** The brief's own calibration says light; `medium` would have tagged every Springbank `peated`. Longrow is the peated sibling and has its own row.                            |
| `macduff`     | light / none / unknown | **none.** The lightly peated claim is about The Deveron, which is a separate row parented to Macduff.                                                                                  |
| `jura`        | light / none           | **light.** See B.                                                                                                                                                                      |
| `the-deveron` | light / none           | **kept light.** It is the branded, lightly peated expression — the other half of the `macduff` decision.                                                                               |
| `speyburn`    | light / none           | **kept light**, cited, and the direction is mild (`smoky` only).                                                                                                                       |
| `ardmore`     | light / medium         | **kept medium.** Ardmore is the Highland distillery that fully peats its standard malt; a peat-avoiding user wants it excluded. Flagged for the owner — 12–14 ppm is arguably `light`. |
| `hibiki`      | light / none           | **kept none.** The `light` claim was self-described as inferred; the `none` claim was cited.                                                                                           |
| `port-askaig` | heavy / unknown        | **kept heavy, and it stays `unverified`** — an undisclosed Islay distillery is exactly what the auto-gate is meant to withhold.                                                        |

## What changed, in total

Eleven `overrides.tsv` rows and one added producer (`early-times`, whose alias
agent 17 wrote without a row — the merge had been reporting it as a dangling
reference). Seed after curation: **796 producers, 227 live, 1040 aliases, 45
flavors, 92 rules, 0 rejected, 0 dangling references.**
