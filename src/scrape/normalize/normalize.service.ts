import { Injectable } from '@nestjs/common';

import { BrandUtils, ProductMatchUtils, ProductNameUtils } from '~utils';

import {
  BRAND_INFO,
  BRAND_KEYS,
  COUNTRY_KEYWORDS,
  FLAVOR_KEYWORDS,
  TYPE_KEYWORDS,
  UMBRELLA_COUNTRIES,
} from './brand-info.constants';

import type { ProductSnapshot } from '~types';
import type { BrandDetection, BrandMatchEntry } from './normalize.interfaces';

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

// Age: "12 yo", "12 y.o.", "12 років", "aged 15 years", the Russian "11 лет"
// a few listings use. Reading the number whole (\d{1,3}) keeps "250 років"
// from being read as "50". Kept in step with `AGE_WORDS` in
// `utils/product-name.util.ts`, which deletes the same token from the name.
const AGE = new RegExp(
  '(?<!\\d)(\\d{1,3})\\s*'
    + '(?:y\\.?o\\.?|yo|years?|років|роки|рік|year|лет|года|год)'
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
    const age = AGE.exec(text);

    if (age) {
      const value = Number.parseInt(age[1], 10);

      if (value >= AGE_MIN && value <= AGE_MAX) {
        return value;
      }
    }

    const vytr = AGE_VYTR.exec(text);

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
   * Builds the brand match index from the catalogue's known brand names. The
   * table is the source, not the `BRAND_INFO` keys: those are stripped match
   * keys, and title-casing one back into a brand would mint a second row next
   * to the spelling the catalogue already uses ("Jack Daniels" beside
   * "Jack Daniel's").
   *
   * @param names - Canonical brand names, as stored in the `brand` table.
   * @returns The index, longest key first; duplicate keys keep the first name.
   */
  public buildBrandIndex(names: string[]): BrandMatchEntry[] {
    const seen = new Set<string>();
    const entries: BrandMatchEntry[] = [];

    names.forEach((name) => {
      const key = this.brandHaystack(name).trim();

      if (key && !seen.has(key)) {
        seen.add(key);
        entries.push({ key, name });
      }
    });

    return entries.sort((left, right) => right.key.length - left.key.length);
  }

  /**
   * Finds the brand a product name states. Longest key first, so a specific
   * brand wins over a shorter one contained in it ("Highland Park" over
   * "Highland"), and both sides are space-wrapped, so a key only matches whole
   * words ("Arran" never matches inside "arrangement"). Reads the name alone —
   * a description mentions other brands.
   *
   * @param name - The product name.
   * @param index - The brand index (see {@link buildBrandIndex}).
   * @returns The canonical brand name, or null when none matched.
   */
  public detectBrandFromName(
    name: string,
    index: BrandMatchEntry[],
  ): string | null {
    const haystack = this.brandHaystack(name);

    const match = index.find((entry) => haystack.includes(` ${entry.key} `));

    return match?.name ?? null;
  }

  /**
   * Enriches a snapshot with derived fields without overwriting values the
   * site already provided. Age and type are read only from the name (a
   * description's "N years" usually means brand history, not maturation).
   *
   * @param snap - The snapshot to enrich (mutated in place).
   * @param brandIndex - Known brand names to read a missing brand from; empty
   * disables that pass. Passed in per run rather than cached here, since the
   * service is a singleton and stores sync concurrently.
   * @returns The same snapshot.
   */
  public normalize(
    snap: ProductSnapshot,
    brandIndex: BrandMatchEntry[] = [],
  ): ProductSnapshot {
    snap.brand = BrandUtils.canonical(snap.brand);

    if (snap.brand === null && brandIndex.length > 0) {
      snap.brand = this.detectBrandFromName(snap.name, brandIndex);
    }

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
   * @param brandIndex - Known brand names, to read a missing brand from.
   * @returns The match key, or null when the name carries no identity.
   */
  public matchKey(
    snap: ProductSnapshot,
    brandIndex: BrandMatchEntry[] = [],
  ): string | null {
    const brand = BrandUtils.canonical(snap.brand)
      ?? (brandIndex.length > 0
        ? this.detectBrandFromName(snap.name, brandIndex)
        : null);

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
