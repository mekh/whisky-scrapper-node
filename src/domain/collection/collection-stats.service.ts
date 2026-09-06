import { Injectable } from '@nestjs/common';

import { COLLECTION_STATS_MAX_MONTHS } from '~constants';
import { CoreUserCollectionPurchaseService } from '~core/user-collection';
import { CollectionTimelineGranularity } from '~enums';
import { BadRequestError } from '~errors';
import type {
  CollectionStats,
  CollectionStatsBounds,
  CollectionStatsQuery,
  ID,
} from '~types';

/**
 * A validated month range for the timeline, clamped to what the collection
 * actually spans, plus the bucket width it resolved to.
 */
interface ResolvedRange {
  /**
   * First month of the resolved range (`YYYY-MM`).
   */
  from: string;

  /**
   * Last month of the resolved range (`YYYY-MM`).
   */
  to: string;

  /**
   * Bucket width to build the timeline at.
   */
  granularity: CollectionTimelineGranularity;
}

/**
 * Business layer for the statistics screen: composes the KPI summary, the
 * price extremes, the three breakdowns and the "added over time" timeline
 * from the aggregate reads {@link CoreUserCollectionPurchaseService} exposes.
 */
@Injectable()
export class CollectionStatsService {
  public constructor(
    private readonly purchases: CoreUserCollectionPurchaseService,
  ) {}

  /**
   * Builds the whole statistics screen for the caller's collection.
   *
   * Only the timeline is scoped by the requested range — the summary, the
   * extremes and the three breakdowns always describe the whole collection,
   * because "my collection" is what those numbers are asked about; a
   * range-scoped total would silently disagree with the list the user is
   * looking at elsewhere on the same screen. The independent reads run
   * together with `Promise.all`.
   *
   * @param userId - The authenticated user.
   * @param query - The requested timeline range and bucket width.
   * @returns The composed statistics.
   * @throws {BadRequestError} When `to` is before `from`, or the requested
   *   range spans more than {@link COLLECTION_STATS_MAX_MONTHS} months.
   */
  public async getOwn(
    userId: ID,
    query: CollectionStatsQuery,
  ): Promise<CollectionStats> {
    const bounds = await this.purchases.boundsForUser(userId);
    const range = this.resolveRange(query, bounds);

    const [
      summary,
      mostExpensive,
      cheapest,
      byCountry,
      byRegion,
      byStore,
      buckets,
    ] = await Promise.all([
      this.purchases.summaryForUser(userId),
      this.purchases.mostExpensiveForUser(userId),
      this.purchases.cheapestForUser(userId),
      this.purchases.countByCountryForUser(userId),
      this.purchases.countByRegionForUser(userId),
      this.purchases.countByStoreForUser(userId),
      this.purchases.timelineForUser(
        userId,
        range.from,
        range.to,
        range.granularity,
      ),
    ]);

    return {
      ...summary,
      mostExpensive,
      cheapest,
      byCountry,
      byRegion,
      byStore,
      timeline: {
        granularity: range.granularity,
        from: range.from,
        to: range.to,
        buckets,
      },
      bounds,
    };
  }

  /**
   * Resolves the requested range into one clamped to what the collection
   * actually spans: `from` defaults to the collection's first purchase
   * month (or the current month when it has none at all), `to` defaults to
   * the current month, and the raw, defaulted range is validated *before*
   * either end is clamped — so a range that is merely outside the
   * collection's span is narrowed silently, while one that is genuinely
   * inverted or too wide is rejected rather than quietly fixed.
   *
   * @param query - The raw range request.
   * @param bounds - The collection's actual purchase-month span, or null
   *   when it holds no purchases at all.
   * @returns The resolved, clamped range and bucket width.
   * @throws {BadRequestError} When `to` is before `from`, or the span
   *   exceeds {@link COLLECTION_STATS_MAX_MONTHS} months.
   */
  private resolveRange(
    query: CollectionStatsQuery,
    bounds: CollectionStatsBounds | null,
  ): ResolvedRange {
    const currentMonth = this.currentMonth();
    const floor = bounds?.firstMonth ?? currentMonth;

    const from = query.from ?? floor;
    const to = query.to ?? currentMonth;

    if (to < from) {
      throw new BadRequestError('"from" must not be after "to"');
    }

    const span = this.monthsBetween(from, to);

    if (span > COLLECTION_STATS_MAX_MONTHS) {
      throw new BadRequestError(
        `Range must not exceed ${COLLECTION_STATS_MAX_MONTHS} months`,
      );
    }

    return {
      granularity: query.granularity ?? CollectionTimelineGranularity.MONTH,
      from: this.clampMonth(from, floor, currentMonth),
      to: this.clampMonth(to, floor, currentMonth),
    };
  }

  /**
   * Counts the whole months spanned by `[from, to]`, inclusive.
   *
   * @param from - First month (`YYYY-MM`).
   * @param to - Last month (`YYYY-MM`).
   * @returns The number of months in the range.
   */
  private monthsBetween(from: string, to: string): number {
    const [fromYear, fromMonth] = from.split('-').map(Number);
    const [toYear, toMonth] = to.split('-').map(Number);

    return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
  }

  /**
   * Clamps a `YYYY-MM` month into an inclusive bound. ISO months compare
   * correctly as plain strings, so no date parsing is needed.
   *
   * @param month - The requested month.
   * @param floor - Earliest allowed month.
   * @param ceiling - Latest allowed month.
   * @returns The clamped month.
   */
  private clampMonth(month: string, floor: string, ceiling: string): string {
    if (month < floor) {
      return floor;
    }

    if (month > ceiling) {
      return ceiling;
    }

    return month;
  }

  /**
   * The current UTC month, used to default `to` and, when the collection
   * has no purchases at all, to default and clamp `from` as well.
   *
   * @returns The current month (`YYYY-MM`).
   */
  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }
}
