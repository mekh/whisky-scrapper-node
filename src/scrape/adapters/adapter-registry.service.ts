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
import { NormalizeService } from '../normalize/normalize.service';

import { AlcomagAdapter } from './alcomag';
import { BayaderaAdapter } from './bayadera';
import { FozzyAdapter } from './fozzy';
import { GoodwineAdapter } from './goodwine';
import { MaudauAdapter } from './maudau';
import { OkwineAdapter } from './okwine';
import { RozetkaAdapter } from './rozetka';
import { SilpoAdapter } from './silpo';
import { WinePointAdapter } from './wine-point';
import { WinewineAdapter } from './winewine';
import { ZakazAdapter } from './zakaz';

import type { AdapterDeps } from './adapter-registry.interfaces';

/**
 * Builders for stores that run their own platform, keyed by slug. Every
 * Zakaz.ua network is served by the parameterized `ZakazAdapter` instead and
 * is therefore absent here.
 */
const SPECIALIZED: Record<string, (deps: AdapterDeps) => ScrapeAdapter> = {
  alcomag: (deps) =>
    new AlcomagAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  bayadera: (deps) =>
    new BayaderaAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  fozzy: (deps) =>
    new FozzyAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  maudau: (deps) =>
    new MaudauAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.reporter,
    ),
  okwine: (deps) =>
    new OkwineAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  winewine: (deps) =>
    new WinewineAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  'wine-point': (deps) =>
    new WinePointAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  goodwine: (deps) =>
    new GoodwineAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
  rozetka: (deps) =>
    new RozetkaAdapter(deps.spec, deps.delayMultiplier, deps.reporter),
  silpo: (deps) =>
    new SilpoAdapter(
      deps.spec,
      deps.delayMultiplier,
      deps.http,
      deps.normalizer,
      deps.reporter,
    ),
};

/**
 * Resolves the adapter for a store. Specialized stores are matched by slug and
 * every Zakaz.ua network (a `retailChain`) shares one parameterized adapter.
 * Every store the project scrapes is registered; an unresolved slug is a
 * configuration error.
 */
@Injectable()
export class AdapterRegistryService implements ScrapeAdapterFactory {
  private readonly httpFactory: HttpClientFactory;

  private readonly normalizer: NormalizeService;

  private readonly config: ScrapeConfig;

  public constructor(
    httpFactory: HttpClientFactory,
    normalizer: NormalizeService,
    config: ScrapeConfig,
  ) {
    this.httpFactory = httpFactory;
    this.normalizer = normalizer;
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
    const deps: AdapterDeps = {
      spec,
      delayMultiplier: this.config.delayMultiplier,
      http: this.httpFactory.create(spec.slug),
      normalizer: this.normalizer,
      reporter,
    };
    const specialized = SPECIALIZED[spec.slug];

    if (specialized) {
      return specialized(deps);
    }

    if (spec.retailChain ?? spec.category) {
      return new ZakazAdapter(
        deps.spec,
        deps.delayMultiplier,
        deps.http,
        deps.normalizer,
        deps.reporter,
      );
    }

    throw new ServerError('No scrape adapter registered for store', {
      slug: spec.slug,
    });
  }
}
