import { DEFAULT_CURRENCY } from '~constants';
import type {
  ProductSnapshot,
  ScrapeAdapter,
  ScrapeItemInput,
  ScrapeProgressEvent,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { politeSleep } from '../scrape-timing.util';

import type { ScrapeHttpClient } from '../http/http-client.interfaces';

/**
 * Common base for every store adapter: holds the store spec, paces requests
 * with the store's politeness delay, emits progress, and builds snapshots with
 * sensible defaults. Subclasses implement `fetchListing` and `close`.
 */
export abstract class ScrapeAdapterBase implements ScrapeAdapter {
  public readonly slug: string;

  public readonly supportsDetail: boolean = false;

  protected readonly spec: StoreScrapeSpec;

  protected readonly delayMultiplier: number;

  private readonly reporter?: ScrapeProgressReporter;

  public constructor(
    spec: StoreScrapeSpec,
    delayMultiplier: number,
    reporter?: ScrapeProgressReporter,
  ) {
    this.slug = spec.slug;
    this.spec = spec;
    this.delayMultiplier = delayMultiplier;
    this.reporter = reporter;
  }

  /**
   * Fetches the store's whole whisky listing.
   *
   * @returns The scraped items.
   */
  public abstract fetchListing(): Promise<ProductSnapshot[]>;

  /**
   * Fills a snapshot's empty fields from its detail page. Default no-op for
   * adapters whose listing already carries every field; detail-capable
   * adapters override it.
   *
   * @param _snap - The snapshot that would be enriched; unused here.
   * @returns Always false — nothing was fetched.
   */
  public enrichDetail(_snap: ProductSnapshot): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Releases the adapter's resources.
   *
   * @returns Resolves once closed.
   */
  public abstract close(): Promise<void>;

  /**
   * Sleeps for the store's jittered politeness delay between requests. Public
   * because the engine paces the detail-enrichment loop it drives itself.
   *
   * @returns Resolves once the delay has elapsed.
   */
  public sleep(): Promise<void> {
    return politeSleep(
      this.spec.delayFrom,
      this.spec.delayTo,
      this.delayMultiplier,
    );
  }

  /**
   * Emits a progress event, if a reporter was provided.
   *
   * @param event - The event to emit.
   */
  protected emit(event: ScrapeProgressEvent): void {
    this.reporter?.(event);
  }

  /**
   * Maps one listing page's raw items to snapshots, dropping the unmappable
   * ones and every SKU already collected — stores routinely repeat items
   * across pages, and a re-seen SKU must not be counted as new.
   *
   * @param items - The raw items of one page.
   * @param seen - SKUs collected on the previous pages.
   * @param toSnapshot - Maps one raw item to a snapshot, or null to skip it.
   * @returns The page's new snapshots, in listing order.
   */
  protected freshSnapshots<T>(
    items: T[],
    seen: ReadonlySet<string>,
    toSnapshot: (item: T) => ProductSnapshot | null,
  ): ProductSnapshot[] {
    const fresh = new Map<string, ProductSnapshot>();

    items.forEach((item) => {
      const snap = toSnapshot(item);

      if (snap && !seen.has(snap.storeSku) && !fresh.has(snap.storeSku)) {
        fresh.set(snap.storeSku, snap);
      }
    });

    return [...fresh.values()];
  }

  /**
   * Builds a full snapshot from the store-specific fields, filling `storeSlug`
   * and the defaults for everything omitted.
   *
   * @param input - The store-provided fields.
   * @returns A complete snapshot.
   */
  protected makeSnapshot(input: ScrapeItemInput): ProductSnapshot {
    return {
      storeSlug: this.slug,
      brand: null,
      oldPrice: null,
      currency: DEFAULT_CURRENCY,
      inStock: true,
      promo: false,
      volumeMl: null,
      abv: null,
      ageYears: null,
      whiskyType: null,
      country: null,
      flavorTags: [],
      rawAttrs: {},
      ...input,
    };
  }
}

/**
 * Base for HTTP (non-browser) adapters: owns the retrying HTTP client and
 * closes it on teardown.
 */
export abstract class HttpAdapterBase extends ScrapeAdapterBase {
  protected readonly http: ScrapeHttpClient;

  public constructor(
    spec: StoreScrapeSpec,
    delayMultiplier: number,
    http: ScrapeHttpClient,
    reporter?: ScrapeProgressReporter,
  ) {
    super(spec, delayMultiplier, reporter);

    this.http = http;
  }

  /**
   * Closes the HTTP client.
   *
   * @returns Resolves once closed.
   */
  public close(): Promise<void> {
    return this.http.close();
  }
}
