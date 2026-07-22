import { Injectable } from '@nestjs/common';

import {
  BEST_MERGE_GUARD,
  BEST_MIN_STORES,
  HISTORY_LIMIT,
  NEW_DAYS,
  WINDOW_DAYS,
} from '~constants';
import { CoreProductService } from '~core/product';
import { ReportKind, ReportWindow } from '~enums';
import { NotFoundError, ServerError } from '~errors';
import {
  PriceHistory,
  ReportCurrentRow,
  ReportFilter,
  ReportOptions,
  ReportRow,
  TypePaginated,
} from '~types';

// Tokens dropped when building the "best offer" match key — units and generic
// category words that carry no identity.
const MATCH_STOP_TOKENS = new Set([
  'віскі',
  'виски',
  'whisky',
  'whiskey',
  'бурбон',
  'bourbon',
  'односолодовий',
  'бленд',
  'blended',
  'blend',
  'single',
  'malt',
  'grain',
]);

@Injectable()
export class ReportService {
  public constructor(private readonly products: CoreProductService) {}

  /**
   * Runs a report: builds the rows for the requested kind, applies an optional
   * global sort, then paginates.
   *
   * @param kind - Which report to run.
   * @param filter - The SQL-level product filter.
   * @param options - Window, min-discount, sort, and pagination settings.
   * @returns A page of report rows plus the total matched count.
   */
  public async report(
    kind: ReportKind,
    filter: ReportFilter,
    options: ReportOptions,
  ): Promise<TypePaginated<ReportRow>> {
    const rows = await this.buildRows(kind, filter, options);
    const sorted = this.sort(rows, options);

    const offset = (options.page - 1) * options.perPage;
    const data = sorted.slice(offset, offset + options.perPage);

    return { data, total: sorted.length, limit: options.perPage, offset };
  }

  /**
   * Resolves a product by id or name/URL term and returns it with its price
   * history.
   *
   * @param term - A product id or a name/URL substring.
   * @returns The product row and its chronological price series.
   * @throws {NotFoundError} When no product matches the term.
   */
  public async history(term: string): Promise<PriceHistory> {
    const id = await this.products.resolveIdByTerm(term);
    const current = id ? await this.products.findCurrentRowById(id) : null;

    if (!id || !current) {
      throw new NotFoundError('Product not found', { term });
    }

    const series = await this.products.priceSeries(id, HISTORY_LIMIT);
    const previous = series.length > 1
      ? series[series.length - 2].price
      : null;

    const product = this.enrich(current, {
      referencePrice: previous,
      isNew: false,
    });

    return { product, series };
  }

  /**
   * Dispatches to the per-kind row builder.
   *
   * @param kind - Which report to build.
   * @param filter - The product filter.
   * @param options - Report options (window, min-discount).
   * @returns The report rows in their natural order.
   */
  private async buildRows(
    kind: ReportKind,
    filter: ReportFilter,
    options: ReportOptions,
  ): Promise<ReportRow[]> {
    const [current, latest] = await Promise.all([
      this.products.findCurrentRows(filter),
      this.products.latestDate(),
    ]);

    if (!latest || !current.length) {
      return [];
    }

    switch (kind) {
      case ReportKind.CATALOG:
        return this.catalog(current);
      case ReportKind.DROPS:
        return this.drops(current, options);
      case ReportKind.LOW:
        return this.low(current, options);
      case ReportKind.NEW:
        return this.newest(current, this.today(), options.window);
      case ReportKind.BEST:
        return this.best(current, options);
      default:
        throw new ServerError(`Unknown report kind: ${String(kind)}`);
    }
  }

  /**
   * Full catalog: every current row, with the previous observed price surfaced
   * as the reference when the price dropped since our last snapshot. The
   * discount is measured only against prices we actually recorded — never the
   * store's advertised strike price (`oldPrice`), which is often a permanent
   * anchor that never moved — so it agrees with the price-history view.
   * Ordered by name then price.
   *
   * @param current - All matching current rows.
   * @returns Catalog rows.
   */
  private catalog(current: ReportCurrentRow[]): ReportRow[] {
    const rows = current.map((row) => {
      const reference = row.previousPrice && row.previousPrice > row.price
        ? row.previousPrice
        : null;

      return this.enrich(row, { referencePrice: reference, isNew: false });
    });

    return rows.sort((a, b) =>
      (a.name ?? a.nameOrig).toLowerCase()
        .localeCompare((b.name ?? b.nameOrig).toLowerCase())
      || a.price - b.price
    );
  }

  /**
   * Active discounts: current price below the window maximum from our own
   * price history. The store's advertised strike price (`oldPrice`) is never
   * used, so a permanent marketing anchor cannot fabricate a discount here.
   * Ordered by discount desc.
   *
   * @param current - All matching current rows.
   * @param options - Report options (window, min-discount).
   * @returns Discount rows.
   */
  private async drops(
    current: ReportCurrentRow[],
    options: ReportOptions,
  ): Promise<ReportRow[]> {
    const cutoff = this.cutoff(current, WINDOW_DAYS[options.window]);
    const extremes = await this.products.priceExtremes(cutoff);

    const rows = current
      .map((row) => {
        const windowMax = extremes.get(row.id)?.max ?? null;
        const reference = this.referencePrice(row, windowMax);

        return this.enrich(row, { referencePrice: reference, isNew: false });
      })
      .filter((row) => row.discountPct !== null);

    return this.applyMinDiscount(rows, options)
      .sort((a, b) => (b.discountPct ?? 0) - (a.discountPct ?? 0));
  }

  /**
   * Window lows: products whose current price equals their minimum over the
   * window and that carry a real discount vs the previous snapshot.
   *
   * @param current - All matching current rows.
   * @param options - Report options (window, min-discount).
   * @returns Window-low rows.
   */
  private async low(
    current: ReportCurrentRow[],
    options: ReportOptions,
  ): Promise<ReportRow[]> {
    const cutoff = this.cutoff(current, WINDOW_DAYS[options.window]);
    const extremes = await this.products.priceExtremes(cutoff);

    const rows = current
      .filter((row) => {
        const min = extremes.get(row.id)?.min;

        return min !== undefined && row.price <= min + 1e-9;
      })
      .map((row) =>
        this.enrich(row, {
          referencePrice: row.previousPrice,
          isNew: false,
        })
      )
      .filter((row) => row.discountPct !== null);

    return this.applyMinDiscount(rows, options)
      .sort((a, b) => (b.discountPct ?? 0) - (a.discountPct ?? 0));
  }

  /**
   * New listings: products first seen within the "new" window, optionally
   * narrowed by when they were added (`window`). Ordered by recency (newest
   * first) then price.
   *
   * Recency is measured against the real current date, not the latest snapshot
   * date, so an item's age reflects real elapsed calendar days: a product first
   * seen 11 days ago reads as "11 днів" even if the scrape data is stale (and
   * the whole report is empty when nothing appeared in the last `NEW_DAYS`).
   *
   * @param current - All matching current rows.
   * @param today - Today's date (`YYYY-MM-DD`), the recency reference point.
   * @param window - When `today`/`yesterday`, keeps only products added that
   *   many days ago; any other window keeps the whole "new" window.
   * @returns New-listing rows.
   */
  private newest(
    current: ReportCurrentRow[],
    today: string,
    window: ReportWindow,
  ): ReportRow[] {
    const since = this.addDays(today, -(NEW_DAYS - 1));

    const rows = current
      .filter((row) => row.firstSeen >= since)
      .map((row) =>
        this.enrich(row, {
          referencePrice: null,
          isNew: true,
          daysNew: this.daysBetween(row.firstSeen, today),
        })
      )
      .filter((row) => this.matchesAddedWindow(row.daysNew, window));

    return rows.sort((a, b) =>
      (a.daysNew ?? 0) - (b.daysNew ?? 0) || a.price - b.price
    );
  }

  /**
   * Whether a new listing's age matches the requested "added" window.
   *
   * @param daysNew - Days since the product first appeared (0 = today).
   * @param window - The requested window; only `today`/`yesterday` narrow the
   *   result, every other window matches the full "new" range.
   * @returns True when the row should be kept.
   */
  private matchesAddedWindow(
    daysNew: number | null,
    window: ReportWindow,
  ): boolean {
    if (window === ReportWindow.TODAY) {
      return daysNew === 0;
    }

    if (window === ReportWindow.YESTERDAY) {
      return daysNew === 1;
    }

    return true;
  }

  /**
   * Best offers: products sold in several stores, keeping the cheapest and
   * marking the saving against the runner-up. Ordered by saving desc.
   *
   * @param current - All matching current rows.
   * @param options - Report options (min-discount).
   * @returns One row per multi-store product group.
   */
  private best(
    current: ReportCurrentRow[],
    options: ReportOptions,
  ): ReportRow[] {
    const groups = this.groupByMatchKey(current);
    const rows: ReportRow[] = [];

    groups.forEach((group) => {
      const row = this.bestOfGroup(group);

      if (row) {
        rows.push(row);
      }
    });

    return this.applyMinDiscount(rows, options)
      .sort((a, b) => (b.discountPct ?? 0) - (a.discountPct ?? 0));
  }

  /**
   * Picks the cheapest offer from a match-key group, guarding against merging
   * mismatched SKUs, and marks its saving against the runner-up.
   *
   * @param group - Current rows sharing a match key.
   * @returns The best-offer row, or null when the group is not a valid deal.
   */
  private bestOfGroup(group: ReportCurrentRow[]): ReportRow | null {
    const stores = new Set(group.map((row) => row.storeSlug));

    if (stores.size < BEST_MIN_STORES) {
      return null;
    }

    const ordered = [...group].sort((a, b) => a.price - b.price);
    const [best, runnerUp] = ordered;

    if (best.price < runnerUp.price * BEST_MERGE_GUARD) {
      return null;
    }

    return this.enrich(best, {
      referencePrice: runnerUp.price,
      isNew: false,
    });
  }

  /**
   * Groups current rows by a canonical match key (brand + significant name
   * tokens + volume + age). Rows without a volume are skipped (can't be
   * matched confidently).
   *
   * @param current - All matching current rows.
   * @returns Match key → rows sharing it.
   */
  private groupByMatchKey(
    current: ReportCurrentRow[],
  ): Map<string, ReportCurrentRow[]> {
    return current.reduce((groups, row) => {
      if (!row.volumeMl) {
        return groups;
      }

      const key = this.matchKey(row);
      const group = groups.get(key) ?? [];
      group.push(row);

      return groups.set(key, group);
    }, new Map<string, ReportCurrentRow[]>());
  }

  /**
   * Builds the canonical match key for a product.
   *
   * @param row - The current row.
   * @returns A stable key identifying the same product across stores.
   */
  private matchKey(row: ReportCurrentRow): string {
    const normalized = (row.name ?? row.nameOrig)
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/[^0-9a-zа-яіїєґ]+/g, ' ');

    const tokens = new Set(
      normalized
        .split(' ')
        .filter((token) =>
          token.length >= 2
          && !MATCH_STOP_TOKENS.has(token)
          && !/^\d+(?:[.,]\d+)?(?:мл|л|l|ml)?$/.test(token)
        ),
    );

    if (row.brand) {
      tokens.add(row.brand.toLowerCase().replace(/[^0-9a-zа-яіїєґ]+/g, ''));
    }

    const signature = [...tokens].sort().join(' ');

    return `${signature}|v${row.volumeMl ?? 0}|a${row.age ?? 0}`;
  }

  /**
   * Removes rows whose discount is below the requested minimum.
   *
   * @param rows - Candidate rows.
   * @param options - Report options carrying `minDiscount`.
   * @returns The filtered rows (unchanged when no minimum is set).
   */
  private applyMinDiscount(
    rows: ReportRow[],
    options: ReportOptions,
  ): ReportRow[] {
    const min = options.minDiscount;

    if (!min) {
      return rows;
    }

    return rows.filter((row) => (row.discountPct ?? 0) >= min);
  }

  /**
   * Sorts rows by the requested field with nulls last, or returns them in the
   * report's natural order when no sort field is set.
   *
   * @param rows - The rows to sort.
   * @param options - Report options carrying `sort`/`order`.
   * @returns The sorted rows (a new array).
   */
  private sort(rows: ReportRow[], options: ReportOptions): ReportRow[] {
    if (!options.sort) {
      return rows;
    }

    const field = options.sort;
    const direction = options.order === 'desc' ? -1 : 1;

    return [...rows].sort((a, b) => {
      const av = a[field] as number | string | null;
      const bv = b[field] as number | string | null;

      if (av === null || av === undefined) {
        return bv === null || bv === undefined ? 0 : 1;
      }

      if (bv === null || bv === undefined) {
        return -1;
      }

      return this.compare(av, bv) * direction;
    });
  }

  /**
   * Compares two non-null values numerically or case-insensitively.
   *
   * @param a - First value.
   * @param b - Second value.
   * @returns Negative, zero, or positive per standard comparator semantics.
   */
  private compare(a: number | string, b: number | string): number {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }

    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }

  /**
   * Enriches a current row into a report row: computes the discount against
   * the given reference price and attaches the new-listing flags.
   *
   * @param row - The base current row.
   * @param extra - Reference price and new-listing flags.
   * @returns The enriched report row.
   */
  private enrich(
    row: ReportCurrentRow,
    extra: { referencePrice: number | null; isNew: boolean; daysNew?: number },
  ): ReportRow {
    return {
      ...row,
      referencePrice: extra.referencePrice,
      discountPct: this.discountPct(row.price, extra.referencePrice),
      isNew: extra.isNew,
      daysNew: extra.daysNew ?? null,
    };
  }

  /**
   * The window maximum from our price history if it beats the current price,
   * else null. Discounts are measured only against prices we actually
   * observed, never the store's advertised strike price.
   *
   * @param row - The current row.
   * @param windowMax - Maximum price over the reference window, if any.
   * @returns The reference price, or null when there is no discount.
   */
  private referencePrice(
    row: ReportCurrentRow,
    windowMax: number | null,
  ): number | null {
    if (windowMax && windowMax > row.price) {
      return windowMax;
    }

    return null;
  }

  /**
   * Whole-percent discount of a price against a reference.
   *
   * @param current - The current price.
   * @param reference - The reference price, or null.
   * @returns The rounded discount percent, or null when there is no discount.
   */
  private discountPct(
    current: number,
    reference: number | null,
  ): number | null {
    if (!reference || reference <= 0 || current >= reference) {
      return null;
    }

    return Math.round((reference - current) / reference * 100);
  }

  /**
   * Today's date as `YYYY-MM-DD` (UTC, matching the `addDays`/`daysBetween`
   * midnight basis). Used as the `new` report's recency reference so listing
   * ages reflect real elapsed days rather than how fresh the latest scrape is.
   *
   * @returns The current date (`YYYY-MM-DD`).
   */
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Computes the window cutoff date relative to the catalog's latest date.
   *
   * @param current - Current rows (for their capture dates).
   * @param days - Window length in days.
   * @returns The cutoff date (`YYYY-MM-DD`).
   */
  private cutoff(current: ReportCurrentRow[], days: number): string {
    const latest = current.reduce(
      (max, row) => row.capturedDate > max ? row.capturedDate : max,
      current[0].capturedDate,
    );

    return this.addDays(latest, -days);
  }

  /**
   * Adds (or subtracts) whole days to a `YYYY-MM-DD` date.
   *
   * @param date - The base date (`YYYY-MM-DD`).
   * @param days - Days to add (negative to subtract).
   * @returns The shifted date (`YYYY-MM-DD`).
   */
  private addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;

    return new Date(ms).toISOString().slice(0, 10);
  }

  /**
   * Whole days between two `YYYY-MM-DD` dates.
   *
   * @param from - Earlier date.
   * @param to - Later date.
   * @returns The day count (0 when equal).
   */
  private daysBetween(from: string, to: string): number {
    const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);

    return Math.round(ms / 86_400_000);
  }
}
