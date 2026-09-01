import { MigrationInterface, QueryRunner } from 'typeorm';

import { ProducerAliasScope } from '../src/enums';
import type { KbAliasEntry } from '../src/interfaces';
import {
  BrandUtils,
  KbAliasUtils,
  KbKeyUtils,
  ProductMatchUtils,
} from '../src/utils';

/**
 * The alias index the resolver matches against, in the order it reads it.
 *
 * Inlined rather than imported from `ProducerRepository`: a migration is a
 * historical record and has to keep applying the same change after the query
 * moves on.
 */
const ALIAS_INDEX_SQL = `
  SELECT a.key, a.scope, p.id, p.slug, p.name, p.kind, p."countryId",
         p.region, p."legalRegion", p."parentId", p."bottlerId",
         p."defaultTypeName", p."peatProfile"
  FROM producer_alias a
  JOIN producer p ON p.id = a."producerId"
  WHERE p.status IN ('verified', 'auto')
  ORDER BY length(a.key) DESC, a.key
`;

/**
 * One bottling, with the brand string its key was built from.
 */
interface Row {
  /**
   * The `product` row id.
   */
  id: string;

  /**
   * Its frozen identity.
   */
  matchKey: string;

  /**
   * The cleaned display name the signature was derived from.
   */
  name: string | null;

  /**
   * The shop spelling of the brand, as `brand-retire-prep` copied it over.
   */
  brandOrig: string;
}

/**
 * Re-signs every match key with the producer the knowledge base resolves,
 * and folds together the bottlings that turn out to be one whisky.
 *
 * The brand is one of the tokens `ProductMatchUtils.key` folds into a
 * bottling's identity, and until now that token was whatever string a shop
 * printed. Nineteen shops print nineteen strings, so the catalogue signed one
 * whisky several ways: `Chivas`, `Chivas Regal` and `Chivas Brothers` were
 * three makers, `Isle of Jura` was not `Jura`, `M H` was not `M&h Elements`,
 * and `Douglas Laingcompany` was not `Douglas Laing`. The knowledge base has
 * known better all along — every one of those spellings is a row of
 * `producer_alias` — but nothing on the identity path ever asked it.
 *
 * The engine asks now (`NormalizeService.resolveKeyBrand`), so the stored keys
 * have to be brought into step or the catalogue would carry two conventions at
 * once. This is that repair, and it works out what to do from the data rather
 * than from a shipped list of ids.
 *
 * **The token is the producer's slug, not its name.** Both are curated, but
 * `producer.name` is a display string that `PATCH /producer/:id` rewrites, and
 * a key that moved whenever a reviewer tidied a spelling would be no more
 * stable than the shop strings it replaces. Measured on a production dump,
 * folding to the name also restated three times as many keys for no gain —
 * `TBWC` would become `thatboutiqueycompany`.
 *
 * **Only the signature is re-derived.** The `|v..|a..` suffix is carried over
 * verbatim, because `age` and `volumeMl` are written *after* a key is frozen —
 * `age-regroup-cyrillic-yo`'s own "fact only" case does exactly that — so
 * re-deriving the suffix would reject rows whose brand is the only thing this
 * repair is allowed to touch. A bottling whose signature no longer reproduces
 * at all has had its name rewritten since creation and is **skipped**: those
 * hold Cyrillic remnants (`irishmanхарвест`, `crownroyalканадакроунройял`) or
 * predate the brand being filled in, and re-signing them would merge rows for
 * reasons that have nothing to do with the brand.
 *
 * **No `product` row is ever deleted.** A merge leaves its source with no
 * offers, and a bottling no store lists is a shape the API already supports —
 * `/preference/details` renders and removes one. Favourites and blacklist
 * entries follow the offers, guarded per user so a merge cannot violate their
 * composite keys.
 *
 * The pass asserts its own invariant before committing: a second planning run
 * over the written rows must find nothing left to do. The whole migration is
 * one transaction, so a failure rolls all of it back.
 *
 * `down()` is a documented no-op. Reversing it would put one whisky back under
 * several identities, and the links as they stood were never recorded anywhere
 * to restore from.
 */
export class BrandCanonicalRegroup1788290342697 implements MigrationInterface {
  /**
   * Splits a stored key into the part this repair may rewrite and the part it
   * must carry over.
   *
   * @param matchKey - The key as stored.
   * @returns The signature and the `|v..|a..` suffix, or null when the key
   *   carries no suffix at all — a shape this repair refuses to touch.
   */
  private static split(
    matchKey: string,
  ): { signature: string; suffix: string } | null {
    const at = matchKey.indexOf('|');

    if (at < 0) {
      return null;
    }

    return {
      signature: matchKey.slice(0, at),
      suffix: matchKey.slice(at),
    };
  }

  /**
   * The signature `ProductMatchUtils.key` builds from a name and a brand.
   *
   * @param name - The cleaned display name, or null.
   * @param brand - The brand token.
   * @returns The signature, or null when no significant word survives.
   */
  private static signature(
    name: string | null,
    brand: string | null,
  ): string | null {
    const key = ProductMatchUtils.key(name, brand, null, null);

    return key === null ? null : key.slice(0, key.indexOf('|'));
  }

  public name = 'BrandCanonicalRegroup1788290342697';

  /**
   * @param queryRunner - The query runner.
   * @returns Resolves once every reproducible key is signed with a producer.
   * @throws {Error} When a second pass still finds work, which would mean the
   *   rewrite is not idempotent and the catalogue would drift on the next run.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const aliases = await this.loadAliases(queryRunner);

    await this.regroup(queryRunner, aliases);

    const left = await this.plan(queryRunner, aliases);

    if (left.length) {
      throw new Error(
        `Brand regroup aborted: ${left.length} bottling(s) still disagree `
          + `with the resolver, first ${left[0].id} (${left[0].from} -> `
          + `${left[0].to})`,
      );
    }
  }

  public async down(): Promise<void> {
    /**
     * Irreversible on purpose. Undoing it would put one whisky back under
     * several identities, and the links as they stood before the repair were
     * never recorded anywhere to restore from.
     */
  }

  /**
   * Loads the alias index, guarded exactly as the running service guards it.
   *
   * @param queryRunner - The migration's query runner.
   * @returns The aliases that carry identity of their own.
   */
  private async loadAliases(
    queryRunner: QueryRunner,
  ): Promise<KbAliasEntry[]> {
    const rows = await queryRunner.query(ALIAS_INDEX_SQL) as {
      key: string;
      scope: ProducerAliasScope;
      id: string;
      slug: string;
    }[];

    const entries = rows.map((row) =>
      ({
        key: row.key,
        scope: row.scope,
        producer: { id: row.id, slug: row.slug },
      }) as unknown as KbAliasEntry
    );

    return KbAliasUtils.usable(entries);
  }

  /**
   * Works out every key that would change, without writing anything.
   *
   * @param queryRunner - The migration's query runner.
   * @param aliases - The alias index.
   * @returns One entry per bottling whose key the resolver disagrees with.
   */
  private async plan(
    queryRunner: QueryRunner,
    aliases: KbAliasEntry[],
  ): Promise<{ id: string; from: string; to: string }[]> {
    const rows = await queryRunner.query(`
      SELECT id, "matchKey", name, "brandOrig"
      FROM product
      WHERE "matchKey" IS NOT NULL AND "brandOrig" IS NOT NULL
      ORDER BY id
    `) as Row[];

    const out: { id: string; from: string; to: string }[] = [];

    rows.forEach((row) => {
      const parts = BrandCanonicalRegroup1788290342697.split(row.matchKey);
      const canonical = BrandUtils.canonical(row.brandOrig);

      if (!parts || canonical === null) {
        return;
      }

      const stored = BrandCanonicalRegroup1788290342697.signature(
        row.name,
        canonical,
      );

      if (stored !== parts.signature) {
        return;
      }

      const hit = KbAliasUtils.matchByBrand(
        KbKeyUtils.key(canonical),
        aliases,
      );

      if (!hit) {
        return;
      }

      const resigned = BrandCanonicalRegroup1788290342697.signature(
        row.name,
        hit.producer.slug,
      );

      if (resigned === null || resigned === parts.signature) {
        return;
      }

      out.push({
        id: row.id,
        from: row.matchKey,
        to: `${resigned}${parts.suffix}`,
      });
    });

    return out;
  }

  /**
   * Applies the plan, merging wherever a re-signed key is already taken.
   *
   * Each target is looked up against the live table rather than against a
   * snapshot, so two bottlings converging on one key settle onto whichever of
   * them got there first — deterministically, because the plan is ordered by
   * id.
   *
   * @param queryRunner - The migration's query runner.
   * @param aliases - The alias index.
   * @returns Resolves once every key has been re-signed or merged away.
   */
  private async regroup(
    queryRunner: QueryRunner,
    aliases: KbAliasEntry[],
  ): Promise<void> {
    const planned = await this.plan(queryRunner, aliases);

    for (const change of planned) {
      const twin = await this.findByKey(queryRunner, change.to);

      if (twin !== null && twin !== change.id) {
        await this.merge(queryRunner, change.id, twin);

        continue;
      }

      await queryRunner.query(
        'UPDATE product SET "matchKey" = $1, "updatedAt" = now() WHERE id = $2',
        [change.to, change.id],
      );
    }
  }

  /**
   * Finds the bottling carrying a key.
   *
   * @param queryRunner - The migration's query runner.
   * @param matchKey - The key to look for.
   * @returns Its product id, or null when nothing carries the key.
   */
  private async findByKey(
    queryRunner: QueryRunner,
    matchKey: string,
  ): Promise<string | null> {
    const rows = await queryRunner.query(
      'SELECT id FROM product WHERE "matchKey" = $1',
      [matchKey],
    ) as { id: string }[];

    return rows.length > 0 ? rows[0].id : null;
  }

  /**
   * Folds one bottling into another that is the same whisky.
   *
   * Verbatim the shape `age-regroup-cyrillic-yo` established: the offers move,
   * the flavour links are copied rather than dropped (a tag is evidence *for*
   * a flavour, never against one), and a person's favourites and blacklist
   * entries follow the offers under a per-user guard so the composite keys
   * hold. The emptied row is left in place — deleting it would cascade those
   * list entries away.
   *
   * One thing this merge does that the age one did not: the emptied source
   * gives up its key. There the source's key stayed meaningful — a bottling
   * whose name states no age is a real identity that a future listing can
   * legitimately join. Here it is not: the key was signed with a shop's own
   * spelling of a maker, and the engine now folds every such spelling through
   * the knowledge base, so nothing will ever compute that signature again. A
   * null key is the catalogue's documented "never match anything to this
   * automatically" (see `CURATION.md`), which is exactly the truth about a row
   * that holds no offers and can gain none. It is also what makes this pass
   * idempotent, and the assertion in `up()` is what noticed: leaving the key
   * behind left the source planning the same move on every run.
   *
   * @param queryRunner - The migration's query runner.
   * @param productId - The bottling to empty.
   * @param targetId - The bottling to keep.
   * @returns Resolves once the source holds no offers.
   */
  private async merge(
    queryRunner: QueryRunner,
    productId: string,
    targetId: string,
  ): Promise<void> {
    await queryRunner.query(
      'UPDATE store_product SET "productId" = $1 WHERE "productId" = $2',
      [targetId, productId],
    );

    await queryRunner.query(
      `INSERT INTO product_flavor ("productId", "flavorId", source)
       SELECT $1, "flavorId", source FROM product_flavor WHERE "productId" = $2
       ON CONFLICT DO NOTHING`,
      [targetId, productId],
    );

    await queryRunner.query(
      `UPDATE favorite f SET "productId" = $1
       WHERE f."productId" = $2
         AND NOT EXISTS (
           SELECT 1 FROM favorite kept
           WHERE kept."userId" = f."userId" AND kept."productId" = $1
         )`,
      [targetId, productId],
    );

    await queryRunner.query(
      `UPDATE blacklist_product b SET "productId" = $1
       WHERE b."productId" = $2
         AND NOT EXISTS (
           SELECT 1 FROM blacklist_product kept
           WHERE kept."userId" = b."userId" AND kept."productId" = $1
         )`,
      [targetId, productId],
    );

    await queryRunner.query(
      `UPDATE product SET "matchKey" = NULL, "updatedAt" = now()
       WHERE id = $1`,
      [productId],
    );
  }
}
