import { Injectable } from '@nestjs/common';

import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { KbAliasUtils, KbKeyUtils } from '~utils';

import { KbApplyService, KbResolverService } from '~scrape/kb';
import type {
  ID,
  KbAliasEntry,
  KbNameGroup,
  KbProducerFacts,
  KbResolution,
  KbResolveInput,
  ProducerQueueHints,
  ReviewInertHits,
} from '~types';

/**
 * What a what-if pass concluded: the name groups and, in the same order, what
 * each would resolve to with the withheld aliases in the index.
 */
interface WithheldResolution {
  /**
   * The catalogue's name groups, in first-seen order.
   */
  groups: KbNameGroup[];

  /**
   * One resolution per group, same order.
   */
  resolutions: KbResolution[];

  /**
   * The ids of the withheld producers, for telling a what-if claim from a
   * live one.
   */
  withheldIds: Set<ID>;
}

/**
 * How many bottlings each withheld producer would claim.
 *
 * The review screen needs this because the obvious number is useless: the
 * resolver's index only loads `verified` and `auto` rows, so a withheld
 * producer resolves to **zero** bottlings by construction — all 466 of them.
 * Ranking the queue by that count ranks it alphabetically, which put
 * `15-stars`, `36-south` and `aberdour` on page one while `jura` (47
 * bottlings), `johnnie-walker` (47) and `highland-park` (28) sat pages deep.
 * A queue nobody can prioritise is the reason 466 rows had never been touched.
 *
 * **What the number means, exactly**: how many bottlings would resolve to this
 * producer if the whole withheld queue went live at once. Two consequences
 * follow from that definition and both are deliberate:
 *
 * - It is computed in **one** resolve pass over the catalogue with every
 *   withheld alias in the index, not by promoting each producer alone and
 *   re-resolving. The marginal version costs ~90 ms per producer (~40 s for
 *   the queue) against ~130 ms for this one, and the difference between them is
 *   confined to the 34 name groups two candidates both match — where the
 *   marginal number would credit the group to both. This one credits it to
 *   whichever alias actually wins, which is what the reviewer would get.
 * - The numbers are therefore **not additive**. Promoting two producers that
 *   contest the same bottlings does not yield the sum of their reaches.
 *
 * It is a ranking signal, never a stored fact: nothing writes it, so it cannot
 * drift, and the alias table stays the single statement of what resolves to
 * what — the same reason the unresolved-brand queue is derived rather than
 * stored.
 */
@Injectable()
export class ProducerReachService {
  /**
   * Merges the live index with the withheld one, restoring the order the
   * resolver relies on.
   *
   * `matchInName` takes the **first** alias whose key appears in the name, so
   * longest-key-first is what makes `Highland Park` win over `Highland`.
   * Concatenating two separately-sorted lists breaks that, and the failure
   * would be silent — a wrong producer, not an error.
   *
   * @param live - The verified and auto aliases.
   * @param withheld - The aliases of the withheld producers.
   * @returns One list, longest key first, ties broken by key.
   */
  private static mergeAliases(
    live: KbAliasEntry[],
    withheld: KbAliasEntry[],
  ): KbAliasEntry[] {
    return [...live, ...withheld].sort((left, right) =>
      right.key.length - left.key.length || left.key.localeCompare(right.key)
    );
  }

  /**
   * Adds the inert rows to the live by-id producer map, so a what-if
   * resolution can name the owner of a range it has just reached.
   *
   * @param live - The live producers by id.
   * @param inert - The withheld or rejected alias entries.
   * @returns A new map holding both.
   */
  private static mergeProducers(
    live: Map<ID, KbProducerFacts>,
    inert: KbAliasEntry[],
  ): Map<ID, KbProducerFacts> {
    const merged = new Map(live);

    inert.forEach((alias) => {
      merged.set(alias.producer.id, alias.producer);
    });

    return merged;
  }

  /**
   * Which withheld producers a group's resolution would claim.
   *
   * A set, not an array, so a group counts once however many slots it fills.
   * The two slots still cannot name one producer — a bottler is refused the
   * producer slot, and `bottlerOf` skips an owner that is the producer itself
   * — but the set keeps that from being a guarantee this read depends on.
   *
   * @param resolution - What the group resolved to.
   * @param withheldIds - The withheld producers' ids.
   * @returns The withheld ids the resolution names, in either slot.
   */
  private static claimedBy(
    resolution: KbResolution,
    withheldIds: Set<ID>,
  ): Set<ID> {
    return new Set(
      [resolution.producer?.id, resolution.bottler?.id]
        .filter((id): id is ID => id != null && withheldIds.has(id)),
    );
  }

  private readonly producers: CoreProducerService;

  private readonly products: CoreProductService;

  private readonly resolver: KbResolverService;

  public constructor(
    producers: CoreProducerService,
    products: CoreProductService,
    resolver: KbResolverService,
  ) {
    this.producers = producers;
    this.products = products;
    this.resolver = resolver;
  }

  /**
   * Counts what each withheld producer would claim.
   *
   * @returns Producer id to bottling count. A producer no bottling would
   *   reach is absent, not zero — three of them have no alias at all, which is
   *   a curation gap rather than a ranking answer.
   */
  public async withheldReach(): Promise<Map<ID, number>> {
    const { groups, resolutions, withheldIds } = await this.resolveWithheld();

    const reach = new Map<ID, number>();

    resolutions.forEach((resolution, position) => {
      const weight = groups[position]?.rows.length ?? 0;

      const claimed = ProducerReachService.claimedBy(resolution, withheldIds);

      claimed.forEach((id) => {
        reach.set(id, (reach.get(id) ?? 0) + weight);
      });
    });

    return reach;
  }

  /**
   * Lists the bottlings one withheld producer would claim — the expansion
   * behind a "potential reach" number. Same pass, same arbitration, so the
   * list always sums to the number the queue ranked by.
   *
   * @param producerId - The withheld producer.
   * @returns The claimed bottlings' ids, in catalogue order.
   */
  public async withheldProductIds(producerId: ID): Promise<ID[]> {
    const { groups, resolutions, withheldIds } = await this.resolveWithheld();

    const ids: ID[] = [];

    resolutions.forEach((resolution, position) => {
      const claimed = ProducerReachService.claimedBy(resolution, withheldIds);

      if (!claimed.has(producerId)) {
        return;
      }

      const group = groups[position];

      group?.rows.forEach((row) => {
        ids.push(row.id);
      });
    });

    return ids;
  }

  /**
   * Says, for every bottling that resolves to nothing today, which inert
   * producer its own spelling would reach.
   *
   * Two of the curation queue's detectors need this and neither can be written
   * in SQL without a second implementation of alias matching — which is the
   * defect class the knowledge base exists to remove. So the real resolver
   * runs over an index the withheld and the rejected rows are added to, once
   * per request, and the answer is handed to the detector query as two id
   * arrays.
   *
   * Only bottlings with **neither** a producer nor a bottler are reported: a
   * resolved bottling is not in this queue whatever an inert row would have
   * claimed.
   *
   * @returns The bottlings reaching a `rejected` producer and those reaching a
   *   withheld one, each with the producer they reach.
   */
  public async inertHits(): Promise<ReviewInertHits> {
    const [index, withheld, rejected, rows] = await Promise.all([
      this.producers.loadIndex(),
      this.producers.loadWithheldAliasIndex(),
      this.producers.loadRejectedAliasIndex(),
      this.products.findKbReconcileCandidates(),
    ]);

    const withheldIds = new Set(withheld.map((one) => one.producer.id));
    const rejectedIds = new Set(rejected.map((one) => one.producer.id));

    const groups = KbApplyService.groupByName(rows);

    const resolutions = this.resolver.resolve(
      groups.map((group) => ({
        id: group.rows[0]?.id ?? ('' as ID),
        name: group.name,
        brand: KbApplyService.brandOf(group),
      })),
      {
        ...index,
        aliases: ProducerReachService.mergeAliases(
          index.aliases,
          [...withheld, ...rejected],
        ),
        producers: ProducerReachService.mergeProducers(
          index.producers,
          [...withheld, ...rejected],
        ),
      },
    );

    const hits: ReviewInertHits = { rejected: new Map(), withheld: new Map() };

    resolutions.forEach((resolution, position) => {
      const producer = resolution.producer ?? resolution.bottler;

      if (!producer) {
        return;
      }

      let bucket: Map<ID, KbProducerFacts> | null = null;

      if (rejectedIds.has(producer.id)) {
        bucket = hits.rejected;
      } else if (withheldIds.has(producer.id)) {
        bucket = hits.withheld;
      }

      if (!bucket) {
        return;
      }

      groups[position]?.rows.forEach((row) => {
        if (row.producerId === null && row.bottlerId === null) {
          bucket.set(row.id, producer);
        }
      });
    });

    return hits;
  }

  /**
   * Says which live producers are unreachable and which are merely
   * unlinked — the two producer detectors no SQL predicate can answer.
   *
   * Reachability is `KbAliasUtils`' own rule and nothing else: a name match
   * needs a scope that is not `brand`, and either the five-character floor or
   * the `lead` anchoring that is exempt from it. Restating that in SQL would
   * be a second copy of the rule the resolver matches by, so the answer is
   * computed here and handed to the query as two id lists.
   *
   * The difference between the two lists is what a person would do about
   * them. **Unreachable**: every spelling the producer has is one the resolver
   * cannot look for inside a name, and some unresolved bottling carries the
   * word anyway — one scope change fixes all of them. **Mentioned**: a
   * spelling does reach it, but the bottlings naming it were not resolved
   * because the name cleaner stripped the token — which usually wants an
   * alias for what the shop actually printed.
   *
   * @returns The two id lists and the per-producer mention counts.
   */
  public async producerHints(): Promise<ProducerQueueHints> {
    const [aliases, unresolved] = await Promise.all([
      this.producers.loadAliasIndex(),
      this.products.findUnresolvedNames(),
    ]);

    const rows = unresolved.map((row) => ({
      name: KbKeyUtils.normalize(row.name ?? ''),
      raw: KbKeyUtils.normalize(row.raw),
    }));

    const byProducer = new Map<ID, KbAliasEntry[]>();

    aliases.forEach((alias) => {
      const held = byProducer.get(alias.producer.id) ?? [];

      held.push(alias);
      byProducer.set(alias.producer.id, held);
    });

    const hints: ProducerQueueHints = {
      unreachable: [],
      mentioned: [],
      mentions: new Map(),
    };

    byProducer.forEach((held, id) => {
      const nameKey = KbKeyUtils.key(held[0].producer.name);
      const keys = [...new Set([nameKey, ...held.map((one) => one.key)])]
        .filter((key) => key.length > 0);

      const hitsRaw = rows.filter((row) =>
        keys.some((key) =>
          KbKeyUtils.matchesWord(row.raw, key)
        )
      ).length;

      if (hitsRaw === 0) {
        return;
      }

      hints.mentions.set(id, hitsRaw);

      const reachable = held.some((alias) => KbAliasUtils.reachesName(alias));

      if (reachable) {
        hints.mentioned.push(id);

        return;
      }

      hints.unreachable.push(id);
    });

    return hints;
  }

  /**
   * Runs the one what-if pass both public reads share: the whole catalogue
   * resolved against the live index plus every withheld alias.
   *
   * @returns The groups, their resolutions and the withheld producer ids.
   */
  private async resolveWithheld(): Promise<WithheldResolution> {
    const [index, withheld, rows] = await Promise.all([
      this.producers.loadIndex(),
      this.producers.loadWithheldAliasIndex(),
      this.products.findKbReconcileCandidates(),
    ]);

    const withheldIds = new Set(
      withheld.map((alias) => alias.producer.id),
    );

    const groups = KbApplyService.groupByName(rows);

    /**
     * The resolver echoes the input id back and nothing here reads it, but the
     * shape requires one, so the group's first bottling stands for the group —
     * exactly as the reconciliation pass does. A group with no rows cannot
     * exist (`groupByName` only ever creates one around a row), so the inputs
     * stay index-aligned with the groups.
     */
    const inputs: KbResolveInput[] = groups.map((group) => ({
      id: group.rows[0]?.id ?? ('' as ID),
      name: group.name,
      brand: KbApplyService.brandOf(group),
    }));

    const resolutions = this.resolver.resolve(inputs, {
      ...index,
      aliases: ProducerReachService.mergeAliases(index.aliases, withheld),
      producers: ProducerReachService.mergeProducers(
        index.producers,
        withheld,
      ),
    });

    return { groups, resolutions, withheldIds };
  }
}
