import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How two names are compared for identity — the same expression
 * `ProductRepository` uses at runtime, inlined because a migration is a
 * historical record and must keep applying the same change after the
 * repository moves on.
 *
 * @param expr - A SQL expression holding a name.
 * @returns The identity form of the name.
 */
const identityOf = (expr: string): string =>
  `lower(regexp_replace(${expr}, '[^[:alnum:]]+', '', 'g'))`;

/**
 * Every retail barcode a listing states, read out of its page URL and its raw
 * name: the Zakaz.ua networks end a product URL in `--0<EAN-13>`, Rozetka
 * writes the code both into the URL and in parentheses at the end of the
 * name, MauDau and others in parentheses only. A 13-digit run bounded by
 * non-digits, with the Zakaz leading zero allowed in front of it.
 */
const BARCODE_SQL = `
  SELECT DISTINCT sp."productId", m[1] AS ean
  FROM store_product sp,
       regexp_matches(
         sp.url || ' ' || sp."nameOrig",
         '(?:^|[^0-9])0?([0-9]{13})(?:[^0-9]|$)',
         'g'
       ) AS m
`;

/**
 * The barcodes that two or more bottlings currently claim between them.
 */
const SHARED_BARCODES_SQL = `
  WITH codes AS (${BARCODE_SQL})
  SELECT ean, array_agg("productId" ORDER BY "productId") AS ids
  FROM codes
  GROUP BY ean
  HAVING count(*) > 1
  ORDER BY ean
`;

/**
 * The bottlings that share an identity — name, volume and age — and are
 * therefore one whisky recorded more than once.
 */
const IDENTITY_GROUPS_SQL = `
  SELECT array_agg(id ORDER BY id) AS ids
  FROM product
  WHERE name IS NOT NULL
  GROUP BY ${identityOf('name')}, "volumeMl", age
  HAVING count(*) > 1
  ORDER BY min(id::text)
`;

/**
 * The rows of one group, best survivor first: a name a person set, then the
 * most listed, then the most in stock, then a row that still holds a key,
 * then the oldest. The ordering is the whole rule for which row a group
 * keeps.
 */
const RANKED_ROWS_SQL = `
  SELECT p.id, p.name, p."matchKey", p."volumeMl", p.age,
         ${identityOf('p.name')} AS identity,
         (SELECT count(*) FROM store_product sp
          WHERE sp."productId" = p.id)::int AS offers
  FROM product p
  WHERE p.id = ANY($1::uuid[])
  ORDER BY COALESCE(p."nameSource" = 'manual', false) DESC,
           offers DESC,
           (SELECT count(*) FROM store_product sp
            WHERE sp."productId" = p.id AND sp."inStock") DESC,
           (p."matchKey" IS NOT NULL) DESC,
           p."createdAt", p.id
`;

/**
 * A single bottling addressed by its identity, for the curated Arran steps.
 */
const BY_IDENTITY_SQL = `
  SELECT id FROM product
  WHERE name IS NOT NULL
    AND ${identityOf('name')} = ${identityOf('$1::text')}
    AND "volumeMl" IS NOT DISTINCT FROM $2::int
    AND age IS NOT DISTINCT FROM $3::int
  ORDER BY "createdAt", id
`;

/**
 * Whether the vanishing row's value for a fact replaces the survivor's: a gap
 * is filled, a better-trusted source wins, a person's value on the survivor
 * is never touched. `FACT_SOURCE_RANK` as of this migration, inlined.
 *
 * @param column - The fact column.
 * @param source - Its provenance column.
 * @returns A SQL boolean over aliases `k` (kept) and `l` (lost).
 */
const loserWins = (column: string, source: string): string => {
  const rank = (expr: string): string =>
    `CASE ${expr} WHEN 'manual' THEN 60 WHEN 'kb' THEN 50 WHEN 'store' THEN 40
      WHEN 'name' THEN 30 WHEN 'llm' THEN 20 WHEN 'legacy' THEN 10
      ELSE 0 END`;

  return `l."${column}" IS NOT NULL
    AND k."${source}" IS DISTINCT FROM 'manual'
    AND (k."${column}" IS NULL OR ${rank(`l."${source}"`)} > ${
    rank(`k."${source}"`)
  })`;
};

/**
 * The identity fields move only when a person set them on the vanishing row:
 * a null age is a NAS bottling, not a gap.
 *
 * @param source - The provenance column of the identity field.
 * @returns A SQL boolean over aliases `k` and `l`.
 */
const loserDecides = (source: string): string =>
  `l."${source}" = 'manual' AND k."${source}" IS DISTINCT FROM 'manual'`;

/**
 * Assigns a fact and its provenance together from whichever side the rule
 * picked.
 *
 * @param column - The fact column.
 * @param source - Its provenance column.
 * @param wins - The SQL boolean deciding for the vanishing row.
 * @returns The two `SET` assignments, comma-separated.
 */
const pick = (column: string, source: string, wins: string): string =>
  `"${column}" = CASE WHEN ${wins} THEN l."${column}" ELSE k."${column}" END,
   "${source}" = CASE WHEN ${wins} THEN l."${source}" ELSE k."${source}" END`;

const PRODUCER_WINS_SQL = `
  ((l."producerSource" = 'manual'
      AND k."producerSource" IS DISTINCT FROM 'manual')
    OR (k."producerId" IS NULL AND l."producerId" IS NOT NULL
      AND k."producerSource" IS DISTINCT FROM 'manual'))`;

/**
 * Folds the facts of a vanishing bottling (`$2`) into the survivor (`$1`).
 * Verbatim what `ProductRepository.mergeInto` does at runtime as of this
 * migration.
 */
const MERGE_FACTS_SQL = `
  UPDATE product k SET
    ${pick('name', 'nameSource', loserDecides('nameSource'))},
    ${pick('age', 'ageSource', loserDecides('ageSource'))},
    ${pick('volumeMl', 'volumeSource', loserDecides('volumeSource'))},
    ${pick('abv', 'abvSource', loserWins('abv', 'abvSource'))},
    ${pick('typeId', 'typeSource', loserWins('typeId', 'typeSource'))},
    ${
  pick('countryId', 'countrySource', loserWins('countryId', 'countrySource'))
},
    "producerId" = CASE WHEN ${PRODUCER_WINS_SQL}
      THEN l."producerId" ELSE k."producerId" END,
    "bottlerId" = CASE WHEN ${PRODUCER_WINS_SQL}
      THEN l."bottlerId" ELSE k."bottlerId" END,
    "producerSource" = CASE WHEN ${PRODUCER_WINS_SQL}
      THEN l."producerSource" ELSE k."producerSource" END,
    "brandOrig" = COALESCE(k."brandOrig", l."brandOrig"),
    "lastLlmFlavorAt" = GREATEST(k."lastLlmFlavorAt", l."lastLlmFlavorAt"),
    "flavorsCuratedAt" = GREATEST(k."flavorsCuratedAt", l."flavorsCuratedAt"),
    "updatedAt" = now()
  FROM product l
  WHERE k.id = $1 AND l.id = $2
`;

/**
 * A tag both rows carry keeps the better-trusted source.
 */
const MERGE_FLAVORS_SQL = `
  INSERT INTO product_flavor ("productId", "flavorId", source)
  SELECT $1, "flavorId", source FROM product_flavor WHERE "productId" = $2
  ON CONFLICT ("productId", "flavorId") DO UPDATE SET
    source = CASE
      WHEN (CASE EXCLUDED.source WHEN 'manual' THEN 40 WHEN 'kb' THEN 30
            WHEN 'llm' THEN 20 WHEN 'scrape' THEN 10 ELSE 0 END)
        > (CASE product_flavor.source WHEN 'manual' THEN 40 WHEN 'kb' THEN 30
            WHEN 'llm' THEN 20 WHEN 'scrape' THEN 10 ELSE 0 END)
      THEN EXCLUDED.source ELSE product_flavor.source END
`;

const MERGE_CONFLICTS_SQL = `
  INSERT INTO product_fact_conflict
    ("productId", "storeId", attribute, "storedValue", "claimedValue",
     "storedSource", "seenCount", "firstSeenAt", "lastSeenAt", "resolvedAt")
  SELECT $1, "storeId", attribute, "storedValue", "claimedValue",
         "storedSource", "seenCount", "firstSeenAt", "lastSeenAt", "resolvedAt"
  FROM product_fact_conflict WHERE "productId" = $2
  ON CONFLICT ("productId", "storeId", attribute) DO UPDATE SET
    "seenCount" = product_fact_conflict."seenCount" + EXCLUDED."seenCount",
    "firstSeenAt" = LEAST(product_fact_conflict."firstSeenAt",
                          EXCLUDED."firstSeenAt"),
    "lastSeenAt" = GREATEST(product_fact_conflict."lastSeenAt",
                            EXCLUDED."lastSeenAt")
`;

/**
 * Words that say what a whisky is rather than which one, dropped before two
 * names are compared as token sets in the barcode pass. Numbers are **kept**
 * whatever their length — `Hyde №3` and `Hyde №4` differ by exactly one
 * digit, and dropping it would fold them.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'віскі',
  'виски',
  'whisky',
  'whiskey',
  'scotch',
  'single',
  'malt',
  'blend',
  'blended',
  'the',
  'of',
  'and',
  'gift',
  'box',
  'gb',
  'set',
  'tube',
]);

/**
 * A row of one merge group, as {@link RANKED_ROWS_SQL} returns it.
 */
interface GroupRow {
  /**
   * The `product` row id.
   */
  id: string;

  /**
   * Its display name.
   */
  name: string | null;

  /**
   * Its frozen key, or null.
   */
  matchKey: string | null;

  /**
   * Its volume, or null.
   */
  volumeMl: number | null;

  /**
   * Its age, or null for NAS.
   */
  age: number | null;

  /**
   * The identity form of the name.
   */
  identity: string | null;

  /**
   * How many offers it holds.
   */
  offers: number;
}

/**
 * The catalogue-wide totals a merge must leave untouched.
 */
interface Footprint {
  /**
   * Store offers.
   */
  offers: number;

  /**
   * Price snapshots.
   */
  snapshots: number;

  /**
   * Collection purchases.
   */
  purchases: number;
}

/**
 * What one pass did, for the run's summary.
 */
interface PassReport {
  /**
   * Groups the pass acted on.
   */
  groups: number;

  /**
   * Bottlings folded away.
   */
  merged: number;

  /**
   * Offers that changed bottling.
   */
  movedOffers: number;

  /**
   * Groups the pass refused, with the reason.
   */
  skipped: string[];
}

/**
 * Folds the catalogue's duplicate bottlings together, once, from what the
 * data says rather than from a shipped list of ids.
 *
 * The catalogue held the same whisky under several rows for three separate
 * reasons, all of them consequences of a match key that is frozen when a row
 * is created and never re-derived. The brand token in the key varies with how
 * a shop spells a maker, so `William Peel` was signed `peelwilliam` by one
 * store and `peelwilliamwilliampeel` by another; an age a shop wrote in a
 * way the reader missed put `Aberlour 12` under `|a0` while ten other shops
 * put it under `|a12`; and a row renamed by hand keeps the key of the name it
 * used to have, so `Arran Amarone Casc` never met `Arran Amarone Cask`. The
 * runtime now closes every one of these doors — an edit merges the row it
 * makes identical with an existing one, a new listing is matched by identity
 * when its key is unknown, and a retired key is kept as an alias — and this
 * migration repairs what those doors let in before.
 *
 * Five steps, in this order:
 *
 * 1. **Spelling.** `Casc` becomes `Cask` in every display name (one row).
 * 2. **Arran.** The curated corrections the generic passes cannot make on
 *    their own: a goodwine `Arran 10yo` gift set that a hand-rename had
 *    filed under the Amarone group goes back to `Arran 10`; the renamed
 *    Amarone row sheds the age and strength somebody set on it by mistake
 *    (an Amarone Cask is NAS at 50 %) and folds into the real Amarone Cask
 *    row, whose barcode its own listings carry; `Arran Bodega Sherry Cask`
 *    folds into `Arran Sherry Cask` and `Arran Malt Sauternes` into
 *    `Arran Sauternes Cask`, choosing the survivor by name rather than by
 *    offer count; and `Machrie Moor` takes the `Arran` prefix every other
 *    Arran expression has. Every step is addressed by identity and by URL,
 *    never by id, and is a no-op on a catalogue that lacks the row.
 * 3. **Identity.** Rows with one name, volume and age are one bottling: 85
 *    groups on the 2026-09-06 dump, 41 of the folded rows already holding no
 *    offers at all (left behind by earlier regroups).
 * 4. **Barcode.** Rows whose listings state one retail barcode are one
 *    bottling. Two shops rarely disagree about a barcode, and where the
 *    names also agree the case is closed; where they differ the pass still
 *    requires one name's significant words to be a subset of the other's,
 *    which is what keeps `Clan Denny Islay` apart from `Clan Denny Speyside`
 *    and `Hyde №3` from `Hyde №4` — the handful of barcodes a shop has
 *    plainly reused — while folding `Isle of Jura` into `Jura`, `Restless
 *    Pony Original` into `Restless Pony` and `Tamnavulin Speyside` into
 *    `Tamnavulin`. Volumes must agree; ages need not, since the rozetka
 *    habit of stating the legal minimum (`Red Label витримка 4 роки`) is the
 *    main way one barcode came to hold two ages.
 * 5. **Orphans.** A bottling with no offer, no favorite, no blacklist entry
 *    and no collection row is deleted — nothing refers to it and nothing can
 *    be lost.
 *
 * A merge keeps the row a person named, else the most listed; the survivor's
 * facts are filled by the trust rules the canonical write uses (a `manual`
 * value on the vanishing row wins, otherwise a gap fills and a better source
 * replaces a worse one), and — unlike every earlier regroup — **the vanishing
 * row is deleted**. Its offers, flavor links, conflicts and every user's
 * favorite, blacklist and collection entry move first, guarded per user, and
 * its key is retired into `product_match_alias` so the next listing spelled
 * that way lands on the survivor. Keeping the empty rows, as the earlier
 * repairs did, is what left 51 orphans answering searches and identity
 * lookups.
 *
 * The run is one transaction that asserts before it commits: the offer,
 * snapshot and purchase totals are unchanged, no identity twins remain, and
 * no alias key is still held by a live row. `down()` is a documented no-op —
 * undoing it would put one whisky back under several rows, and the links as
 * they stood were never recorded anywhere to restore from.
 */
export class ProductDuplicateMerge1788723300000 implements MigrationInterface {
  /**
   * The significant words of a name, for the barcode pass's subset test.
   *
   * @param name - A display name.
   * @returns Lower-cased, diacritic-free words with the stop words removed.
   */
  public static tokens(name: string): Set<string> {
    const folded = name
      .normalize('NFD')
      .replace(/([A-Za-z])[̀-ͯ]+/g, '$1')
      .normalize('NFC')
      .toLowerCase()
      .replace(/['’‘ʼ`´]/g, '');

    return new Set(
      folded
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length > 0 && !STOP_WORDS.has(token)),
    );
  }

  /**
   * Whether two names can be one whisky under the barcode pass: both carry
   * at least one significant word, and one's words are all among the other's.
   *
   * @param left - One display name.
   * @param right - The other display name.
   * @returns True when the names are compatible.
   */
  public static compatible(left: string, right: string): boolean {
    const a = ProductDuplicateMerge1788723300000.tokens(left);
    const b = ProductDuplicateMerge1788723300000.tokens(right);

    if (a.size === 0 || b.size === 0) {
      return false;
    }

    const [small, large] = a.size <= b.size ? [a, b] : [b, a];

    return [...small].every((token) => large.has(token));
  }

  public name = 'ProductDuplicateMerge1788723300000';

  /**
   * Redirects for bottlings this run has already folded away, so a later
   * group that still names one of them acts on its survivor.
   */
  private readonly redirects = new Map<string, string>();

  /**
   * @param queryRunner - The query runner.
   * @returns Resolves once the catalogue holds each whisky once.
   * @throws {Error} When an invariant fails, which rolls the whole run back.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    const before = await this.footprint(queryRunner);

    const spelled = await this.fixCaskSpelling(queryRunner);
    const arran = await this.curateArran(queryRunner);
    const identity = await this.mergeIdentityGroups(queryRunner);
    const barcode = await this.mergeBarcodeGroups(queryRunner);
    const orphans = await this.sweepOrphans(queryRunner);

    await this.assertInvariants(queryRunner, before);

    const lines = [
      `product-duplicate-merge: ${spelled} name(s) respelled`,
      ...arran.map((line) => `product-duplicate-merge: arran: ${line}`),
      `product-duplicate-merge: identity: ${this.describe(identity)}`,
      `product-duplicate-merge: barcode: ${this.describe(barcode)}`,
      ...barcode.skipped.map((line) =>
        `product-duplicate-merge: barcode skipped: ${line}`
      ),
      `product-duplicate-merge: ${orphans} orphan bottling(s) deleted`,
    ];

    lines.forEach((line) => {
      console.log(line);
    });
  }

  public async down(): Promise<void> {
    /**
     * Irreversible on purpose. Undoing it would put one whisky back under
     * several rows, and the links as they stood before the repair were never
     * recorded anywhere to restore from.
     */
  }

  /**
   * Corrects the `Casc` misspelling in display names.
   *
   * @param queryRunner - The migration's query runner.
   * @returns How many names changed.
   */
  private async fixCaskSpelling(queryRunner: QueryRunner): Promise<number> {
    const result = await queryRunner.query(
      `UPDATE product
       SET name = regexp_replace(name, '\\mCasc\\M', 'Cask', 'g'),
           "nameSource" = 'manual', "updatedAt" = now()
       WHERE name ~ '\\mCasc\\M'`,
    ) as [unknown[], number];

    return result[1];
  }

  /**
   * The curated Arran corrections, each a no-op when the catalogue lacks the
   * row it names.
   *
   * @param queryRunner - The migration's query runner.
   * @returns One line per correction made.
   */
  private async curateArran(queryRunner: QueryRunner): Promise<string[]> {
    const lines: string[] = [];

    const moved = await this.moveGoodwineArranSet(queryRunner);

    if (moved) {
      lines.push('goodwine Arran 10yo gift set moved back to Arran 10');
    }

    const amarone = await this.foldByIdentity(
      queryRunner,
      { name: 'Arran Amarone Cask', volumeMl: 700, age: 10 },
      { name: 'Arran Amarone Cask', volumeMl: 700, age: null },
      { clearAgeAndAbv: true, keepAlias: false },
    );

    if (amarone) {
      lines.push(
        `renamed Amarone row folded into Arran Amarone Cask (${amarone})`,
      );
    }

    const bodega = await this.foldByIdentity(
      queryRunner,
      { name: 'Arran Bodega Sherry Cask', volumeMl: 700, age: null },
      { name: 'Arran Sherry Cask', volumeMl: 700, age: null },
      { clearAgeAndAbv: false, keepAlias: true },
    );

    if (bodega) {
      lines.push(
        `Arran Bodega Sherry Cask folded into Arran Sherry Cask (${bodega})`,
      );
    }

    const sauternes = await this.foldByIdentity(
      queryRunner,
      { name: 'Arran Malt Sauternes', volumeMl: 700, age: null },
      { name: 'Arran Sauternes Cask', volumeMl: 700, age: null },
      { clearAgeAndAbv: false, keepAlias: true },
    );

    if (sauternes) {
      lines.push(
        `Arran Malt Sauternes folded into Arran Sauternes Cask (${sauternes})`,
      );
    }

    const renamed = await queryRunner.query(
      `UPDATE product
       SET name = 'Arran Machrie Moor', "nameSource" = 'manual',
           "updatedAt" = now()
       WHERE name IS NOT NULL
         AND ${identityOf('name')} = ${identityOf("'Machrie Moor'")}`,
    ) as [unknown[], number];

    if (renamed[1] > 0) {
      lines.push(
        `${renamed[1]} Machrie Moor row(s) renamed Arran Machrie Moor`,
      );
    }

    return lines;
  }

  /**
   * Returns goodwine's `Arran 10yo + 2 glasses` set to the `Arran 10`
   * bottling. Its raw name is the bare `Віскі, 0.7 л`, so nothing about it
   * could ever be matched; the page URL is the only thing that states what
   * it is.
   *
   * @param queryRunner - The migration's query runner.
   * @returns True when an offer was moved.
   */
  private async moveGoodwineArranSet(
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const targets = await queryRunner.query(BY_IDENTITY_SQL, [
      'Arran',
      700,
      10,
    ]) as { id: string }[];

    const target = targets[0];

    if (!target) {
      return false;
    }

    const result = await queryRunner.query(
      `UPDATE store_product sp
       SET "productId" = $1, "updatedAt" = now()
       FROM store st
       WHERE st.id = sp."storeId" AND st.slug = 'goodwine'
         AND sp.url LIKE '%nabir-viski-arran-10yo%'
         AND sp."productId" <> $1`,
      [target.id],
    ) as [unknown[], number];

    return result[1] > 0;
  }

  /**
   * Folds one bottling, addressed by identity, into another.
   *
   * @param queryRunner - The migration's query runner.
   * @param from - The identity of the bottling to fold away.
   * @param into - The identity of the bottling to keep.
   * @param options - `clearAgeAndAbv` drops the vanishing row's age and
   *   strength first, for a row where a person set both wrongly;
   *   `keepAlias: false` retires the vanishing row's key without leaving it
   *   pointing at the survivor — for a row whose key names a *wider* identity
   *   than the survivor (`arran|v700|a0` is any ageless Arran, not the
   *   Amarone Cask), so that a listing keyed like it becomes a new row for a
   *   person to place rather than an Amarone Cask by default.
   * @returns How many offers moved, or null when either row is absent.
   */
  private async foldByIdentity(
    queryRunner: QueryRunner,
    from: { name: string; volumeMl: number; age: number | null },
    into: { name: string; volumeMl: number; age: number | null },
    options: { clearAgeAndAbv: boolean; keepAlias: boolean },
  ): Promise<number | null> {
    const losers = await queryRunner.query(BY_IDENTITY_SQL, [
      from.name,
      from.volumeMl,
      from.age,
    ]) as { id: string }[];

    const survivors = await queryRunner.query(BY_IDENTITY_SQL, [
      into.name,
      into.volumeMl,
      into.age,
    ]) as { id: string }[];

    const loser = losers[0];
    const survivor = survivors[0];

    if (!loser || !survivor || loser.id === survivor.id) {
      return null;
    }

    if (options.clearAgeAndAbv) {
      await queryRunner.query(
        `UPDATE product
         SET age = NULL, "ageSource" = NULL, abv = NULL, "abvSource" = NULL
         WHERE id = $1`,
        [loser.id],
      );
    }

    const keys = await queryRunner.query(
      'SELECT "matchKey" FROM product WHERE id = $1',
      [loser.id],
    ) as { matchKey: string | null }[];

    const moved = await this.merge(queryRunner, loser.id, survivor.id);

    if (!options.keepAlias && keys[0]?.matchKey) {
      await queryRunner.query(
        'DELETE FROM product_match_alias WHERE key = $1',
        [keys[0].matchKey],
      );
    }

    return moved;
  }

  /**
   * Folds every group of rows that share a name, volume and age.
   *
   * @param queryRunner - The migration's query runner.
   * @returns What the pass did.
   */
  private async mergeIdentityGroups(
    queryRunner: QueryRunner,
  ): Promise<PassReport> {
    const groups = await queryRunner.query(IDENTITY_GROUPS_SQL) as {
      ids: string[];
    }[];

    const report = this.emptyReport();

    for (const group of groups) {
      const rows = await this.ranked(queryRunner, group.ids);

      await this.foldGroup(queryRunner, rows, report);
    }

    return report;
  }

  /**
   * Folds every group of rows whose listings share a retail barcode, where
   * the names allow it.
   *
   * @param queryRunner - The migration's query runner.
   * @returns What the pass did, including the groups it refused.
   */
  private async mergeBarcodeGroups(
    queryRunner: QueryRunner,
  ): Promise<PassReport> {
    const groups = await queryRunner.query(SHARED_BARCODES_SQL) as {
      ean: string;
      ids: string[];
    }[];

    const report = this.emptyReport();

    for (const group of groups) {
      const rows = await this.ranked(queryRunner, group.ids);
      const [survivor, ...rest] = rows;

      if (!survivor || !rest.length) {
        continue;
      }

      const eligible = rest.filter((row) =>
        this.sameVolume(survivor, row)
        && this.compatibleNames(survivor, row)
      );

      rest
        .filter((row) => !eligible.includes(row))
        .forEach((row) => {
          report.skipped.push(
            `${group.ean}: "${survivor.name ?? ''}" vs "${row.name ?? ''}"`,
          );
        });

      await this.foldGroup(queryRunner, [survivor, ...eligible], report);
    }

    return report;
  }

  /**
   * Whether two rows state the same, known volume.
   *
   * @param left - One row.
   * @param right - The other.
   * @returns True when the volumes are equal and not null.
   */
  private sameVolume(left: GroupRow, right: GroupRow): boolean {
    return left.volumeMl !== null && left.volumeMl === right.volumeMl;
  }

  /**
   * Whether two rows' names allow a barcode merge: equal as identities, or
   * one a subset of the other's significant words.
   *
   * @param left - One row.
   * @param right - The other.
   * @returns True when the names are compatible.
   */
  private compatibleNames(left: GroupRow, right: GroupRow): boolean {
    if (left.name === null || right.name === null) {
      return false;
    }

    if (left.identity !== null && left.identity === right.identity) {
      return true;
    }

    return ProductDuplicateMerge1788723300000.compatible(
      left.name,
      right.name,
    );
  }

  /**
   * Folds every row of a ranked group into its first row.
   *
   * @param queryRunner - The migration's query runner.
   * @param rows - The group, survivor first.
   * @param report - The pass report to add to (mutated).
   * @returns Resolves once the group is one row.
   */
  private async foldGroup(
    queryRunner: QueryRunner,
    rows: GroupRow[],
    report: PassReport,
  ): Promise<void> {
    const [survivor, ...rest] = rows;

    if (!survivor || !rest.length) {
      return;
    }

    report.groups += 1;

    for (const row of rest) {
      report.movedOffers += await this.merge(queryRunner, row.id, survivor.id);
      report.merged += 1;
    }
  }

  /**
   * Loads a group's rows, survivor first, following the redirects of rows an
   * earlier group already folded away and dropping the duplicates that leaves.
   *
   * @param queryRunner - The migration's query runner.
   * @param ids - The group's product ids as planned.
   * @returns The live rows, best survivor first.
   */
  private async ranked(
    queryRunner: QueryRunner,
    ids: string[],
  ): Promise<GroupRow[]> {
    const live = [...new Set(ids.map((id) => this.resolve(id)))];

    return queryRunner.query(RANKED_ROWS_SQL, [live]) as Promise<GroupRow[]>;
  }

  /**
   * Follows the redirects to the row that holds a folded bottling now.
   *
   * @param id - A product id as it was planned.
   * @returns The id it resolves to.
   */
  private resolve(id: string): string {
    let current = id;
    let next = this.redirects.get(current);

    while (next !== undefined) {
      current = next;
      next = this.redirects.get(current);
    }

    return current;
  }

  /**
   * Folds one bottling into another and deletes it — the runtime merge as of
   * this migration, inlined.
   *
   * @param queryRunner - The migration's query runner.
   * @param loserId - The bottling to fold away.
   * @param survivorId - The bottling to keep.
   * @returns How many offers moved.
   */
  private async merge(
    queryRunner: QueryRunner,
    loserId: string,
    survivorId: string,
  ): Promise<number> {
    const rows = await queryRunner.query(
      `SELECT id, "matchKey", "flavorsCuratedAt" IS NOT NULL AS curated
       FROM product WHERE id = ANY($1::uuid[])`,
      [[loserId, survivorId]],
    ) as { id: string; matchKey: string | null; curated: boolean }[];

    const loser = rows.find((row) => row.id === loserId);
    const survivor = rows.find((row) => row.id === survivorId);

    if (!loser || !survivor) {
      throw new Error(`Merge of ${loserId} into ${survivorId}: row missing`);
    }

    await queryRunner.query(MERGE_FACTS_SQL, [survivorId, loserId]);

    if (loser.curated && !survivor.curated) {
      await queryRunner.query(
        'DELETE FROM product_flavor WHERE "productId" = $1',
        [survivorId],
      );
    }

    await queryRunner.query(MERGE_FLAVORS_SQL, [survivorId, loserId]);
    await queryRunner.query(MERGE_CONFLICTS_SQL, [survivorId, loserId]);

    const moved = await queryRunner.query(
      `UPDATE store_product SET "productId" = $1, "updatedAt" = now()
       WHERE "productId" = $2`,
      [survivorId, loserId],
    ) as [unknown[], number];

    await this.moveUserLists(queryRunner, loserId, survivorId);
    await this.moveCollection(queryRunner, loserId, survivorId);
    await this.retireKey(queryRunner, loser, survivor);
    await queryRunner.query('DELETE FROM product WHERE id = $1', [loserId]);

    this.redirects.set(loserId, survivorId);

    return moved[1];
  }

  /**
   * Re-points every user's favorite and blacklist entries, guarded per user
   * so the composite keys hold; an entry the user already has on the survivor
   * is dropped with the vanishing row.
   *
   * @param queryRunner - The migration's query runner.
   * @param loserId - The bottling being folded away.
   * @param survivorId - The bottling to keep.
   * @returns Resolves once both lists point at the survivor.
   */
  private async moveUserLists(
    queryRunner: QueryRunner,
    loserId: string,
    survivorId: string,
  ): Promise<void> {
    for (const table of ['favorite', 'blacklist_product']) {
      await queryRunner.query(
        `UPDATE ${table} x SET "productId" = $1
         WHERE x."productId" = $2
           AND NOT EXISTS (
             SELECT 1 FROM ${table} kept
             WHERE kept."userId" = x."userId" AND kept."productId" = $1
           )`,
        [survivorId, loserId],
      );

      await queryRunner.query(
        `DELETE FROM ${table} WHERE "productId" = $1`,
        [loserId],
      );
    }
  }

  /**
   * Moves every user's collection rows onto the survivor; a user holding both
   * bottlings keeps the survivor's row and gains the other's purchases.
   *
   * @param queryRunner - The migration's query runner.
   * @param loserId - The bottling being folded away.
   * @param survivorId - The bottling to keep.
   * @returns Resolves once no collection row names the vanishing bottling.
   */
  private async moveCollection(
    queryRunner: QueryRunner,
    loserId: string,
    survivorId: string,
  ): Promise<void> {
    await queryRunner.query(
      `UPDATE user_collection_purchase p
       SET "collectionId" = k.id, "updatedAt" = now()
       FROM user_collection l
       JOIN user_collection k
         ON k."userId" = l."userId" AND k."productId" = $1
       WHERE p."collectionId" = l.id AND l."productId" = $2`,
      [survivorId, loserId],
    );

    await queryRunner.query(
      `DELETE FROM user_collection l
       WHERE l."productId" = $2
         AND EXISTS (
           SELECT 1 FROM user_collection k
           WHERE k."userId" = l."userId" AND k."productId" = $1
         )`,
      [survivorId, loserId],
    );

    await queryRunner.query(
      `UPDATE user_collection SET "productId" = $1, "updatedAt" = now()
       WHERE "productId" = $2`,
      [survivorId, loserId],
    );
  }

  /**
   * Hands the vanishing row's keys to the survivor: its aliases are
   * re-pointed, and its own key is adopted when the survivor has none or
   * retired into an alias otherwise.
   *
   * @param queryRunner - The migration's query runner.
   * @param loser - The bottling being folded away, with its key.
   * @param survivor - The bottling to keep, with its key.
   * @returns Resolves once every key the loser held resolves to the survivor.
   */
  private async retireKey(
    queryRunner: QueryRunner,
    loser: { id: string; matchKey: string | null },
    survivor: { id: string; matchKey: string | null },
  ): Promise<void> {
    await queryRunner.query(
      'UPDATE product_match_alias SET "productId" = $1 WHERE "productId" = $2',
      [survivor.id, loser.id],
    );

    if (loser.matchKey === null) {
      return;
    }

    await queryRunner.query(
      'UPDATE product SET "matchKey" = NULL WHERE id = $1',
      [loser.id],
    );

    if (survivor.matchKey === null) {
      await queryRunner.query(
        'UPDATE product SET "matchKey" = $1 WHERE id = $2',
        [loser.matchKey, survivor.id],
      );

      return;
    }

    await queryRunner.query(
      `INSERT INTO product_match_alias (key, "productId") VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET "productId" = EXCLUDED."productId"`,
      [loser.matchKey, survivor.id],
    );
  }

  /**
   * Deletes every bottling nothing refers to.
   *
   * @param queryRunner - The migration's query runner.
   * @returns How many rows went.
   */
  private async sweepOrphans(queryRunner: QueryRunner): Promise<number> {
    const result = await queryRunner.query(
      `DELETE FROM product p
       WHERE NOT EXISTS (SELECT 1 FROM store_product sp
                         WHERE sp."productId" = p.id)
         AND NOT EXISTS (SELECT 1 FROM user_collection c
                         WHERE c."productId" = p.id)
         AND NOT EXISTS (SELECT 1 FROM favorite f WHERE f."productId" = p.id)
         AND NOT EXISTS (SELECT 1 FROM blacklist_product b
                         WHERE b."productId" = p.id)`,
    ) as [unknown[], number];

    return result[1];
  }

  /**
   * Reads the totals the run must leave untouched.
   *
   * @param queryRunner - The migration's query runner.
   * @returns The offer, snapshot and purchase counts.
   */
  private async footprint(queryRunner: QueryRunner): Promise<Footprint> {
    const rows = await queryRunner.query(
      `SELECT (SELECT count(*) FROM store_product)::int AS offers,
              (SELECT count(*) FROM price_snapshot)::int AS snapshots,
              (SELECT count(*) FROM user_collection_purchase)::int
                AS purchases`,
    ) as Footprint[];

    return rows[0];
  }

  /**
   * Checks the run's invariants, throwing so the transaction rolls back.
   *
   * @param queryRunner - The migration's query runner.
   * @param before - The totals read before the run.
   * @returns Resolves when every invariant holds.
   * @throws {Error} When one does not.
   */
  private async assertInvariants(
    queryRunner: QueryRunner,
    before: Footprint,
  ): Promise<void> {
    const after = await this.footprint(queryRunner);

    if (
      after.offers !== before.offers
      || after.snapshots !== before.snapshots
      || after.purchases !== before.purchases
    ) {
      throw new Error(
        `Duplicate merge aborted: footprint changed from ${
          JSON.stringify(before)
        } to ${JSON.stringify(after)}`,
      );
    }

    const twins = await queryRunner.query(IDENTITY_GROUPS_SQL) as unknown[];

    if (twins.length) {
      throw new Error(
        `Duplicate merge aborted: ${twins.length} identity group(s) remain`,
      );
    }

    const clashes = await queryRunner.query(
      `SELECT count(*)::int AS n FROM product_match_alias a
       JOIN product p ON p."matchKey" = a.key`,
    ) as { n: number }[];

    if (clashes[0]?.n) {
      throw new Error(
        `Duplicate merge aborted: ${clashes[0].n} alias key(s) still live`,
      );
    }
  }

  /**
   * A fresh pass report.
   *
   * @returns All counters at zero.
   */
  private emptyReport(): PassReport {
    return { groups: 0, merged: 0, movedOffers: 0, skipped: [] };
  }

  /**
   * One line summarising a pass.
   *
   * @param report - The pass report.
   * @returns The summary.
   */
  private describe(report: PassReport): string {
    return `${report.groups} group(s), ${report.merged} bottling(s) folded, `
      + `${report.movedOffers} offer(s) moved`;
  }
}
