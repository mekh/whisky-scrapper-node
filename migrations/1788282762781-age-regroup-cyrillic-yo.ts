import { MigrationInterface, QueryRunner } from 'typeorm';

import { FactSource } from '../src/enums';
import { NormalizeService } from '../src/scrape/normalize/normalize.service';

/**
 * The age component of a match key, the only part this repair may rewrite. The
 * signature and the volume are carried over from the stored key verbatim:
 * re-deriving them would re-key bottlings whose name has since been cleaned or
 * corrected by hand, which is exactly what the frozen key exists to prevent.
 */
const KEY_AGE = /\|a(\d+)$/;

/**
 * One store offer with the bottling it currently points at.
 */
interface OfferRow {
  /**
   * The `store_product` row id.
   */
  id: string;

  /**
   * The bottling the offer is linked to today.
   */
  productId: string;

  /**
   * The raw scraped name — the only place a stated age survives, the display
   * name having had it stripped.
   */
  nameOrig: string;

  /**
   * The bottling's frozen identity.
   */
  matchKey: string;
}

/**
 * The offers of one bottling, each paired with the age its name states.
 */
interface Group {
  /**
   * The bottling's stored match key.
   */
  matchKey: string;

  /**
   * The age the key was signed with, `0` standing for "none stated".
   */
  keyAge: number;

  /**
   * The bottling's offers and the age each one's name states.
   */
  offers: { id: string; stated: number | null }[];
}

/**
 * Repairs the bottlings that the Cyrillic `уо` age spelling merged together.
 *
 * `ProductNameUtils` deleted `12уо` from the display name while
 * `NormalizeService.extractAgeYears` could not read it, so the age was erased
 * from the name and recorded nowhere: `ProductMatchUtils.key` signed the
 * bottling `|a0`, and every age of one expression landed on a single `product`
 * row. Rozetka and MauDau both spell it that way, which is how the 12, 15, 18
 * and 30 year old Dalmore became one bottling the catalogue served as
 * `Dalmore 12yo 43% 0,7л` — the 30 year old among them at nearly half a
 * million hryvnia. The same asymmetry hid an age typed with a look-alike
 * letter of the other alphabet (`Chivas Regal 12 рокiв`, Latin `i`), which the
 * stripper folds before matching and the reader did not.
 *
 * The reader is fixed; the frozen keys are not, because nothing on the scrape
 * path re-keys an offer once its SKU is known. This is that correction, and it
 * works out what to do from the data it finds rather than from a shipped list
 * of ids — production's catalogue is not any other catalogue, and the age has
 * to be the one the fixed engine now reads, which is why it asks the engine
 * instead of re-implementing its patterns.
 *
 * Three cases, and the boundary between them is what keeps the repair honest:
 *
 * - **Split.** The group's offers state two or more different ages, so the row
 *   is provably several whiskies. Every offer that states an age moves to the
 *   bottling carrying that age; offers that state none stay behind, because
 *   nothing here can tell which of the ages such a listing sells.
 * - **Merge.** The group agrees on one age and a bottling with that exact key
 *   already exists — one whisky recorded twice because one shop spelled the
 *   age in a way the reader understood and another did not. The whole group
 *   moves onto it.
 * - **Fact only.** The group agrees on one age and no such bottling exists.
 *   The age is filled in as a `name`-sourced fact and **the key is left
 *   alone**. Re-keying here would be a downgrade rather than a fix: these
 *   groups are one shop stating an age that seven others omit, so signing the
 *   row with it would push every silent listing off the bottling at the next
 *   sync and break the cross-store comparison the catalogue exists for.
 *
 * **No `product` row is ever deleted.** A merge leaves its source with no
 * offers, and a bottling no store lists is a shape the API already supports —
 * `/preference/details` renders and removes one. Deleting instead would mean
 * guessing which of a split's four targets a person's favourite meant.
 * Favourites and blacklist entries follow the offers only in the merge case,
 * where the target is unambiguous.
 *
 * The pass asserts its own invariant before committing: no bottling may be
 * left holding offers whose names state conflicting ages. The whole migration
 * is one transaction, so a failure rolls all of it back.
 *
 * `down()` is a documented no-op. Reversing it would put whiskies of different
 * ages back onto one row, and the links as they stood were never recorded
 * anywhere to restore from.
 */
export class AgeRegroupCyrillicYo1788282762781 implements MigrationInterface {
  /**
   * Reads the age component out of a stored match key.
   *
   * @param matchKey - The key as stored.
   * @returns The age it was signed with, or null when the key carries no age
   *   suffix at all — a shape this repair refuses to touch.
   */
  private static keyAge(matchKey: string): number | null {
    const match = KEY_AGE.exec(matchKey);

    return match ? Number.parseInt(match[1], 10) : null;
  }

  /**
   * The key the same bottling would carry at a different age.
   *
   * @param matchKey - The stored key.
   * @param age - The age to sign it with.
   * @returns The re-signed key.
   */
  private static rekey(matchKey: string, age: number): string {
    return matchKey.replace(KEY_AGE, `|a${age}`);
  }

  /**
   * The distinct ages a group's names state, smallest first.
   *
   * @param group - The bottling's offers.
   * @returns The stated ages, deduplicated.
   */
  private static statedAges(group: Group): number[] {
    const ages = group.offers
      .map((offer) => offer.stated)
      .filter((age): age is number => age !== null);

    return [...new Set(ages)].sort((a, b) => a - b);
  }

  /**
   * Loads every offer whose bottling has a decided identity, grouped by that
   * bottling, and reads the age each offer's name states.
   *
   * @param queryRunner - The migration's query runner.
   * @returns The groups, keyed by product id.
   */
  private static async load(
    queryRunner: QueryRunner,
  ): Promise<Map<string, Group>> {
    const normalizer = new NormalizeService();
    const rows = await queryRunner.query(`
      SELECT sp.id, sp."productId", sp."nameOrig", p."matchKey"
      FROM store_product sp
      JOIN product p ON p.id = sp."productId"
      WHERE p."matchKey" IS NOT NULL
    `) as OfferRow[];
    const groups = new Map<string, Group>();

    rows.forEach((row) => {
      const keyAge = AgeRegroupCyrillicYo1788282762781.keyAge(row.matchKey);

      if (keyAge === null) {
        return;
      }

      const group = groups.get(row.productId)
        ?? { matchKey: row.matchKey, keyAge, offers: [] };

      group.offers.push({
        id: row.id,
        stated: normalizer.extractAgeYears(row.nameOrig),
      });
      groups.set(row.productId, group);
    });

    return groups;
  }

  public name = 'AgeRegroupCyrillicYo1788282762781';

  /**
   * @param queryRunner - The query runner.
   * @returns Resolves once every bottling holds offers of a single age.
   * @throws {Error} When a bottling is still mixed after the repair.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const groups = await AgeRegroupCyrillicYo1788282762781.load(queryRunner);

    for (const [productId, group] of groups) {
      const stated = AgeRegroupCyrillicYo1788282762781.statedAges(group);

      if (stated.length > 1) {
        await this.split(queryRunner, productId, group);

        continue;
      }

      if (stated.length === 1 && stated[0] !== group.keyAge) {
        await this.settleSingleAge(queryRunner, productId, group, stated[0]);
      }
    }

    await this.assertNoMixedAges(queryRunner);
  }

  public async down(): Promise<void> {
    /**
     * Irreversible on purpose. Undoing it would put whiskies of different ages
     * back onto one bottling, and the links as they stood before the repair
     * were never recorded anywhere to restore from.
     */
  }

  /**
   * Moves each age-stating offer of a genuinely mixed bottling onto the
   * bottling carrying its age, creating that bottling when none exists.
   *
   * Offers whose name states no age are left where they are: the row they sit
   * on is the "no age stated" identity, which is all that is known about them.
   *
   * That row's own stored age goes with them. It was inherited from the merged
   * mess — the Dalmore row read 12 while carrying the 30 — and once every
   * age-stating offer has left, nothing supports it: a key signed `|a0` means
   * the age is unknown, so a plain `Dalmore` listed tomorrow would join the row
   * and be served as a 12 year old all over again. A curator's age is left
   * alone, being a decision rather than an inheritance.
   *
   * @param queryRunner - The migration's query runner.
   * @param productId - The mixed bottling.
   * @param group - Its offers and their stated ages.
   * @returns Resolves once every stated age has its own bottling.
   */
  private async split(
    queryRunner: QueryRunner,
    productId: string,
    group: Group,
  ): Promise<void> {
    for (const offer of group.offers) {
      if (offer.stated === null || offer.stated === group.keyAge) {
        continue;
      }

      const target = await this.ensureBottling(
        queryRunner,
        productId,
        AgeRegroupCyrillicYo1788282762781.rekey(group.matchKey, offer.stated),
        offer.stated,
      );

      await queryRunner.query(
        'UPDATE store_product SET "productId" = $1 WHERE id = $2',
        [target, offer.id],
      );
    }

    if (group.keyAge === 0) {
      await queryRunner.query(
        `UPDATE product SET age = NULL, "ageSource" = NULL
         WHERE id = $1 AND "ageSource" IS DISTINCT FROM $2`,
        [productId, FactSource.MANUAL],
      );
    }
  }

  /**
   * Settles a bottling whose offers agree on an age its key does not carry:
   * folded into the twin that already carries it, or — when there is no twin —
   * left where it is with the age recorded as a fact.
   *
   * @param queryRunner - The migration's query runner.
   * @param productId - The bottling to settle.
   * @param group - Its offers.
   * @param age - The age they agree on.
   * @returns Resolves once the bottling is settled.
   */
  private async settleSingleAge(
    queryRunner: QueryRunner,
    productId: string,
    group: Group,
    age: number,
  ): Promise<void> {
    const target = AgeRegroupCyrillicYo1788282762781.rekey(
      group.matchKey,
      age,
    );
    const twin = await this.findByKey(queryRunner, target);

    if (twin !== null) {
      await this.merge(queryRunner, productId, twin);

      return;
    }

    await this.stampAge(queryRunner, productId, age);
  }

  /**
   * Folds a bottling into the one that already carries its age.
   *
   * Both rows describe the same whisky, so the source's flavour links are
   * copied over rather than dropped — a tag is evidence for a flavour, never
   * against one — and a person's favourites and blacklist entries follow the
   * offers. The emptied source row is left in place: deleting it would cascade
   * those list entries away, and a bottling with no offers is a shape the
   * preference endpoints already render.
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
  }

  /**
   * Records an age the names state but the bottling never stored, leaving the
   * frozen key untouched.
   *
   * Written as `name`-sourced, the rank a value read out of a listing's title
   * carries, so a spec page or a curator still outranks it. A stored age is
   * never overwritten: filling a gap is evidence, replacing a decision is not
   * this migration's business.
   *
   * @param queryRunner - The migration's query runner.
   * @param productId - The bottling to stamp.
   * @param age - The age its offers agree on.
   * @returns Resolves once the age is recorded.
   */
  private async stampAge(
    queryRunner: QueryRunner,
    productId: string,
    age: number,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE product SET age = $1, "ageSource" = $2
       WHERE id = $3 AND age IS NULL`,
      [age, FactSource.NAME, productId],
    );
  }

  /**
   * Finds the bottling carrying a given key.
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
   * Returns the bottling carrying a key, creating it from the mixed row's own
   * facts when it does not exist.
   *
   * Everything but the age is copied: brand, type, country, strength, volume,
   * name, producer and their provenance all describe the expression, which the
   * split does not change. The age is written `name`-sourced, because a
   * listing's title is exactly where it was read.
   *
   * @param queryRunner - The migration's query runner.
   * @param sourceId - The mixed bottling to copy the facts from.
   * @param matchKey - The key the bottling must carry.
   * @param age - Its age.
   * @returns The product id carrying the key.
   */
  private async ensureBottling(
    queryRunner: QueryRunner,
    sourceId: string,
    matchKey: string,
    age: number,
  ): Promise<string> {
    const existing = await this.findByKey(queryRunner, matchKey);

    if (existing !== null) {
      return existing;
    }

    const rows = await queryRunner.query(
      `INSERT INTO product
         ("matchKey", name, "brandId", "typeId", "countryId", age, abv,
          "volumeMl", "producerId", "bottlerId", "nameSource", "brandSource",
          "typeSource", "countrySource", "ageSource", "abvSource",
          "volumeSource", "producerSource")
       SELECT $1, name, "brandId", "typeId", "countryId", $2, abv,
              "volumeMl", "producerId", "bottlerId", "nameSource",
              "brandSource", "typeSource", "countrySource", $3, "abvSource",
              "volumeSource", "producerSource"
       FROM product WHERE id = $4
       RETURNING id`,
      [matchKey, age, FactSource.NAME, sourceId],
    ) as { id: string }[];

    return rows[0].id;
  }

  /**
   * Fails the migration unless every bottling now holds offers of one age.
   *
   * This is the property the repair exists to establish, so it is checked
   * against the written rows rather than against the plan that wrote them.
   * The run is one transaction, so throwing rolls all of it back.
   *
   * @param queryRunner - The migration's query runner.
   * @returns Resolves when no bottling is mixed.
   * @throws {Error} Naming the first bottling that still is.
   */
  private async assertNoMixedAges(queryRunner: QueryRunner): Promise<void> {
    const groups = await AgeRegroupCyrillicYo1788282762781.load(queryRunner);

    for (const [productId, group] of groups) {
      const stated = AgeRegroupCyrillicYo1788282762781.statedAges(group);

      if (stated.length > 1) {
        throw new Error(
          `Age regroup aborted: product ${productId} (${group.matchKey}) `
            + `still holds offers stating ages ${stated.join(', ')}`,
        );
      }
    }
  }
}
