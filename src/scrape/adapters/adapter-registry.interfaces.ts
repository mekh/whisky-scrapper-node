import type { ScrapeProgressReporter, StoreScrapeSpec } from '~types';

import type { ScrapeHttpClient } from '../http/http-client.interfaces';
import type { NormalizeService } from '../normalize/normalize.service';

/**
 * Everything the registry hands a store adapter at construction time.
 */
export interface AdapterDeps {
  /**
   * The store's scrape configuration.
   */
  spec: StoreScrapeSpec;

  /**
   * Per-request delay multiplier from `ScrapeConfig`.
   */
  delayMultiplier: number;

  /**
   * The store's HTTP transport, already wrapped with retry/backoff.
   */
  http: ScrapeHttpClient;

  /**
   * Shared normalization helpers, for adapters that pre-fill fields the site
   * gives them outright.
   */
  normalizer: NormalizeService;

  /**
   * Optional progress sink.
   */
  reporter?: ScrapeProgressReporter;
}
