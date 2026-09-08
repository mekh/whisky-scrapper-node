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

/**
 * Highest price a single purchase may state, in the currency it was bought
 * in. The column is `numeric(12,2)`, so anything above 9 999 999 999.99
 * fails in Postgres with SQLSTATE `22003` — and `@IsNumber` cannot catch it,
 * because its `maxDecimalPlaces` check only looks at values with a
 * fractional part, so `1e11` and even `1e21` sail through as integers. Ten
 * million is far under that ceiling and far above any bottle: the point is
 * to answer a nonsense number with a `400` instead of a logged `500`.
 */
export const COLLECTION_PRICE_MAX = 10_000_000;

/**
 * How many purchases one `PATCH /collection/:id` may add, patch or remove
 * per group.
 *
 * The cap is what bounds the request: the three groups are applied one
 * statement at a time inside a single transaction, and every field of a
 * purchase is optional — so `{}` is a valid addition three bytes long, and
 * Fastify's default 1 MiB body would otherwise buy ~350 000 inserts on one
 * connection in one transaction. Ten is what an edit screen can produce;
 * nothing legitimate sends more.
 */
export const COLLECTION_PURCHASES_MAX_PER_REQUEST = 10;
