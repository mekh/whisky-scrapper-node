import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { FlavorSource } from '~enums';
import {
  FlavorCandidateRow,
  ID,
  ProductCanonicalInput,
  ProductFillInput,
  ProductMatchRow,
  ProductNameCandidateRow,
  ProductScrapeFlavorLink,
  ProductSearchItem,
  ProductStoreFieldsRow,
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
 */
const FIND_OR_CREATE_SQL = `
  INSERT INTO product
     ("matchKey", name, "brandId", "typeId", "countryId", age, abv, "volumeMl")
   SELECT * FROM unnest(
     $1::text[], $2::text[], $3::uuid[], $4::uuid[], $5::uuid[],
     $6::int[], $7::real[], $8::int[]
   )
   ON CONFLICT ("matchKey") DO UPDATE SET "matchKey" = EXCLUDED."matchKey"
   RETURNING id, "matchKey", (xmax = 0) AS "isNew"
`;

/**
 * Fills the secondary fields of already-stored bottlings, never overwriting.
 *
 * The `WHERE` clause is not an optimization. Without it every offer of every
 * store would write a new row version of a **shared** row on every sync, hold
 * its lock until that store's whole transaction commits, and bump `updatedAt`
 * for a write that changed nothing.
 */
const FILL_MISSING_SQL = `
  UPDATE product p SET
    abv = COALESCE(p.abv, v.abv),
    "brandId" = COALESCE(p."brandId", v."brandId"),
    "typeId" = COALESCE(p."typeId", v."typeId"),
    "countryId" = COALESCE(p."countryId", v."countryId"),
    "updatedAt" = now()
  FROM unnest($1::uuid[], $2::real[], $3::uuid[], $4::uuid[], $5::uuid[])
    AS v(id, abv, "brandId", "typeId", "countryId")
  WHERE p.id = v.id
    AND ((v.abv IS NOT NULL AND p.abv IS NULL)
      OR (v."brandId" IS NOT NULL AND p."brandId" IS NULL)
      OR (v."typeId" IS NOT NULL AND p."typeId" IS NULL)
      OR (v."countryId" IS NOT NULL AND p."countryId" IS NULL))
`;

/**
 * Autocomplete search, one row per bottling.
 *
 * Deliberately NOT preference-filtered — it takes no user at all. The picker's
 * job includes finding a bottling the user already hid so it can be un-hidden;
 * filtering it by the lists it edits would make such an entry unfindable. This
 * joins `/report/history` as a read that ignores the blacklist on purpose
 * (documented in MIGRATION.md).
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
  SELECT p.id AS "productId", p.name, o."nameOrig", b.name AS brand,
         p.age, p.abv::float8 AS abv, p."volumeMl",
         COALESCE(o."inStock", false) AS "inStock"
  FROM product p
  LEFT JOIN brand b ON b.id = p."brandId"
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
      inputs.map((input) => input.brandId),
      inputs.map((input) => input.typeId),
      inputs.map((input) => input.countryId),
      inputs.map((input) => input.age),
      inputs.map((input) => input.abv),
      inputs.map((input) => input.volumeMl),
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
    const rows = await this.query(
      `INSERT INTO product
         ("matchKey", name, "brandId", "typeId", "countryId",
          age, abv, "volumeMl")
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.name,
        input.brandId,
        input.typeId,
        input.countryId,
        input.age,
        input.abv,
        input.volumeMl,
      ],
    ) as { id: ID }[];

    return rows[0].id;
  }

  /**
   * Fills still-null strength, brand, type and country on stored bottlings.
   *
   * A stored value always wins, so this can only add knowledge — which is what
   * lets a store that reads a spec page contribute to a bottling another store
   * listed first, and what keeps a manual edit safe from the next sync.
   *
   * Name, age and volume are deliberately not fillable here: the name is the
   * catalogue's own decision, and age and volume are part of the identity, so
   * changing them would describe a different bottling.
   *
   * @param inputs - One patch per canonical product; duplicates by id waste a
   *   row lock and should be merged by the caller.
   * @returns How many bottlings actually gained a value.
   */
  public async fillMissing(inputs: ProductFillInput[]): Promise<number> {
    if (!inputs.length) {
      return 0;
    }

    const result = await this.query(FILL_MISSING_SQL, [
      inputs.map((input) => input.id),
      inputs.map((input) => input.abv),
      inputs.map((input) => input.brandId),
      inputs.map((input) => input.typeId),
      inputs.map((input) => input.countryId),
    ]) as [unknown[], number];

    return result[1] ?? 0;
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
         ON CONFLICT ("productId", "flavorId") DO UPDATE SET source = $3`,
        [productId, distinct, FlavorSource.LLM],
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
              p."brandId", p."typeId", p."countryId"
       FROM store_product sp
       JOIN product p ON p.id = sp."productId"
       WHERE sp."storeId" = $1`,
      [storeId],
    ) as Promise<ProductStoreFieldsRow[]>;
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
   * @param storeSlug - Restrict to bottlings a given store carries, or omit
   *   for the whole catalogue.
   * @returns One candidate per bottling still lacking an LLM answer.
   */
  public async findFlavorCandidates(
    storeSlug?: string,
  ): Promise<FlavorCandidateRow[]> {
    return this.query(
      `SELECT p.id, o."nameOrig" AS name,
              t.name AS "whiskyType", c."nameUa" AS country
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
       WHERE p."lastLlmFlavorAt" IS NULL
         AND p."flavorsCuratedAt" IS NULL
         AND ($1::text IS NULL OR EXISTS (
           SELECT 1 FROM store_product sp
           JOIN store st ON st.id = sp."storeId"
           WHERE sp."productId" = p.id AND st.slug = $1
         ))
       ORDER BY p."createdAt", p.id`,
      [storeSlug ?? null],
    ) as Promise<FlavorCandidateRow[]>;
  }
}
