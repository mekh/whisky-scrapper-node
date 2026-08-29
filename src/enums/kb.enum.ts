/**
 * What kind of entity a `producer` row describes. All four are stored in one
 * table because they share the same aliases, the same citations and the same
 * review workflow — and because a name in a product title does not announce
 * which kind it is.
 */
export enum ProducerKind {
  /**
   * A physical distillery: Tobermory, Laphroaig, Nikka Yoichi.
   */
  DISTILLERY = 'distillery',
  /**
   * A named brand whose liquid comes from a known distillery, recorded as its
   * `parentId`. This is the row type that fixes the reported bug: `Ledaig` is
   * a brand of the Tobermory distillery with its own peat profile, and so are
   * `Port Charlotte` (Bruichladdich), `An Orkney` (Highland Park) and the
   * teaspooned labels `Williamson` (Laphroaig) and `Burnside` (Balvenie).
   */
  BRAND = 'brand',
  /**
   * A blend or vatting with no single distillery of origin: Johnnie Walker,
   * Big Peat, Finlaggan, and the several hundred own-label bottlings.
   */
  BLEND = 'blend',
  /**
   * An independent bottler or retailer range: Douglas Laing, Signatory,
   * Gordon & MacPhail. A product whose brand resolves to a bottler carries
   * its distillery inside the name, which is what the resolver extracts.
   */
  BOTTLER = 'bottler',
}

/**
 * Whisky region as the market and the labels use it — the filter and display
 * value. Includes `islands`, which the Scotch Whisky Regulations do **not**
 * recognise; see {@link ScotlandLegalRegion}.
 */
export enum ScotlandRegion {
  /**
   * Campbeltown: Springbank, Glen Scotia, Glengyle.
   */
  CAMPBELTOWN = 'campbeltown',
  /**
   * Mainland Highland.
   */
  HIGHLAND = 'highland',
  /**
   * Islay.
   */
  ISLAY = 'islay',
  /**
   * Lowland.
   */
  LOWLAND = 'lowland',
  /**
   * Speyside.
   */
  SPEYSIDE = 'speyside',
  /**
   * The islands other than Islay: Mull, Skye, Orkney, Jura, Arran. Legally
   * Highland, universally listed apart.
   */
  ISLANDS = 'islands',
}

/**
 * The five protected regions of the Scotch Whisky Regulations 2009. Stored
 * separately from {@link ScotlandRegion} because Tobermory, Talisker, Highland
 * Park, Jura and Arran are all formally Highland while every shop and every
 * enthusiast calls them island whiskies — so one column cannot answer both
 * questions without being wrong for one of them.
 */
export enum ScotlandLegalRegion {
  /**
   * Campbeltown.
   */
  CAMPBELTOWN = 'campbeltown',
  /**
   * Highland — which legally subsumes every island except Islay.
   */
  HIGHLAND = 'highland',
  /**
   * Islay.
   */
  ISLAY = 'islay',
  /**
   * Lowland.
   */
  LOWLAND = 'lowland',
  /**
   * Speyside.
   */
  SPEYSIDE = 'speyside',
}

/**
 * How peated a producer's standard line is. An ordinal band, never a phenol
 * ppm number: the figures published for ppm conflate the malt specification,
 * the new-make spirit and the bottled product, which differ by three to ten
 * times, so a stored number would be a fact-shaped guess.
 *
 * There is deliberately no `variable` band. A producer running several peating
 * levels (Bruichladdich, Springbank, Bunnahabhain) is modelled as separate
 * `producer` rows and `flavor_rule` overrides, because `variable` would leave
 * the resolver with nothing to act on — which is the failure mode this work
 * removes.
 */
export enum PeatProfile {
  /**
   * Not researched, or researched and genuinely unknown. Never treated as
   * "unpeated": the peat tags are removed rather than asserted.
   */
  UNKNOWN = 'unknown',
  /**
   * Unpeated. Tobermory, Glenfiddich, Macallan.
   */
  NONE = 'none',
  /**
   * A trace of smoke, not a peated whisky. Johnnie Walker Black, Benromach.
   * Yields the `smoky` tag only.
   */
  LIGHT = 'light',
  /**
   * Clearly peated but not a peat monster. Talisker, Highland Park, Bowmore.
   */
  MEDIUM = 'medium',
  /**
   * Heavily peated. Ardbeg, Laphroaig, Lagavulin, Ledaig, Port Charlotte.
   */
  HEAVY = 'heavy',
}

/**
 * How much a knowledge-base row has been checked, and therefore whether the
 * resolver is allowed to act on it. Only `verified` and `auto` rows are ever
 * loaded into the match index, so `unverified` and `rejected` are both inert —
 * the difference between them is intent, and only `rejected` is a decision.
 */
export enum KbStatus {
  /**
   * A person confirmed the row. Required for every positive peat profile, for
   * the highest-volume brands, and for anything a cross-check flagged.
   */
  VERIFIED = 'verified',
  /**
   * Auto-applied by the research pass because it cleared the confidence gate
   * (high confidence, at least two citing hosts, and — for a positive peat
   * profile — a corroborating signal). Live, but still listed for review.
   */
  AUTO = 'auto',
  /**
   * Researched but not trusted, or researched and unresolvable. Persisted so
   * the brand is never researched twice, and ignored by the resolver.
   */
  UNVERIFIED = 'unverified',
  /**
   * A person ruled the row out: it is not a whisky producer at all. The
   * research input was `SELECT DISTINCT name FROM brand`, so the catalogue's
   * own dirt came with it — a retailer's name that leaked into the brand
   * column, a sherry bodega, a brandy, a cocktail.
   *
   * Distinct from `unverified` rather than a deletion, and that is the point:
   * the row stays, so the decision is auditable, `pnpm research-brands` never
   * pays to look the brand up again, and `pnpm kb-export` carries the verdict
   * to the next environment instead of letting a fresh seed resurrect it.
   */
  REJECTED = 'rejected',
}

/**
 * What a curated flavor row asserts about a producer's house style.
 */
export enum KbFlavorEffect {
  /**
   * The house style typically shows this tag. Used to ground the LLM prompt
   * and to fill bottlings the model answered "unknown" for — never to
   * overwrite a per-expression answer, because a cask finish legitimately
   * departs from the house style.
   */
  BASELINE = 'baseline',
  /**
   * Every bottling of this producer carries the tag.
   */
  REQUIRE = 'require',
  /**
   * No bottling of this producer carries the tag, whatever a store's
   * description or the model says. This is the general form of the Tobermory
   * fix for the thirteen non-peat tags.
   */
  FORBID = 'forbid',
}

/**
 * How a `flavor_rule` pattern is matched against a normalized product name.
 * Both modes are plain string tests, never regular expressions — a rule has to
 * be reviewable by someone who does not read regex.
 */
export enum FlavorRuleMatchMode {
  /**
   * Whole-word match. `peat` must not fire inside `repeat`, and the
   * catalogue's `Johnny Smoking Gun` must not read as peated.
   */
  WORD = 'word',
  /**
   * Word-initial prefix match, for Ukrainian inflection: `торф` has to reach
   * `торф'яний` and `торфяний` without listing every form.
   */
  PREFIX = 'prefix',
}

/**
 * Where an alias may be matched. The distinction exists because a short or
 * generic alias is safe as an exact brand value and actively harmful as a
 * substring of a free-form product name — the catalogue carries
 * `Elements of Islay`, `M&H Elements` and `Glenmorangie Elementa`, so a bare
 * `elements` name-alias would mis-resolve two of the three.
 */
export enum ProducerAliasScope {
  /**
   * Matched only against a product's brand value, as a whole string.
   */
  BRAND = 'brand',
  /**
   * Matched only inside a product name, as whole words.
   */
  NAME = 'name',
  /**
   * Matched both ways.
   */
  ANY = 'any',
}

/**
 * Minimum length for an alias the resolver is allowed to look for **inside** a
 * product name. Short aliases stay brand-scoped: matched as a whole brand
 * value they are unambiguous, matched as a substring they are not.
 */
export const KB_NAME_ALIAS_MIN_LENGTH = 5;
