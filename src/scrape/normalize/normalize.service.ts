import { Injectable } from '@nestjs/common';

import { FactSource, ProductFactField } from '~enums';
import {
  BrandUtils,
  KbAliasUtils,
  KbKeyUtils,
  ProductMatchUtils,
  ProductNameUtils,
} from '~utils';

import {
  BRAND_INFO,
  BRAND_KEYS,
  COUNTRY_KEYWORDS,
  FLAVOR_KEYWORDS,
  TYPE_KEYWORDS,
  UMBRELLA_COUNTRIES,
} from './brand-info.constants';

import type { KbAliasEntry, ProductSnapshot } from '~types';
import type { BrandDetection } from './normalize.interfaces';

// Cyrillic letters, used in place of ASCII-only \w / \b (JS keeps those ASCII
// even under the u flag, unlike Python's Unicode-aware regex). The trailing
// negative lookahead reproduces Python's word boundary after a Cyrillic unit.
const CYRILLIC = 'а-яіїєґ';
const NOT_LETTER = `(?![a-z${CYRILLIC}])`;

// Volume: "0.7 л", "0,7л", "700 мл", "1 l". `літр` comes first so the shorter
// `л` alternative does not steal the match inside the longer word.
const VOLUME_ML = new RegExp(`(\\d{2,4})\\s*(?:мл|ml)${NOT_LETTER}`, 'i');
const VOLUME_L = new RegExp(
  `(\\d+(?:[.,]\\d+)?)\\s*(?:літр|л|l)${NOT_LETTER}`,
  'i',
);

// ABV: "40%", "43 %", "alc 46%".
const ABV = /(\d{1,2}(?:[.,]\d)?)\s*%/g;

// Age: "12 yo", "12 y.o.", "12 уо", "12 років", "aged 15 years", the Russian
// "11 лет" a few listings use. Reading the number whole (\d{1,3}) keeps
// "250 років" from being read as "50".
//
// Kept in step with `AGE_YO`, `AGE_YO_CYRILLIC` and `AGE_WORDS` in
// `utils/product-name.util.ts`, which delete the same tokens from the display
// name -- and the pairing is load-bearing, not tidiness. A token this pattern
// misses but the stripper deletes is an age that vanishes from the name
// *and* never reaches `product.age`, so `ProductMatchUtils.key` signs the
// bottling `|a0` and every age of that expression collapses onto one row.
// The Cyrillic transliteration `уо` is exactly how that happened: Rozetka and
// MauDau spell it that way, so "Dalmore 12уо", "15уо", "18уо" and "30 уо"
// were one product listed as a 12-year-old.
const AGE = new RegExp(
  '(?<!\\d)(\\d{1,3})\\s*'
    + '(?:y\\.?o\\.?|yo|уо|years?|років|роки|рік|year|лет|года|год)'
    + NOT_LETTER,
  'i',
);
const AGE_VYTR = new RegExp(`витримк[${CYRILLIC}]*\\s*(?<!\\d)(\\d{1,3})`, 'i');

// Non-alphanumeric run (Cyrillic included) used to tokenize a brand haystack.
const BRAND_NON_ALNUM = new RegExp(`[^0-9a-z${CYRILLIC}]+`, 'gi');

// A bare number field value ("0.7", "1") with no unit.
const BARE_NUMBER = /^\s*(\d+(?:[.,]\d+)?)\s*$/;

// A field value that is purely a number with an optional unit.
const NUMBER_WITH_UNIT = /\d{1,2}(?:[.,]\d)?/g;

/**
 * The snapshot facts that carry provenance, each paired with how to read it.
 *
 * One list drives both stamping sweeps — the "the store said this" pass before
 * any derivation and the "this pass worked it out" one after — so a fact can
 * never be added to the pipeline and silently left without a source.
 */
const STORE_FACT_FIELDS: [
  ProductFactField,
  (snap: ProductSnapshot) => unknown,
][] = [
  [ProductFactField.VOLUME, (snap): unknown => snap.volumeMl],
  [ProductFactField.ABV, (snap): unknown => snap.abv],
  [ProductFactField.AGE, (snap): unknown => snap.ageYears],
  [ProductFactField.TYPE, (snap): unknown => snap.whiskyType],
  [ProductFactField.COUNTRY, (snap): unknown => snap.country],
];

const ABV_MIN = 30;
const ABV_MAX = 70;
const AGE_MIN = 1;
const AGE_MAX = 60;
const LITRE_THRESHOLD = 20;
const DISCOUNT_PREFIXES = '-−–';

/**
 * Deterministic extraction of volume / ABV / age / flavor / type / country
 * from product names and detail-page field values. A direct port of the
 * Python `normalize` module; brand and display-name canonicalization are
 * delegated to the shared `BrandUtils` / `ProductNameUtils`.
 */
@Injectable()
export class NormalizeService {
  /**
   * Parses a number, accepting a comma decimal separator.
   *
   * @param raw - The numeric string.
   * @returns The parsed float.
   */
  private static toFloat(raw: string): number {
    return Number.parseFloat(raw.replace(',', '.'));
  }

  /**
   * Extracts the volume in millilitres from free text.
   *
   * A gift set that joins its bottles with `+` is summed rather than read off
   * the first match: `Wild Turkey 0.7 л + Wild Turkey 101 0.7 л` is 1.4 л, and
   * recording it as 0.7 л put a two-bottle price beside single bottles in the
   * report. `bundleSegments` returns null for an accessory bundle
   * (`+ 2 склянки`) and for a brand spelled with a `+` (`Roe + Co`), so only a
   * real set is summed.
   *
   * @param text - Text to search (name or field value).
   * @returns The volume in millilitres, or null when none is found.
   */
  public extractVolumeMl(text: string): number | null {
    const segments = ProductNameUtils.bundleSegments(text);

    if (segments) {
      const volumes = segments
        .map((segment) => this.singleVolumeMl(segment))
        .filter((volume): volume is number => volume !== null);

      if (volumes.length > 1) {
        return volumes.reduce((total, volume) => total + volume, 0);
      }
    }

    return this.singleVolumeMl(text);
  }

  /**
   * Extracts the first volume stated in a fragment.
   *
   * @param text - Text to search.
   * @returns The volume in millilitres, or null when none is found.
   */
  private singleVolumeMl(text: string): number | null {
    const ml = VOLUME_ML.exec(text);

    if (ml) {
      return Number.parseInt(ml[1], 10);
    }

    const litres = VOLUME_L.exec(text);

    if (litres) {
      return Math.round(NormalizeService.toFloat(litres[1]) * 1000);
    }

    return null;
  }

  /**
   * Extracts the ABV percent from free text, ignoring discounts (`-25%`) and
   * values outside the whisky range.
   *
   * @param text - Text to search.
   * @returns The ABV percent, or null when none is found.
   */
  public extractAbv(text: string): number | null {
    ABV.lastIndex = 0;

    let match = ABV.exec(text);

    while (match !== null) {
      /**
       * The index check must gate the lookup, not feed it an empty string:
       * `DISCOUNT_PREFIXES.includes('')` is true, which used to make a
       * percentage at the very start of the text ("40%", the shape a detail
       * page's characteristics field has) read as a discount and be skipped.
       */
      const isDiscount = match.index > 0
        && DISCOUNT_PREFIXES.includes(text[match.index - 1]);

      if (!isDiscount) {
        const value = NormalizeService.toFloat(match[1]);

        if (value >= ABV_MIN && value <= ABV_MAX) {
          return value;
        }
      }

      match = ABV.exec(text);
    }

    return null;
  }

  /**
   * Extracts an explicit age statement (in years) from short text — a product
   * name or a spec field, never a marketing description. Values outside 1–60
   * are ignored.
   *
   * @param text - Text to search.
   * @returns The age in years, or null when none is found.
   */
  public extractAgeYears(text: string): number | null {
    /**
     * Read from the folded text, the same view `ProductNameUtils` strips
     * from. Several stores type a word with a stray look-alike letter of the
     * other alphabet — `Вiскi Chivas Regal 12 рокiв` carries a Latin `i`
     * inside a Cyrillic word -- and the raw string then matches the stripper
     * (which folds first) but not this pattern, so the age is deleted from
     * the name and recorded nowhere.
     */
    const folded = ProductNameUtils.foldScripts(text);
    const age = AGE.exec(folded);

    if (age) {
      const value = Number.parseInt(age[1], 10);

      if (value >= AGE_MIN && value <= AGE_MAX) {
        return value;
      }
    }

    const vytr = AGE_VYTR.exec(folded);

    if (vytr) {
      const value = Number.parseInt(vytr[1], 10);

      if (value >= AGE_MIN && value <= AGE_MAX) {
        return value;
      }
    }

    return null;
  }

  /**
   * Determines the whisky type from text (single malt / blend / bourbon / ...).
   *
   * @param text - Text to classify.
   * @returns The canonical type, or null when undetermined.
   */
  public extractType(text: string): string | null {
    const lowered = ` ${text.toLowerCase()} `;

    const found = TYPE_KEYWORDS.find(
      ([, keywords]) => keywords.some((keyword) => lowered.includes(keyword)),
    );

    return found ? found[0] : null;
  }

  /**
   * Determines the origin country from keyword matches (Ukrainian name).
   *
   * @param text - Text to classify.
   * @returns The canonical country name, or null when undetermined.
   */
  public extractCountry(text: string): string | null {
    const lowered = text.toLowerCase();

    const found = COUNTRY_KEYWORDS.find(
      ([, keywords]) => keywords.some((keyword) => lowered.includes(keyword)),
    );

    return found ? found[0] : null;
  }

  /**
   * Reduces a source country value to the project taxonomy: concrete countries
   * pass through; the umbrella "United Kingdom" is dropped so the brand/keyword
   * pass can refine it.
   *
   * @param value - The raw country value.
   * @returns The canonical country name, or null.
   */
  public canonicalCountry(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const trimmed = value.trim();

    if (UMBRELLA_COUNTRIES.has(trimmed.toLowerCase())) {
      return null;
    }

    return trimmed || null;
  }

  /**
   * Parses an ABV from a spec field value where `%` may be absent (`40`, `40%`,
   * `37-43%`): the first number in the whisky range.
   *
   * @param text - The field value.
   * @returns The ABV percent, or null.
   */
  public parseAbvValue(text: string | null | undefined): number | null {
    if (!text) {
      return null;
    }

    const matches = text.match(NUMBER_WITH_UNIT) ?? [];

    for (const raw of matches) {
      const value = NormalizeService.toFloat(raw);

      if (value >= ABV_MIN && value <= ABV_MAX) {
        return value;
      }
    }

    return null;
  }

  /**
   * Parses a volume from a spec field value. A bare number (no unit) is read as
   * litres (`0.7` → 700, `1` → 1000); values with units go through
   * {@link extractVolumeMl}.
   *
   * @param text - The field value.
   * @returns The volume in millilitres, or null.
   */
  public parseVolumeValue(text: string | null | undefined): number | null {
    if (!text) {
      return null;
    }

    const ml = this.extractVolumeMl(text);

    if (ml) {
      return ml;
    }

    const bare = BARE_NUMBER.exec(text);

    if (bare) {
      const value = NormalizeService.toFloat(bare[1]);

      return value < LITRE_THRESHOLD
        ? Math.round(value * 1000)
        : Math.round(value);
    }

    return null;
  }

  /**
   * Parses an age from a spec field value where the unit may be absent (`12`,
   * `12 років`): a bare number is read as years; values with words go through
   * {@link extractAgeYears}. Values outside 1–60 are ignored.
   *
   * @param text - The field value.
   * @returns The age in years, or null.
   */
  public parseAgeValue(text: string | null | undefined): number | null {
    if (!text) {
      return null;
    }

    const bare = BARE_NUMBER.exec(text);

    if (bare) {
      const value = Number.parseInt(bare[1], 10);

      return value >= AGE_MIN && value <= AGE_MAX ? value : null;
    }

    return this.extractAgeYears(text);
  }

  /**
   * Extracts the flavor tags present in text.
   *
   * @param text - Text to scan.
   * @returns The matched tags, sorted and deduplicated.
   */
  public extractFlavorTags(text: string): string[] {
    const lowered = text.toLowerCase();

    const tags = FLAVOR_KEYWORDS
      .filter(([, keywords]) => keywords.some((kw) => lowered.includes(kw)))
      .map(([tag]) => tag);

    return [...new Set(tags)].sort();
  }

  /**
   * Infers origin country and type from a known brand in the name or brand
   * field.
   *
   * @param name - The product name.
   * @param brand - The brand field, when present.
   * @returns The detected country and type (each null when unknown).
   */
  public detectBrandInfo(
    name: string,
    brand?: string | null,
  ): BrandDetection {
    const haystacks = [this.brandHaystack(name)];

    if (brand) {
      haystacks.push(this.brandHaystack(brand));
    }

    const key = BRAND_KEYS.find((candidate) => {
      const needle = ` ${candidate} `;

      return haystacks.some((haystack) => haystack.includes(needle));
    });

    if (!key) {
      return { country: null, type: null };
    }

    const info = BRAND_INFO.get(key);

    return { country: info?.country ?? null, type: info?.type ?? null };
  }

  /**
   * The brand string that decides a bottling's identity.
   *
   * **Not the brand a listing shows, and not the label a report prints.** It
   * is the token `ProductMatchUtils.key` folds into the frozen match key, and
   * it is resolved against the knowledge base so that nineteen shops spelling
   * one maker nineteen ways still sign the same bottling: `The Macallan` and
   * `Macallan`, `M H` and `M&h Elements`, `Chivas` and `Chivas Regal`,
   * `Isle of Jura` and `Jura` all reduce to one producer here.
   *
   * The resolved value is the producer's **slug**, never its name. Both are
   * curated, but `producer.name` is a display string that
   * `PATCH /producer/:id` rewrites, and a match key that moved whenever a
   * reviewer tidied a spelling would be no more stable than the shop strings
   * this replaces. The slug is unique, is never edited for display, and is
   * short — folding to the name instead inflated the key with the producer's
   * legal title (`TBWC` becomes `thatboutiqueycompany`) and restated three
   * times as many keys for no gain.
   *
   * A brand the knowledge base does not know falls back to its own canonical
   * spelling, which is exactly what the key used before, so an unresearched
   * brand keeps working and simply stops improving.
   *
   * @param snap - The snapshot to identify.
   * @param aliases - The knowledge base's alias index, longest key first.
   * @returns The identity brand, or null when neither the brand field nor the
   *   name names anything.
   */
  public resolveKeyBrand(
    snap: ProductSnapshot,
    aliases: KbAliasEntry[],
  ): string | null {
    const canonical = BrandUtils.canonical(snap.brand);

    if (canonical !== null) {
      const stated = KbAliasUtils.matchByBrand(
        KbKeyUtils.key(canonical),
        aliases,
      );

      return stated ? stated.producer.slug : canonical;
    }

    const named = KbAliasUtils.matchInName(
      KbKeyUtils.normalize(snap.name),
      aliases,
    );

    return named ? named.producer.slug : null;
  }

  /**
   * Enriches a snapshot with derived fields without overwriting values the
   * site already provided. Age and type are read only from the name (a
   * description's "N years" usually means brand history, not maturation).
   *
   * `snap.brand` is left holding **what the shop stated**, canonicalized and
   * nothing more. It used to be filled in from the product name when a shop
   * stated none, and that job has moved: the name now reaches the knowledge
   * base directly, through {@link resolveKeyBrand} for identity and through
   * `KbResolverService` for the producer a report labels the bottling with.
   * What survives here is the one thing neither of those records — the string
   * a shop actually used — which is what `product.brandOrig` stores and what
   * `pnpm research-brands` reads to find the makers the knowledge base is
   * still missing.
   *
   * @param snap - The snapshot to enrich (mutated in place).
   * @returns The same snapshot.
   */
  public normalize(snap: ProductSnapshot): ProductSnapshot {
    /**
     * Taken before anything is derived: whatever the snapshot already carries
     * at this point came from the store's listing or its detail page, because
     * `enrichDetail` runs before this pass and the LLM one runs after. That
     * ordering is what lets provenance be decided in one place instead of in
     * every adapter.
     */
    this.stampStoreSources(snap);

    snap.brand = BrandUtils.canonical(snap.brand);

    const haystack = this.haystack(snap);

    // Age and type read only from the name (a description's "N years" usually
    // means brand history, not maturation); everything else from the haystack.
    snap.volumeMl ??= this.extractVolumeMl(haystack);
    snap.abv ??= this.extractAbv(haystack);
    snap.ageYears ??= this.extractAgeYears(snap.name);
    snap.whiskyType ??= this.extractType(snap.name);
    snap.country ??= this.extractCountry(haystack);

    if (snap.country === null || snap.whiskyType === null) {
      const detected = this.detectBrandInfo(snap.name, snap.brand);

      snap.country ??= detected.country;
      snap.whiskyType ??= detected.type;
    }

    this.stampDerivedSources(snap);

    const flavors = new Set([
      ...snap.flavorTags,
      ...this.extractFlavorTags(haystack),
    ]);

    snap.flavorTags = [...flavors].sort();

    return snap;
  }

  /**
   * The cross-store identity of the bottling a snapshot describes.
   *
   * Callable before {@link normalize} has run, which is what the detail-page
   * gate needs: the brand is resolved the same way `normalize` resolves it, and
   * volume and age fall back to what the name states. Reading the name is
   * fail-open there — a key that misses costs one detail fetch, never a wrong
   * link — and deliberately does **not** write the derived values onto the
   * snapshot, because the detail page's spec fields must still win over
   * anything guessed from a name.
   *
   * @param snap - The snapshot to identify.
   * @param aliases - The knowledge base's alias index; empty resolves nothing
   *   and falls back to the shop's own spelling.
   * @returns The match key, or null when the name carries no identity.
   */
  public matchKey(
    snap: ProductSnapshot,
    aliases: KbAliasEntry[] = [],
  ): string | null {
    const brand = this.resolveKeyBrand(snap, aliases);

    return ProductMatchUtils.key(
      ProductNameUtils.resolve(snap.cleanName, snap.name),
      brand,
      snap.volumeMl ?? this.extractVolumeMl(snap.name),
      snap.ageYears ?? this.extractAgeYears(snap.name),
    );
  }

  /**
   * Whether a snapshot still lacks a field the regex pass could not fill, so
   * the LLM fallback is worth trying.
   *
   * @param snap - The snapshot to check.
   * @returns True when ABV or volume is still missing.
   */
  public needsLlm(snap: ProductSnapshot): boolean {
    return snap.abv === null || snap.volumeMl === null;
  }

  /**
   * Marks every fact the store itself supplied.
   *
   * Called before any derivation, so "already present" is an exact test:
   * adapters and detail pages have run, this pass and the LLM one have not.
   *
   * @param snap - The snapshot to stamp (mutated in place, as the whole
   *   pipeline is).
   * @returns Nothing.
   */
  private stampStoreSources(snap: ProductSnapshot): void {
    STORE_FACT_FIELDS.forEach(([field, read]) => {
      if (read(snap) !== null && read(snap) !== undefined) {
        snap.factSources[field] = FactSource.STORE;
      }
    });
  }

  /**
   * Marks every fact this pass derived from the name or the description.
   *
   * Anything still unstamped but now filled was produced here, so one sweep
   * after the derivations covers all of them without threading a stamp through
   * each `??=`.
   *
   * @param snap - The snapshot to stamp (mutated in place).
   * @returns Nothing.
   */
  private stampDerivedSources(snap: ProductSnapshot): void {
    STORE_FACT_FIELDS.forEach(([field, read]) => {
      this.stamp(snap, field, read(snap));
    });
  }

  /**
   * Stamps one fact as name-derived, unless it already has a source.
   *
   * @param snap - The snapshot to stamp (mutated in place).
   * @param field - The fact field.
   * @param value - The value now held, used only to skip empty facts.
   * @returns Nothing.
   */
  private stamp(
    snap: ProductSnapshot,
    field: ProductFactField,
    value: unknown,
  ): void {
    if (value === null || value === undefined) {
      return;
    }

    snap.factSources[field] ??= FactSource.NAME;
  }

  /**
   * Builds the search text for a snapshot: its name plus every string value in
   * `rawAttrs` (description, attributes).
   *
   * @param snap - The snapshot.
   * @returns The combined search text.
   */
  private haystack(snap: ProductSnapshot): string {
    const parts = [snap.name];

    Object.values(snap.rawAttrs).forEach((value) => {
      if (typeof value === 'string') {
        parts.push(value);
      }
    });

    return parts.join(' ');
  }

  /**
   * Normalizes text for brand matching: lower-cased, apostrophes removed, every
   * non-alphanumeric run collapsed to a space, wrapped in spaces so a key can
   * be matched as a whole word.
   *
   * @param text - The text to normalize.
   * @returns The space-wrapped normalized haystack.
   */
  private brandHaystack(text: string): string {
    const stripped = text
      .toLowerCase()
      .replace(/['`’]/g, '')
      .replace(BRAND_NON_ALNUM, ' ')
      .trim();

    return ` ${stripped} `;
  }
}
