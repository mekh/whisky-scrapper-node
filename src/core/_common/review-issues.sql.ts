import {
  PRODUCER_KIND_SUSPECT_SHARE,
  REVIEW_ABV_MAX,
  REVIEW_ABV_MIN,
  REVIEW_ISSUE_SEVERITY,
  REVIEW_PACKAGING_WORDS,
  REVIEW_RAW_AGE_EXCEPT_PATTERN,
  REVIEW_RAW_AGE_PATTERN,
  REVIEW_SCOTLAND_CODE,
  REVIEW_SCOTLAND_WORDS,
  REVIEW_SEVERITY_RANK,
  REVIEW_TYPE_PATTERNS,
} from '~constants';
import {
  FactSource,
  ProducerIssueCode,
  ProducerKind,
  ReviewIssueCode,
  ReviewIssueSeverity,
} from '~enums';

/**
 * Quotes a literal into generated SQL.
 *
 * Every value that reaches this comes from a constant in `~constants`, never
 * from a request — the detectors are a closed vocabulary. The doubling is
 * there so a keyword carrying an apostrophe stays writable in that table.
 *
 * @param value - The literal.
 * @returns The quoted literal.
 */
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Builds an `OR` of substring tests against the haystack.
 *
 * @param words - The keywords, matched case-insensitively.
 * @param column - The haystack expression.
 * @returns A SQL boolean, or `false` when there are no keywords.
 */
const anyOf = (words: readonly string[], column = 'b.hay'): string => {
  if (!words.length) {
    return 'false';
  }

  return `(${
    words.map((word) => `${column} LIKE ${lit(`%${word.toLowerCase()}%`)}`)
      .join(' OR ')
  })`;
};

/**
 * The whisky type a bottling's own name states, or NULL when it states none.
 *
 * Generated from {@link REVIEW_TYPE_PATTERNS} rather than written out, which
 * is what keeps the SQL that fires the chip and the TypeScript that explains
 * it reading one vocabulary. The rows are tested in order, so `single malt`
 * decides before `malt` could.
 */
const NAMED_TYPE_SQL = `CASE\n${
  REVIEW_TYPE_PATTERNS.map((pattern) =>
    `    WHEN ${anyOf(pattern.match)}${
      pattern.except.length ? ` AND NOT ${anyOf(pattern.except)}` : ''
    } THEN ${lit(pattern.type)}`
  ).join('\n')
}\n  END`;

/**
 * Whether a bottling is stocked anywhere. The queue's default scope: a
 * bottling nobody sells is not work.
 */
const STOCKED_SQL = 'o.stocked';

/**
 * One `CASE` per detector, in the order a reader of the chips would want them.
 * `array_remove(..., NULL)` turns the column into the row's issue list.
 *
 * Every predicate lives here and nowhere else, which is what makes the chip on
 * a row and the chip in the «Проблеми» filter the same object: the filter is
 * an overlap test against this array, and the counts are a tally of it.
 *
 * `$1`/`$2` are the what-if answer — the bottlings whose spelling reaches a
 * producer that is `rejected` or still withheld. That pass is the real
 * resolver run over an index those two statuses are added to, computed once
 * per request and handed in; reimplementing alias matching in SQL would be a
 * second resolver, which is the defect class the knowledge base exists to
 * remove. `$3` widens the conflict test to acknowledged rows, `$4` is the
 * trusted fact sources.
 */
const ISSUE_CASES: readonly [ReviewIssueCode, string][] = [
  [
    ReviewIssueCode.PRODUCER_REJECTED,
    'b."producerId" IS NULL AND b."bottlerId" IS NULL'
    + ' AND b.id = ANY($1::uuid[])',
  ],
  [
    ReviewIssueCode.NO_PRODUCER,
    'b."producerId" IS NULL AND b."bottlerId" IS NULL',
  ],
  [
    ReviewIssueCode.PRODUCER_WITHHELD,
    'b."producerId" IS NULL AND b."bottlerId" IS NULL'
    + ' AND b.id = ANY($2::uuid[])',
  ],
  [
    ReviewIssueCode.CYRILLIC_NAME,
    "b.name IS NOT NULL AND b.name !~ '[A-Za-z]'",
  ],
  [ReviewIssueCode.DUPLICATE, 'b.duplicate'],
  [ReviewIssueCode.MISSING_ABV, 'b.abv IS NULL'],
  [ReviewIssueCode.MISSING_VOLUME, 'b."volumeMl" IS NULL'],
  [ReviewIssueCode.MISSING_COUNTRY, 'b."countryId" IS NULL'],
  [ReviewIssueCode.MISSING_TYPE, 'b."typeId" IS NULL'],
  [
    ReviewIssueCode.TYPE_VS_NAME,
    'b."namedType" IS NOT NULL AND b.type IS DISTINCT FROM b."namedType"'
    + ` AND b."typeSource" IS DISTINCT FROM '${FactSource.MANUAL}'`,
  ],
  [
    ReviewIssueCode.COUNTRY_VS_NAME,
    `${anyOf(REVIEW_SCOTLAND_WORDS)}`
    + ` AND b."countryCode" IS DISTINCT FROM ${lit(REVIEW_SCOTLAND_CODE)}`
    + ` AND b."countrySource" IS DISTINCT FROM '${FactSource.MANUAL}'`,
  ],
  [
    ReviewIssueCode.ABV_RANGE,
    `b.abv IS NOT NULL AND (b.abv < ${REVIEW_ABV_MIN}`
    + ` OR b.abv > ${REVIEW_ABV_MAX})`
    + ` AND b."abvSource" IS DISTINCT FROM '${FactSource.MANUAL}'`,
  ],
  [
    ReviewIssueCode.NAME_LEFTOVER,
    anyOf(REVIEW_PACKAGING_WORDS, "' ' || lower(b.name) || ' '"),
  ],
  [ReviewIssueCode.AGE_IN_RAW, 'b.age IS NULL AND b."rawAge"'],
  [
    ReviewIssueCode.AGE_SINGLE_STORE,
    `b."ageSource" = '${FactSource.STORE}' AND b."storeCount" = 1`,
  ],
  [
    ReviewIssueCode.UNTRUSTED_FACT,
    '(b."typeId" IS NOT NULL AND (b."typeSource" IS NULL'
    + ' OR NOT (b."typeSource" = ANY($4::text[]))))'
    + ' OR (b."countryId" IS NOT NULL AND (b."countrySource" IS NULL'
    + ' OR NOT (b."countrySource" = ANY($4::text[]))))',
  ],
  [ReviewIssueCode.CONFLICT, 'b."openConflicts" > 0'],
  [
    ReviewIssueCode.NEW,
    'b."reviewStatus" = \'pending\'',
  ],
];

/**
 * The issue array, built from {@link ISSUE_CASES}.
 */
const ISSUES_SQL = `array_remove(ARRAY[\n${
  ISSUE_CASES.map(([code, predicate]) =>
    `    CASE WHEN ${predicate} THEN ${lit(code)} END`
  ).join(',\n')
}\n  ], NULL)`;

/**
 * Groups the issue codes by the severity they carry.
 *
 * @returns The codes of each severity, worst first.
 */
const bySeverity = (): [ReviewIssueSeverity, ReviewIssueCode[]][] => {
  const groups = new Map<ReviewIssueSeverity, ReviewIssueCode[]>();

  Object.entries(REVIEW_ISSUE_SEVERITY).forEach(([code, severity]) => {
    const held = groups.get(severity) ?? [];

    held.push(code as ReviewIssueCode);
    groups.set(severity, held);
  });

  return [...groups.entries()]
    .sort((left, right) =>
      REVIEW_SEVERITY_RANK[left[0]] - REVIEW_SEVERITY_RANK[right[0]]
    );
};

/**
 * A row's severity as a number, worst first — the default sort key.
 *
 * Generated from the same severity map the client colours its chips from, so
 * "the queue's worst row" and "the reddest chip" are the same statement.
 */
const SEVERITY_SQL = `CASE\n${
  bySeverity().map(([severity, codes]) =>
    `    WHEN f.issues && ARRAY[${codes.map(lit).join(', ')}]::text[]`
    + ` THEN ${REVIEW_SEVERITY_RANK[severity]}`
  ).join('\n')
}\n    ELSE ${Object.keys(REVIEW_SEVERITY_RANK).length}\n  END`;

/**
 * The identity two catalogue rows are compared by — the same expression
 * `SAME_IDENTITY_SQL` uses, so the duplicate chip and the merge agree about
 * what a twin is.
 */
const IDENTITY_SQL = "lower(regexp_replace(p.name, '[^[:alnum:]]+', '', 'g'))";

/**
 * The bottlings some other row duplicates: one folded name, one volume, one
 * age.
 *
 * A window count rather than a self-join, since `PARTITION BY` already treats
 * two NULL volumes as equal the way `IS NOT DISTINCT FROM` does — and it is
 * the same identity `SAME_IDENTITY_SQL` compares by, so the chip and the merge
 * agree about what a twin is.
 *
 * The near-twin — same maker, same name and volume, exactly one of the pair
 * stating an age — is deliberately **not** here. Measured on the dump of
 * 2026-09-17 it fires on 302 stocked bottlings against the exact rule's two,
 * because the age is stripped from the canonical name: a NAS `Glenfiddich`
 * and a twelve-year-old `Glenfiddich` are one folded name and are genuinely
 * two whiskies. It is a real signal and a useless queue, so it lives in the
 * per-bottling suggestions, where a person is already looking at the row.
 *
 * Computed over the whole catalogue rather than the page, because a twin may
 * be unstocked and the person still has to be told.
 */
const DUPLICATES_SQL = `
  SELECT id FROM (
    SELECT p.id, count(*) OVER (
             PARTITION BY ${IDENTITY_SQL}, p."volumeMl", p.age
           ) AS n
    FROM product p
    WHERE p.name IS NOT NULL
  ) q
  WHERE q.n > 1
`;

/**
 * Everything a detector reads about one bottling, gathered once.
 *
 * The haystack is the canonical name plus **every** shop's raw name, stocked
 * or not: a raw name is evidence about the bottling whether or not the shop
 * still sells it. The age test runs per offer rather than over the joined
 * haystack, because its exclusion has to apply to the same raw name that
 * stated the number.
 */
const BASE_SQL = `
  SELECT p.id, p.name, p.age, p.abv, p."volumeMl", p."matchKey",
         p."typeId", p."typeSource", p."countryId", p."countrySource",
         p."abvSource", p."ageSource", p."volumeSource",
         p."producerId", p."bottlerId", p."producerSource", p."brandOrig",
         p."reviewStatus", p."reviewedAt", p."createdAt",
         t.name AS type, c.code AS "countryCode",
         c."nameUa" AS "countryName", c.icon AS "countryIcon",
         o."storeCount", o."rawAge", o.stocked,
         d.id IS NOT NULL AS duplicate,
         (SELECT count(*)::int FROM product_fact_conflict k
          WHERE k."productId" = p.id
            AND ($3::boolean OR k."resolvedAt" IS NULL)) AS "openConflicts",
         ' ' || lower(coalesce(p.name, '') || ' ' || coalesce(o.raw, ''))
           || ' ' AS hay
  FROM product p
  LEFT JOIN type t ON t.id = p."typeId"
  LEFT JOIN country c ON c.id = p."countryId"
  LEFT JOIN LATERAL (
    SELECT string_agg(sp."nameOrig", ' ') AS raw,
           count(DISTINCT sp."storeId") FILTER (WHERE sp."inStock")::int
             AS "storeCount",
           bool_or(sp."inStock") AS stocked,
           bool_or(sp."nameOrig" ~* ${lit(REVIEW_RAW_AGE_PATTERN)}
             AND sp."nameOrig" !~* ${lit(REVIEW_RAW_AGE_EXCEPT_PATTERN)})
             AS "rawAge"
    FROM store_product sp
    WHERE sp."productId" = p.id
  ) o ON true
  LEFT JOIN (${DUPLICATES_SQL}) d ON d.id = p.id
`;

/**
 * The queue's membership, by which slice the caller asked for.
 *
 * `open` is the work: not decided, and at least one detector fired. The other
 * two are the log, where the issues are still computed so a decision stays
 * inspectable — and where `rejected` is reachable because a rejection made by
 * mistake is only reversible if the row can still be found.
 */
const STATUS_SQL = `CASE $8::text
    WHEN 'verified' THEN f."reviewStatus" = 'verified'
    WHEN 'rejected' THEN f."reviewStatus" = 'rejected'
    ELSE f."reviewStatus" IS DISTINCT FROM 'verified'
      AND f."reviewStatus" IS DISTINCT FROM 'rejected'
      AND cardinality(f.issues) > 0
  END`;

/**
 * What narrows a page: the free-text search over both names and a shop's
 * listing URL, and the shop filter.
 */
const SEARCH_SQL = `(
    $5::text IS NULL
    OR p.name ILIKE '%' || $5 || '%'
    OR EXISTS (
      SELECT 1 FROM store_product sp
      WHERE sp."productId" = p.id
        AND (sp."nameOrig" ILIKE '%' || $5 || '%'
          OR sp.url ILIKE '%' || $5 || '%')
    )
  )
  AND (
    $6::text[] IS NULL
    OR EXISTS (
      SELECT 1 FROM store_product sp
      JOIN store s ON s.id = sp."storeId"
      WHERE sp."productId" = p.id AND s.slug = ANY($6::text[])
    )
  )
  AND ($9::boolean OR ${STOCKED_SQL})
  AND ($10::uuid[] IS NULL OR p.id = ANY($10::uuid[]))`;

/**
 * The curation queue's one detector pass: every predicate, the issue array it
 * produces, and the severity that ranks it.
 *
 * Parameters, in order: `$1` bottlings whose spelling reaches a `rejected`
 * producer, `$2` the same for a withheld one, `$3` whether acknowledged
 * conflicts count, `$4` the trusted fact sources, `$5` the search term, `$6`
 * the shop slugs, `$7` the issue codes to keep, `$8` the slice, `$9` whether
 * unstocked bottlings are included, `$10` specific bottlings to restrict to.
 */
export const REVIEW_ISSUES_SQL = `
  WITH b AS (${BASE_SQL}
    WHERE ${SEARCH_SQL}
  ),
  n AS (
    SELECT b.*, ${NAMED_TYPE_SQL} AS "namedType" FROM b
  ),
  f AS (
    SELECT b.*, ${ISSUES_SQL} AS issues FROM n b
  ),
  q AS (
    SELECT f.*, ${SEVERITY_SQL} AS severity
    FROM f
    WHERE ${STATUS_SQL}
      AND ($7::text[] IS NULL OR f.issues && $7::text[])
  )
`;

/**
 * Whether a producer's recorded `blend` kind is contradicted by what it
 * actually bottles. Shared by the producers queue's detector and its count.
 */
export const PRODUCER_KIND_SUSPECT_SQL = `
  p.kind = '${ProducerKind.BLEND}'
  AND (SELECT count(*) FROM product pr WHERE pr."producerId" = p.id) > 0
  AND (SELECT count(*) FILTER (WHERE ty.name = 'single malt')::float8
              / greatest(count(*), 1)
       FROM product pr
       LEFT JOIN type ty ON ty.id = pr."typeId"
       WHERE pr."producerId" = p.id) > ${PRODUCER_KIND_SUSPECT_SHARE}
`;

/**
 * The producers queue's detectors, in the same shape as the bottlings'.
 *
 * `$1` is the ids of the producers whose every alias is unreachable by name
 * while some unresolved stocked bottling carries the word, and `$2` the ids
 * whose name is mentioned in such a bottling's raw name. Both come from the
 * same what-if pass the bottlings queue uses, for the same reason: the rule
 * about what an alias can match belongs to `KbAliasUtils`, not to a second
 * copy of it in SQL.
 */
export const PRODUCER_ISSUE_CASES: readonly [ProducerIssueCode, string][] = [
  [ProducerIssueCode.UNVERIFIED, "p.status = 'unverified'"],
  [
    ProducerIssueCode.NO_ALIAS,
    'NOT EXISTS (SELECT 1 FROM producer_alias a'
    + ' WHERE a."producerId" = p.id)',
  ],
  [ProducerIssueCode.ALIAS_UNREACHABLE, 'p.id = ANY($1::uuid[])'],
  [ProducerIssueCode.UNLINKED_MENTIONS, 'p.id = ANY($2::uuid[])'],
  [ProducerIssueCode.KIND_SUSPECT, `(${PRODUCER_KIND_SUSPECT_SQL})`],
  [
    ProducerIssueCode.NO_REGION,
    `p.kind = '${ProducerKind.DISTILLERY}' AND p.region IS NULL`
    + ` AND c.code = ${lit(REVIEW_SCOTLAND_CODE)}`,
  ],
  [
    ProducerIssueCode.NO_DEFAULT_TYPE,
    `p.kind <> '${ProducerKind.BOTTLER}' AND p."defaultTypeName" IS NULL`,
  ],
  [
    ProducerIssueCode.BRAND_NO_PARENT,
    `p.kind = '${ProducerKind.BRAND}' AND p."parentId" IS NULL`,
  ],
  [
    ProducerIssueCode.PEAT_UNKNOWN,
    `p.kind <> '${ProducerKind.BOTTLER}' AND p."peatProfile" = 'unknown'`,
  ],
];

/**
 * The producers queue's issue array.
 */
export const PRODUCER_ISSUES_SQL = `array_remove(ARRAY[\n${
  PRODUCER_ISSUE_CASES.map(([code, predicate]) =>
    `    CASE WHEN ${predicate} THEN ${lit(code)} END`
  ).join(',\n')
}\n  ], NULL)`;
