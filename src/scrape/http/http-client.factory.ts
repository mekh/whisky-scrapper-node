import { Injectable } from '@nestjs/common';

import { ScrapeConfig } from '~config';

import { ImpitHttpClient } from './impit-http-client';
import { PlainHttpClient } from './plain-http-client';
import { RetryingHttpClient } from './retrying-http-client';

import { HttpStrategy } from './http-client.interfaces';

import type { ScrapeHttpClient } from './http-client.interfaces';

/**
 * Per-store HTTP strategy, filled from the feasibility spike. Stores absent
 * here use plain fetch; browser-tier stores (`needsBrowser`) bypass this
 * factory entirely. The CF-fronted stores use impersonation: `winewine`
 * because plain fetch 403s from a datacenter IP, `wine-point`/`goodwine`
 * pre-emptively as the same WooCommerce/Magento-behind-Cloudflare family,
 * and `silpo` pre-emptively too — its API host is CF-fronted and passes
 * plain fetch from a residential IP, but the datacenter behavior is
 * unproven.
 */
// TODO: move this to the `store_config`
export const HTTP_STRATEGY_BY_SLUG: Partial<Record<string, HttpStrategy>> = {
  winewine: HttpStrategy.IMPERSONATE,
  'wine-point': HttpStrategy.IMPERSONATE,
  goodwine: HttpStrategy.IMPERSONATE,
  silpo: HttpStrategy.IMPERSONATE,
};

/**
 * Builds the HTTP client a store's adapter should use, wrapped with
 * retry/backoff.
 */
@Injectable()
export class HttpClientFactory {
  private readonly config: ScrapeConfig;

  public constructor(config: ScrapeConfig) {
    this.config = config;
  }

  /**
   * Creates the retrying HTTP client for a store slug.
   *
   * @param slug - Store slug, used to pick the transport strategy.
   * @returns A retrying client over the chosen transport.
   */
  public create(slug: string): ScrapeHttpClient {
    const strategy = HTTP_STRATEGY_BY_SLUG[slug] ?? HttpStrategy.PLAIN;

    const inner = strategy === HttpStrategy.IMPERSONATE
      ? new ImpitHttpClient()
      : new PlainHttpClient();

    return new RetryingHttpClient(inner, this.config.delayMultiplier);
  }
}
