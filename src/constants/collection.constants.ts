/**
 * Bounds of a personal rating. The scale is 0..10 with one decimal, which is
 * finer than the star scales most collection apps use — the bar renders the
 * value and the number states it, so the precision is readable rather than
 * decorative.
 */
export const COLLECTION_RATING_MIN = 0;

export const COLLECTION_RATING_MAX = 10;

/**
 * `numeric(3,1)` holds 0.0..99.9, which the CHECK constraint narrows to the
 * 0..10 range. Scale 1 is the "0.1 step" expressed in the column itself, so
 * nothing downstream has to re-round a slider's float.
 */
export const COLLECTION_RATING_PRECISION = 3;

export const COLLECTION_RATING_SCALE = 1;

/**
 * Free-text fields on a collection row: the general note plus the three
 * structured tasting fields. Generous, because a tasting note is prose.
 */
export const COLLECTION_NOTE_MAX_LENGTH = 2000;

/**
 * A bottle's barcode as the user types it: EAN-8, UPC-A, EAN-13 or ITF-14 —
 * digits only, 8 to 14 of them. Stored on the collection row rather than on
 * the bottling, since it is one person's observation of one physical bottle
 * and carries no provenance the catalogue could trust.
 */
export const COLLECTION_BARCODE_MAX_LENGTH = 32;

export const COLLECTION_BARCODE_PATTERN = /^\d{8,14}$/;

/**
 * Widest timeline a stats request may ask for, in months (50 years). A
 * collection can legitimately start in the 1990s; beyond that the range is a
 * typo rather than a question.
 */
export const COLLECTION_STATS_MAX_MONTHS = 600;
