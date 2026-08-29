# P1.8 — review dossier

Every row in this file is one where being wrong is **not** recoverable
by the user noticing. A wrong positive peat level silently removes a
whisky from a filtered result; a wrong sibling link hands one brand
another brand's facts. Generated from `docs/kb-research/seed/`.

Nothing here is `verified`. The seed ships as `auto` (live) or
`unverified` (stored and ignored), and promotion to `verified` is a
reviewer action — add a `status` row to `curation/overrides.tsv`.

## 1. Positive peat levels — 59 rows (31 live, 28 withheld)

### 1a. LIVE — these change tags the moment the seed is applied

| slug             | peat       | tags           | region      | kind       | parent        | confidence | citation                                                     |
| ---------------- | ---------- | -------------- | ----------- | ---------- | ------------- | ---------- | ------------------------------------------------------------ |
| `ardbeg`         | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://en.wikipedia.org/wiki/Ardbeg_distillery              |
| `ardnahoe`       | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://www.whiskeyatlas.co.uk/learn/every-islay-distillery- |
| `ballechin`      | **heavy**  | peated + smoky | highland    | brand      | edradour      | high       | https://dram1.com/edradour-distillery-spotlight/             |
| `big-peat`       | **heavy**  | peated + smoky | islay       | blend      | —             | high       | https://www.douglaslaing.com/products/big-peat               |
| `caol-ila`       | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://en.wikipedia.org/wiki/Caol_Ila_distillery            |
| `kilchoman`      | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://www.kilchomandistillery.com/our-farm-distillery/     |
| `lagavulin`      | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://islaywhiskyacademy.scot/lagavulin-distillery/        |
| `laphroaig`      | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://en.wikipedia.org/wiki/List_of_whisky_distilleries_in |
| `ledaig`         | **heavy**  | peated + smoky | islands     | brand      | tobermory     | high       | https://en.wikipedia.org/wiki/Tobermory_distillery           |
| `octomore`       | **heavy**  | peated + smoky | islay       | brand      | bruichladdich | high       | https://en.wikipedia.org/wiki/Bruichladdich_distillery       |
| `peats-beast`    | **heavy**  | peated + smoky | islay       | blend      | —             | high       | https://www.masterofmalt.com/whiskies/peats-beast-peat-malt- |
| `port-charlotte` | **heavy**  | peated + smoky | islay       | brand      | bruichladdich | high       | https://www.remy-cointreau.com/en/brands/bruichladdich-port- |
| `port-ellen`     | **heavy**  | peated + smoky | islay       | distillery | —             | high       | https://www.malts.com/en-row/distilleries/port-ellen         |
| `smokehead`      | **heavy**  | peated + smoky | islay       | brand      | —             | high       | https://en.wikipedia.org/wiki/Ian_Macleod_Distillers         |
| `torabhaig`      | **heavy**  | peated + smoky | islands     | distillery | —             | high       | https://torabhaig.com/collections/the-legacy-series          |
| `black-bottle`   | **light**  | smoky          | —           | blend      | —             | high       | https://en.wikipedia.org/wiki/Black_Bottle                   |
| `chivas-regal`   | **light**  | smoky          | —           | blend      | —             | high       | https://thewhiskeyjug.com/scotch-whiskey/chivas-regal-12-yea |
| `clynelish`      | **light**  | smoky          | highland    | distillery | —             | high       | https://scotchwhisky.com/whiskypedia/1831/clynelish/         |
| `gladstone-axe`  | **light**  | smoky          | —           | blend      | —             | high       | https://www.drinkhacker.com/2022/07/31/review-the-gladstone- |
| `kilkerran`      | **light**  | smoky          | campbeltown | brand      | glengyle      | high       | https://kilkerran.scot/kilkerran-bottlings/12yo/             |
| `raasay`         | **light**  | smoky          | islands     | distillery | —             | high       | https://www.raasaydistillery.com/                            |
| `shackleton`     | **light**  | smoky          | —           | blend      | —             | high       | https://scotchwhisky.com/magazine/latest-news/13645/shacklet |
| `speyburn`       | **light**  | smoky          | speyside    | distillery | —             | high       | https://en.wikipedia.org/wiki/Speyburn_distillery            |
| `the-deveron`    | **light**  | smoky          | highland    | brand      | macduff       | high       | https://en.wikipedia.org/wiki/Macduff_distillery             |
| `ardmore`        | **medium** | peated + smoky | highland    | distillery | —             | high       | https://www.ardmorewhisky.com/                               |
| `bowmore`        | **medium** | peated + smoky | islay       | distillery | —             | high       | https://en.wikipedia.org/wiki/Bowmore_distillery             |
| `brora`          | **medium** | peated + smoky | highland    | distillery | —             | high       | https://en.wikipedia.org/wiki/Brora_distillery               |
| `connemara`      | **medium** | peated + smoky | —           | brand      | cooley        | high       | https://en.wikipedia.org/wiki/Cooley_Distillery              |
| `machrie-moor`   | **medium** | peated + smoky | islands     | brand      | arran         | high       | https://www.arranwhisky.com/shop-whiskies/arran-limited-edit |
| `talisker`       | **medium** | peated + smoky | islands     | distillery | —             | high       | https://en.wikipedia.org/wiki/Talisker_distillery            |
| `the-deacon`     | **medium** | peated + smoky | —           | blend      | —             | high       | https://distiller.com/spirits/the-deacon-blended-scotch-whis |

### 1b. WITHHELD by the auto-gate — stored, ignored, awaiting you

| slug              | peat   | why it failed the gate                                                                                                            |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `lagg`            | heavy  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `longrow`         | heavy  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `old-ballantruan` | heavy  | confidence=low                                                                                                                    |
| `port-askaig`     | heavy  | confidence=low                                                                                                                    |
| `akashi`          | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `ballantines`     | light  | confidence=low                                                                                                                    |
| `benromach`       | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `claymore`        | light  | confidence=low                                                                                                                    |
| `cu-bocan`        | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `glen-ryan`       | light  | confidence=low                                                                                                                    |
| `glen-scotia`     | light  | confidence=low                                                                                                                    |
| `hakushu`         | light  | confidence=low                                                                                                                    |
| `johnnie-walker`  | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `jura`            | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `oban`            | light  | confidence=low                                                                                                                    |
| `onikishi`        | light  | confidence=low                                                                                                                    |
| `rock-island`     | light  | confidence=low                                                                                                                    |
| `rysa`            | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `springbank`      | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `teachers`        | light  | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `white-horse`     | light  | confidence=low                                                                                                                    |
| `ailsa-bay`       | medium | confidence=low                                                                                                                    |
| `an-orkney`       | medium | confidence=low                                                                                                                    |
| `embra`           | medium | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `highland-park`   | medium | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `man-o-sword`     | medium | positive peat with no independent corroboration (not Islay, no peat word in the slug, no citation from the producer's own domain) |
| `scarabus`        | medium | confidence=low                                                                                                                    |
| `yoichi`          | medium | confidence=low                                                                                                                    |

## 2. Peat rules — 73 (10 authored globally, 63 researched)

A rule reads the bottling's own name and beats the house profile.

### 2a. Global — authored centrally in `scripts/kb-merge.ts`

| pattern          | mode   | -> peat | priority |
| ---------------- | ------ | ------- | -------- |
| `non peated`     | word   | none    | 100      |
| `not peated`     | word   | none    | 100      |
| `unpeated`       | word   | none    | 100      |
| `неторф`         | prefix | none    | 100      |
| `heavily peated` | word   | heavy   | 60       |
| `lightly peated` | word   | light   | 60       |
| `peat`           | word   | heavy   | 50       |
| `peated`         | word   | heavy   | 50       |
| `peaty`          | word   | heavy   | 50       |
| `торф`           | prefix | heavy   | 50       |

### 2b. Producer-scoped — researched

| producer              | pattern          | -> peat | priority | note                                                                   |
| --------------------- | ---------------- | ------- | -------- | ---------------------------------------------------------------------- |
| `achill-island`       | `peated`         | medium  | 60       | Explicit 'Peated Single Malt' release, described as gentle/delicate sm |
| `amrut`               | `fusion`         | light   | 60       | 25% peated Scottish malt / 75% unpeated Indian malt; described as "gen |
| `amrut`               | `peated`         | medium  | 60       | ~23-24ppm phenol - moderate/mid-range peat, comparable to Bowmore rath |
| `ancnoc`              | `peated`         | medium  | 60       | Peaty Collection / Peated Edition releases, ~20ppm; matches this batch |
| `arlett`              | `tourbe`         | medium  | 60       | "Tourbe" = French for peat; distillery site lists a "Peated" expressio |
| `arran`               | `machrie moor`   | medium  | 60       | Arran's peated expression line (first released 8 Dec 2010 per Wikipedi |
| `balvenie`            | `peat`           | heavy   | 60       | Covers "Peat Week" / "Week of Peat" release names.                     |
| `balvenie`            | `peated`         | heavy   | 60       | Covers "Peated Triple Cask" release name.                              |
| `bank-note`           | `peated`         | medium  | 60       | "Peated Reserve" variant exists; intensity not detailed so rated mediu |
| `bankhall`            | `peated`         | medium  | 60       | Distillery also produces "Peated English Malt" / "Peated Black Malt" s |
| `benriach`            | `authenticus`    | heavy   | 60       | 25yo peated expression.                                                |
| `benriach`            | `birnie moss`    | heavy   | 60       | "Intensely Peated" NAS expression.                                     |
| `benriach`            | `curiositas`     | heavy   | 60       | 10yo peated expression (heavily peated malt).                          |
| `benriach`            | `septendecim`    | heavy   | 60       | 17yo peated expression.                                                |
| `benriach`            | `smoky`          | heavy   | 60       | Distillery's unpeated-core range carries a separately named peated lin |
| `benromach`           | `peat smoke`     | heavy   | 60       | Matches brief's own worked example verbatim: distinct heavily-peated b |
| `black-bull`          | `peated`         | medium  | 60       | Sample "Black Bull Peated Finish" implies a peat-finished variant dist |
| `bunnahabhain`        | `moine`          | heavy   | 60       | Bunnahabhain's core range is unpeated but its Mòine range is heavily p |
| `caol-ila`            | `unpeated`       | none    | 60       | Wiki: "Since 1999, the distillery has also produced a non-peated 'high |
| `clan-denny`          | `islay`          | heavy   | 60       | Clan Denny Islay blended malt vats Ardbeg, Bowmore, Bruichladdich, Bun |
| `clydeside`           | `fortnight`      | heavy   | 60       | 'Fortnight' is a heavily peated (54ppm) once-a-year release, distinct  |
| `compass-box`         | `peat monster`   | heavy   | 60       | Marketed/named as a fully peated blended malt; not observed in this ba |
| `elements-of-islay`   | `peat`           | heavy   | 60       | Permanent no-age-statement expression named simply 'Peat', introduced  |
| `evade`               | `peated`         | medium  | 60       | Separate 'Evade Peated' / 'Evade Peated Wine Cask Finish' single malt  |
| `famous-grouse`       | `smoky`          | medium  | 60       | "The Famous Grouse Smoky Black" (renamed from "The Black Grouse" in 20 |
| `glasgow-1770`        | `peated`         | medium  | 60       | Third member of the Signature Range alongside The Original and Triple  |
| `glen-clan`           | `peated`         | heavy   | 60       | This batch's only sample, "Glen Clan Smoky Peated Blend", states both  |
| `glen-moray`          | `peated`         | medium  | 60       | 'Glen Moray Classic Peated' launched 2015 per scotchwhisky.com whiskyp |
| `glen-moray`          | `smoky`          | medium  | 60       | Catalogue sample 'Glen Moray Smoky' is presumed to be the same Peated  |
| `glendalough`         | `peated`         | medium  | 60       | "Glendalough Pot Still Peated" is an explicit peated expression (Gold  |
| `glendronach`         | `peated`         | medium  | 60       | Explicit NAS "Peated" expression (Oloroso sherry casks, 54%+ ABV per W |
| `glenturret`          | `peated`         | heavy   | 60       | Matches this batch's own sample "Glenturret Peated" and existing prece |
| `hakushu`             | `heavily peated` | heavy   | 60       | 2013 limited series explicitly named 'Heavily Peated', distinct from t |
| `hinch`               | `peated`         | medium  | 60       | Hinch's own site lists a "Peated Single Malt" and "Peated Small Batch" |
| `hyde`                | `peat`           | heavy   | 60       | "Hyde No. 11 The Peat Cask" and similar releases are heavily peated; b |
| `jura`                | `prophecy`       | heavy   | 60       | 35ppm phenol special edition, well above the light core range; not obs |
| `kavalan`             | `peatist`        | light   | 60       | Peatist Series uses lightly peated malt sourced from Europe.           |
| `kavalan`             | `peaty`          | light   | 60       | Solist Peaty Cask uses lightly peated malt.                            |
| `kilkerran`           | `heavily peated` | heavy   | 60       | Distillery's own product page: 'A departure from our typically lightly |
| `kyro`                | `peat smoke`     | heavy   | 60       | 100% Finnish rye malt smoked 24h with Finnish freshwater peat in a tra |
| `m-h`                 | `peated`         | medium  | 60       | Elements Peated Cask edition; smokiness is cask-derived from ex-Islay  |
| `mackmyra`            | `svensk rok`     | heavy   | 60       | ~70% peated malt; Mackmyra's dedicated smoky release, distinct from th |
| `matsui`              | `peated`         | medium  | 60       | "The Peated" NAS expression; specific ppm not published so rated mediu |
| `monkey-shoulder`     | `smokey`         | medium  | 60       | Wikipedia: 'Smokey Monkey Batch 9, a blend that includes Islay whiskie |
| `paul-john`           | `bold`           | medium  | 60       | Confirmed peated to about 25ppm.                                       |
| `paul-john`           | `edited`         | light   | 60       | Described as mildly peated, lighter than Bold.                         |
| `paul-john`           | `peated`         | heavy   | 60       | Peated Select Cask line uses imported Islay and Aberdeen peat, distinc |
| `penderyn`            | `celt`           | medium  | 60       | Wikipedia: 'the Dragon range comprising Legend (Madeira finish), Myth  |
| `penderyn`            | `peated`         | medium  | 60       | Wikipedia infobox lists 'Penderyn Peated' (Single Malt, cask: Bourbon, |
| `prologue`            | `peated`         | medium  | 60       | Evidenced directly by this batch's own product name ('Prologue Peated  |
| `royal-salute`        | `peated`         | medium  | 60       | "21 Year Old The Peated Blend" incorporates peated malts; described as |
| `rozelieures`         | `tourbe`         | medium  | 60       | Barley peated to 30ppm for the Tourbe (Tourbe) collection; pattern wri |
| `sir-edwards`         | `smoky`          | medium  | 60       | Sir Edward's own site lists a distinct 'Smoky' variant in its range al |
| `slyrs`               | `peat`           | heavy   | 60       | Dedicated "Bavarian PEAT" expression; core range is unpeated.          |
| `speyside-distillery` | `fumare`         | heavy   | 60       | Spey Fumare (2016) was explicitly 'the first ever peated whisky from t |
| `starward`            | `peated`         | medium  | 60       | "Peated Finish" is red-wine-cask spirit finished about 18 months in pe |
| `teeling`             | `blackpitts`     | heavy   | 60       | officially branded 'Blackpitts Peated Single Malt' on teelingwhiskey.c |
| `teerenpeli`          | `savu`           | light   | 60       | Peated to ~5ppm - Teerenpeli's dedicated "smoke" single malt. Not itse |
| `togouchi`            | `peated`         | medium  | 60       | Togouchi Peated Cask Finish: bourbon-cask matured then finished in ex- |
| `tomintoul`           | `peaty`          | medium  | 60       | Distillery bottles a distinct "Peaty Tang" expression alongside its un |
| `westland`            | `peated`         | heavy   | 60       | No citation opened for this specific release this session (see produce |
| `wilton-house`        | `peated`         | heavy   | 60       | Explicit "Speyside Single Malt Scotch Whisky Peated" bottling under th |
| `wolfburn`            | `morven`         | light   | 60       | Morven is Wolfburn's one peated expression ("a delicate touch of peat" |

### 2c. Producer-scoped tag rules (not peat) — 2

| producer | pattern      | tag   | effect  |
| -------- | ------------ | ----- | ------- |
| `grants` | `smoky`      | smoky | require |
| `kyro`   | `wood smoke` | smoky | require |

## 3. Sibling pairs — 38 parents, 67 children

A child exists **because its facts differ from its parent**. The
resolver never inherits peat through `parentSlug`. Rows where parent
and child disagree on peat are the ones doing real work; rows where
they agree are worth a glance in case the child was a copy.

| parent                        | parent peat | child                   | child peat | differs |
| ----------------------------- | ----------- | ----------------------- | ---------- | ------- |
| `annandale`                   | unknown     | `man-o-sword`           | medium     | **yes** |
| `annandale`                   | unknown     | `man-o-words`           | none       | **yes** |
| `arran`                       | none        | `machrie-moor`          | medium     | **yes** |
| `balvenie`                    | none        | `burnside`              | none       | no      |
| `bruichladdich`               | none        | `octomore`              | heavy      | **yes** |
| `bruichladdich`               | none        | `port-charlotte`        | heavy      | **yes** |
| `buffalo-trace`               | none        | `blantons`              | none       | no      |
| `buffalo-trace`               | none        | `eagle-rare`            | none       | no      |
| `buffalo-trace`               | none        | `old-rip-van-winkle`    | none       | no      |
| `cameronbridge`               | none        | `haig-club`             | none       | no      |
| `clear-creek`                 | unknown     | `mccarthys`             | unknown    | no      |
| `cooley`                      | none        | `connemara`             | medium     | **yes** |
| `cooley`                      | none        | `tyrconnell`            | none       | no      |
| `copper-rivet`                | unknown     | `masthouse`             | unknown    | no      |
| `dufftown`                    | none        | `singleton-of-dufftown` | none       | no      |
| `echlinville`                 | none        | `dunvilles`             | none       | no      |
| `echlinville`                 | none        | `old-comber`            | none       | no      |
| `edradour`                    | none        | `ballechin`             | heavy      | **yes** |
| `eigashima`                   | unknown     | `tokinoka`              | unknown    | no      |
| `glen-moray`                  | none        | `glen-turner`           | none       | no      |
| `glen-ord`                    | none        | `singleton-glen-ord`    | none       | no      |
| `glengyle`                    | unknown     | `kilkerran`             | light      | **yes** |
| `glenmorangie`                | none        | `westport`              | none       | no      |
| `heaven-hill`                 | none        | `bernheim`              | none       | no      |
| `heaven-hill`                 | none        | `elijah-craig`          | none       | no      |
| `heaven-hill`                 | none        | `evan-williams`         | none       | no      |
| `heaven-hill`                 | none        | `mellow-corn`           | none       | no      |
| `heaven-hill`                 | none        | `parkers-heritage`      | none       | no      |
| `heaven-hill`                 | none        | `pikesville`            | none       | no      |
| `heaven-hill`                 | none        | `quality-house`         | none       | no      |
| `heaven-hill`                 | none        | `rittenhouse`           | none       | no      |
| `highland-park`               | medium      | `an-orkney`             | medium     | no      |
| `holyrood`                    | unknown     | `embra`                 | medium     | **yes** |
| `isle-of-harris`              | unknown     | `the-hearach`           | unknown    | no      |
| `jim-beam`                    | none        | `bakers`                | none       | no      |
| `jim-beam`                    | none        | `basil-hayden`          | none       | no      |
| `jim-beam`                    | none        | `old-overholt`          | none       | no      |
| `kentucky-artisan-distillery` | none        | `coalition`             | none       | no      |
| `loch-lomond`                 | none        | `inchmurrin`            | unknown    | **yes** |
| `lux-row-distillers`          | none        | `daviess-county`        | none       | no      |
| `lux-row-distillers`          | none        | `ezra-brooks`           | none       | no      |
| `lux-row-distillers`          | none        | `old-ezra`              | none       | no      |
| `macallan`                    | none        | `speymalt`              | none       | no      |
| `macduff`                     | none        | `the-deveron`           | light      | **yes** |
| `mgp`                         | none        | `rossville-union`       | none       | no      |
| `michters`                    | none        | `bombergers`            | none       | no      |
| `michters`                    | none        | `shenks`                | none       | no      |
| `midleton`                    | none        | `green-spot`            | none       | no      |
| `midleton`                    | none        | `method-and-madness`    | unknown    | **yes** |
| `midleton`                    | none        | `midleton-very-rare`    | none       | no      |
| `midleton`                    | none        | `powers-johns-lane`     | none       | no      |
| `midleton`                    | none        | `redbreast`             | none       | no      |
| `midleton`                    | none        | `yellow-spot`           | none       | no      |
| `redwood-empire`              | none        | `lost-monarch`          | none       | no      |
| `redwood-empire`              | none        | `pipe-dream`            | none       | no      |
| `speyburn`                    | light       | `bradan-orach`          | none       | **yes** |
| `springbank`                  | light       | `longrow`               | heavy      | **yes** |
| `tobermory`                   | none        | `ledaig`                | heavy      | **yes** |
| `tomatin`                     | none        | `cu-bocan`              | light      | **yes** |
| `tomatin`                     | none        | `the-talisman`          | none       | no      |
| `tomintoul`                   | none        | `old-ballantruan`       | heavy      | **yes** |
| `virginia-distillery-company` | none        | `courage-conviction`    | none       | no      |
| `willett`                     | none        | `johnny-drum`           | none       | no      |
| `willett`                     | none        | `kentucky-vintage`      | none       | no      |
| `willett`                     | none        | `noahs-mill`            | none       | no      |
| `willett`                     | none        | `pure-kentucky-xo`      | none       | no      |
| `willett`                     | none        | `rowans-creek`          | none       | no      |

## 3b. Recommended promotions — the one decision this dossier asks for

The auto-gate is asymmetric on purpose: a positive peat claim needs Islay, a
peat word in the slug, or a citation from the producer's own domain, and 28
rows failed that. Being withheld is safe — an unresolved producer loses peat
tags rather than gaining wrong ones — but it means these whiskies will **not**
be excluded by a `peated` filter until someone promotes them.

The ones where withholding is most visibly wrong, in order:

| slug              | peat   | why it should go live                                                                                    |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `highland-park`   | medium | A major peated malt (heather peat, whole range). Withheld only because Orkney is `islands`, not `islay`. |
| `longrow`         | heavy  | Springbank's heavily peated sibling, ~55 ppm, cited. Withheld only because Campbeltown is not Islay.     |
| `benromach`       | light  | Cited; the brief itself uses `benromach Peat Smoke` as a worked example.                                 |
| `johnnie-walker`  | light  | The brief's own calibration example for `light`.                                                         |
| `springbank`      | light  | Set by cross-check in P1.7; the brief lists it under `light`.                                            |
| `jura`            | light  | Set by cross-check in P1.7, three citations.                                                             |
| `cu-bocan`        | light  | Tomatin's lightly peated sibling brand, cited from Wikipedia's Tomatin article.                          |
| `lagg`            | heavy  | Arran's second, peated distillery, ~50 ppm, cited.                                                       |
| `an-orkney`       | medium | The teaspooned Highland Park label — the plan names it explicitly as a seed acceptance row.              |
| `old-ballantruan` | heavy  | Tomintoul's peated line; `low` confidence only because no ppm figure was found.                          |
| `yoichi`          | medium | Nikka's coal-fired Hokkaido malt; recovered from the brandless products in P1.5.                         |
| `man-o-sword`     | medium | Annandale's peated line, against its unpeated `man-o-words` twin. Wikipedia states the split outright.   |

To promote, append to `curation/overrides.tsv` — `status` overrides are applied
after the gate, so they stick:

```
highland-park	status	verified	Reviewed 2026-08-28: major peated malt, withheld only for not being Islay.
```

Leaving them withheld is a legitimate choice too. It costs recall on a peat
filter, never correctness.

## 4. Cross-check hits

Recorded in full in `cross-check-report.md`; the decisions are the 11
rows of `overrides.tsv`. The four that changed a peat level:
`springbank` medium->light, `macduff` light->none, `jura` none->light,
`clynelish` none->light.

## 5. Known limitation to sign off on

The alias `jura` is four characters and `KB_NAME_ALIAS_MIN_LENGTH` is
five, so it may only match a whole brand value, never a product name.
`Old Malt Cask Jura` therefore resolves its bottler (Hunter Laing) but
not its distillery. Lowering the floor is a P0 decision and was left
alone; the consequence is in the safe direction, since an unresolved
producer removes peat tags rather than inventing them.
