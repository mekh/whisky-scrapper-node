import { ReportSortField, SortOrder } from '~enums';
import type {
  CachePagePick,
  PreferenceFilterIds,
  ReportGroup,
  ReportOptions,
  ReportOrderKey,
  ReportPageIndex,
} from '~types';

/**
 * A sortable value as a group carries it.
 */
type SortValue = number | string | null | undefined;

/**
 * The options a page selection reads.
 */
type PageOptions = Pick<ReportOptions, 'sort' | 'order' | 'page' | 'perPage'>;

/**
 * Turns a report's result set into a page-addressable index, and picks a
 * caller's page out of one without touching the groups the page leaves out.
 *
 * `buildIndex` runs once per cached set; `select` runs per request and
 * reads only ids and positions, so the groups themselves are fetched and
 * decoded fifty at a time by whoever holds them.
 */
export class ReportPageUtils {
  /**
   * Builds the index of a result set: per-position ids for personalisation
   * and one precomputed order per sortable field and direction.
   *
   * @param groups - The set in the report's natural order.
   * @returns The index; positions refer to `groups`.
   */
  public static buildIndex(groups: ReportGroup[]): ReportPageIndex {
    const natural = groups.map((_, position) => position);

    const sorted = Object.values(ReportSortField).flatMap((field) =>
      Object.values(SortOrder).map((order): [ReportOrderKey, number[]] => [
        ReportPageUtils.orderKey(field, order),
        ReportPageUtils.order(groups, field, order),
      ])
    );

    return {
      ids: groups.map((group) => group.productId),
      producers: groups.map((group) => group.producerId),
      bottlers: groups.map((group) => group.bottlerId),
      orders: {
        natural,
        ...Object.fromEntries(sorted),
      } as Record<ReportOrderKey, number[]>,
    };
  }

  /**
   * Names the order a request reads: the natural one without `sort`, else
   * the field and direction.
   *
   * @param sort - The requested sort field, if any.
   * @param order - The requested direction.
   * @returns The order key.
   */
  public static orderKey(
    sort: ReportSortField | undefined,
    order: SortOrder,
  ): ReportOrderKey {
    return sort ? `${sort}:${order}` : 'natural';
  }

  /**
   * Picks the caller's page: walks the requested order, drops what the
   * caller hid, keeps only favourites when asked, and counts the rest.
   *
   * @param index - The set's index.
   * @param preferences - The caller's favourites and blacklists.
   * @param favoritesOnly - Whether only favourited bottlings are shown.
   * @param options - Sort, direction, page and page size.
   * @returns The page's positions and the visible total.
   */
  public static select(
    index: ReportPageIndex,
    preferences: PreferenceFilterIds,
    favoritesOnly: boolean | undefined,
    options: PageOptions,
  ): CachePagePick {
    const hiddenProducts = new Set(preferences.blacklistProducts);
    const hiddenMakers = new Set(preferences.blacklistProducers);
    const favorites = new Set(preferences.favorites);
    const order = index.orders[
      ReportPageUtils.orderKey(options.sort, options.order)
    ];
    const offset = (options.page - 1) * options.perPage;
    const end = offset + options.perPage;
    const positions: number[] = [];

    let total = 0;

    order.forEach((position) => {
      const productId = index.ids[position] as string;
      const producerId = index.producers[position] ?? null;
      const bottlerId = index.bottlers[position] ?? null;

      const hidden = hiddenProducts.has(productId)
        || (producerId !== null && hiddenMakers.has(producerId))
        || (bottlerId !== null && hiddenMakers.has(bottlerId));

      if (hidden || (favoritesOnly && !favorites.has(productId))) {
        return;
      }

      if (total >= offset && total < end) {
        positions.push(position);
      }

      total += 1;
    });

    return { positions, total };
  }

  /**
   * Orders positions by one field in one direction: nulls last whichever
   * the direction, ties by the primary offer's id ascending.
   *
   * @param groups - The set.
   * @param field - The field to order by.
   * @param order - The direction.
   * @returns The positions in that order.
   */
  private static order(
    groups: ReportGroup[],
    field: ReportSortField,
    order: SortOrder,
  ): number[] {
    const direction = order === SortOrder.DESC ? -1 : 1;

    return groups
      .map((_, position) => position)
      .sort((a, b) => {
        const left = groups[a] as ReportGroup;
        const right = groups[b] as ReportGroup;
        const av = left[field] as SortValue;
        const bv = right[field] as SortValue;

        if (av === null || av === undefined) {
          return bv === null || bv === undefined
            ? left.id.localeCompare(right.id)
            : 1;
        }

        if (bv === null || bv === undefined) {
          return -1;
        }

        return ReportPageUtils.compare(av, bv) * direction
          || left.id.localeCompare(right.id);
      });
  }

  /**
   * Compares two non-null values numerically or case-insensitively.
   *
   * @param a - First value.
   * @param b - Second value.
   * @returns Negative, zero or positive per comparator semantics.
   */
  private static compare(a: number | string, b: number | string): number {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }

    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }
}
