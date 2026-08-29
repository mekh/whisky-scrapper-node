export const STORE_SLUG_MAX_LENGTH = 64;
export const STORE_NAME_MAX_LENGTH = 128;
export const BASE_URL_MAX_LENGTH = 512;
export const COLOR_MAX_LENGTH = 16;
export const RETAIL_CHAIN_MAX_LENGTH = 64;
export const STORE_CATEGORY_MAX_LENGTH = 64;
export const STORE_GROUP_MAX_LENGTH = 32;
export const SYNC_ENGINE_MAX_LENGTH = 16;
export const SYNC_TRIGGER_MAX_LENGTH = 16;
export const SYNC_LOG_FILE_MAX_LENGTH = 256;

export const PRODUCT_SKU_MAX_LENGTH = 128;
export const PRODUCT_URL_MAX_LENGTH = 1024;
export const PRODUCT_NAME_MAX_LENGTH = 512;

/**
 * Ceiling for the derived cross-store match key. The inputs bound it at
 * roughly 780 characters (a 512-char name plus a 256-char brand plus the
 * volume and age suffix), which stays under the btree index tuple limit even
 * if every character is two-byte Cyrillic. Measured keys are far shorter — 82
 * characters at the catalogue's longest.
 */
export const PRODUCT_MATCH_KEY_MAX_LENGTH = 1024;

export const BRAND_NAME_MAX_LENGTH = 256;
export const WHISKY_TYPE_NAME_MAX_LENGTH = 64;
export const FLAVOR_NAME_MAX_LENGTH = 64;
export const FLAVOR_SOURCE_MAX_LENGTH = 16;

export const PRODUCER_SLUG_MAX_LENGTH = 64;
export const PRODUCER_NAME_MAX_LENGTH = 128;
export const PRODUCER_OWNER_MAX_LENGTH = 128;
export const PRODUCER_ALIAS_MAX_LENGTH = 128;
export const FLAVOR_RULE_PATTERN_MAX_LENGTH = 64;

/**
 * Width of every knowledge-base enum column (`kind`, `region`, `status`,
 * `effect`, `peatProfile`, ...) and of the per-field provenance columns on
 * `product`. Matches `FLAVOR_SOURCE_MAX_LENGTH`, which is the same kind of
 * app-pinned varchar-instead-of-pg-enum column.
 */
export const KB_ENUM_MAX_LENGTH = 16;

/**
 * Width of `product_fact_conflict.storedValue` / `claimedValue`. They hold a
 * human-readable rendering of a disputed fact — a country name, a type name, a
 * brand name or a formatted number — so the widest real input is a brand name,
 * truncated to keep the QA log narrow.
 */
export const FACT_CONFLICT_VALUE_MAX_LENGTH = 128;

/**
 * Width of `product_fact_conflict.attribute`, which holds a
 * `ProductFactField` value.
 */
export const FACT_ATTRIBUTE_MAX_LENGTH = 16;

/**
 * The two flavor tags the knowledge base owns outright.
 *
 * They live here, in the leaf constants layer, rather than beside the other
 * thirteen in `scrape/normalize/brand-info.constants.ts`, because `core/` must
 * not import from `scrape/` and the peat mapping is a core-layer write. The
 * scrape-side vocabulary imports these instead of restating them, so the two
 * halves of the fifteen-tag vocabulary cannot drift apart.
 *
 * `peated` means peat, and after reconciliation it has exactly one automatic
 * source: this knowledge base. `smoky` means smokiness in general, so it also
 * covers non-peat smoke — Jack Daniel's charcoal mellowing keeps its `smoky`
 * tag through a curated house-style row while carrying no peat at all.
 */
export const KB_PEAT_TAGS = {
  peated: 'peated',
  smoky: 'smoky',
} as const;

export const COUNTRY_CODE_MAX_LENGTH = 8;
export const COUNTRY_NAME_MAX_LENGTH = 64;
export const COUNTRY_ICON_MAX_LENGTH = 32;

export const CURRENCY_MAX_LENGTH = 8;
export const DEFAULT_CURRENCY = 'UAH';

export const PRICE_PRECISION = 12;
export const PRICE_SCALE = 2;
