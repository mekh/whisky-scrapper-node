/**
 * Where a bottling's stored fact came from. Kept on `product` as one
 * `varchar(16)` column per fact field (`typeSource`, `countrySource`, ...),
 * not as a Postgres enum type — mirroring {@link FlavorSource}, so this enum
 * only pins the values the app writes.
 *
 * The values are **ranked** (see {@link FACT_SOURCE_RANK}), and that ranking is
 * the whole mechanism: the canonical write fills a field when it is still null
 * **or** when the incoming source outranks the stored one. Before provenance
 * existed the first writer won forever, so an LLM guess made on the day a
 * bottling was discovered could never be corrected by a store that actually
 * states the value on its spec page — and a hand-curated value was
 * indistinguishable from that guess.
 */
export enum FactSource {
  /**
   * A person set this by hand through `POST /product/update`. Outranks every
   * automatic source and is never overwritten, which is what makes curation
   * durable.
   */
  MANUAL = 'manual',
  /**
   * Resolved from the curated knowledge base (`producer` and its rules). The
   * authority for producer-level facts — country, type, region, peat — because
   * a store's listing and a model's answer are both evidence about the same
   * underlying fact the knowledge base states outright.
   */
  KB = 'kb',
  /**
   * A store's listing or detail page stated the value. The best automatic
   * source: it is a claim by a party that handles the bottle, and it is
   * checkable against other stores (see `product_fact_conflict`).
   */
  STORE = 'store',
  /**
   * Derived from the product name by the deterministic keyword/regex pass in
   * `NormalizeService` — the name says "Islay" or "Bourbon", so the fact is
   * read off the label rather than guessed.
   */
  NAME = 'name',
  /**
   * The LLM field-enrichment pass produced the value with no source stating
   * it. Lowest-ranked live source, and the one the review screen surfaces.
   */
  LLM = 'llm',
  /**
   * Written before provenance existed, so the true source is **unknown**. Not
   * a claim about quality: the backfill deliberately does not guess, because
   * the catalogue holds rows whose age was once read out of a description.
   * The shrinking share of `legacy` is the coverage metric for this work.
   */
  LEGACY = 'legacy',
}

/**
 * Trust order for {@link FactSource}. A higher number wins: the canonical
 * write overwrites a stored value only when the incoming rank is strictly
 * greater, so equal sources keep the first value and no sync rewrites a row it
 * has nothing new to say about.
 *
 * Gaps between the numbers are intentional — a source can be slotted in later
 * without renumbering the ones already persisted.
 */
export const FACT_SOURCE_RANK: Readonly<Record<FactSource, number>> = {
  [FactSource.MANUAL]: 60,
  [FactSource.KB]: 50,
  [FactSource.STORE]: 40,
  [FactSource.NAME]: 30,
  [FactSource.LLM]: 20,
  [FactSource.LEGACY]: 10,
};

/**
 * Source assigned to every non-null fact field that predates the provenance
 * columns.
 */
export const DEFAULT_FACT_SOURCE = FactSource.LEGACY;

/**
 * The bottling fields that carry provenance. The stored column is the value
 * plus `Source` (`type` -> `typeSource`), which is why these are the field
 * *base* names rather than the column names.
 *
 * `matchKey` is absent on purpose: it is derived and frozen at creation, so it
 * has no source beyond "the catalogue decided once".
 */
export enum ProductFactField {
  /**
   * The cleaned display name, owned by the name-extraction pass.
   */
  NAME = 'name',
  /**
   * Whisky type FK. Overwritten by the knowledge base where the resolved
   * producer states a default type.
   */
  TYPE = 'type',
  /**
   * Country FK. Overwritten by the knowledge base whenever a producer
   * resolves — a distillery's country does not vary by bottling.
   */
  COUNTRY = 'country',
  /**
   * Brand FK. Deliberately **not** knowledge-base-owned: the brand is a
   * display and grouping label and a component of the frozen match key.
   */
  BRAND = 'brand',
  /**
   * Alcohol by volume. Physical, per-bottling, so the knowledge base does not
   * curate it — it gets provenance and cross-store conflict logging instead.
   */
  ABV = 'abv',
  /**
   * Stated age in years. Part of the frozen match key, so effectively
   * immutable; provenance records who first supplied it.
   */
  AGE = 'age',
  /**
   * Pack size in millilitres. Part of the frozen match key, same as age.
   */
  VOLUME = 'volume',
  /**
   * The resolved producer (and, with it, the bottler). Written only by the
   * knowledge-base resolver or by hand.
   */
  PRODUCER = 'producer',
}

/**
 * The sources a filter is allowed to trust.
 *
 * `types` and `countries` answer from these and send everything else — `llm`
 * and whatever `legacy` is left — to the filter's `unknown` bucket. The reason
 * is that a filter makes a promise the rest of the app does not: a user who
 * excludes a country is entitled to believe the results really are from
 * somewhere else. A model's recollection and an unattributed historical value
 * cannot carry that promise, and a filter that quietly includes them is worse
 * than one that admits it does not know.
 *
 * The values are still shown in the UI, marked unverified, and are still
 * editable — they are demoted as *filter evidence*, not deleted.
 */
export const TRUSTED_FACT_SOURCES: FactSource[] = [
  FactSource.MANUAL,
  FactSource.KB,
  FactSource.STORE,
  FactSource.NAME,
];
