import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import {
  FACT_SOURCE_RANK,
  FactSource,
  FlavorSource,
  ProductFactField,
  TRUSTED_FACT_SOURCES,
} from '~enums';
import {
  FlavorCandidateRow,
  ID,
  KbFactWrite,
  KbFlavorWrite,
  KbProducerWrite,
  KbReconcileRow,
  ProducerProductRow,
  ProductCanonicalInput,
  ProductFactConflictInput,
  ProductFactReviewRow,
  ProductFillInput,
  ProductMatchRow,
  ProductNameCandidateRow,
  ProductScrapeFlavorLink,
  ProductSearchItem,
  ProductStoreFieldsRow,
  ProductStoredFactsRow,
  ReviewConflictRow,
  UntrustedFactCounts,
} from '~types';
import { SearchTermUtils } from '~utils';

import { ProductEntity } from './product.entity';

/**
 * Finds or creates a batch of bottlings by their match key.
 *
 * `DO UPDATE` rather than `DO NOTHING` because only an updated row is returned,
 * and the ids of the rows that already existed are exactly what the caller
 * needs. A follow-up `SELECT` would not do: stores in different sync tracks
 * persist concurrently, and a `SELECT` cannot see a row another transaction has
 * inserted but not yet committed — it would block, then return nothing.
 *
 * The assignment is a deliberate no-op. Touching `updatedAt` here would make it
 * mean "some store listed this again", which `store_product.lastSeen` already
 * records; it is reserved for a real change to the bottling's own fields.
 *
 * The provenance columns are written on insert, not left for a later pass. A
 * fact created without a source ranks below everything, so the very next sync
 * would overwrite the values this row was created from — which would make
 * "first writer wins" into "last writer wins" rather than into a trust order.
 * A source is only ever stored next to a value it describes: where the value
 * is null the source is null too.
 */
const FIND_OR_CREATE_SQL = `
  INSERT INTO product
     ("matchKey", name, "brandOrig", "typeId", "countryId", age, abv,
      "volumeMl", "nameSource", "typeSource", "countrySource",
      "ageSource", "abvSource", "volumeSource")
   SELECT * FROM unnest(
     $1::text[], $2::text[], $3::text[], $4::uuid[], $5::uuid[],
     $6::int[], $7::real[], $8::int[],
     $9::text[], $10::text[], $11::text[],
     $12::text[], $13::text[], $14::text[]
   )
   ON CONFLICT ("matchKey") DO UPDATE SET "matchKey" = EXCLUDED."matchKey"
   RETURNING id, "matchKey", (xmax = 0) AS "isNew"
`;

/**
 * Renders the stored provenance of a fact column as its trust rank, so the SQL
 * can compare it against an incoming one.
 *
 * The mapping is generated from {@link FACT_SOURCE_RANK} rather than written as
 * a SQL function or a lookup table, which keeps the ranking single-sourced in
 * `~enums`: a source added there cannot be silently missing here.
 *
 * `ELSE 0` covers both a NULL source and any value this build does not know,
 * meaning "no provenance recorded" — so anything at all outranks it.
 *
 * @param sourceColumn - The provenance column to rank.
 * @returns A SQL `CASE` expression yielding an integer rank.
 */
const storedRank = (sourceColumn: string): string => {
  const whens = Object.entries(FACT_SOURCE_RANK)
    .map(([source, rank]) => `WHEN '${source}' THEN ${rank}`)
    .join(' ');

  return `CASE p."${sourceColumn}" ${whens} ELSE 0 END`;
};

/**
 * Whether an incoming value should replace what is stored: it has to exist,
 * the stored value must not be a person's, and it must either fill a gap or
 * come from a better-trusted source.
 *
 * The `manual` guard is redundant against today's callers — nothing on the
 * scrape path sends a rank as high as a person's — but it is stated anyway,
 * because a future source slotted in above `kb` would otherwise start
 * overwriting curation with nothing in this file to stop it.
 *
 * @param column - The fact column.
 * @param sourceColumn - Its provenance column.
 * @param rankParam - The SQL expression holding the incoming rank.
 * @returns A SQL boolean expression.
 */
const incomingWins = (
  column: string,
  sourceColumn: string,
  rankParam: string,
): string =>
  `v."${column}" IS NOT NULL
    AND p."${sourceColumn}" IS DISTINCT FROM '${FactSource.MANUAL}'
    AND (p."${column}" IS NULL
      OR ${rankParam} > ${storedRank(sourceColumn)})`;

/**
 * Assigns a fact column and its provenance column together, so a value can
 * never end up stored without a source or with a stale one.
 *
 * @param column - The fact column.
 * @param sourceColumn - Its provenance column.
 * @param rankParam - The SQL expression holding the incoming rank.
 * @param sourceParam - The SQL expression holding the incoming source.
 * @returns The two `SET` assignments, comma-separated.
 */
const fillAssignment = (
  column: string,
  sourceColumn: string,
  rankParam: string,
  sourceParam: string,
): string => {
  const wins = incomingWins(column, sourceColumn, rankParam);

  return `"${column}" = CASE WHEN ${wins}
      THEN v."${column}" ELSE p."${column}" END,
    "${sourceColumn}" = CASE WHEN ${wins}
      THEN ${sourceParam} ELSE p."${sourceColumn}" END`;
};

/**
 * The fact columns this write may contribute to, each with its provenance
 * column and the parameter positions carrying the incoming rank and source.
 *
 * Name, age and volume are deliberately absent: the name is the catalogue's own
 * decision, and age and volume are components of the frozen match key, so
 * changing them would describe a different bottling.
 */
const FILL_FIELDS = [
  {
    column: 'abv',
    source: 'abvSource',
    rank: 'v."abvRank"',
    src: 'v."abvSrc"',
  },
  {
    column: 'typeId',
    source: 'typeSource',
    rank: 'v."typeRank"',
    src: 'v."typeSrc"',
  },
  {
    column: 'countryId',
    source: 'countrySource',
    rank: 'v."countryRank"',
    src: 'v."countrySrc"',
  },
] as const;

/**
 * Fills or corrects the secondary fields of already-stored bottlings.
 *
 * **This is no longer fill-if-null.** It used to `COALESCE`, so whichever store
 * or model spoke first owned the value forever — which is exactly why the
 * catalogue could hold a whisky's country as an early guess while a later
 * store's spec page stated it outright, with nothing recording the difference.
 * A value is now replaced when the incoming source outranks the stored one, and
 * a person's value is never replaced at all.
 *
 * The consequence to keep in mind is that a stored fact can now change between
 * syncs, where before it could not. That is the point — the alternative is a
 * catalogue that cannot be corrected — but it means the provenance columns are
 * load-bearing rather than decorative.
 *
 * The `WHERE` clause is not an optimization. Without it every offer of every
 * store would write a new row version of a **shared** row on every sync, hold
 * its lock until that store's whole transaction commits, and bump `updatedAt`
 * for a write that changed nothing.
 */
const FILL_MISSING_SQL = `
  UPDATE product p SET
    ${
  FILL_FIELDS.map(
    (field) =>
      fillAssignment(field.column, field.source, field.rank, field.src),
  ).join(',\n    ')
},
    "brandOrig" = COALESCE(p."brandOrig", v."brandOrig"),
    "updatedAt" = now()
  FROM unnest(
    $1::uuid[], $2::real[], $3::uuid[], $4::uuid[], $5::text[],
    $6::int[], $7::int[], $8::int[],
    $9::text[], $10::text[], $11::text[]
  ) AS v(
    id, abv, "typeId", "countryId", "brandOrig",
    "abvRank", "typeRank", "countryRank",
    "abvSrc", "typeSrc", "countrySrc"
  )
  WHERE p.id = v.id
    AND ((v."brandOrig" IS NOT NULL AND p."brandOrig" IS NULL)
      OR ${
  FILL_FIELDS.map(
    (field) => `(${incomingWins(field.column, field.source, field.rank)})`,
  ).join('\n      OR ')
})
`;

/**
 * Writes the producer and bottler the knowledge-base resolver decided on.
 *
 * A hand-made relink is never touched: `producerSource = 'manual'` is how a
 * person's correction survives every later run, the same way
 * `store_product.productId` is left out of the offer upsert's conflict clause.
 */
/**
 * What a conflict value has to look like before it is cast to a uuid.
 *
 * `storedValue` and `claimedValue` are text because they hold a foreign key for
 * `type` and `country` and a number for `abv`. The guard has to be on
 * the value rather than on the attribute name: Postgres is free to evaluate a
 * cast before the predicate meant to exclude it, and one ABV row would
 * otherwise abort the whole query.
 */
const UUID_SHAPE = '^[0-9a-fA-F-]{36}$';

/**
 * How many shop links one review row carries.
 *
 * A bottling can be listed by nineteen shops, and nineteen links in a table
 * cell is not a row a person can read. Five is enough to check a fact against
 * a couple of listings, and the row already links to the bottling's own screen,
 * where every offer is listed in full.
 */
const STORE_LINK_LIMIT = 5;

/**
 * The shops' own pages for one bottling, at most {@link STORE_LINK_LIMIT} of
 * them, in-stock first.
 *
 * **One link per shop**, which is what the inner `DISTINCT ON` buys: a shop
 * routinely lists the same bottling under two SKUs (boxed and plain), and
 * without the dedup two of the five slots went to one shop — three shops
 * offered where five were meant to be. Within a shop the in-stock, most
 * recently seen listing wins.
 *
 * The nesting is forced by `DISTINCT ON`, whose `ORDER BY` must lead with the
 * distinct expression, so the "in-stock first" ordering the limit needs has to
 * happen one level out.
 *
 * An out-of-stock listing is offered rather than hidden — the page still says
 * what the shop claims about the bottling, which is the fact under review —
 * and marked so the client can dim it.
 */
const STORE_LINKS_SQL = `
  SELECT COALESCE(json_agg(json_build_object(
           'slug', o.slug, 'name', o.name,
           'url', o.url, 'inStock', o."inStock"
         ) ORDER BY o."inStock" DESC, o.name), '[]'::json)
  FROM (
    SELECT d.* FROM (
      SELECT DISTINCT ON (sp."storeId")
             s.slug, s.name, sp.url, sp."inStock"
      FROM store_product sp
      JOIN store s ON s.id = sp."storeId"
      WHERE sp."productId" = p.id AND sp.url <> ''
      ORDER BY sp."storeId", sp."inStock" DESC, sp."lastSeen" DESC
    ) d
    ORDER BY d."inStock" DESC, d.name
    LIMIT ${STORE_LINK_LIMIT}
  ) o
`;

/**
 * Builds the producer-expansion read: the display names behind one producer
 * row, **grouped by name**. One whisky in three volumes is three bottlings but
 * one entry — the screen links into the catalogue by name, so ungrouped rows
 * were identical links repeated. The display name falls back to the longest
 * raw store name, as the facts queue picks it, and `inStock` is true when any
 * grouped bottling has a stocked offer anywhere. Built by one function for
 * both reads so the resolved and the what-if paths cannot drift apart in what
 * they show.
 *
 * @param where - The predicate selecting the bottlings, over alias `p`.
 * @returns The grouped, ordered query.
 */
const producerProductsSql = (where: string): string => `
  SELECT x.label AS name, count(*)::int AS "productCount",
         bool_or(x."inStock") AS "inStock"
  FROM (
    SELECT COALESCE(p.name, (
             SELECT sp."nameOrig" FROM store_product sp
             WHERE sp."productId" = p.id
             ORDER BY length(sp."nameOrig") DESC LIMIT 1)) AS label,
           EXISTS (SELECT 1 FROM store_product sp
                   WHERE sp."productId" = p.id AND sp."inStock") AS "inStock"
    FROM product p
    WHERE ${where}
  ) x
  GROUP BY x.label
  ORDER BY lower(x.label), x.label
`;

/**
 * The `WHERE` fragment that takes one half of the untrusted-fact queue.
 *
 * A lookup rather than a nested ternary because the two formatters disagree
 * about how to indent one, and the queue's halves are a closed set anyway: a
 * value outside it means "both halves", which is the empty fragment.
 */
const FACT_QUEUE_SEGMENT: Record<string, string | undefined> = {
  resolved: ' AND p."producerId" IS NOT NULL',
  unresolved: ' AND p."producerId" IS NULL',
};

const SET_PRODUCERS_SQL = `
  UPDATE product p SET
    "producerId" = v."producerId",
    "bottlerId" = v."bottlerId",
    "producerSource" = v.source,
    "updatedAt" = now()
  FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
    AS v(id, "producerId", "bottlerId", source)
  WHERE p.id = v.id
    AND p."producerSource" IS DISTINCT FROM '${FactSource.MANUAL}'
    AND (p."producerId" IS DISTINCT FROM v."producerId"
      OR p."bottlerId" IS DISTINCT FROM v."bottlerId"
      OR p."producerSource" IS DISTINCT FROM v.source)
`;

/**
 * Writes the facts the knowledge base owns outright.
 *
 * Unlike {@link FILL_MISSING_SQL} this does not compare ranks: the knowledge
 * base is the authority for these fields, so a resolved producer's country
 * replaces whatever a store or a model had contributed. Only a person's value
 * outranks it.
 *
 * A NULL incoming value means "the knowledge base states nothing here" and
 * leaves the stored value alone — it is never a request to clear the column,
 * because an unresearched producer must not erase what a store did state.
 */
const APPLY_KB_FACTS_SQL = `
  UPDATE product p SET
    "countryId" = COALESCE(
      CASE WHEN p."countrySource" IS DISTINCT FROM '${FactSource.MANUAL}'
        THEN v."countryId" END, p."countryId"),
    "countrySource" = CASE
      WHEN v."countryId" IS NOT NULL
        AND p."countrySource" IS DISTINCT FROM '${FactSource.MANUAL}'
      THEN '${FactSource.KB}' ELSE p."countrySource" END,
    "typeId" = COALESCE(
      CASE WHEN p."typeSource" IS DISTINCT FROM '${FactSource.MANUAL}'
        THEN v."typeId" END, p."typeId"),
    "typeSource" = CASE
      WHEN v."typeId" IS NOT NULL
        AND p."typeSource" IS DISTINCT FROM '${FactSource.MANUAL}'
      THEN '${FactSource.KB}' ELSE p."typeSource" END,
    "updatedAt" = now()
  FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])
    AS v(id, "countryId", "typeId")
  WHERE p.id = v.id
    AND ((v."countryId" IS NOT NULL
        AND p."countrySource" IS DISTINCT FROM '${FactSource.MANUAL}'
        AND (p."countryId" IS DISTINCT FROM v."countryId"
          OR p."countrySource" IS DISTINCT FROM '${FactSource.KB}'))
      OR (v."typeId" IS NOT NULL
        AND p."typeSource" IS DISTINCT FROM '${FactSource.MANUAL}'
        AND (p."typeId" IS DISTINCT FROM v."typeId"
          OR p."typeSource" IS DISTINCT FROM '${FactSource.KB}')))
`;

/**
 * Autocomplete search, one row per bottling.
 *
 * Deliberately NOT preference-filtered — it takes no user at all. The picker's
 * job includes finding a bottling the user already hid so it can be un-hidden;
 * filtering it by the lists it edits would make such an entry unfindable. This
 * joins `/report/history` as a read that ignores the blacklist on purpose
 * (documented in CLAUDE.md, "API contract").
 *
 * Matching mirrors `findCurrentRows`: the canonical name OR any store's raw
 * name, plus the age-aware pass (`$2`/`$3` from `SearchTermUtils.splitAge`) —
 * the age is stripped from the canonical name and every store spells it
 * differently, so `Glenfiddich 12` matches nothing as one substring. No brand
 * predicate: `product.name` is "brand + expression" by construction.
 *
 * Ordering: in-stock first, then prefix matches, then the shortest name, so
 * `glenfiddich` offers `Glenfiddich` above `Glenfiddich 15 Solera Vat`. The
 * `COALESCE(p.name, '')` before the prefix test matters — a NULL name yields
 * NULL, and `DESC` sorts NULLs first, which would float the nameless rows to
 * the top of every result.
 *
 * Plain leading-wildcard ILIKE over the few-thousand-row `product` table is
 * sub-10 ms; a `pg_trgm` index is the escape hatch if the catalogue outgrows
 * that.
 */
const SEARCH_SQL = `
  SELECT p.id AS "productId", p.name, o."nameOrig",
         COALESCE(pr.name, bo.name) AS brand,
         p.age, p.abv::float8 AS abv, p."volumeMl",
         COALESCE(o."inStock", false) AS "inStock"
  FROM product p
  LEFT JOIN producer pr ON pr.id = p."producerId"
  LEFT JOIN producer bo ON bo.id = p."bottlerId"
  LEFT JOIN LATERAL (
    SELECT sp."nameOrig", sp."inStock"
    FROM store_product sp
    WHERE sp."productId" = p.id
    ORDER BY sp."inStock" DESC, sp."lastSeen" DESC, sp.id
    LIMIT 1
  ) o ON true
  WHERE p.name ILIKE '%' || $1 || '%'
     OR EXISTS (
       SELECT 1 FROM store_product sp
       WHERE sp."productId" = p.id
         AND sp."nameOrig" ILIKE '%' || $1 || '%'
     )
     OR ($2::text IS NOT NULL AND p.age = $3::int
         AND (p.name ILIKE '%' || $2 || '%'
              OR EXISTS (
                SELECT 1 FROM store_product sp
                WHERE sp."productId" = p.id
                  AND sp."nameOrig" ILIKE '%' || $2 || '%'
              )))
  ORDER BY COALESCE(o."inStock", false) DESC,
           (COALESCE(p.name, '') ILIKE $1 || '%') DESC,
           length(COALESCE(p.name, o."nameOrig", '')),
           p.name NULLS LAST, p.id
  LIMIT $4
`;

@TypeormRepository(ProductEntity)
export class ProductRepository extends BaseRepository<ProductEntity> {
  /**
   * Looks up what the catalogue already knows about a set of bottlings.
   *
   * The enrichment passes gate on this: a detail page, an LLM field or a
   * flavor classification that the stored bottling already has must not be
   * paid for again, because the canonical write fills only what is still null
   * and would discard the answer.
   *
   * @param keys - Match keys to look up; a null key never matches anything and
   *   must not be passed.
   * @returns Map from match key to the stored row; unmatched keys are absent.
   */
  public async findByMatchKeys(
    keys: string[],
  ): Promise<Map<string, ProductMatchRow>> {
    if (!keys.length) {
      return new Map();
    }

    const rows = await this.query(
      `SELECT id, "matchKey", name, abv, "volumeMl", "typeId", "countryId",
              "lastLlmFlavorAt", "flavorsCuratedAt"
       FROM product
       WHERE "matchKey" = ANY($1::text[])`,
      [keys],
    ) as ProductMatchRow[];

    return new Map(rows.map((row) => [row.matchKey, row]));
  }

  /**
   * Which of the given canonical ids exist.
   *
   * The favorites and blacklist writes need this because their tables carry a
   * foreign key to `product`: an id that does not exist would raise a
   * constraint violation the client reads as a 500, where it owes them a 400
   * naming the ids it could not place.
   *
   * @param ids - Canonical product ids to check; duplicates are ignored.
   * @returns The subset that exists.
   */
  public async findExistingIds(ids: ID[]): Promise<Set<ID>> {
    if (!ids.length) {
      return new Set();
    }

    const rows = await this.query(
      'SELECT id FROM product WHERE id = ANY($1::uuid[])',
      [ids],
    ) as { id: ID }[];

    return new Set(rows.map((row) => row.id));
  }

  /**
   * Autocomplete search over the whole catalogue, one row per bottling. See
   * `SEARCH_SQL` for why it is not preference-filtered and how it matches.
   *
   * @param term - The substring to look for; the caller enforces the minimum
   *   length.
   * @param limit - Rows to return at most.
   * @returns Matching bottlings, best matches first.
   */
  public async searchByName(
    term: string,
    limit: number,
  ): Promise<ProductSearchItem[]> {
    const aged = SearchTermUtils.splitAge(term);

    return this.query(SEARCH_SQL, [
      term,
      aged?.name ?? null,
      aged?.age ?? null,
      limit,
    ]) as Promise<ProductSearchItem[]>;
  }

  /**
   * Resolves a batch of bottlings to canonical ids, creating the ones the
   * catalogue has never seen.
   *
   * @param inputs - One entry per distinct match key. Must be deduplicated by
   *   key — Postgres rejects a statement whose conflict target repeats — and
   *   sorted by key, so concurrent store transactions take their row locks in
   *   the same order and cannot deadlock.
   * @returns Map from match key to the canonical id, and how many rows were
   *   newly inserted.
   */
  public async findOrCreateByMatchKeys(
    inputs: ProductCanonicalInput[],
  ): Promise<{ ids: Map<string, ID>; added: number }> {
    if (!inputs.length) {
      return { ids: new Map(), added: 0 };
    }

    const rows = await this.query(FIND_OR_CREATE_SQL, [
      inputs.map((input) => input.matchKey),
      inputs.map((input) => input.name),
      inputs.map((input) => input.brandOrig),
      inputs.map((input) => input.typeId),
      inputs.map((input) => input.countryId),
      inputs.map((input) => input.age),
      inputs.map((input) => input.abv),
      inputs.map((input) => input.volumeMl),
      ...this.sourceColumns(inputs),
    ]) as { id: ID; matchKey: string; isNew: boolean }[];

    return {
      ids: new Map(rows.map((row) => [row.matchKey, row.id])),
      added: rows.filter((row) => row.isNew).length,
    };
  }

  /**
   * Creates a bottling that carries no match key.
   *
   * Nothing can match such a row — normalization left it without a single
   * significant word — so it is always inserted rather than looked up, and it
   * stays an offer of its own until someone relinks it by hand.
   *
   * @param input - The bottling to create; its `matchKey` must be null.
   * @returns The new canonical id.
   */
  public async createUnmatched(input: ProductCanonicalInput): Promise<ID> {
    const sources = this.sourceColumns([input]);

    const rows = await this.query(
      `INSERT INTO product
         ("matchKey", name, "brandOrig", "typeId", "countryId",
          age, abv, "volumeMl",
          "nameSource", "typeSource", "countrySource",
          "ageSource", "abvSource", "volumeSource")
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        input.name,
        input.brandOrig,
        input.typeId,
        input.countryId,
        input.age,
        input.abv,
        input.volumeMl,
        ...sources.map((column) => column[0]),
      ],
    ) as { id: ID }[];

    return rows[0].id;
  }

  /**
   * Fills or corrects strength, type and country on stored bottlings, and
   * fills `brandOrig` when the row has none.
   *
   * A gap is filled as it always was; what is new is that a better-trusted
   * source now replaces a worse-trusted one, so a store's spec page can
   * correct a value the LLM guessed on the day the bottling was discovered.
   * A person's value is never replaced.
   *
   * Name, age and volume are deliberately not writable here: the name is the
   * catalogue's own decision, and age and volume are part of the identity, so
   * changing them would describe a different bottling.
   *
   * `brandOrig` is the one column here that is still plain fill-if-null. It
   * carries no rank because it is not a curated fact — it is the string one
   * shop happened to use, kept only so an unresearched maker stays findable —
   * and the first shop to name a bottling is as good a witness as the tenth.
   *
   * @param inputs - One patch per canonical product; duplicates by id waste a
   *   row lock and should be merged by the caller.
   * @returns How many bottlings actually changed.
   */
  public async fillMissing(inputs: ProductFillInput[]): Promise<number> {
    if (!inputs.length) {
      return 0;
    }

    const result = await this.query(FILL_MISSING_SQL, [
      inputs.map((input) => input.id),
      inputs.map((input) => input.abv),
      inputs.map((input) => input.typeId),
      inputs.map((input) => input.countryId),
      inputs.map((input) => input.brandOrig),
      inputs.map((input) => FACT_SOURCE_RANK[input.abvSource]),
      inputs.map((input) => FACT_SOURCE_RANK[input.typeSource]),
      inputs.map((input) => FACT_SOURCE_RANK[input.countrySource]),
      inputs.map((input) => input.abvSource),
      inputs.map((input) => input.typeSource),
      inputs.map((input) => input.countrySource),
    ]) as [unknown[], number];

    return result[1] ?? 0;
  }

  /**
   * Records which distillery and bottler the knowledge-base resolver placed
   * each bottling with.
   *
   * @param writes - One assignment per bottling; a null producer or bottler
   *   clears the link, which is how a producer that lost its alias stops being
   *   claimed.
   * @returns How many bottlings changed.
   */
  public async setProducers(writes: KbProducerWrite[]): Promise<number> {
    if (!writes.length) {
      return 0;
    }

    const result = await this.query(SET_PRODUCERS_SQL, [
      writes.map((write) => write.productId),
      writes.map((write) => write.producerId),
      writes.map((write) => write.bottlerId),
      writes.map((write) => write.source),
    ]) as [unknown[], number];

    return result[1] ?? 0;
  }

  /**
   * Writes the facts the knowledge base owns — country and whisky type — over
   * whatever a store or a model had contributed.
   *
   * This is the write that makes the knowledge base a source of truth rather
   * than one more opinion. It does not weigh ranks: a resolved producer's
   * country is not evidence about the bottling's country, it is the answer.
   * Only a person's value stands above it.
   *
   * @param writes - One entry per bottling. A null field means the knowledge
   *   base states nothing there and the stored value is kept — never cleared,
   *   because an unresearched producer must not erase what a store did state.
   * @returns How many bottlings changed.
   */
  public async applyKbFacts(writes: KbFactWrite[]): Promise<number> {
    if (!writes.length) {
      return 0;
    }

    const result = await this.query(APPLY_KB_FACTS_SQL, [
      writes.map((write) => write.productId),
      writes.map((write) => write.countryId),
      writes.map((write) => write.typeId),
    ]) as [unknown[], number];

    return result[1] ?? 0;
  }

  /**
   * Applies the knowledge base's flavor decisions: links the tags it states
   * and unlinks the ones it rules out.
   *
   * The delete is what the peat fix needs. Every other write path in this
   * repository only ever adds, which is correct for evidence — a listing that
   * does not mention smoke has learned nothing about smoke — but it left a
   * wrong `llm` peat tag with no way to clear it short of a data migration.
   * The knowledge base is not evidence, so it may remove.
   *
   * A person's link is never touched, and a hand-curated bottling is skipped
   * wholesale through the join to `product`.
   *
   * @param writes - One entry per bottling, with the tags to add and remove.
   *   The pairs are sorted here so concurrent transactions take their
   *   `product_flavor` locks in one agreed order.
   * @returns Resolves once the links are written.
   */
  public async applyKbFlavors(writes: KbFlavorWrite[]): Promise<void> {
    const deletions = this.flatten(writes, (write) => write.deleteFlavorIds);
    const insertions = this.flatten(writes, (write) => write.insertFlavorIds);

    if (deletions.length) {
      await this.query(
        `DELETE FROM product_flavor pf
         USING product p, unnest($1::uuid[], $2::uuid[]) AS v(id, flavor)
         WHERE pf."productId" = v.id AND pf."flavorId" = v.flavor
           AND p.id = pf."productId" AND p."flavorsCuratedAt" IS NULL
           AND pf.source <> $3`,
        [
          deletions.map((pair) => pair.productId),
          deletions.map((pair) => pair.flavorId),
          FlavorSource.MANUAL,
        ],
      );
    }

    if (insertions.length) {
      await this.query(
        `INSERT INTO product_flavor ("productId", "flavorId", source)
         SELECT v.id, v.flavor, $3 FROM unnest($1::uuid[], $2::uuid[])
           AS v(id, flavor)
         JOIN product p ON p.id = v.id AND p."flavorsCuratedAt" IS NULL
         ON CONFLICT ("productId", "flavorId") DO UPDATE SET source = $3`,
        [
          insertions.map((pair) => pair.productId),
          insertions.map((pair) => pair.flavorId),
          FlavorSource.KB,
        ],
      );
    }
  }

  /**
   * Records the store claims that contradict what the catalogue holds.
   *
   * Upserted on `(productId, storeId, attribute)` so a disagreement that
   * stands for months stays one row with a rising `seenCount`, rather than one
   * row per sync. `resolvedAt` is cleared on a fresh sighting: a conflict
   * someone marked settled that reappears is not settled.
   *
   * @param conflicts - The claims observed this run; duplicates by key are
   *   merged by the caller.
   * @returns Resolves once the log is written.
   */
  public async logFactConflicts(
    conflicts: ProductFactConflictInput[],
  ): Promise<void> {
    if (!conflicts.length) {
      return;
    }

    await this.query(
      `INSERT INTO product_fact_conflict
         ("productId", "storeId", attribute, "storedValue", "claimedValue",
          "storedSource")
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[]
       )
       ON CONFLICT ("productId", "storeId", attribute) DO UPDATE SET
         "storedValue" = EXCLUDED."storedValue",
         "claimedValue" = EXCLUDED."claimedValue",
         "storedSource" = EXCLUDED."storedSource",
         "seenCount" = product_fact_conflict."seenCount" + 1,
         "lastSeenAt" = now(),
         "resolvedAt" = NULL`,
      [
        conflicts.map((conflict) => conflict.productId),
        conflicts.map((conflict) => conflict.storeId),
        conflicts.map((conflict) => conflict.attribute),
        conflicts.map((conflict) => conflict.storedValue),
        conflicts.map((conflict) => conflict.claimedValue),
        conflicts.map((conflict) => conflict.storedSource),
      ],
    );
  }

  /**
   * Builds the provenance parameter arrays for an insert, in the column order
   * the insert statements declare.
   *
   * A source is emitted only where the value it describes is present: storing
   * one next to a null would claim a source for a fact the row does not hold,
   * and the next real value would then be judged against it.
   *
   * @param inputs - The bottlings being inserted.
   * @returns One array per provenance column: name, type, country, age, abv,
   *   volume.
   */
  private sourceColumns(
    inputs: ProductCanonicalInput[],
  ): (FactSource | null)[][] {
    const columns: [
      ProductFactField,
      (
        input: ProductCanonicalInput,
      ) => unknown,
    ][] = [
      [ProductFactField.NAME, (input): unknown => input.name],
      [ProductFactField.TYPE, (input): unknown => input.typeId],
      [ProductFactField.COUNTRY, (input): unknown => input.countryId],
      [ProductFactField.AGE, (input): unknown => input.age],
      [ProductFactField.ABV, (input): unknown => input.abv],
      [ProductFactField.VOLUME, (input): unknown => input.volumeMl],
    ];

    return columns.map(([field, read]) =>
      inputs.map((input) =>
        read(input) === null || read(input) === undefined
          ? null
          : input.factSources[field] ?? FactSource.STORE
      )
    );
  }

  /**
   * Flattens per-product tag lists into sorted (product, flavor) pairs.
   *
   * @param writes - The per-product write entries.
   * @param pick - Which tag list of an entry to flatten.
   * @returns The pairs, sorted so every caller takes its row locks in the same
   *   order.
   */
  private flatten(
    writes: KbFlavorWrite[],
    pick: (write: KbFlavorWrite) => ID[],
  ): { productId: ID; flavorId: ID }[] {
    const pairs = writes.flatMap((write) =>
      [...new Set(pick(write))].map((flavorId) => ({
        productId: write.productId,
        flavorId,
      }))
    );

    return pairs.sort((left, right) =>
      left.productId.localeCompare(right.productId)
      || left.flavorId.localeCompare(right.flavorId)
    );
  }

  /**
   * Adds keyword-derived flavor links, never removing any.
   *
   * The keyword pass used to delete and re-derive its links on every sync,
   * which was coherent only while each store owned its own product row. The
   * links now hang off the shared bottling, and a store whose listing does not
   * happen to spell out "торф" has learned nothing about peat — it must not be
   * able to erase what another store's listing stated. So the links accumulate:
   * a keyword hit is evidence for a flavor, never against one.
   *
   * A tag the LLM pass already owns keeps its source; the insert never
   * downgrades an `llm` row to `scrape`.
   *
   * A bottling someone has curated by hand is skipped entirely — the join to
   * `product` is what enforces that. Accumulating is only ever evidence *for* a
   * flavor, so without this guard a tag the person deliberately removed would
   * be re-contributed by the very next sync that still matched the keyword.
   *
   * @param links - Product/flavor pairs to add. Should be deduplicated and
   *   sorted by the caller so concurrent transactions agree on lock order.
   * @returns Resolves once the links are stored.
   */
  public async addScrapeFlavors(
    links: ProductScrapeFlavorLink[],
  ): Promise<void> {
    if (!links.length) {
      return;
    }

    await this.query(
      `INSERT INTO product_flavor ("productId", "flavorId", source)
       SELECT v.id, v.flavor, $3 FROM unnest($1::uuid[], $2::uuid[])
         AS v(id, flavor)
       JOIN product p ON p.id = v.id AND p."flavorsCuratedAt" IS NULL
       ON CONFLICT ("productId", "flavorId") DO NOTHING`,
      [
        links.map((link) => link.productId),
        links.map((link) => link.flavorId),
        FlavorSource.SCRAPE,
      ],
    );
  }

  /**
   * Replaces a bottling's LLM-derived flavor links and stamps
   * `lastLlmFlavorAt`. The stamp is written even for an empty list, because an
   * "unknown" answer links nothing and would otherwise be indistinguishable
   * from never having been asked — leaving the product to be re-sent to the
   * model on every future run.
   *
   * A tag the keyword pass already linked is taken over rather than
   * duplicated: the composite key allows one row per pair, so the insert
   * promotes its source to `llm`.
   *
   * **A `kb` link is the exception and is never taken over.** The upsert's
   * `WHERE product_flavor.source <> 'kb'` is what stops the model from quietly
   * repossessing a tag the knowledge base owns — which would break the
   * invariant that every peat link is `kb` or `manual`, and would do it
   * silently, one product at a time, on whichever sync happened to re-ask.
   *
   * A hand-curated bottling keeps its links untouched: both statements below
   * are gated on `flavorsCuratedAt`, in SQL rather than in a caller, so no
   * pass can talk over a person's decision. The stamp is still written, which
   * is what stops the model from being asked about it again.
   *
   * @param productId - Canonical product id.
   * @param flavorIds - Flavor ids the model returned; duplicates are ignored.
   * @returns Resolves once the links are replaced and the stamp is written.
   */
  public async setLlmFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    await this.query(
      `DELETE FROM product_flavor pf
       USING product p
       WHERE pf."productId" = $1 AND pf.source = $2
         AND p.id = pf."productId" AND p."flavorsCuratedAt" IS NULL`,
      [productId, FlavorSource.LLM],
    );

    const distinct = [...new Set(flavorIds)];

    if (distinct.length) {
      await this.query(
        `INSERT INTO product_flavor ("productId", "flavorId", source)
         SELECT p.id, v.flavor, $3 FROM unnest($2::uuid[]) AS v(flavor)
         JOIN product p ON p.id = $1 AND p."flavorsCuratedAt" IS NULL
         ON CONFLICT ("productId", "flavorId") DO UPDATE SET source = $3
           WHERE product_flavor.source <> $4`,
        [productId, distinct, FlavorSource.LLM, FlavorSource.KB],
      );
    }

    await this.query(
      'UPDATE product SET "lastLlmFlavorAt" = now() WHERE id = $1',
      [productId],
    );
  }

  /**
   * Replaces a bottling's whole flavor set with a person's choice and marks it
   * curated from now on.
   *
   * Every existing link goes, whatever its source: the curated set is the whole
   * truth about the bottling, so a `scrape` or `llm` tag the person did not
   * keep is one they rejected. `flavorsCuratedAt` then locks both passes
   * out (see `addScrapeFlavors` and `setLlmFlavors`), which is what makes a
   * removal stick — the keyword pass would otherwise re-add the tag on the next
   * sync that still matched it.
   *
   * @param productId - Canonical product id.
   * @param flavorIds - Flavor ids to keep; duplicates are ignored and an empty
   *   list is valid, meaning "this whisky has no tags".
   * @returns Resolves once the set is stored and the bottling is marked.
   */
  public async setManualFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    await this.query(
      'DELETE FROM product_flavor WHERE "productId" = $1',
      [productId],
    );

    /**
     * Sorted for the same reason the persist path sorts: concurrent
     * transactions must take their `product_flavor` locks in one agreed order.
     */
    const distinct = [...new Set(flavorIds)].sort();

    if (distinct.length) {
      await this.query(
        `INSERT INTO product_flavor ("productId", "flavorId", source)
         SELECT $1, flavor, $3 FROM unnest($2::uuid[]) AS v(flavor)`,
        [productId, distinct, FlavorSource.MANUAL],
      );
    }

    await this.query(
      'UPDATE product SET "flavorsCuratedAt" = now() WHERE id = $1',
      [productId],
    );
  }

  /**
   * Loads every bottling with one store's raw name to re-derive a display name
   * from, flagging the ones a store filter covers.
   *
   * The whole catalogue is returned even under a filter: the cleaning sweep's
   * spelling vote and tag collapse weigh a name against every other name in
   * the catalogue, and deriving that evidence from one store alone let a
   * one-store run undo what a catalogue-wide run had decided.
   *
   * @param storeSlug - Restrict the rewrite to bottlings a store carries.
   * @returns Every bottling, with its representative raw name.
   */
  public async findNameCandidates(
    storeSlug?: string,
  ): Promise<ProductNameCandidateRow[]> {
    return this.query(
      `SELECT p.id, p.name, o."nameOrig",
              ($1::text IS NULL OR EXISTS (
                SELECT 1 FROM store_product sp
                JOIN store st ON st.id = sp."storeId"
                WHERE sp."productId" = p.id AND st.slug = $1
              )) AS carried
       FROM product p
       JOIN LATERAL (
         SELECT sp."nameOrig"
         FROM store_product sp
         WHERE sp."productId" = p.id
         ORDER BY sp."lastSeen" DESC, sp.id
         LIMIT 1
       ) o ON true
       ORDER BY p.id`,
      [storeSlug ?? null],
    ) as Promise<ProductNameCandidateRow[]>;
  }

  /**
   * Loads the bottlings a store carries, one row per SKU it lists them under,
   * with the fields a backfill can fill.
   *
   * Keyed by SKU rather than by bottling because that is what the caller can
   * line up against a scrape of the same store — and a store listing one
   * whisky twice legitimately has two gaps to close.
   *
   * @param storeId - Store id.
   * @returns One row per offer the store lists.
   */
  public async findCarriedByStore(
    storeId: ID,
  ): Promise<ProductStoreFieldsRow[]> {
    return this.query(
      `SELECT sp.sku, p.age, p.abv, p."volumeMl",
              p."typeId", p."countryId"
       FROM store_product sp
       JOIN product p ON p.id = sp."productId"
       WHERE sp."storeId" = $1`,
      [storeId],
    ) as Promise<ProductStoreFieldsRow[]>;
  }

  /**
   * Reads the stored facts of a set of bottlings, with their provenance.
   *
   * The conflict log needs the stored value and the live claim side by side,
   * and `persist` is the only place both exist at once — `rawAttrs` is never
   * written, so nothing later can reconstruct what a listing said.
   *
   * @param ids - The bottlings being written this run.
   * @returns One row per bottling that exists.
   */
  public async findFactsByIds(ids: ID[]): Promise<ProductStoredFactsRow[]> {
    if (!ids.length) {
      return [];
    }

    return this.query(
      `SELECT id, "typeId", "countryId", abv,
              "typeSource", "countrySource", "abvSource"
       FROM product WHERE id = ANY($1::uuid[])`,
      [ids],
    ) as Promise<ProductStoredFactsRow[]>;
  }

  /**
   * Counts the bottlings whose type or country the filters no longer trust.
   *
   * Both per-field counts and the distinct count are returned, because they
   * answer different questions and summing the two is wrong: 892 bottlings
   * have *both* facts untrusted, so `type + country` overstates the work by
   * that much. The badge on the review screen wants `either`; the two
   * sub-counts say which field is the problem.
   *
   * `eitherUnresolved` says how much of the queue is a **symptom** rather than
   * work: a bottling with no resolved producer has no authority behind either
   * fact, and resolving the producer fixes every bottling it makes at once.
   *
   * @returns The per-field counts, the distinct count, and the unresolved
   *   share of it.
   */
  public async countUntrustedFacts(): Promise<UntrustedFactCounts> {
    const untrustedType = `"typeId" IS NOT NULL
           AND ("typeSource" IS NULL
                OR NOT ("typeSource" = ANY($1::text[])))`;
    const untrustedCountry = `"countryId" IS NOT NULL
           AND ("countrySource" IS NULL
                OR NOT ("countrySource" = ANY($1::text[])))`;

    const rows = await this.query(
      `SELECT
         count(*) FILTER (WHERE ${untrustedType})::int AS type,
         count(*) FILTER (WHERE ${untrustedCountry})::int AS country,
         count(*) FILTER (WHERE (${untrustedType})
                             OR (${untrustedCountry}))::int AS either,
         count(*) FILTER (WHERE ((${untrustedType})
                             OR (${untrustedCountry}))
                            AND "producerId" IS NULL)::int
           AS "eitherUnresolved"
       FROM product`,
      [TRUSTED_FACT_SOURCES],
    ) as UntrustedFactCounts[];

    return rows[0]
      ?? { type: 0, country: 0, either: 0, eitherUnresolved: 0 };
  }

  /**
   * Lists the bottlings whose type or country the filters distrust.
   *
   * Ordered by how many shops carry the bottling, because a fact wrong on a
   * whisky twelve shops list is wrong twelve times over on the reports.
   *
   * Each row carries the country's own label and flag rather than its code
   * alone, and up to `STORE_LINK_LIMIT` links to the shops' own pages — the
   * reviewer's fastest way to settle a disputed fact is to look at the
   * listing that produced it.
   *
   * @param field - `type`, `country`, or omit for either.
   * @param limit - Page size.
   * @param offset - Page offset.
   * @param producer - `resolved` or `unresolved` to take one half of the
   *   queue; omit for both. The halves need different work, which is why the
   *   filter exists at all.
   * @param search - Case-insensitive substring of the canonical name or any
   *   store's raw name, or omit for all. Both columns, because the screen
   *   falls back to the raw name where cleaning left nothing.
   * @returns The rows and the total matching count.
   */
  public async findUntrustedFacts(
    field?: string,
    limit = 50,
    offset = 0,
    producer?: string,
    search?: string,
  ): Promise<{ rows: ProductFactReviewRow[]; total: number }> {
    const segment = FACT_QUEUE_SEGMENT[producer ?? ''] ?? '';

    const where = `(
         (
           ($1::text IS NULL OR $1 = 'type')
           AND p."typeId" IS NOT NULL
           AND (p."typeSource" IS NULL
                OR NOT (p."typeSource" = ANY($2::text[])))
         ) OR (
           ($1::text IS NULL OR $1 = 'country')
           AND p."countryId" IS NOT NULL
           AND (p."countrySource" IS NULL
                OR NOT (p."countrySource" = ANY($2::text[])))
         )
       ) AND (
         $3::text IS NULL
         OR p.name ILIKE '%' || $3 || '%'
         OR EXISTS (
           SELECT 1 FROM store_product snp
           WHERE snp."productId" = p.id
             AND snp."nameOrig" ILIKE '%' || $3 || '%')
       )`;

    const rows = await this.query(
      `SELECT p.id, p.name, COALESCE(pr.name, bo.name) AS brand,
              t.name AS type, p."typeSource",
              c.code AS "countryCode", c."nameUa" AS "countryName",
              c.icon AS "countryIcon", p."countrySource",
              pr.slug AS "producerSlug",
              (SELECT sp."nameOrig" FROM store_product sp
               WHERE sp."productId" = p.id
               ORDER BY length(sp."nameOrig") DESC LIMIT 1) AS "nameOrig",
              (SELECT count(DISTINCT sp."storeId")::int FROM store_product sp
               WHERE sp."productId" = p.id AND sp."inStock") AS "storeCount",
              (${STORE_LINKS_SQL}) AS stores
       FROM product p
       LEFT JOIN type t ON t.id = p."typeId"
       LEFT JOIN country c ON c.id = p."countryId"
       LEFT JOIN producer pr ON pr.id = p."producerId"
       LEFT JOIN producer bo ON bo.id = p."bottlerId"
       WHERE (${where})${segment}
       ORDER BY (SELECT count(DISTINCT sp."storeId") FROM store_product sp
                 WHERE sp."productId" = p.id AND sp."inStock") DESC, p.id
       LIMIT $4 OFFSET $5`,
      [field ?? null, TRUSTED_FACT_SOURCES, search ?? null, limit, offset],
    ) as ProductFactReviewRow[];

    const counted = await this.query(
      `SELECT count(*)::int AS total FROM product p
       WHERE (${where})${segment}`,
      [field ?? null, TRUSTED_FACT_SOURCES, search ?? null],
    ) as { total: number }[];

    return { rows, total: counted[0]?.total ?? 0 };
  }

  /**
   * Counts the unresolved cross-shop contradictions.
   *
   * @returns How many are open.
   */
  public async countOpenConflicts(): Promise<number> {
    const rows = await this.query(
      `SELECT count(*)::int AS total FROM product_fact_conflict
       WHERE "resolvedAt" IS NULL`,
    ) as { total: number }[];

    return rows[0]?.total ?? 0;
  }

  /**
   * Lists the unresolved contradictions, worst-first by how often each has
   * been seen.
   *
   * The stored and claimed values are foreign keys for three of the four
   * attributes and a number for the fourth, so the uuid cast is guarded by a
   * `CASE` on the value's shape — Postgres is free to evaluate a cast before
   * the predicate meant to exclude it, and an ABV row would otherwise abort
   * the whole query.
   *
   * @param attribute - Restrict to one disputed attribute.
   * @param store - Restrict to one shop's claims, by slug.
   * @param limit - Page size.
   * @param offset - Page offset.
   * @param search - Case-insensitive substring of the bottling's canonical
   *   name or any store's raw name, or omit for all.
   * @returns The rows and the total matching count.
   */
  public async findConflicts(
    attribute?: string,
    store?: string,
    limit = 50,
    offset = 0,
    search?: string,
  ): Promise<{ rows: ReviewConflictRow[]; total: number }> {
    const nameMatch = `($3::text IS NULL
         OR p.name ILIKE '%' || $3 || '%'
         OR EXISTS (
           SELECT 1 FROM store_product snp
           WHERE snp."productId" = p.id
             AND snp."nameOrig" ILIKE '%' || $3 || '%'))`;

    const rows = await this.query(
      `WITH q AS (
         SELECT c.*,
                CASE WHEN c."storedValue" ~ $6 THEN c."storedValue"::uuid END
                  AS "storedId",
                CASE WHEN c."claimedValue" ~ $6 THEN c."claimedValue"::uuid END
                  AS "claimedId"
         FROM product_fact_conflict c
         WHERE c."resolvedAt" IS NULL
       )
       SELECT q."productId", p.name AS "productName",
              q."storeId", st.slug AS "storeSlug",
              q.attribute, q."storedSource", q."seenCount", q."lastSeenAt",
              COALESCE(sty.name, sc.code, q."storedValue")
                AS "storedValue",
              COALESCE(cty.name, cc.code, q."claimedValue")
                AS "claimedValue"
       FROM q
       JOIN store st ON st.id = q."storeId"
       JOIN product p ON p.id = q."productId"
       LEFT JOIN type sty ON sty.id = q."storedId"
       LEFT JOIN country sc ON sc.id = q."storedId"
       LEFT JOIN type cty ON cty.id = q."claimedId"
       LEFT JOIN country cc ON cc.id = q."claimedId"
       WHERE ($1::text IS NULL OR q.attribute = $1)
         AND ($2::text IS NULL OR st.slug = $2)
         AND ${nameMatch}
       ORDER BY q."seenCount" DESC, q."lastSeenAt" DESC
       LIMIT $4 OFFSET $5`,
      [
        attribute ?? null,
        store ?? null,
        search ?? null,
        limit,
        offset,
        UUID_SHAPE,
      ],
    ) as ReviewConflictRow[];

    const counted = await this.query(
      `SELECT count(*)::int AS total
       FROM product_fact_conflict c
       JOIN store st ON st.id = c."storeId"
       JOIN product p ON p.id = c."productId"
       WHERE c."resolvedAt" IS NULL
         AND ($1::text IS NULL OR c.attribute = $1)
         AND ($2::text IS NULL OR st.slug = $2)
         AND ${nameMatch}`,
      [attribute ?? null, store ?? null, search ?? null],
    ) as { total: number }[];

    return { rows, total: counted[0]?.total ?? 0 };
  }

  /**
   * Marks one contradiction settled.
   *
   * The scrape clears `resolvedAt` again on the next sighting, so a
   * disagreement somebody dismissed that keeps arriving is not dismissed.
   *
   * @param productId - The bottling.
   * @param storeId - The shop making the claim.
   * @param attribute - Which fact is disputed.
   * @returns Resolves once the row is marked.
   */
  public async resolveConflict(
    productId: ID,
    storeId: ID,
    attribute: string,
  ): Promise<void> {
    await this.query(
      `UPDATE product_fact_conflict SET "resolvedAt" = now()
       WHERE "productId" = $1 AND "storeId" = $2 AND attribute = $3`,
      [productId, storeId, attribute],
    );
  }

  /**
   * Lists the display names resolved to a producer, in either slot: made by it
   * or bottled by it. The bottler slot matters because a bottler's own
   * `productCount` is structurally zero — the resolver refuses it the producer
   * slot — so without it expanding a bottler row would always show nothing.
   *
   * @param producerId - The producer or bottler.
   * @returns The grouped names, alphabetically, each with its bottling count.
   */
  public async findResolvedByProducer(
    producerId: ID,
  ): Promise<ProducerProductRow[]> {
    return this.query(
      producerProductsSql('p."producerId" = $1 OR p."bottlerId" = $1'),
      [producerId],
    ) as Promise<ProducerProductRow[]>;
  }

  /**
   * Reads specific bottlings as producer-expansion rows — the withheld path,
   * where the ids come from a what-if resolution rather than from a stored
   * link.
   *
   * @param ids - The bottlings to read.
   * @returns The grouped names, alphabetically, each with its bottling count.
   */
  public async findProducerProductsByIds(
    ids: ID[],
  ): Promise<ProducerProductRow[]> {
    if (!ids.length) {
      return [];
    }

    return this.query(
      producerProductsSql('p.id = ANY($1::uuid[])'),
      [ids],
    ) as Promise<ProducerProductRow[]>;
  }

  /**
   * Loads every bottling the reconciliation pass may touch, with its stored
   * facts, their provenance and its current flavor links.
   *
   * The whole catalogue comes back in one query on purpose. The unit of
   * reconciliation is the group of identically-named bottlings — that grouping
   * is what makes "same name, same facts" structural rather than a repair —
   * and a group cannot be assembled from a slice. At ~4000 rows the read is
   * cheap; paging it would only make the grouping wrong.
   *
   * @param storeSlug - Narrow to bottlings some store lists, for a spot check.
   * @param brand - Narrow to one brand name, likewise.
   * @param ids - Narrow to specific bottlings; this is the sync path, which
   *   only ever touches what the run wrote.
   * @returns One row per bottling, flavor links included.
   */
  public async findKbReconcileCandidates(
    storeSlug?: string,
    brand?: string,
    ids?: ID[],
  ): Promise<KbReconcileRow[]> {
    return this.query(
      `SELECT p.id, p.name, p."brandOrig" AS brand,
              p."countryId", p."countrySource",
              p."typeId", p."typeSource",
              p."producerId", p."bottlerId", p."flavorsCuratedAt",
              COALESCE((
                SELECT json_agg(json_build_object(
                  'flavorId', pf."flavorId", 'name', f.name,
                  'source', pf.source) ORDER BY f.name)
                FROM product_flavor pf
                JOIN flavor f ON f.id = pf."flavorId"
                WHERE pf."productId" = p.id
              ), '[]'::json) AS flavors
       FROM product p
       WHERE ($1::text IS NULL OR EXISTS (
               SELECT 1 FROM store_product sp
               JOIN store st ON st.id = sp."storeId"
               WHERE sp."productId" = p.id AND st.slug = $1))
         AND ($2::text IS NULL OR lower(p."brandOrig") = lower($2))
         AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))
       ORDER BY lower(COALESCE(p.name, '')), p.id`,
      [storeSlug ?? null, brand ?? null, ids?.length ? ids : null],
    ) as Promise<KbReconcileRow[]>;
  }

  /**
   * Loads the bottlings the LLM flavor pass has never answered for, as
   * classification input. Out-of-stock offers count: a flavor is a property of
   * the bottle, not of its availability.
   *
   * The classification input is one store's raw name rather than the canonical
   * one, because the descriptors the cleaner strips ("Peated", "Sherry Cask")
   * are exactly what the model reads. The longest raw name wins as the one
   * carrying the most of them.
   *
   * A hand-curated bottling is never a candidate: `setLlmFlavors` would refuse
   * to write its answer anyway, so asking the model about it would only spend
   * tokens on a result nobody can use.
   *
   * **One candidate per distinct name, not per bottling.** Identically-named
   * bottlings are the same whisky in different sizes or packaging, so asking
   * about each is paying twice for one answer — and worse, the two answers
   * routinely differed, which is how 250 name groups came to disagree about
   * the other thirteen tags. `clean-product-names.ts` already makes this exact
   * decision for the same reason. The group's ids ride along in `groupIds` so
   * the caller writes the one answer to all of them.
   *
   * The resolved producer is joined in for grounding. Handing the model the
   * distillery and its region is what stops it having to work out whose whisky
   * an independent bottling is — the guess it makes when it cannot is precisely
   * what put Ledaig's smoke on Tobermory. The producer's `forbid` rows come
   * along too, applied as a post-filter on the answer rather than argued about
   * in the prompt.
   *
   * @param storeSlug - Restrict to bottlings a given store carries, or omit
   *   for the whole catalogue.
   * @returns One candidate per bottling still lacking an LLM answer.
   */
  public async findFlavorCandidates(
    storeSlug?: string,
  ): Promise<FlavorCandidateRow[]> {
    return this.query(
      `SELECT DISTINCT ON (lower(COALESCE(p.name, o."nameOrig")))
              p.id, o."nameOrig" AS name,
              t.name AS "whiskyType", c."nameUa" AS country,
              pr.name AS distillery, pr.region AS region,
              COALESCE((
                SELECT array_agg(f.name ORDER BY f.name)
                FROM producer_flavor pf
                JOIN flavor f ON f.id = pf."flavorId"
                WHERE pf."producerId" = pr.id AND pf.effect = 'forbid'
              ), ARRAY[]::text[]) AS "forbiddenTags",
              ARRAY(
                SELECT g.id FROM product g
                WHERE lower(COALESCE(g.name, '')) = lower(COALESCE(p.name, ''))
                  AND p.name IS NOT NULL
                  AND g."lastLlmFlavorAt" IS NULL
                  AND g."flavorsCuratedAt" IS NULL
              ) || ARRAY[p.id] AS "groupIds"
       FROM product p
       JOIN LATERAL (
         SELECT sp."nameOrig"
         FROM store_product sp
         WHERE sp."productId" = p.id
         ORDER BY length(sp."nameOrig") DESC, sp."lastSeen" DESC, sp.id
         LIMIT 1
       ) o ON true
       LEFT JOIN type t ON t.id = p."typeId"
       LEFT JOIN country c ON c.id = p."countryId"
       LEFT JOIN producer pr ON pr.id = p."producerId"
       WHERE p."lastLlmFlavorAt" IS NULL
         AND p."flavorsCuratedAt" IS NULL
         AND ($1::text IS NULL OR EXISTS (
           SELECT 1 FROM store_product sp
           JOIN store st ON st.id = sp."storeId"
           WHERE sp."productId" = p.id AND st.slug = $1
         ))
       ORDER BY lower(COALESCE(p.name, o."nameOrig")), p."createdAt", p.id`,
      [storeSlug ?? null],
    ) as Promise<FlavorCandidateRow[]>;
  }
}
