import 'reflect-metadata';

import { AdapterRegistryService } from '../../src/scrape/adapters/adapter-registry.service';
import { GoodwineAdapter } from '../../src/scrape/adapters/goodwine';
import { MaudauAdapter } from '../../src/scrape/adapters/maudau';
import { OkwineAdapter } from '../../src/scrape/adapters/okwine';
import { RozetkaAdapter } from '../../src/scrape/adapters/rozetka';
import { WinePointAdapter } from '../../src/scrape/adapters/wine-point';
import { WinewineAdapter } from '../../src/scrape/adapters/winewine';
import { ZakazAdapter } from '../../src/scrape/adapters/zakaz';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';

import type { ScrapeConfig } from '~config';
import type { StoreScrapeSpec } from '~types';
import type { HttpClientFactory } from '../../src/scrape/http/http-client.factory';

/**
 * Every Zakaz.ua network in `store_config` today: each one must resolve to the
 * shared parameterized adapter.
 */
const ZAKAZ_CHAINS = [
  'alcohub',
  'auchan',
  'chudomarket',
  'cosmos',
  'ekomarket',
  'epicentr',
  'grono',
  'ideal',
  'kharkiv',
  'megamarket',
  'metro',
  'novus',
  'onde',
  'tavriav',
  'torba',
  'ultramarket',
  'vostorg',
  'winetime',
  'zaraz',
];

/**
 * Builds a store spec for the registry.
 *
 * @param slug - Store slug.
 * @param over - Chain / category overrides.
 * @returns The spec.
 */
function spec(
  slug: string,
  over: Partial<StoreScrapeSpec> = {},
): StoreScrapeSpec {
  return {
    slug,
    name: slug,
    baseUrl: `https://${slug}.test`,
    tier: 1,
    needsBrowser: false,
    retailChain: null,
    category: null,
    delayFrom: 0,
    delayTo: 0,
    ...over,
  };
}

/**
 * Builds the registry with stub dependencies.
 *
 * @returns The registry under test.
 */
function makeRegistry(): AdapterRegistryService {
  const httpFactory = {
    create: (): unknown => ({
      get: (): unknown => undefined,
      close: async (): Promise<void> => undefined,
    }),
  } as unknown as HttpClientFactory;

  return new AdapterRegistryService(
    httpFactory,
    new NormalizeService(),
    { delayMultiplier: 1 } as ScrapeConfig,
  );
}

describe('AdapterRegistryService', () => {
  it('serves every Zakaz.ua chain with the shared adapter', () => {
    const registry = makeRegistry();

    ZAKAZ_CHAINS.forEach((slug) => {
      const adapter = registry.create(
        spec(slug, { retailChain: slug, category: `whiskey-${slug}` }),
      );

      expect(adapter).toBeInstanceOf(ZakazAdapter);
      expect(adapter.slug).toBe(slug);
    });
  });

  it('resolves the specialized adapters by slug', () => {
    const registry = makeRegistry();

    expect(registry.create(spec('maudau'))).toBeInstanceOf(MaudauAdapter);
    expect(registry.create(spec('okwine'))).toBeInstanceOf(OkwineAdapter);
    expect(registry.create(spec('winewine'))).toBeInstanceOf(WinewineAdapter);
    expect(registry.create(spec('wine-point')))
      .toBeInstanceOf(WinePointAdapter);
    expect(registry.create(spec('goodwine', { tier: 2 })))
      .toBeInstanceOf(GoodwineAdapter);
    expect(registry.create(spec('rozetka', { tier: 3, needsBrowser: true })))
      .toBeInstanceOf(RozetkaAdapter);
  });

  it('reports which of the detail-page stores fetch product pages', () => {
    const registry = makeRegistry();

    expect(registry.create(spec('winewine')).supportsDetail).toBe(true);
    expect(registry.create(spec('wine-point')).supportsDetail).toBe(true);
    expect(registry.create(spec('goodwine')).supportsDetail).toBe(true);
    expect(registry.create(spec('rozetka')).supportsDetail).toBe(false);
    expect(registry.create(spec('maudau')).supportsDetail).toBe(false);
  });

  it('leaves the disabled silpo store without an adapter', () => {
    const registry = makeRegistry();

    const silpo = spec('silpo', { tier: 3, needsBrowser: true });

    expect(() => registry.create(silpo)).toThrow(
      'No scrape adapter registered for store',
    );
  });
});
