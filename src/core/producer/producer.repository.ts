import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { KbStatus } from '~enums';
import {
  ID,
  KbAliasEntry,
  KbFlavorRule,
  KbPeatFlavorIds,
  KbProducerFacts,
  KbProducerFlavor,
  ProducerChildRow,
  ProducerReviewRow,
  ProducerRuleInput,
  ProducerRuleRow,
  ResearchedProducer,
  UnresearchedBrandRow,
  UnresolvedBrandRow,
} from '~types';

import { ProducerEntity } from './producer.entity';

import type { ProducerReviewPatch } from './producer-review.interfaces';
import type { KbAliasRow, KbFlavorRuleRow } from './producer.interfaces';

/**
 * Loads the alias match index, each alias carrying its producer's facts.
 *
 * Only `verified` and `auto` rows take part: an `unverified` row is either
 * awaiting review or a recorded dead end, and either way must not reach a
 * product. That filter is the whole safety gate between research output and
 * the catalogue.
 *
 * Ordered longest key first so a caller can take the first match and get the
 * most specific one — the same technique `detectBrandFromName` uses, and the
 * reason `Highland Park` wins over `Highland`.
 */
const ALIAS_INDEX_SQL = `
  SELECT a.key, a.scope,
         p.id, p.slug, p.name, p.kind, p."countryId", p.region,
         p."legalRegion", p."parentId", p."bottlerId", p."defaultTypeName",
         p."peatProfile"
  FROM producer_alias a
  JOIN producer p ON p.id = a."producerId"
  WHERE p.status = ANY($1::text[])
  ORDER BY length(a.key) DESC, a.key
`;

/**
 * Loads one producer's rules, resolved to readable labels, for the review
 * screen. Unlike {@link RULES_SQL} this is a display read: it joins the
 * flavour's name and carries the citations and the note.
 */
const RULE_ROWS_SQL = `
  SELECT r.id, r.pattern, r."matchMode", f.name AS "flavorName", r.effect,
         r."peatProfile", r.priority, r."sourceUrls", r.note
  FROM flavor_rule r
  LEFT JOIN flavor f ON f.id = r."flavorId"
  WHERE r."producerId" = $1
  ORDER BY r.priority DESC, r.pattern
`;

/**
 * The rules that apply to every producer, peat only.
 *
 * A reviewer judging a peat band has to know that `unpeated` in a name beats
 * any band the row carries, and that a bare `peated` is read as heavy. The tag
 * rules are deliberately left out: they say nothing about the value under
 * review.
 */
const GLOBAL_PEAT_RULE_ROWS_SQL = `
  SELECT r.id, r.pattern, r."matchMode", NULL AS "flavorName", r.effect,
         r."peatProfile", r.priority, r."sourceUrls", r.note
  FROM flavor_rule r
  WHERE r."producerId" IS NULL AND r."peatProfile" IS NOT NULL
  ORDER BY r.priority DESC, r.pattern
`;

/**
 * Loads every name-pattern rule. Both the global rules and the
 * producer-scoped ones come back in one read — the set is small enough
 * (~120 rows) that splitting it would buy nothing.
 *
 * Ordered so the winning peat rule is the first match a caller finds:
 * priority descending, then the longer pattern, then producer-scoped ahead of
 * global.
 */
const RULES_SQL = `
  SELECT r."producerId", r.pattern, r."matchMode", r."flavorId", r.effect,
         r."peatProfile", r.priority
  FROM flavor_rule r
  ORDER BY r.priority DESC, length(r.pattern) DESC,
           (r."producerId" IS NULL), r.pattern
`;

/**
 * The apostrophe shapes the catalogue's brand names use, stripped before a key
 * is compared. `KbKeyUtils` strips the same set; the two must stay in step.
 */
const APOSTROPHES = "'\u2019\u02bc\u0060";

@TypeormRepository(ProducerEntity)
export class ProducerRepository extends BaseRepository<ProducerEntity> {
  /**
   * Loads the alias match index.
   *
   * @returns Alias entries with their producers' facts, longest key first.
   */
  public async findAliasIndex(): Promise<KbAliasEntry[]> {
    const rows = await this.query(
      ALIAS_INDEX_SQL,
      [[KbStatus.VERIFIED, KbStatus.AUTO]],
    ) as KbAliasRow[];

    return rows.map((row) => ({
      key: row.key,
      scope: row.scope,
      producer: this.toFacts(row),
    }));
  }

  /**
   * Loads the aliases of the producers the gate withheld.
   *
   * Deliberately a **second** read rather than a status parameter on
   * {@link findAliasIndex}: that method's whitelist is the safety gate between
   * research output and the catalogue, and a parameter would make it one
   * argument away from being switched off. Nothing may combine these two lists
   * except the review screen's what-if computation, which writes nothing.
   *
   * `rejected` rows are excluded — a row somebody ruled out is not a candidate
   * for anything.
   *
   * @returns Alias entries whose producers are `unverified`, longest key
   *   first.
   */
  public async findWithheldAliasIndex(): Promise<KbAliasEntry[]> {
    const rows = await this.query(
      ALIAS_INDEX_SQL,
      [[KbStatus.UNVERIFIED]],
    ) as KbAliasRow[];

    return rows.map((row) => ({
      key: row.key,
      scope: row.scope,
      producer: this.toFacts(row),
    }));
  }

  /**
   * Loads every name-pattern rule.
   *
   * @returns Rules, best-matching first (see {@link RULES_SQL}).
   */
  public async findRules(): Promise<KbFlavorRule[]> {
    const rows = await this.query(RULES_SQL) as KbFlavorRuleRow[];

    return rows.map((row) => ({
      producerId: row.producerId,
      pattern: row.pattern,
      matchMode: row.matchMode,
      flavorId: row.flavorId,
      effect: row.effect,
      peatProfile: row.peatProfile,
      priority: row.priority,
    }));
  }

  /**
   * Loads the curated house-style statements, grouped by producer.
   *
   * @returns Map from producer id to its statements; producers with none are
   *   absent.
   */
  public async findProducerFlavors(): Promise<Map<ID, KbProducerFlavor[]>> {
    const rows = await this.query(
      'SELECT "producerId", "flavorId", effect FROM producer_flavor',
    ) as KbProducerFlavor[];

    const grouped = new Map<ID, KbProducerFlavor[]>();

    rows.forEach((row) => {
      const existing = grouped.get(row.producerId);

      if (existing) {
        existing.push(row);

        return;
      }

      grouped.set(row.producerId, [row]);
    });

    return grouped;
  }

  /**
   * Resolves the two peat tag ids the profile mapping writes.
   *
   * @param peatedName - Name of the `peated` tag.
   * @param smokyName - Name of the `smoky` tag.
   * @returns Both ids; either is null when the tag is missing from the
   *   reference table, which the caller must treat as "cannot write peat".
   */
  public async findPeatFlavorIds(
    peatedName: string,
    smokyName: string,
  ): Promise<KbPeatFlavorIds> {
    const rows = await this.query(
      'SELECT id, name FROM flavor WHERE name = ANY($1::text[])',
      [[peatedName, smokyName]],
    ) as { id: ID; name: string }[];

    const byName = new Map(rows.map((row) => [row.name, row.id]));

    return {
      peated: byName.get(peatedName) ?? null,
      smoky: byName.get(smokyName) ?? null,
    };
  }

  /**
   * Lists brands that have never been researched, worst-first.
   *
   * The predicate is "no alias matches this brand's key", **not** "no producer
   * resolves it". Those differ, and the difference is the whole point of the
   * `unverified` status: a brand researched and withheld still resolves to
   * nothing, so keying on the producer link would offer it up again on every
   * run and pay the model for the same answer forever.
   *
   * The key is normalized in SQL the way `KbKeyUtils` normalizes it —
   * lower-cased, apostrophes stripped, every other non-alphanumeric run
   * collapsed to one space. That has to stay in step with the utility;
   * `pnpm research-brands --dry-run` prints exactly what it would ask about,
   * which is how the two are checked against each other.
   *
   * @param limit - How many to return.
   * @returns Brand names with product counts and a few sample names.
   */
  public async findUnresearchedBrands(
    limit = 50,
  ): Promise<UnresearchedBrandRow[]> {
    return this.query(
      `SELECT b.name AS brand, count(*)::int AS "productCount",
              (array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL))
                [1:6] AS "sampleNames"
       FROM product p
       JOIN brand b ON b.id = p."brandId"
       WHERE p."producerId" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM producer_alias a
           WHERE a.key = btrim(regexp_replace(
             lower(translate(b.name, $2, '')),
             '[^0-9a-z\u0430-\u044f\u0456\u0457\u0454\u0491]+', ' ', 'g'))
         )
       GROUP BY b.name
       ORDER BY 2 DESC, 1
       LIMIT $1`,
      [limit, APOSTROPHES],
    ) as Promise<UnresearchedBrandRow[]>;
  }

  /**
   * Stores one researched producer and the alias that reaches it.
   *
   * Both halves matter. Without the alias the producer is unreachable; without
   * the producer the alias is dangling. They go in together, and the alias is
   * the catalogue's **exact** brand spelling — typos included, since that
   * spelling is what has to resolve.
   *
   * An existing slug is left alone rather than overwritten: the seed and a
   * reviewer both outrank a model, and a later run must never quietly replace
   * a curated row with a generated one.
   *
   * @param row - The producer to store.
   * @param aliasKey - The normalized brand key that must reach it.
   * @param aliasScope - Where the alias may be matched.
   * @returns True when a new producer row was created.
   */
  public async saveResearched(
    row: ResearchedProducer,
    aliasKey: string,
    aliasScope: string,
  ): Promise<boolean> {
    const inserted = await this.query(
      `INSERT INTO producer (
         slug, name, kind, "countryId", region, "legalRegion", owner,
         "defaultTypeName", "peatProfile", status, confidence, "sourceUrls",
         note
       )
       SELECT $1, $2, $3,
              (SELECT c.id FROM country c WHERE c.code = $4),
              nullif($5, ''), nullif($6, ''), nullif($7, ''),
              nullif($8, ''), $9, $10, nullif($11, ''), nullif($12, '')
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [
        row.slug,
        row.name,
        row.kind,
        row.countryCode || null,
        row.region,
        row.legalRegion,
        row.owner,
        row.defaultTypeName,
        row.peatProfile,
        row.status,
        row.confidence,
        row.sourceUrls,
        row.note,
      ],
    ) as { id: ID }[];

    await this.query(
      `INSERT INTO producer_alias (key, "producerId", scope)
       SELECT $1, p.id, $3 FROM producer p WHERE p.slug = $2
       ON CONFLICT (key) DO NOTHING`,
      [aliasKey, row.slug, aliasScope],
    );

    return inserted.length > 0;
  }

  /**
   * Applies a reviewer's edit and stamps the row confirmed.
   *
   * Written as one statement over `COALESCE` so an absent field is genuinely
   * left alone rather than nulled — a reviewer correcting a peat band must not
   * silently wipe an owner or a citation they never looked at. Clearing a
   * field on purpose is expressed by the explicit `clear*` flags, because
   * "absent" and "deliberately empty" are different intentions and a single
   * nullable parameter cannot carry both.
   *
   * `countryCode` is resolved through a sub-select, so an unknown code leaves
   * the country untouched instead of nulling it — the alternative would let a
   * typo erase a fact.
   *
   * @param id - The producer to edit.
   * @param patch - The fields to change.
   * @returns The updated row, or null when no producer has that id.
   */
  public async applyReview(
    id: ID,
    patch: ProducerReviewPatch,
  ): Promise<boolean> {
    const result = await this.query(
      `UPDATE producer SET
         name = COALESCE($2, name),
         kind = COALESCE($3, kind),
         "countryId" = COALESCE(
           (SELECT c.id FROM country c WHERE c.code = $4), "countryId"),
         region = CASE WHEN $12 THEN NULL ELSE COALESCE($5, region) END,
         "legalRegion" = CASE WHEN $13 THEN NULL
           ELSE COALESCE($6, "legalRegion") END,
         owner = CASE WHEN $14 THEN NULL ELSE COALESCE($7, owner) END,
         "defaultTypeName" = CASE WHEN $15 THEN NULL
           ELSE COALESCE($8, "defaultTypeName") END,
         "peatProfile" = COALESCE($9, "peatProfile"),
         status = COALESCE($10, status),
         "sourceUrls" = COALESCE($11, "sourceUrls"),
         note = COALESCE($16, note),
         "verifiedAt" = now(),
         "updatedAt" = now()
       WHERE id = $1
       RETURNING id`,
      [
        id,
        patch.name ?? null,
        patch.kind ?? null,
        patch.countryCode ?? null,
        patch.region ?? null,
        patch.legalRegion ?? null,
        patch.owner ?? null,
        patch.defaultTypeName ?? null,
        patch.peatProfile ?? null,
        patch.status ?? null,
        patch.sourceUrls ?? null,
        patch.clearRegion ?? false,
        patch.clearLegalRegion ?? false,
        patch.clearOwner ?? false,
        patch.clearDefaultTypeName ?? false,
        patch.note ?? null,
      ],
    ) as { id: ID }[];

    return result.length > 0;
  }

  /**
   * Reads one producer in the review screen's shape.
   *
   * @param id - The producer to read.
   * @returns The row, or null.
   */
  public async findOneForReview(id: ID): Promise<ProducerReviewRow | null> {
    const rows = await this.query(
      `SELECT p.id, p.slug, p.name, p.kind, p.region, p."legalRegion",
              p.owner, p."defaultTypeName", p."peatProfile", p.status,
              p.confidence, p."sourceUrls", p.note, p."verifiedAt",
              c.code AS "countryCode", c."nameUa" AS "countryName",
              c.icon AS "countryIcon",
              par.slug AS "parentSlug", bot.slug AS "bottlerSlug",
              (SELECT count(*)::int FROM product pr
               WHERE pr."producerId" = p.id) AS "productCount",
              NULL::int AS "potentialReach"
       FROM producer p
       LEFT JOIN country c ON c.id = p."countryId"
       LEFT JOIN producer par ON par.id = p."parentId"
       LEFT JOIN producer bot ON bot.id = p."bottlerId"
       WHERE p.id = $1`,
      [id],
    ) as ProducerReviewRow[];

    return rows[0] ?? null;
  }

  /**
   * Lists the named lines parented to a producer.
   *
   * The resolver never inherits peat across this link, so a child's band is
   * its own claim — which is exactly what a reviewer judging the parent's band
   * needs to see. `bruichladdich` reads `none` only because
   * `port-charlotte` and `octomore` carry the `heavy` claims themselves.
   *
   * @param id - The parent producer.
   * @returns Its children, alphabetically.
   */
  public async findChildren(id: ID): Promise<ProducerChildRow[]> {
    return this.query(
      `SELECT p.id, p.slug, p.name, p.kind, p."peatProfile", p.status,
              (SELECT count(*)::int FROM product pr
               WHERE pr."producerId" = p.id) AS "productCount"
       FROM producer p
       WHERE p."parentId" = $1
       ORDER BY p.slug`,
      [id],
    ) as Promise<ProducerChildRow[]>;
  }

  /**
   * Lists the name-pattern rules that bear on one producer.
   *
   * Two sets, because they are two different things to a reviewer: the rules
   * scoped to this producer are part of what the row asserts, while the global
   * peat rules apply to every producer and are context rather than something
   * this review can change.
   *
   * @param id - The producer whose scoped rules to read.
   * @returns The producer's own rules and the global peat rules, each
   *   highest-priority first.
   */
  public async findRulesForReview(id: ID): Promise<{
    rules: ProducerRuleRow[];
    globalPeatRules: ProducerRuleRow[];
  }> {
    const [rules, globalPeatRules] = await Promise.all([
      this.query(RULE_ROWS_SQL, [id]) as Promise<ProducerRuleRow[]>,
      this.query(GLOBAL_PEAT_RULE_ROWS_SQL) as Promise<ProducerRuleRow[]>,
    ]);

    return { rules, globalPeatRules };
  }

  /**
   * Inserts one producer-scoped name-pattern rule.
   *
   * The caller has already validated and normalized the input — this only
   * writes it. A duplicate `(producerId, pattern, flavorId)` violates
   * `flavor_rule_uindex` and surfaces as the driver's 23505, which the domain
   * layer maps to a conflict.
   *
   * @param input - The validated rule.
   * @returns Resolves once the row is written.
   */
  public async insertRule(input: ProducerRuleInput): Promise<void> {
    await this.query(
      `INSERT INTO flavor_rule
         ("producerId", pattern, "matchMode", "flavorId", effect,
          "peatProfile", priority, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.producerId,
        input.pattern,
        input.matchMode,
        input.flavorId,
        input.effect,
        input.peatProfile,
        input.priority,
        input.note,
      ],
    );
  }

  /**
   * Deletes one rule, scoped to its producer so a global rule is unreachable
   * by construction: those are migration-authored and a stray id could
   * otherwise silently remove a rule every producer relies on.
   *
   * @param ruleId - The rule to delete.
   * @param producerId - The producer it must belong to.
   * @returns How many rows were deleted — zero when the rule is not that
   *   producer's.
   */
  public async deleteRule(ruleId: ID, producerId: ID): Promise<number> {
    const result = await this.query(
      `DELETE FROM flavor_rule
       WHERE id = $1 AND "producerId" = $2`,
      [ruleId, producerId],
    ) as [unknown[], number];

    return result[1] ?? 0;
  }

  /**
   * Lists producers for the review screen.
   *
   * `productCount` is how many bottlings resolve to the row **today**, which
   * is a fact for a `verified` or `auto` producer and structurally **zero for
   * every withheld one** — the resolver's index whitelists `verified`/`auto`,
   * so a withheld producer resolves to nothing by definition. Ordering by it
   * therefore ranks the withheld queue alphabetically, which is why the
   * withheld tab is ranked in the domain layer instead (see
   * `ProducerReachService`) and this ordering only serves the live tabs.
   *
   * @param status - Restrict to one review status, or omit for all. Note that
   *   omitting it now also returns `rejected` rows, so a work queue must ask
   *   for its status explicitly.
   * @param limit - Page size; `null` returns every matching row (Postgres
   *   reads `LIMIT NULL` as unlimited), which is what the ranked tab needs.
   * @param offset - Page offset.
   * @param search - Case-insensitive substring of the name or slug, or omit
   *   for all.
   * @returns The rows and the total matching count.
   */
  public async findForReview(
    status?: string,
    limit: number | null = 50,
    offset = 0,
    search?: string,
  ): Promise<{ rows: ProducerReviewRow[]; total: number }> {
    const rows = await this.query(
      `SELECT p.id, p.slug, p.name, p.kind, p.region, p."legalRegion",
              p.owner, p."defaultTypeName", p."peatProfile", p.status,
              p.confidence, p."sourceUrls", p.note, p."verifiedAt",
              c.code AS "countryCode", c."nameUa" AS "countryName",
              c.icon AS "countryIcon",
              par.slug AS "parentSlug", bot.slug AS "bottlerSlug",
              (SELECT count(*)::int FROM product pr
               WHERE pr."producerId" = p.id) AS "productCount",
              NULL::int AS "potentialReach"
       FROM producer p
       LEFT JOIN country c ON c.id = p."countryId"
       LEFT JOIN producer par ON par.id = p."parentId"
       LEFT JOIN producer bot ON bot.id = p."bottlerId"
       WHERE ($1::text IS NULL OR p.status = $1)
         AND ($4::text IS NULL
              OR p.name ILIKE '%' || $4 || '%'
              OR p.slug ILIKE '%' || $4 || '%')
       ORDER BY (SELECT count(*) FROM product pr
                 WHERE pr."producerId" = p.id) DESC, p.slug
       LIMIT $2 OFFSET $3`,
      [status ?? null, limit ?? null, offset, search ?? null],
    ) as ProducerReviewRow[];

    const counted = await this.query(
      `SELECT count(*)::int AS total FROM producer p
       WHERE ($1::text IS NULL OR p.status = $1)
         AND ($2::text IS NULL
              OR p.name ILIKE '%' || $2 || '%'
              OR p.slug ILIKE '%' || $2 || '%')`,
      [status ?? null, search ?? null],
    ) as { total: number }[];

    return { rows, total: counted[0]?.total ?? 0 };
  }

  /**
   * Counts producers by review status.
   *
   * @returns One entry per status present.
   */
  public async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.query(
      'SELECT status, count(*)::int AS count FROM producer GROUP BY status',
    ) as { status: string; count: number }[];

    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  /**
   * Lists the brand keys nothing in the knowledge base resolves, worst-first.
   *
   * Derived rather than stored. A queue table would be a second copy of what
   * the alias table already states, and it would drift the moment somebody
   * added an alias — the absence of a match *is* the queue.
   *
   * @param limit - How many to return.
   * @returns Brand names with the number of bottlings behind them.
   */
  public async findUnresolvedBrands(
    limit = 100,
  ): Promise<UnresolvedBrandRow[]> {
    return this.query(
      `SELECT b.name AS brand, count(*)::int AS "productCount"
       FROM product p
       JOIN brand b ON b.id = p."brandId"
       WHERE p."producerId" IS NULL
       GROUP BY b.name
       ORDER BY 2 DESC, 1
       LIMIT $1`,
      [limit],
    ) as Promise<UnresolvedBrandRow[]>;
  }

  /**
   * Resolves whisky type names to ids, so the knowledge base's
   * `defaultTypeName` can be written as an FK without each caller joining.
   *
   * @param names - Type names; duplicates and blanks are ignored.
   * @returns Map from name to id; unknown names are absent.
   */
  public async findTypeIdsByName(names: string[]): Promise<Map<string, ID>> {
    const keys = [...new Set(names.filter((name) => name.length > 0))];

    if (!keys.length) {
      return new Map();
    }

    const rows = await this.query(
      'SELECT id, name FROM type WHERE name = ANY($1::text[])',
      [keys],
    ) as { id: ID; name: string }[];

    return new Map(rows.map((row) => [row.name, row.id]));
  }

  /**
   * Projects an alias row's producer columns into the facts the resolver
   * reads.
   *
   * @param row - One joined alias row.
   * @returns The producer's facts.
   */
  private toFacts(row: KbAliasRow): KbProducerFacts {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      countryId: row.countryId,
      region: row.region,
      legalRegion: row.legalRegion,
      parentId: row.parentId,
      bottlerId: row.bottlerId,
      defaultTypeName: row.defaultTypeName,
      peatProfile: row.peatProfile,
    };
  }
}
