import { Injectable } from '@nestjs/common';

import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { KbApplyService, KbResolverService } from '~scrape/kb';
import type { ID, KbAliasEntry, KbResolveInput } from '~types';

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
     * exactly as the reconciliation pass does.
     */
    const inputs: KbResolveInput[] = [];
    const weights: number[] = [];

    groups.forEach((group) => {
      const first = group.rows[0];

      if (!first) {
        return;
      }

      inputs.push({
        id: first.id,
        name: group.name,
        brand: KbApplyService.brandOf(group),
      });
      weights.push(group.rows.length);
    });

    const resolutions = this.resolver.resolve(inputs, {
      ...index,
      aliases: ProducerReachService.mergeAliases(index.aliases, withheld),
    });

    const reach = new Map<ID, number>();

    resolutions.forEach((resolution, position) => {
      const weight = weights[position] ?? 0;

      /**
       * A set, not an array, so a group counts once however many slots it
       * fills. Today the two slots can never name the same producer — a
       * bottler is refused the producer slot outright — but `bottlerOf`'s own
       * documentation promises a second path it does not yet implement (the
       * resolved producer being a range a bottler owns, `Big Peat` reporting
       * Douglas Laing), and that path would make the collision real.
       */
      const claimed = new Set(
        [resolution.producer?.id, resolution.bottler?.id]
          .filter((id): id is ID => id != null && withheldIds.has(id)),
      );

      claimed.forEach((id) => {
        reach.set(id, (reach.get(id) ?? 0) + weight);
      });
    });

    return reach;
  }
}
