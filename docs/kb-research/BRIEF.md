# Whisky knowledge-base research brief

You are researching whisky producers so a price-tracking catalogue can stop
guessing. Today every fact about a bottling is whatever a shop's listing said or
a language model recalled, so the same whisky disagrees with itself across
shops. The worst case reported by the owner: `Tobermory 12` was tagged smoky and
peated. Tobermory is **unpeated**; `Ledaig` is the peated brand from the _same
distillery_. The owner filters peated whisky out, so his favourite malt vanished
from every result.

Your output becomes curated database rows. **Accuracy matters far more than
coverage.** A row you are unsure of should say `unknown`; a wrong row is worse
than no row, because a wrong row is trusted.

## Your input

A TSV file (path given in your task) with one line per brand:

```
<brand name as the catalogue spells it>	<how many products>	<up to 6 sample product names>
```

The sample names are evidence — read them. They often reveal what the brand
actually is (an independent bottler's samples name the distilleries it bottles).

## Your output — four TSV files

Write to the output directory given in your task. Use a literal TAB between
fields. **Never use a tab inside a value.** Empty field = leave it empty
(nothing between the tabs). Do not write a header row. Do not quote values.

### 1. `producer.tsv`

```
slug	name	kind	countryCode	region	legalRegion	owner	defaultTypeName	peatProfile	parentSlug	bottlerSlug	status	confidence	sourceUrls	note
```

- `slug` — kebab-case, ASCII, stable: `tobermory`, `gordon-macphail`,
  `port-charlotte`. This is the key everything else references.
- `name` — display name, properly spelled (`The Macallan` → `Macallan`).
- `kind` — exactly one of:
  - `distillery` — a physical distillery (Tobermory, Laphroaig, Yoichi).
  - `brand` — a named brand whose liquid comes from a **known** distillery you
    record in `parentSlug`: `Ledaig` (Tobermory), `Port Charlotte`
    (Bruichladdich), `An Orkney` (Highland Park), `Williamson` (Laphroaig).
  - `blend` — a blend or vatting with no single distillery of origin: Johnnie
    Walker, Big Peat, Finlaggan, and most supermarket own labels.
  - `bottler` — an independent bottler or retailer range: Douglas Laing,
    Signatory, Gordon & MacPhail, That Boutique-y Whisky Company.
- `countryCode` — from the closed list below. Use `GB-SCT` for Scotland,
  `GB-ENG` England, `GB-WLS` Wales, `IE` Ireland. **Never `GB`** for a whisky
  whose home nation you know.
- `region` — Scotland only, one of: `campbeltown` `highland` `islay` `lowland`
  `speyside` `islands`. `islands` is the market convention for Mull, Skye,
  Orkney, Jura, Arran. Leave empty outside Scotland and for most blends.
- `legalRegion` — Scotland only, the protected SWA region, one of:
  `campbeltown` `highland` `islay` `lowland` `speyside`. **Never `islands`** —
  the islands are legally Highland. So Tobermory is `region=islands`,
  `legalRegion=highland`; Laphroaig is `islay`/`islay`.
- `owner` — current owner company, or empty.
- `defaultTypeName` — the type EVERY bottling of this producer is, from:
  `single malt` `blend` `bourbon` `rye` `grain` `malt` `single pot still`
  `tennessee`. **Leave empty** for bottlers and for any producer whose range
  spans several types. Do not guess.
- `peatProfile` — the single most important field. One of:
  - `none` — unpeated. Tobermory, Glenfiddich, Macallan, most Speyside.
  - `light` — a trace of smoke, not a peated whisky. Johnnie Walker Black,
    Benromach, Springbank.
  - `medium` — clearly peated but not extreme. Talisker, Highland Park, Bowmore.
  - `heavy` — Ardbeg, Laphroaig, Lagavulin, Ledaig, Port Charlotte, Octomore.
  - `unknown` — **use this whenever you are not confident**, and always for a
    bottler and for an undisclosed/secret label. It is the safe answer.
- `parentSlug` — for `kind=brand` only: the distillery slug it comes from.
- `bottlerSlug` — when this brand/range is owned by a bottler: `big-peat` has
  `bottlerSlug=douglas-laing`.
- `status` — always write `unverified`. A human promotes rows later.
- `confidence` — `high` `low` or `unknown`, your honest self-assessment.
- `sourceUrls` — one or more URLs separated by a single SPACE. Required
  whenever `peatProfile` is not `unknown`, and whenever `confidence=high`.
  Prefer: the producer's own site > Wikipedia / Wikidata > whisky.com >
  whiskybase / Master of Malt.
- `note` — free text (no tabs). Say what you were unsure about, and record any
  claim you deliberately withheld.

### 2. `alias.tsv`

```
key	producerSlug	scope	note
```

Every spelling that should resolve to the producer. Write the spelling
**as-is** — do not normalise, lowercase or strip punctuation; a later step does
that.

- **You MUST emit one alias for the exact brand string from your input**, even
  when it is misspelled (`Isiay Mist`, `Douglas Laingcompany`, `Pear's Beast`).
  Those typos are real rows in the catalogue and must resolve.
- Also add: the canonical name, common variants (`The Macallan` / `Macallan`),
  Cyrillic spellings if you saw any in the samples (`Хайленд Парк`).
- `scope` — one of:
  - `any` — safe to match both as a whole brand value and inside a product
    name. Use for distinctive names of 5+ characters (`Laphroaig`, `Ledaig`).
  - `brand` — match only as a complete brand value. **Use this for anything
    short, generic or ambiguous** (`Spey`, `Artist`, `Elements`, `Grant`, any
    alias under 5 characters). Getting this wrong makes a name match the wrong
    producer, so when in doubt use `brand`.
  - `name` — rare; only match inside a product name.

### 3. `flavor.tsv` (optional, high confidence only)

```
producerSlug	flavor	effect	confidence	sourceUrls	note
```

House-style statements for the 13 non-peat tags:
`bourbon-cask caramel chocolate citrus floral fruity honey maritime nutty oak
sherry spicy vanilla`

- `effect` — `baseline` (the house style typically shows this), `require`
  (every bottling has it), `forbid` (no bottling has it).
- **`peated` must NEVER appear in this file.** Peat has one source of truth:
  `peatProfile`. A row with `peated` will be rejected.
- `smoky` IS allowed here, but only for **non-peat** smokiness — Jack Daniel's
  charcoal mellowing is the classic case (`jack-daniels smoky require`).
- Emit at most a handful of rows per producer, and only ones you are confident
  about. This file may be empty.

### 4. `rule.tsv` (only for real exceptions)

```
producerSlug	pattern	matchMode	flavor	effect	peatProfile	priority	sourceUrls	note
```

A rule fires when `pattern` appears in a product's name. Use it when one
producer's range varies:

- `bunnahabhain	Moine	word		heavy	60` — Bunnahabhain's core range is
  unpeated but its Mòine range is heavily peated.
- `benriach	Smoky	word		heavy	60`
- `benromach	Peat Smoke	word		heavy	60`

Rules are **either** a peat rule (fill `peatProfile`, leave `flavor` and
`effect` empty) **or** a tag rule (fill `flavor` and `effect`, leave
`peatProfile` empty). Never both.

- `matchMode` — `word` (whole word) almost always. `prefix` only for Ukrainian
  inflection.
- `priority` — use `60` for a producer-scoped exception.
- Do **not** write global rules (`peated`, `unpeated`, `sherry cask`) — those
  are authored centrally. Only producer-specific exceptions.

## Closed country codes

`AM AT AU AZ BE BG CA CH CU CZ DE DK EE ES FI FR GB GB-ENG GB-SCT GB-WLS GE GR
HR HU IE IL IN IT JP KZ LK LT LV MD MX NL NO NZ PL PT RO SE SG SI SK TR TW UA
US XX ZA`

## Rules that matter most

1. **Sibling brands are separate rows.** If a distillery makes both an unpeated
   and a peated line under different names, that is two `producer` rows joined
   by `parentSlug` — never one row with an averaged profile. Known pairs to
   watch: Tobermory/Ledaig, Bruichladdich/Port Charlotte/Octomore,
   Springbank/Longrow/Hazelburn, Bunnahabhain/Mòine, BenRiach/Curiositas,
   Glenglassaugh/Torfa, Highland Park/An Orkney, Tomatin/Cù Bòcan,
   Loch Lomond/Inchmoan/Croftengea.
2. **Independent bottlers.** If your brand is a bottler, set `kind=bottler` and
   `peatProfile=unknown` — a bottler has no house peat level. Then **also emit
   `distillery` rows for the distilleries named in its sample product names**,
   so those bottlings can resolve (Douglas Laing's samples name Jura, Ardmore,
   Bowmore, Caol Ila and more). Those extra distillery rows are valuable.
3. **Undisclosed labels stay unknown.** `Probably Orkney's Finest`,
   `Speyside's Finest`, `XOP Speyside Finest 1967`, `Secret Speyside` — record
   `peatProfile=unknown` and say so in `note`. Do not guess the distillery.
   Well-documented teaspooned exceptions you may record with citations:
   Williamson=Laphroaig, Burnside=Balvenie, Westport=Glenmorangie.
4. **Own-label and supermarket blends** (1–2 products, no web presence) — this
   is most of the long tail. `kind=blend`, `peatProfile=none` if it is an
   ordinary blended Scotch, `region` empty, `confidence=low`, and move on. Do
   not spend a web search on each one.
5. **Never invent a citation.** If you did not open a page, leave `sourceUrls`
   empty and set `confidence=low` or `unknown`.

## Budget

Spend your effort where it changes an answer: brands with many products, and
any brand where peat could plausibly be non-zero. The long tail of one-product
own labels should be fast. Do not exceed roughly 40 web searches for the whole
batch.

## Before you finish

Re-read your `producer.tsv` and check:

- every line has exactly 15 tab-separated fields (14 tabs);
- `alias.tsv` has 4 fields, `flavor.tsv` 6, `rule.tsv` 9;
- every `parentSlug` / `bottlerSlug` you referenced exists as a row in your own
  `producer.tsv`, or is a well-known slug another batch will certainly have
  (say which in `note`);
- no `peated` in `flavor.tsv`;
- no value contains a tab or a newline;
- every non-`unknown` `peatProfile` has at least one URL.

Report back: how many producers, aliases, flavors and rules you wrote, which
brands you left as `unknown` and why, and anything you think a human reviewer
must look at.
