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

export const COUNTRY_CODE_MAX_LENGTH = 8;
export const COUNTRY_NAME_MAX_LENGTH = 64;
export const COUNTRY_ICON_MAX_LENGTH = 32;

export const CURRENCY_MAX_LENGTH = 8;
export const DEFAULT_CURRENCY = 'UAH';

export const PRICE_PRECISION = 12;
export const PRICE_SCALE = 2;
