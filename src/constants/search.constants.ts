/**
 * Shortest term the autocomplete searches accept. A server floor of 2 only
 * bars a catalogue scan; the web client applies its own UX minimum of 3,
 * mirroring the report name search.
 */
export const SEARCH_MIN_LENGTH = 2;

/**
 * Rows an autocomplete search returns when the request names no limit.
 */
export const SEARCH_DEFAULT_LIMIT = 10;

/**
 * Ceiling on the rows one autocomplete search may request.
 */
export const SEARCH_MAX_LIMIT = 20;
