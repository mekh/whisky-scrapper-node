# Whisky Metadata Enrichment: Problem Analysis and Proposed Architecture

**Context:** A price/availability tracker for Ukrainian whisky retailers. Daily scrapes build a
historical price database with per-product offer aggregation and search. When a new product is
discovered, its name/age/volume/etc. are sent to an LLM, which is expected to return:

- country of origin of the brand
- flavour descriptors (smoky, peated, vanilla, honey, …)
- whisky type (single malt, blended malt, blended, rye, bourbon, …)

**Reported failure:** `Tobermory 12yo` was tagged `smoky` and `peated`. It is neither. Because the
user filters out peated whisky, one of his favourite malts was silently excluded from every result
set. Missing coverage was also noted for Scottish regions and independent bottlers.

---

## 1. Diagnosis: this is not a knowledge-gap problem

The framing ("the model was trained on bad data → I need RAG or a ready-made database") is wrong,
and none of the three candidate solutions proposed (RAG, buy a dataset, scrape producer websites)
addresses the actual defect.

### 1.1 The Tobermory error is a deterministic entity collision, not a hallucination

Tobermory distillery on the Isle of Mull runs **two brands from one site**:

| Brand       | Malt spec                                                  | Profile               |
| ----------- | ---------------------------------------------------------- | --------------------- |
| `Tobermory` | unpeated                                                   | fruity, waxy, coastal |
| `Ledaig`    | heavily peated (commonly cited ~35–40 ppm phenols in malt) | smoke, iodine, ash    |

An LLM asked to infer flavour from a _name_ is really inferring from a _place_. "Tobermory" pulls
the entire semantic neighbourhood `Isle of Mull → island whisky → maritime → peat → Ledaig`. This is
reproducible, not stochastic. The same collision will break, at minimum:

- **Bunnahabhain** — Islay, but the core range is unpeated; only the `Mòine` range is peated
- **Bruichladdich** — `Classic Laddie` unpeated; `Port Charlotte` / `Octomore` heavily peated
- **Springbank** — three peating levels on one site: `Hazelburn` (unpeated), `Springbank`
  (lightly peated), `Longrow` (heavily peated)
- **BenRiach**, **Jura**, **Tomatin** (`Cù Bòcan`), **Glen Scotia**, **Wolfburn**, **Raasay**,
  **Loch Lomond** (`Inchmoan`, `Croftengea`)

**RAG over tasting notes will make this worse, not better.** Nearly every published text about
Tobermory mentions Ledaig in the same paragraph. Naive retrieval will surface exactly the wrong
context.

### 1.2 The schema forces a lossy decision

The current schema asks for a boolean: `smoky: true/false`. Peatiness is a **scalar**. Here is real
data from the canonical Wishart dataset (86 distilleries, 12 dimensions, 0–4 scale — see §4.1):

| Distillery    | Smoky | Medicinal |
| ------------- | ----: | --------: |
| Ardbeg        |     4 |         4 |
| Lagavulin     |     4 |         4 |
| Laphroaig     |     4 |         4 |
| Caol Ila      |     4 |         2 |
| Talisker      |     3 |         3 |
| Bowmore       |     3 |         1 |
| Highland Park |     3 |         1 |
| Springbank    |     2 |         2 |
| Aberfeldy     |     2 |         0 |
| **Tobermory** | **1** |     **0** |
| Glenfiddich   |     1 |         0 |
| Glen Grant    |     0 |         0 |

Note that the _median_ `Smoky` score among unpeated malts is 1–2, not 0. Some degree of
smoke/char/phenol is nearly universal. A boolean tag forces the model to pick an arbitrary cut point,
and it will pick the wrong one in every borderline case.

The Tobermory bug disappears with a single predicate: `WHERE smoky <= 2`.

### 1.3 There is no provenance

Attributes are stored bare — no record of where each value came from, how confident it is, or when
it was written. Consequences:

- errors cannot be debugged, only noticed
- manual corrections get overwritten by the next nightly enrichment run
- there is no way to distinguish "unpeated" from "we don't know whether it's peated"

Adding a `source_type` column is the single highest-leverage change in this entire document.

### 1.4 The token-cost concern is overstated by 1–2 orders of magnitude

Order-of-magnitude estimate for the Ukrainian market:

| Quantity                                                        | Estimate     |
| --------------------------------------------------------------- | ------------ |
| Total SKUs across all monitored shops                           | 8,000–20,000 |
| Unique products after dedup                                     | 3,000–6,000  |
| New products per day (raw)                                      | 30–80        |
| New products per day (after cross-shop dedup)                   | 10–30        |
| Tokens per enrichment call (candidates + instructions + output) | ~3,500       |
| Tokens per day                                                  | ~100,000     |
| Tokens per month                                                | ~3,000,000   |

At flagship-model list pricing (order of $15 per million input tokens — verify current rates), that
is **tens of dollars per month**, before caching. With content-hash caching (one call per unique
normalised title, not per shop listing) and the Batch API (50% discount), it drops to single-digit
dollars. Occasional web search for the 2–5 genuinely unresolved products per day adds 10–20k tokens
each — negligible.

**The real cost centre is human curation hours**, and that is where the budget should go.

---

## 2. Proposed architecture: canonical entities + deterministic inheritance

### 2.1 The scale insight that changes everything

- Operating Scotch malt distilleries: **~150**
- Closed Scotch distilleries that realistically appear in IB bottlings: **~60**
- Ireland: ~50 · Japan: ~30 relevant · Rest of world: ~100 relevant brands
- Independent bottlers reaching the Ukrainian market: **30–60**

Total: **a 1,000–1,500 row lookup table.** This is not an AI problem. It is a weekend with a
spreadsheet and a reference book.

Once that table exists, the LLM's job changes from **"emit facts"** to **"parse a string and match
it to one of these 8 candidates."** LLMs are reliable at the second task, and — critically — the
output is _verifiable_.

### 2.2 Schema

```sql
distillery (
  id, canonical_name,
  aliases        text[],   -- INCLUDING Cyrillic transliterations
  country,
  legal_region,            -- Tobermory → 'Highland'
  common_region,           -- Tobermory → 'Island'
  status, owner, founded, closed,
  peat_default   text,     -- unpeated | light | medium | heavy | mixed
  wikidata_id, whiskybase_id
);

brand (
  id, name, aliases text[], owner,
  category_hint,
  distillery_id  nullable  -- NULL for blends / undisclosed sources
);
-- Johnnie Walker, Monkey Shoulder, Smokehead, Finlaggan, Big Peat…

bottler       (id, name, aliases text[], type);  -- OB | IB | retailer
bottler_range (id, bottler_id, name, aliases text[], reveals_distillery bool);
-- Douglas Laing → Provenance, Old Particular, XOP, Big Peat, Scallywag, Rock Oyster

flavour_profile (
  entity_type, entity_id,               -- distillery | brand | expression
  body, sweetness, smoky, medicinal, tobacco, honey,
  spicy, winey, nutty, malty, fruity, floral,   -- smallint 0..4
  source, confidence, as_of
);

expression (                            -- the canonical product
  id, distillery_id, brand_id, bottler_id, range_id,
  age, vintage, bottled_year, abv, cask_type, batch,
  category,                             -- legal category (see §2.6)
  peat_override
);

attribute_provenance (
  expression_id, attribute, value,
  source_type,   -- human | distillery_default | name_signal | cask_rule
                 -- | grounded_extraction | llm_guess
  source_ref, confidence, created_at
);

listing (shop_id, raw_title, expression_id, match_confidence, price, seen_at, …);
```

**Rule:** an attribute whose only `source_type` is `llm_guess` is **not exposed in filters**. It may
be shown as a greyed-out hint. That one rule kills most of the current error surface.

### 2.3 Normalisation and transliteration — the most underestimated bug

Ukrainian retailers write titles like:

```
Віскі Тобермори 12 років 0.7л в подарунковій упаковці
Уiски Лафройг Квотер Каск 48% 0,7 л
Гленфiддiх 15 Solera Reserve
```

Without a Cyrillic↔Latin layer, the pipeline will keep minting duplicate entities. Pipeline steps:

1. **Unicode normalisation (NFC)**, strip `Віскі/Виски/Уіскі/Whisky/Whiskey`, volume, ABV,
   `в тубусі`, `подарункова упаковка`, retailer boilerplate.
2. **Regex grammar** for structural fields:
   - age: `\b(\d{1,2})\s*(yo|y\.?o\.?|years?|років|року|лет)\b`
   - ABV: `\b(\d{2}[.,]\d)\s*%`
   - volume: `\b(0[.,]\d{1,2}|\d{2,4})\s*(л|l|ml|мл)\b`
   - modifiers: `Cask Strength`, `Sherry Finish`, `Single Cask`, `Batch \d+`, `Small Batch`,
     `Peated`, `Heavily Peated`, `PX`, `Oloroso`, `Port`, `Virgin Oak`
3. **Bidirectional transliteration** (uk→en and en→uk) so `Тобермори`, `Тобермері`, `Тоберморі`
   all reach `Tobermory`. Maintain the alias table as a growing artefact; every unmatched token goes
   into a review queue.
4. **Candidate generation:** `pg_trgm` similarity over `aliases` (Latin + transliterated Cyrillic),
   plus `pgvector` with a multilingual embedding model as a second independent channel. Union → top 8.
5. **LLM as tie-breaker only:** input = raw title + 8 candidates with their aliases. Output = one id
   **or `none`**. Allowing `none` is mandatory; without it the model will always pick something.

After this step, attributes are **inherited, not generated**.

### 2.4 Deterministic inheritance precedence

| Priority | Source                               | `source_type`        | Example                                                                      |
| -------: | ------------------------------------ | -------------------- | ---------------------------------------------------------------------------- |
|        1 | Manual override                      | `human`              | you fixed it once, forever                                                   |
|        2 | Expression override                  | `human`              | `Bunnahabhain Mòine` → heavy                                                 |
|        3 | Signal in the product name           | `name_signal`        | `Peated`, `Heavily Peated`, `Mòine`, `Port Charlotte`, `Islay Cask Finish`   |
|        4 | Cask rule                            | `cask_rule`          | PX → fig/chocolate, winey +1; ex-bourbon → vanilla/honey; virgin oak → spice |
|        5 | Distillery default + flavour profile | `distillery_default` | Tobermory → unpeated, smoky=1                                                |
|        6 | Brand default                        | `distillery_default` | blends with undisclosed sources                                              |
|        7 | Nothing                              | —                    | `unknown` — **not** `false`                                                  |

"The model guessed" appears nowhere in this list.

### 2.5 Asymmetric loss — model the actual use case

For a user who dislikes peat, a false-positive `smoky` tag costs a lost good bottle (the Tobermory
case). A false negative costs one bad purchase. The schema should encode that asymmetry:

- `smoky` as a scalar 0–4 with a **user-adjustable threshold** in the filter UI
- a separate `peat_confirmed` field that is only set on positive evidence (precedence levels 1–4),
  with a genuine third state `unknown`
- an explicit UI toggle for whether `unknown` is included in results

### 2.6 Whisky type is a legal taxonomy, not a flavour

No LLM required. Encode the rules:

- **Scotch** — Scotch Whisky Regulations 2009: exactly five categories (single malt, single grain,
  blended malt, blended grain, blended Scotch). Protected regions: Highland, Lowland, Speyside,
  Islay, Campbeltown. **"Islands" is not a legal region** — Tobermory, Talisker, Highland Park,
  Jura and Arran are all formally Highland. Hence the two separate fields `legal_region` and
  `common_region`.
- **USA** — 27 CFR Part 5: bourbon (≥51% corn, new charred oak containers, distilled ≤160 proof,
  entered into barrel ≤125 proof), rye (≥51% rye), Tennessee whiskey, straight designations.
- **Ireland** — Irish Whiskey GI technical file: single pot still, single malt, single grain, blended.
- **Japan** — JSLMA labelling standards (in force from 2021, fully applicable from 2024). Important
  because a large share of "Japanese whisky" on shelves is bottled imported spirit.

This resolves deterministically from `distillery.type` + declared category + name signals in ~95% of
cases.

### 2.7 Flavour: two tracks, never free association

**Track A — deterministic (covers ~90%).** Distillery flavour profile (seeded from Wishart, then
hand-curated) plus cask modifiers. Stable, debuggable, cheap, no inference at read time.

**Track B — grounded extraction (for the remainder).** You already have a free corpus you scrape
every day: **the retailer product descriptions themselves**. Add whiskyfun.com (~20k reviews by
Serge Valentin, static HTML, scrapeable in an evening) and selective producer pages.

Then: the LLM extracts tags **with a mandatory citation to the source sentence**. A post-processor
rejects any tag not grounded in the retrieved text. This is RAG used correctly — as a grounding and
verification mechanism, not as a substitute for knowledge.

Bonus signal: when two shops' descriptions disagree about the same expression, flag it for review.

---

## 3. Independent bottlers and undisclosed sources

This is the second largest gap after entity collisions. Model it as `bottler → range → distillery`.

Bottlers likely to appear:

> Douglas Laing (Provenance, Old Particular, XOP, Big Peat, Scallywag, Timorous Beastie,
> Rock Oyster) · Hunter Laing (Old Malt Cask, Old & Rare, Hepburn's Choice, Scarabus) ·
> Signatory Vintage · Gordon & MacPhail (Connoisseurs Choice, Discovery) · Cadenhead's ·
> Berry Bros & Rudd · Compass Box · Elixir Distillers / Single Malts of Scotland ·
> That Boutique-y Whisky Company · Thompson Bros · Watt Whisky · Càrn Mòr (Morrison) ·
> Dràm Mòr · Lady of the Glen · Claxton's · Infrequent Flyers · Adelphi · Duncan Taylor ·
> Murray McDavid · Cooper's Choice · Wemyss · Ian Macleod · North Star · Kirsch · Sansibar

### Undisclosed / "teaspooned" names

Well-documented mappings (confidence: **high**):

| Label name | Actual source         |
| ---------- | --------------------- |
| Williamson | Laphroaig             |
| Burnside   | Balvenie (teaspooned) |
| Westport   | Glenmorangie          |

Elements of Islay codes: `Cl` = Caol Ila, `Lp` = Laphroaig, `Bw` = Bowmore, `Ar` = Ardbeg,
`Bn` = Bunnahabhain, `Br` = Bruichladdich, `Pl` = Port Ellen.

For the dozens of other "secret Speyside" / "undisclosed Islay" labels, confidence is **low** —
store `unknown` rather than guessing. These are precisely the cases where an LLM hallucinates with
maximum apparent confidence.

---

## 4. Data sources, with verdicts

### 4.1 The Wishart dataset — direct links

**What it is.** David Wishart (then at the University of St Andrews) compiled a vocabulary of ~500
aroma/taste descriptors from published tasting notes and condensed them into **12 dimensions**, each
scored **0–4**, for **86 Scotch single malt distilleries**. One benchmark expression per distillery
(typically 10–15 years old, widely available; rare, premium, cask-finished and closed-distillery
bottlings were excluded). Published in the book _Whisky Classified: Choosing Single Malts by Flavour_
(revised edition ISBN 9781911595731). The 10 flavour **clusters** (A–J) come from his k-means +
PCA analysis of these scores.

The 12 dimensions: `Body, Sweetness, Smoky, Medicinal, Tobacco, Honey, Spicy, Winey, Nutty, Malty,
Fruity, Floral`. (Some write-ups list the 4th/5th as _Medicinal (Salty)_ and _Feinty (Sulphury)_;
the circulating CSV column is named `Tobacco`.)

**Original source** — University of Strathclyde "Nessie" maths outreach pages, which hosted
`whiskies.txt` and a companion `regions.txt`:

- <https://www.mathstat.strath.ac.uk/outreach/nessie/nessie_whisky.html>
- <https://www.mathstat.strath.ac.uk/outreach/nessie/datasets/whiskies.txt>
- <http://outreach.mathstat.strath.ac.uk/outreach/nessie/datasets/whiskies.txt>

⚠️ These original URLs may no longer resolve — the outreach site has been reorganised over the
years. Use a mirror.

**Verified working mirror** (I fetched this one and confirmed the contents — 86 rows,
header `RowID,Distillery,Body,Sweetness,Smoky,Medicinal,Tobacco,Honey,Spicy,Winey,Nutty,Malty,Fruity,Floral,Postcode,Latitude,Longitude`):

- <https://www.datascienceblog.net/data-sets/whiskies.txt>

**Cleaned and augmented version** (spelling errors fixed, Scottish region column added by hand from
Wikipedia) — probably the best starting point:

- <https://www.datascienceblog.net/post/other/whiskey-data-annotation/>

**Other mirrors:**

| Link                                                               | Notes                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| <https://gist.github.com/ryanpitts/8202396>                        | CSV mirror, cites the Strathclyde original                                                                             |
| <https://github.com/dataewan/whisky-vis>                           | Data file plus `whisky-clusters.csv` (his own clustering) and BNG→WGS84 coordinate conversion in `process_whiskies.py` |
| <https://github.com/storrgie/scotchit>                             | Mirrors Wishart's methodology notes on selection criteria                                                              |
| <https://www.kaggle.com/datasets/koki25ando/scotch-whisky-dataset> | Kaggle packaging, includes distillery coordinates                                                                      |

**Background on the dataset's provenance** (worth reading — the Strathclyde file was originally
completely unsourced):

- <https://wonkviz.tumblr.com/post/72400253092/whiskey-data-sleuthing-with-help-from-reddit>
- <https://blog.revolutionanalytics.com/2013/12/k-means-clustering-86-single-malt-scotch-whiskies.html>

**Known defects to handle on import.** The circulating file contains distillery-name typos that must
be mapped: `Belvenie` → Balvenie, `Laphroig` → Laphroaig, `Craigallechie` → Craigellachie,
`Knochando` → Knockando, `Craigganmore` → Cragganmore, `GlenDeveronMacduff` → Macduff/Glen Deveron,
`OldFettercairn` → Fettercairn, `OldPulteney` → Old Pulteney, `Clynelish` → Clynelish (ok),
`ArranIsleOf` → Arran. Coordinates are in **British National Grid**, not lat/lon, despite the column
headers — convert (EPSG:27700 → EPSG:4326). Postcodes have embedded tabs and leading whitespace.

**Limitations.** 86 distilleries only. Data vintage ~2006. One benchmark expression per distillery,
so it says nothing about `Port Charlotte` vs `Classic Laddie`. Ledaig is absent (only `Tobermory` is
listed). Treat it as a **seed** for Track A, then override per expression.

### 4.2 Everything else

| Source                                                                                                                                                                                                        | What it gives                                                                                                                                                                          | Verdict                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wishart / whiskies.txt** (§4.1)                                                                                                                                                                             | 86 distilleries × 12 scalar flavour dims, free, public                                                                                                                                 | **Take it now.** Best seed for Track A. Confidence: high (contents verified).                                                                                                                                                                                                                                                                                                            |
| **whiskyanalysis.com** (Selfbuilt) — [database](https://whiskyanalysis.com/index.php/database/), [methodology](https://whiskyanalysis.com/index.php/methodology-introduction/methodology-flavour-comparison/) | ~4,000+ whiskies, meta-critic scores aggregated from expert reviewers, flavour clusters revised from Wishart, plus a `Type` field. Published as an embedded Google Sheet → exportable  | **Take it.** Updates are irregular (a cached version of the page reports "last updated January 20, 2023"). Contact the author for commercial use. Confidence: moderate on freshness.                                                                                                                                                                                                     |
| **Whiskybase Data API** — <https://www.whiskybase.com/wp/api>                                                                                                                                                 | 250,000+ bottlings with structured distillery / bottler / brand / vintage / strength, community ratings, retail and auction prices, and bottle _identification_ against Whiskybase IDs | **Highest-value option — email them.** This is literally the entity-resolution problem you are solving by hand. Access is scoped per partner; pricing not public. Scraping violates ToS and is technically painful. Confidence: moderate-high that the API exists; unknown on terms.                                                                                                     |
| **Wikidata (SPARQL)**                                                                                                                                                                                         | Distilleries: country, region, owner, coordinates, founding/closure dates. CC0                                                                                                         | **Take it** as the skeleton for the `distillery` table. Coverage uneven, no flavour data.                                                                                                                                                                                                                                                                                                |
| **SWA — [scotch-whisky.org.uk](https://www.scotch-whisky.org.uk/)**                                                                                                                                           | Legal categories and protected regions, primary source                                                                                                                                 | Use for §2.6.                                                                                                                                                                                                                                                                                                                                                                            |
| **Malt Whisky Yearbook** (annual print)                                                                                                                                                                       | Every distillery: owner, capacity, status, product ranges. The most accurate and complete distillery reference in existence                                                            | Not machine-readable. Buy the paper copy (~€20/yr) and use it as the arbiter for manual curation.                                                                                                                                                                                                                                                                                        |
| **whiskyfun.com**                                                                                                                                                                                             | ~20k reviews including IB bottlings and closed distilleries                                                                                                                            | **Best corpus for Track B.** Static site, trivial to scrape.                                                                                                                                                                                                                                                                                                                             |
| **Your own scraped retailer descriptions**                                                                                                                                                                    | Already in your DB, free, multi-source                                                                                                                                                 | Underrated. Multi-source means contradictions become a QA signal.                                                                                                                                                                                                                                                                                                                        |
| **TTB COLA registry** (US label approvals)                                                                                                                                                                    | Approved labels with declared product class, free                                                                                                                                      | Useful for American whiskey type classification.                                                                                                                                                                                                                                                                                                                                         |
| **Producer websites** _(your proposal)_                                                                                                                                                                       | Official tasting notes                                                                                                                                                                 | **Worst ROI on this list.** 150+ different site layouts, JS rendering, periodic redesigns, marketing prose ("notes of Highland heather at sunset"), and — critically — official notes systematically _understate_ smoke and _overstate_ fruit. They also cover IB bottlings worst, which is where your error rate is highest. Do this selectively for ~20 top brands, not as a strategy. |
| **Fine-tuning your own model**                                                                                                                                                                                | —                                                                                                                                                                                      | **Don't.** Fine-tuning teaches format, not facts. You would get the same hallucinations with no way to fix them via a SQL UPDATE.                                                                                                                                                                                                                                                        |

### 4.3 A note on ppm

There is no authoritative public phenol database, and the figures circulating on blogs conflate three
different measurements: ppm in the **malt specification**, ppm in the **new-make spirit**, and ppm in
the **bottled product** (the last is typically 3–10× lower than the first). Do **not** store ppm as a
number. Store an ordinal scale (`unpeated / light / medium / heavy`) with a `source` field.

---

## 5. Implementation roadmap

### Stage 1 — Foundation (~1 weekend)

- Wikidata SPARQL → skeleton `distillery` table (country, region, owner, status)
- Import Wishart 86 → `flavour_profile` (with the typo mapping and BNG→WGS84 conversion from §4.1)
- **Manually fill `peat_default` for all ~150 operating Scotch distilleries** — realistically 3–4
  hours with the Yearbook to hand
- Add `source_type` to every attribute; mark all existing AI-generated values as `llm_guess` and
  exclude them from filters
- Add `legal_region` / `common_region` split

**Tobermory is back in your search results at the end of this stage.**

### Stage 2 — Resolution pipeline (~1 week)

- Title normaliser + regex grammar + bidirectional Cyrillic transliteration
- `pg_trgm` + `pgvector` candidate generation → LLM tie-breaker with a mandatory `none` option
- Content-hash cache keyed on normalised title (one call per unique product, not per listing)
- **Build a golden set of 200 hand-labelled products**, deliberately skewed toward hard cases:
  Ledaig/Tobermory, Bunnahabhain Mòine, Port Charlotte, Longrow vs Hazelburn, teaspooned IB
  bottlings, Cyrillic titles, NAS expressions
- Measure precision/recall **separately for `peated`** — this is metric #1
- Run the golden set as a regression suite on every prompt or model change

### Stage 3 — Human-in-the-loop (~1 week)

- Review queue for: new entities (expect 2–5/month — trivial time cost, enormous accuracy payoff),
  `match_confidence` below threshold, cross-shop description contradictions
- Hard rule: `source_type = 'human'` is never overwritten by automation
- Batch API for the nightly enrichment run

### Stage 4 — Optional / opportunistic

- Contact Whiskybase about API terms. If acceptable, it replaces half of Stage 2.
- Scrape whiskyfun as the Track B corpus; implement grounded extraction with citation enforcement
- Populate `bottler` / `bottler_range` tables and the undisclosed-source mapping table (§3)

---

## 6. Summary

The problem is not that the agent lacks data. The problem is that a task structurally unsuited to
generative inference — emitting provenance-free facts over a closed entity set of ~1,500 rows — was
delegated to an LLM.

Four changes, in order of leverage:

1. **Add `source_type` to every attribute.** Suppress `llm_guess` from filters.
2. **Replace generation with resolution.** Curate the entity tables; the LLM becomes a parser and
   matcher, not an oracle.
3. **Replace boolean flavour tags with 0–4 scalars.** Make the peat threshold user-adjustable.
4. **Make "no data" an explicit `unknown`**, distinct from `false`.

The LLM stays in the pipeline. It just stops being the source of truth.

---

## Appendix A: Confidence levels on claims in this document

| Claim                                                                                         | Confidence                                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Current-production Tobermory is unpeated; Ledaig is the peated brand from the same distillery | High                                                                                    |
| Wishart dataset contents, structure, and the Tobermory row (Smoky=1, Medicinal=0)             | High — file fetched and inspected                                                       |
| The `datascienceblog.net` mirror URL works                                                    | High — fetched successfully                                                             |
| The original Strathclyde URLs still resolve                                                   | Low — likely moved or retired                                                           |
| whiskyanalysis.com data is exportable and currently maintained                                | Moderate — page exists; last-updated date may be stale                                  |
| Whiskybase offers an official partner Data API                                                | Moderate-high — API page exists; terms and pricing unknown                              |
| Williamson=Laphroaig, Burnside=Balvenie, Westport=Glenmorangie                                | High                                                                                    |
| Specific ppm figures for any distillery                                                       | Low — do not store as numbers                                                           |
| Count of ~150 operating Scotch malt distilleries                                              | Moderate — verify against the current Malt Whisky Yearbook                              |
| Token cost estimates in §1.4                                                                  | Moderate — arithmetic is sound, SKU volumes are estimates; verify current model pricing |
