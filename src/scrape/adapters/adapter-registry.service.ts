import { Injectable } from '@nestjs/common';

import { ScrapeConfig } from '~config';
import { ServerError } from '~errors';
import type {
  ScrapeAdapter,
  ScrapeAdapterFactory,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { HttpClientFactory } from '../http/http-client.factory';

/**
 * Resolves the adapter for a store. Specialized stores are matched by slug and
 * every Zakaz.ua network (a `retailChain`) shares one parameterized adapter —
 * both are wired in as adapters are ported (steps 6-9). An unresolved slug is
 * a configuration error.
 */
@Injectable()
export class AdapterRegistryService implements ScrapeAdapterFactory {
  private readonly httpFactory: HttpClientFactory;

  private readonly config: ScrapeConfig;

  public constructor(httpFactory: HttpClientFactory, config: ScrapeConfig) {
    this.httpFactory = httpFactory;
    this.config = config;
  }

  /**
   * Builds the adapter for a store.
   *
   * @param spec - The store's scrape configuration.
   * @param reporter - Optional progress reporter passed to the adapter.
   * @returns The store's adapter.
   * @throws {ServerError} When no adapter is registered for the store.
   */
  public create(
    spec: StoreScrapeSpec,
    reporter?: ScrapeProgressReporter,
  ): ScrapeAdapter {
    // Concrete adapters are registered here as they are ported. Until then,
    // resolving a slug is a configuration error. `httpFactory`/`config` are the
    // dependencies those adapters will be built from.
    void this.httpFactory;
    void this.config;
    void reporter;

    throw new ServerError('No scrape adapter registered for store', {
      slug: spec.slug,
    });
  }
}
