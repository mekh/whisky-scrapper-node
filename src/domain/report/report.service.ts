import { Injectable } from '@nestjs/common';

import {
  BEST_MERGE_GUARD,
  BEST_MIN_STORES,
  HISTORY_LIMIT,
  NEW_DAYS,
  WINDOW_DAYS,
} from '~constants';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow } from '~enums';
import { NotFoundError, ServerError } from '~errors';
import {
  ID,
  PriceHistory,
  ReportCurrentRow,
  ReportFilter,
  ReportGroup,
  ReportOffer,
  ReportOptions,
  ReportRow,
  TypePaginated,
} from '~types';

@Injectable()
export class ReportService {
  public constructor(
    private readonly offers: CoreStoreProductService,
    private readonly snapshots: CorePriceSnapshotService,
  ) {}

  /**
   * Runs a report: builds the product groups for the requested kind, applies
   * an optional global sort, then paginates.
   *
   * Pagination counts groups, not offers: a page of 50 is 50 distinct
   * bottlings however many stores carry them, which is the whole point of
   * grouping — a screen of offers used to be a handful of whiskies repeated.
   *
   * @param kind - Which report to run.
   * @param filter - The SQL-level product filter.
   * @param options - Window, min-discount, sort, and pagination settings.
   * @returns A page of report groups plus the total matched group count.
   */
  public async report(
    kind: ReportKind,
    filter: ReportFilter,
    options: ReportOptions,
  ): Promise<TypePaginated<ReportGroup>> {
    const groups = await this.buildGroups(kind, filter, options);
    const sorted = this.sort(groups, options);

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
    const id = await this.offers.resolveIdByTerm(term);
    const current = id ? await this.offers.findCurrentRowById(id) : null;

    if (!id || !current) {
      throw new NotFoundError('Product not found', { term });
    }

    const series = await this.snapshots.priceSeries(id, HISTORY_LIMIT);
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
   * Dispatches to the per-kind group builder.
   *
   * Each kind selects its offers exactly as it always did and only then groups
   * them, so the grouping can never disagree with the selection: an offer a
   * report rejected is absent from its product's group too. `low` and `best`
   * pick one offer per row by design and therefore yield single-offer groups.
   *
   * The one predicate that cannot run in SQL for every kind is the price
   * bound — see `selectionFilter`.
   *
   * @param kind - Which report to build.
   * @param filter - The product filter.
   * @param options - Report options (window, min-discount).
   * @returns The report groups in their natural order.
   */
  private async buildGroups(
    kind: ReportKind,
    filter: ReportFilter,
    options: ReportOptions,
  ): Promise<ReportGroup[]> {
    const [current, latest] = await Promise.all([
      this.offers.findCurrentRows(this.selectionFilter(kind, filter)),
      this.snapshots.latestDate(),
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
        return this.best(current, filter, options);
      default:
        throw new ServerError(`Unknown report kind: ${String(kind)}`);
    }
  }

  /**
   * The filter the current rows are selected with: the caller's filter for
   * every report but `best`, which is asked for its candidates without the
   * price bounds.
   *
   * `best` is the one kind that compares a bottling's offers against each
   * other, so an offer the user would never buy still has to be loaded. Drop
   * the runner-up in SQL because it costs more than the ceiling and the group
   * falls under the two-store guard, taking the affordable offer the report
   * exists to show down with it: a whisky listed at 1699 in one store and 3299
   * in another disappeared from `maxPrice=2000` entirely. A surviving group
   * would be misreported too, its saving measured against whichever runner-up
   * happened to fit the bounds. The bounds are applied to the winning offer
   * instead (see `best`) — the price the user would actually pay.
   *
   * @param kind - The report being built.
   * @param filter - The caller's filter.
   * @returns The filter to select the current rows with.
   */
  private selectionFilter(
    kind: ReportKind,
    filter: ReportFilter,
  ): ReportFilter {
    if (kind !== ReportKind.BEST) {
      return filter;
    }

    return { ...filter, minPrice: undefined, maxPrice: undefined };
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
   * @returns Catalog groups, one per bottling, holding every in-stock offer.
   */
  private catalog(current: ReportCurrentRow[]): ReportGroup[] {
    const rows = current.map((row) =>
      this.enrich(row, {
        referencePrice: this.previousDrop(row),
        isNew: false,
      })
    );

    return this.groupOffers(rows).sort((a, b) =>
      (a.name ?? a.nameOrig).toLowerCase()
        .localeCompare((b.name ?? b.nameOrig).toLowerCase())
      || a.price - b.price
      || a.id.localeCompare(b.id)
    );
  }

  /**
   * Active discounts: current price below the window maximum from our own
   * price history. The store's advertised strike price (`oldPrice`) is never
   * used, so a permanent marketing anchor cannot fabricate a discount here.
   * Each row also carries `daysDiscount`: how long the current price has held
   * (measured against the real current date, like the `new` report's age), and
   * `discountWindow` narrows the report to the drops of one day by it.
   * Ordered by discount desc.
   *
   * @param current - All matching current rows.
   * @param options - Report options (window, discount window, min-discount).
   * @returns Discount groups, each holding only that bottling's discounted
   *   offers.
   */
  private async drops(
    current: ReportCurrentRow[],
    options: ReportOptions,
  ): Promise<ReportGroup[]> {
    const cutoff = this.cutoff(current, WINDOW_DAYS[options.window]);

    const [extremes, priceSince] = await Promise.all([
      this.snapshots.priceExtremes(cutoff),
      this.snapshots.currentPriceSince(),
    ]);

    const today = this.today();

    const rows = current
      .map((row) => {
        const windowMax = extremes.get(row.id)?.max ?? null;
        const reference = this.referencePrice(row, windowMax);
        const since = priceSince.get(row.id) ?? null;

        return this.enrich(row, {
          referencePrice: reference,
          isNew: false,
          daysDiscount: since === null ? null : this.daysBetween(since, today),
        });
      })
      .filter((row) =>
        row.discountPct !== null
        && this.matchesDayWindow(row.daysDiscount, options.discountWindow)
      );

    return this.groupOffers(this.applyMinDiscount(rows, options))
      .sort((a, b) =>
        (b.discountPct ?? 0) - (a.discountPct ?? 0) || a.id.localeCompare(b.id)
      );
  }

  /**
   * Window lows: products whose current price equals their minimum over the
   * window and that carry a real discount vs the previous snapshot.
   *
   * Selection is per offer, and it stays that way: two stores can both be at
   * their own window low, and collapsing them would hide one of the two lows
   * this report exists to show. Each qualifying offer therefore becomes its own
   * single-offer group, so what the user sees is unchanged.
   *
   * @param current - All matching current rows.
   * @param options - Report options (window, min-discount).
   * @returns Window-low groups, one per qualifying offer.
   */
  private async low(
    current: ReportCurrentRow[],
    options: ReportOptions,
  ): Promise<ReportGroup[]> {
    const cutoff = this.cutoff(current, WINDOW_DAYS[options.window]);
    const extremes = await this.snapshots.priceExtremes(cutoff);

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

    return this.wrapOffers(this.applyMinDiscount(rows, options))
      .sort((a, b) =>
        (b.discountPct ?? 0) - (a.discountPct ?? 0) || a.id.localeCompare(b.id)
      );
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
   * @returns New-listing groups, each holding only that bottling's newly
   *   listed offers — a whisky two stores just started carrying lists exactly
   *   those two, not every store that has had it for months.
   */
  private newest(
    current: ReportCurrentRow[],
    today: string,
    window: ReportWindow,
  ): ReportGroup[] {
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
      .filter((row) => this.matchesDayWindow(row.daysNew, window));

    return this.groupOffers(rows).sort((a, b) =>
      (a.daysNew ?? 0) - (b.daysNew ?? 0) || a.price - b.price
      || a.id.localeCompare(b.id)
    );
  }

  /**
   * Whether a day count matches a single-day window. Shared by the `new`
   * report's "added on" narrowing (`daysNew`) and the `drops` report's
   * "discounted on" one (`daysDiscount`) — the two carry the same
   * today/yesterday semantics over different columns.
   *
   * @param days - Days since the event (0 = today), or null when unknown.
   * @param window - The requested window; only `today`/`yesterday` narrow the
   *   result, every other window (and none at all) matches everything.
   * @returns True when the row should be kept.
   */
  private matchesDayWindow(
    days: number | null,
    window?: ReportWindow,
  ): boolean {
    if (window === ReportWindow.TODAY) {
      return days === 0;
    }

    if (window === ReportWindow.YESTERDAY) {
      return days === 1;
    }

    return true;
  }

  /**
   * Best offers: products sold in several stores, keeping the cheapest and
   * marking the saving against the runner-up. Ordered by saving desc.
   *
   * The group carries every in-stock offer of the bottling, exactly as the
   * catalog's groups do. It used to carry the winner alone, on the grounds
   * that `referencePrice` already states the comparison — but a price is not
   * an offer: it names neither the store that asks it nor the page to open,
   * and the client renders a group's other offers anyway. Only the winner is
   * enriched against the runner-up; every other offer reads as it would in the
   * catalog, against its own previous price.
   *
   * The price bounds are applied here rather than in SQL, because the rows
   * this report is handed deliberately still hold the offers that fall outside
   * them — they are what the winner is compared against (see
   * `selectionFilter`). A bound therefore filters the winning offer, which is
   * the only price this report ever quotes.
   *
   * @param current - All matching current rows, price bounds not yet applied.
   * @param filter - The report filter, for its price bounds.
   * @param options - Report options (min-discount).
   * @returns One group per multi-store bottling, led by its winning offer.
   */
  private best(
    current: ReportCurrentRow[],
    filter: ReportFilter,
    options: ReportOptions,
  ): ReportGroup[] {
    const groups: ReportGroup[] = [];

    this.groupByProduct(current).forEach((group) => {
      const winner = this.bestOfGroup(group);

      if (winner && this.withinPriceBounds(winner.price, filter)) {
        groups.push(this.toGroup(winner, this.bestOffers(group, winner)));
      }
    });

    return this.applyMinDiscount(groups, options)
      .sort((a, b) =>
        (b.discountPct ?? 0) - (a.discountPct ?? 0) || a.id.localeCompare(b.id)
      );
  }

  /**
   * Picks the cheapest offer of one bottling and marks its saving against the
   * runner-up.
   *
   * Both guards still earn their place after the split. A group has to span at
   * least two stores because one store alone can list the same bottling twice
   * (two SKUs, say a boxed and a plain listing) and undercutting yourself is
   * not a deal. And a best price far below the runner-up still means something
   * is wrong — no longer a name key merging two whiskies, but a mislinked
   * offer, which is the failure mode manual curation exists to fix.
   *
   * The candidates are ordered by the same comparator the group's offers are,
   * so the winner is also `offers[0]` — the invariant every group keeps — and
   * two offers at one price can no longer swap the winner between requests.
   *
   * @param group - Current rows sharing a canonical product.
   * @returns The best-offer row, or null when the group is not a valid deal.
   */
  private bestOfGroup(group: ReportCurrentRow[]): ReportRow | null {
    const stores = new Set(group.map((row) => row.storeSlug));

    if (stores.size < BEST_MIN_STORES) {
      return null;
    }

    const ordered = [...group].sort((a, b) => this.byOfferPrice(a, b));
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
   * The offers of one bottling as `best` states them: the winner exactly as
   * the group header reads it — its saving against the runner-up — and every
   * other offer as the catalog would state it, against its own previous price.
   * The two discounts answer different questions (what this bottling costs
   * elsewhere; whether this store has moved its price), and only the winner's
   * is the report's own claim.
   *
   * Offers outside the price bounds are deliberately kept: a runner-up above
   * the user's ceiling is the whole reason the winner is a deal, and the group
   * already quotes its price.
   *
   * @param group - Current rows sharing a canonical product.
   * @param winner - The enriched winning row, already picked from the group.
   * @returns The group's offers, cheapest first, led by the winner.
   */
  private bestOffers(
    group: ReportCurrentRow[],
    winner: ReportRow,
  ): ReportOffer[] {
    return group
      .map((row) =>
        row.id === winner.id ? winner : this.enrich(row, {
          referencePrice: this.previousDrop(row),
          isNew: false,
        })
      )
      .sort((a, b) => this.byOfferPrice(a, b))
      .map((row) => this.toOffer(row));
  }

  /**
   * Whether a price satisfies the filter's price bounds.
   *
   * Only `best` asks: every other report has both bounds applied in SQL, where
   * they select the offers and can do no harm.
   *
   * @param price - The price to test.
   * @param filter - The report filter carrying the bounds.
   * @returns True when the price is within every bound the filter sets.
   */
  private withinPriceBounds(price: number, filter: ReportFilter): boolean {
    const min = filter.minPrice ?? null;
    const max = filter.maxPrice ?? null;

    return (min === null || price >= min) && (max === null || price <= max);
  }

  /**
   * Groups current rows by the bottling they are offers of.
   *
   * The grouping is read straight off the persisted link, never recomputed
   * here. This service used to derive its own token key from the row, which
   * meant the read side held a second, competing opinion about which offers are
   * the same whisky — and the two would diverge the moment someone corrected a
   * link by hand, which is exactly what the catalogue exists to allow. Persist
   * decides identity once; the report just reads it.
   *
   * Volume-less rows are no longer skipped. That skip existed because the old
   * key embedded the volume, so two unrelated bottlings with no size collapsed
   * onto one signature and the group could not be trusted. A canonical row is
   * one curated bottling whatever its volume, so there is nothing left to
   * guard against, and a genuine cross-store deal stops being invisible.
   *
   * @param rows - The rows to group, current or already enriched.
   * @returns Canonical product id → the offers of it.
   */
  private groupByProduct<T extends { productId: ID }>(
    rows: T[],
  ): Map<ID, T[]> {
    return rows.reduce((groups, row) => {
      const group = groups.get(row.productId) ?? [];
      group.push(row);

      return groups.set(row.productId, group);
    }, new Map<ID, T[]>());
  }

  /**
   * Collapses report rows into one group per bottling, cheapest offer first.
   *
   * The cheapest offer is always the primary one — the price the collapsed row
   * states and the value an offer-level sort orders by — even when a pricier
   * store advertises a bigger percentage off. A user comparing offers is
   * choosing what to pay, so 1000 at −10% beats 1100 at −15%.
   *
   * @param rows - The rows the report selected, already enriched.
   * @returns One group per bottling, offers ordered by price ascending.
   */
  private groupOffers(rows: ReportRow[]): ReportGroup[] {
    const grouped = Array.from(this.groupByProduct(rows).values());

    return grouped.map((group) => {
      const ordered = [...group].sort((a, b) => this.byOfferPrice(a, b));

      return this.toGroup(ordered[0], ordered.map((row) => this.toOffer(row)));
    });
  }

  /**
   * Wraps each row as its own single-offer group, for `low` — the one report
   * that selects per offer and must keep doing so, since two stores can both
   * be at their own window low and collapsing them would hide one of the two
   * lows the report exists to show.
   *
   * @param rows - The rows the report selected.
   * @returns One single-offer group per row, in the input order.
   */
  private wrapOffers(rows: ReportRow[]): ReportGroup[] {
    return rows.map((row) => this.toGroup(row, [this.toOffer(row)]));
  }

  /**
   * Builds a group from its primary offer and its offers.
   *
   * Every group-level field is the primary offer's, which is what lets the
   * whole report keep working unchanged: the global sort, the min-discount
   * filter and every column the client already renders read the same fields
   * they always did, now meaning "of the cheapest offer".
   *
   * @param primary - The offer the group leads with (the cheapest one).
   * @param offers - The group's offers, cheapest first.
   * @returns The report group.
   */
  private toGroup(primary: ReportRow, offers: ReportOffer[]): ReportGroup {
    return { ...primary, offers };
  }

  /**
   * Projects a report row onto its offer-level fields.
   *
   * Spelled out rather than spread so the payload cannot silently grow: the
   * bottling's name, specs and flavors are stated once per group, and repeating
   * them per offer would multiply a page's size by the number of stores.
   *
   * @param row - The enriched report row.
   * @returns The offer view of it.
   */
  private toOffer(row: ReportRow): ReportOffer {
    return {
      id: row.id,
      sku: row.sku,
      url: row.url,
      nameOrig: row.nameOrig,
      storeSlug: row.storeSlug,
      storeName: row.storeName,
      price: row.price,
      oldPrice: row.oldPrice,
      currency: row.currency,
      promo: row.promo,
      inStock: row.inStock,
      previousPrice: row.previousPrice,
      referencePrice: row.referencePrice,
      discountPct: row.discountPct,
      isNew: row.isNew,
      daysNew: row.daysNew,
      daysDiscount: row.daysDiscount,
      firstSeen: row.firstSeen,
      capturedDate: row.capturedDate,
    };
  }

  /**
   * Orders two offers of one bottling by price, then deterministically.
   *
   * The tie-breakers are not cosmetic: the current-rows query has no `ORDER BY`
   * of its own, so two equally priced offers would otherwise swap places
   * between requests, and with them the group's primary offer — the store, URL
   * and history the collapsed row points at.
   *
   * It takes the offer-level fields alone rather than a whole `ReportRow`,
   * because `best` orders its candidates with it before any of them is
   * enriched.
   *
   * @param a - First offer.
   * @param b - Second offer.
   * @returns Negative, zero, or positive per standard comparator semantics.
   */
  private byOfferPrice(
    a: Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'>,
    b: Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'>,
  ): number {
    return a.price - b.price
      || a.storeName.localeCompare(b.storeName)
      || a.id.localeCompare(b.id);
  }

  /**
   * Removes rows whose discount is below the requested minimum.
   *
   * Generic over the row type so `best` can filter the groups it has already
   * built — its offers are chosen per group, not per surviving row.
   *
   * @param rows - Candidate rows.
   * @param options - Report options carrying `minDiscount`.
   * @returns The filtered rows (unchanged when no minimum is set).
   */
  private applyMinDiscount<T extends ReportRow>(
    rows: T[],
    options: ReportOptions,
  ): T[] {
    const min = options.minDiscount;

    if (!min) {
      return rows;
    }

    return rows.filter((row) => (row.discountPct ?? 0) >= min);
  }

  /**
   * Sorts items by the requested field with nulls last, or returns them in the
   * report's natural order when no sort field is set.
   *
   * Equal sort keys fall back to the item id. Without it the comparator leaves
   * such items in whatever order the unordered current-rows query returned, so
   * a product could appear on two pages or on none — which the client's
   * infinite scroll would show as a duplicate or a gap.
   *
   * @param rows - The items to sort (report groups, or the rows behind them).
   * @param options - Report options carrying `sort`/`order`.
   * @returns The sorted items (a new array).
   */
  private sort<T extends ReportRow>(rows: T[], options: ReportOptions): T[] {
    if (!options.sort) {
      return rows;
    }

    const field = options.sort;
    const direction = options.order === 'desc' ? -1 : 1;

    return [...rows].sort((a, b) => {
      const av = a[field] as number | string | null;
      const bv = b[field] as number | string | null;

      if (av === null || av === undefined) {
        return bv === null || bv === undefined ? a.id.localeCompare(b.id) : 1;
      }

      if (bv === null || bv === undefined) {
        return -1;
      }

      return this.compare(av, bv) * direction || a.id.localeCompare(b.id);
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
    extra: {
      referencePrice: number | null;
      isNew: boolean;
      daysNew?: number;
      daysDiscount?: number | null;
    },
  ): ReportRow {
    return {
      ...row,
      referencePrice: extra.referencePrice,
      discountPct: this.discountPct(row.price, extra.referencePrice),
      isNew: extra.isNew,
      daysNew: extra.daysNew ?? null,
      daysDiscount: extra.daysDiscount ?? null,
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
   * The row's own previous price when the price has fallen since, else null.
   *
   * This is what an offer-level discount means on every report that states one
   * — measured against a price we actually recorded, never the store's
   * advertised strike price — so the catalog's offers and the offers `best`
   * lists beside its winner read identically.
   *
   * @param row - The current row.
   * @returns The previous price when it beats the current one, else null.
   */
  private previousDrop(row: ReportCurrentRow): number | null {
    return row.previousPrice && row.previousPrice > row.price
      ? row.previousPrice
      : null;
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
