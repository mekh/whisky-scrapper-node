# Whisky knowledge base — verification round brief

You are verifying producers that the seed research round left `unverified`.
The seed brief told researchers to economize on the long tail ("do not spend a
web search on each one", "confidence=low, and move on"), so 437 rows sit
withheld — most of them are real, identifiable producers whose row simply
lacks evidence. Your job is to give every assigned row the evidence it
deserves: verify each fact on the web, correct what is wrong, and cite what
you actually opened.

Accuracy still matters far more than coverage. A wrong row is worse than a
withheld row, because a wrong row is trusted by filters.

## Why your output unlocks rows (the auto-gate)

A downstream gate re-grades every row you return. It promotes a row to live
(`auto`) only when **all** of these hold:

1. `confidence` is `high`;
2. `sourceUrls` has at least one URL;
3. `countryCode` is filled;
4. and, **only if** `peatProfile` is positive (`light`/`medium`/`heavy`), the
   claim is independently corroborated — the producer sits on Islay, has a
   peat word in its slug, or a cited URL is from the producer's own domain.

`peatProfile=unknown` or `none` with points 1–3 passes on its own. So a row
"kind and country verified, peat honestly unknown" **goes live and is
valuable** — it supplies country/type to filters and simply makes no peat
claim. Do not hold a whole row hostage to an unknowable peat level.

## Confidence semantics for this round

`confidence` describes **the facts the row asserts** (name, kind, country,
region, owner, default type — and peat only when you state one):

- `high` — you verified those fields against at least one source you opened.
  Peat may still be `unknown`.
- `low` — you could not verify the row's identity (no usable web presence, or
  sources conflict). Say why in `note`.

Never write `high` without a URL you actually opened. Never invent a URL.

## Peat rules (unchanged, the most important field)

- A wrong `none` merely removes smoke tags — visible, recoverable. A wrong
  positive silently removes a whisky from peat-exclusion results. When not
  confident: `unknown`.
- State `none` only when the house style is documented unpeated (an ordinary
  blended Scotch counts, if you verified it IS an ordinary blended Scotch).
- State a positive level **only** with a page from the producer's own domain
  saying so (or the producer is on Islay). If your only evidence is Wikipedia
  or a retailer, keep `unknown` and record the withheld claim in `note`
  (e.g. `withheld peat proposal: medium per <url>`).
- Sibling lines with different peat are separate rows joined by `parentSlug`
  — never one averaged row.

## Your input

`docs/kb-research/verify/in/batch-NN.tsv`, one line per producer, 18
tab-separated fields:

```
slug name kind countryCode region legalRegion owner defaultTypeName
peatProfile parentSlug bottlerSlug status confidence sourceUrls note
aliases potentialReach sampleProductNames
```

Fields 1–15 are the stored row (the seed round's output — start from it, it
is often right but under-evidenced). `aliases` are the catalogue spellings
already mapped to it (`|`-separated). `potentialReach` is how many catalogue
bottlings would resolve to this row once live. `sampleProductNames` are real
bottling names it would claim — read them, they reveal what the row actually
is.

`docs/kb-research/verify/live-slugs.txt` lists every already-live producer
slug, for `parentSlug`/`bottlerSlug` references and duplicate checks.

## Your output — up to five TSV files

Write to `docs/kb-research/verify/out/NN/` (NN = your batch number). Literal
TAB between fields, no tabs/newlines inside values, no header rows, no
quoting. Empty field = nothing between tabs.

### 1. `producer.tsv` — required, one line per input row (minus rejects)

Same 15 fields as input fields 1–15:

```
slug name kind countryCode region legalRegion owner defaultTypeName
peatProfile parentSlug bottlerSlug status confidence sourceUrls note
```

- `slug` — copy **exactly** from input. Never rename, never re-slug.
- `status` — always write `unverified`; the gate decides promotion.
- `kind` — `distillery` | `brand` | `blend` | `bottler`. Fix it if the seed
  got it wrong (samples of an independent bottler name other distilleries).
- `countryCode` — closed list:
  `AM AT AU AZ BE BG CA CH CU CZ DE DK EE ES FI FR GB GB-ENG GB-SCT GB-WLS GE
  GR HR HU IE IL IN IT JP KZ LK LT LV MD MX NL NO NZ PL PT RO SE SG SI SK TR
  TW UA US XX ZA`. Never plain `GB` for a known home nation.
- `region` — Scotland only: `campbeltown highland islay lowland speyside
  islands` (market convention). `legalRegion` — the SWA five, never
  `islands`.
- `defaultTypeName` — only when EVERY bottling is that type, from:
  `single malt` `blend` `bourbon` `rye` `grain` `malt` `single pot still`
  `tennessee`. Empty for bottlers and multi-type ranges.
- `parentSlug` / `bottlerSlug` — a slug from `live-slugs.txt`, from your own
  batch, or a new row you emit yourself (below).
- `sourceUrls` — space-separated URLs **you opened**. Producer's own site
  first, then Wikipedia, whisky.com, whiskybase, Master of Malt.
- `note` — what you verified, what you corrected, what you withheld. If the
  row duplicates an already-live producer, start the note with
  `duplicate-of:<live-slug>` and leave the rest of the row as-is.

You may append **new** producer rows (slugs not in any input) when your
assigned rows need them — a parent distillery or an owning bottler that the
knowledge base lacks. Mark them `new row for <your-slug>` in `note`.

### 2. `alias.tsv` — additions only (optional)

```
key producerSlug scope note
```

Spellings you saw in samples that are not yet in the row's `aliases` —
including Cyrillic ones. `scope`: `any` for distinctive names of 5+ chars,
`brand` for anything short/generic/ambiguous, `name` rare.

### 3. `flavor.tsv` — optional, high confidence only

```
producerSlug flavor effect confidence sourceUrls note
```

House style for the 13 non-peat tags only:
`bourbon-cask caramel chocolate citrus floral fruity honey maritime nutty oak
sherry spicy vanilla` — plus `smoky` for non-peat smokiness only. `peated`
must NEVER appear here. `effect`: `baseline` | `require` | `forbid`.

### 4. `rule.tsv` — only for real in-range exceptions

```
producerSlug pattern matchMode flavor effect peatProfile priority sourceUrls
note
```

Either a peat rule (fill `peatProfile`) or a tag rule (fill
`flavor`+`effect`), never both. `matchMode` `word` almost always;
`priority` `60`. No global rules.

### 5. `reject.tsv` — rows that are not whisky producers at all

```
slug reason sourceUrls
```

A liqueur or RTD house with no whisky, a wine/sherry bodega, a cognac or rum
brand, a retailer whose name leaked into the brand column, a cocktail name.
Cite evidence for the verdict; when in doubt, keep it in `producer.tsv` with
`confidence=low` instead. A rejected slug must not appear in `producer.tsv`.

## Hard rules

- **Never touch any database.** Do not run psql, do not boot the app, do not
  run project scripts. Your only inputs are the files named above and the
  web; your only outputs are files in `docs/kb-research/verify/out/NN/`.
- Do not modify any file outside your output directory.
- Verify **every** row on the web — this round exists because the seed round
  skipped the tail. Typical spend: 2–4 searches/fetches per producer; a
  one-product own-label still gets at least one search. If the world is
  genuinely silent about a row, keep `confidence=low` and say so — that is a
  legitimate answer.
- Never invent a citation. Only URLs you opened in this session.

## Before you finish

- `producer.tsv` lines have exactly 15 fields (14 tabs); `alias.tsv` 4;
  `flavor.tsv` 6; `rule.tsv` 9; `reject.tsv` 3.
- Every input slug appears exactly once — in `producer.tsv` or `reject.tsv`.
- Every `confidence=high` row has `countryCode` and at least one URL.
- Every positive `peatProfile` has a producer-domain URL (or Islay), else it
  is `unknown` with the withheld claim in `note`.
- No `peated` in `flavor.tsv`; no value contains a tab or newline.

Report back one paragraph: rows verified, corrected fields, rejects, new
rows, rows left `low` and why, anything a human reviewer must look at.
