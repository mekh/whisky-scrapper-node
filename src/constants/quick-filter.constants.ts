/**
 * How many saved filter sets one user may hold. The binding constraint is
 * scannability of the picker, not storage.
 */
export const QUICK_FILTER_MAX_PER_USER = 20;

/**
 * Maximum length of a filter set's name.
 */
export const QUICK_FILTER_NAME_MAX_LENGTH = 64;

/**
 * Maximum serialized size of a filter payload. Bounds how far a user can
 * inflate their own row; the real payloads are a few hundred bytes.
 */
export const QUICK_FILTER_PAYLOAD_MAX_BYTES = 4096;

/**
 * Maximum number of top-level keys (filter dimensions) in a payload.
 */
export const QUICK_FILTER_MAX_KEYS = 32;

/**
 * Maximum length of a payload key.
 */
export const QUICK_FILTER_KEY_MAX_LENGTH = 64;

/**
 * Maximum number of elements in a payload's array value.
 */
export const QUICK_FILTER_MAX_VALUES_PER_KEY = 200;

/**
 * Maximum length of a string value inside a payload.
 */
export const QUICK_FILTER_VALUE_MAX_LENGTH = 256;
