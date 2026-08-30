import { Injectable } from '@nestjs/common';

import { FactSource, FlavorSource, PeatProfile } from '~enums';
import type {
  ID,
  KbApplyOptions,
  KbApplyPlan,
  KbFlavorWrite,
  KbIndex,
  KbNameGroup,
  KbPeatFlavorIds,
  KbReconcileRow,
  KbResolution,
} from '~types';

import { KbResolverService } from './kb-resolver.service';

/**
 * Sources whose flavor links the knowledge base may replace. A `manual` link
 * outranks it and a `kb` link is already its own.
 */
const REPLACEABLE = new Set<string>([
  FlavorSource.SCRAPE,
  FlavorSource.LLM,
]);

/**
 * Turns what the resolver concluded into the writes that state it.
 *
 * It exists as a service rather than as a function inside the reconciliation
 * script because two callers need it and they must not drift: the script,
 * which repairs the whole catalogue at once, and `ScrapePersistService`, which
 * applies the same rules to the handful of bottlings a sync touched. Two
 * implementations of "which peat link may survive" is precisely the shape of
 * defect this work exists to remove — it would take one edit to one of them
 * for a nightly sync to start undoing what the reconciliation pass had just
 * settled.
 *
 * Nothing here reads or writes the database. It is given the stored rows and
 * the loaded index and returns the writes; the caller decides whether to
 * report them or perform them.
 */
@Injectable()
export class KbApplyService {
  private readonly resolver: KbResolverService;

  public constructor(resolver: KbResolverService) {
    this.resolver = resolver;
  }

  /**
   * Groups bottlings by lower-cased name.
   *
   * The group, not the product, is the unit. Identically-named bottlings were
   * classified independently and disagree with each other — 100 groups
   * disagreed on the peat tags alone — so resolving once per group is what
   * makes "same name, same facts" structural rather than a repair to be
   * repeated. A bottling with no name is its own group, since nothing can be
   * said about it collectively.
   *
   * @param rows - The bottlings to group.
   * @returns The groups, in first-seen order.
   */
  public static groupByName(rows: KbReconcileRow[]): KbNameGroup[] {
    const groups = new Map<string, KbNameGroup>();

    rows.forEach((row) => {
      const key = row.name ? row.name.toLowerCase() : ` ${row.id}`;
      const seen = groups.get(key);

      if (seen) {
        seen.rows.push(row);

        return;
      }

      groups.set(key, { key, name: row.name, rows: [row] });
    });

    return [...groups.values()];
  }

  /**
   * Picks the brand value a group resolves under.
   *
   * A group's members can carry different brand spellings — 59 groups
   * disagreed on brand in the production dump — so the most common non-empty
   * spelling stands for the group. Ties break on the alphabetically first
   * value, which makes a run reproducible rather than dependent on row order.
   *
   * @param group - The name group.
   * @returns The brand, or null when no member carries one.
   */
  public static brandOf(group: KbNameGroup): string | null {
    const counts = new Map<string, number>();

    group.rows.forEach((row) => {
      if (row.brand) {
        counts.set(row.brand, (counts.get(row.brand) ?? 0) + 1);
      }
    });

    const ranked = [...counts.entries()]
      .sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])
      );

    return ranked[0]?.[0] ?? null;
  }

  /**
   * Builds every write a set of bottlings implies, without performing any.
   *
   * @param rows - The bottlings as stored, with their flavor links.
   * @param index - The loaded knowledge base.
   * @param typeIds - Whisky type name to id, for `defaultTypeName`.
   * @param options - Whether to spare the peat links of unresolved bottlings.
   * @returns The groups, their resolutions and the three write sets.
   */
  public plan(
    rows: KbReconcileRow[],
    index: KbIndex,
    typeIds: Map<string, ID>,
    options: KbApplyOptions = {},
  ): KbApplyPlan {
    const groups = KbApplyService.groupByName(rows);

    const resolutions = this.resolver.resolve(
      groups.map((group, at) => ({
        id: String(at) as ID,
        name: group.name,
        brand: KbApplyService.brandOf(group),
      })),
      index,
    );

    const plan: KbApplyPlan = {
      groups,
      resolutions,
      producers: [],
      facts: [],
      flavors: [],
    };

    groups.forEach((group, at) => {
      const resolution = resolutions[at];

      group.rows.forEach((row) => {
        const producer = resolution.producer;
        const typeName = producer?.defaultTypeName ?? null;

        plan.producers.push({
          productId: row.id,
          producerId: producer?.id ?? null,
          bottlerId: resolution.bottler?.id ?? null,
          source: FactSource.KB,
        });

        plan.facts.push({
          productId: row.id,
          countryId: producer?.countryId ?? null,
          typeId: typeName ? typeIds.get(typeName) ?? null : null,
        });

        plan.flavors.push(
          row.flavorsCuratedAt
            ? { productId: row.id, insertFlavorIds: [], deleteFlavorIds: [] }
            : this.planFlavors(
              row,
              resolution,
              index.peatFlavorIds,
              options,
            ),
        );
      });
    });

    return plan;
  }

  /**
   * Decides which flavor links one bottling should gain and lose.
   *
   * Peat is the part that removes. Every `peated` or `smoky` link the knowledge
   * base did not put there is deleted, whatever the resolver concluded — that
   * is the hard invariant the whole exercise establishes, and it is what clears
   * the tag a model guessed onto an unresolved bottling. The other thirteen
   * tags are only ever added, or removed where a rule or house style forbids
   * them.
   *
   * @param row - The bottling as stored.
   * @param resolution - What the knowledge base concluded.
   * @param peatIds - The `peated` and `smoky` flavor ids.
   * @param options - Whether to spare an unresolved bottling's peat links.
   * @returns The links to insert and delete, both possibly empty.
   */
  private planFlavors(
    row: KbReconcileRow,
    resolution: KbResolution,
    peatIds: KbPeatFlavorIds,
    options: KbApplyOptions,
  ): KbFlavorWrite {
    const insert = new Set<ID>();
    const remove = new Set<ID>();

    const isPeatId = (id: ID): boolean =>
      id === peatIds.peated || id === peatIds.smoky;

    const wanted = new Set<ID>(
      KbResolverService.peatTags(resolution.peatProfile)
        .map((tag) => (tag === 'peated' ? peatIds.peated : peatIds.smoky))
        .filter((id): id is ID => Boolean(id)),
    );

    const spared = Boolean(options.keepUnknownPeat)
      && resolution.peatProfile === PeatProfile.UNKNOWN;

    const manual = new Set(
      row.flavors
        .filter((link) => link.source === FlavorSource.MANUAL)
        .map((link) => link.flavorId),
    );

    row.flavors.forEach((link) => {
      if (link.source === FlavorSource.MANUAL) {
        return;
      }

      if (isPeatId(link.flavorId)) {
        if (!spared && !wanted.has(link.flavorId)) {
          remove.add(link.flavorId);
        }

        return;
      }

      if (
        REPLACEABLE.has(link.source)
        && resolution.forbiddenFlavorIds.includes(link.flavorId)
      ) {
        remove.add(link.flavorId);
      }
    });

    const held = new Set(row.flavors.map((link) => link.flavorId));

    /**
     * Links the knowledge base already owns. Re-writing one is a no-op upsert,
     * but it is not a no-op *plan*: a dry run would report a thousand flavor
     * writes and the idempotency check — which is how a reviewer tells a
     * settled catalogue from a drifting one — would never come back clean.
     */
    const owned = new Set(
      row.flavors
        .filter((link) => link.source === FlavorSource.KB)
        .map((link) => link.flavorId),
    );

    /**
     * A wanted peat tag is written even when the bottling already carries it,
     * unless the knowledge base already owns that link. The upsert promotes
     * the source to `kb`, which is what makes the invariant true of the tags
     * that stay and not only of the ones that arrive.
     */
    wanted.forEach((id) => {
      if (!manual.has(id) && !owned.has(id)) {
        insert.add(id);
      }
    });

    /**
     * A required tag outranks the peat sweep, and `Grant's Triple Wood Smoky`
     * is why. Its producer is unpeated, so the sweep drops its `smoky` link;
     * its own name then requires `smoky` back through the global smoke rule.
     * Running the two in the wrong order made the pass oscillate — the tag
     * dropped on one run and restored on the next, forever.
     *
     * `peated` is exempt and always will be. It has exactly one source of
     * truth, `peatProfile`, and letting a rule require it would rebuild the
     * second source this whole exercise exists to remove.
     */
    resolution.requiredFlavorIds.forEach((id) => {
      if (id === peatIds.peated || manual.has(id)) {
        return;
      }

      remove.delete(id);

      if (!owned.has(id)) {
        insert.add(id);
      }
    });

    resolution.baselineFlavorIds.forEach((id) => {
      if (!held.has(id) && !remove.has(id)) {
        insert.add(id);
      }
    });

    return {
      productId: row.id,
      insertFlavorIds: [...insert],
      deleteFlavorIds: [...remove],
    };
  }
}
