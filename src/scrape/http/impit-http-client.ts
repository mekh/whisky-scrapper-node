import { Impit } from 'impit';

import { DEFAULT_HEADERS } from './headers.constants';
import { bufferedResponse, buildUrl, collectHeaders } from './http.util';

import type {
  ScrapeHttpClient,
  ScrapeHttpRequestOptions,
  ScrapeHttpResponse,
} from './http-client.interfaces';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transport backed by `impit` impersonating Chrome, reproducing a real
 * browser's TLS/JA3 and HTTP/2 fingerprint. Used for the Cloudflare-fronted
 * HTML stores that reject plain fetch from a datacenter IP. Only
 * `Accept-Language` is overridden — impersonation owns the rest of the
 * headers, and desyncing them is exactly what Cloudflare looks for.
 */
export class ImpitHttpClient implements ScrapeHttpClient {
  private readonly impit: Impit;

  public constructor() {
    this.impit = new Impit({
      browser: 'chrome',
      followRedirects: true,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'Accept-Language': DEFAULT_HEADERS['Accept-Language'] },
    });
  }

  /**
   * Performs a GET request via impit.
   *
   * @param url - Absolute URL.
   * @param options - Optional query parameters and headers.
   * @returns The buffered response.
   */
  public async get(
    url: string,
    options?: ScrapeHttpRequestOptions,
  ): Promise<ScrapeHttpResponse> {
    const response = await this.impit.fetch(buildUrl(url, options?.params), {
      method: 'GET',
      headers: options?.headers,
    });

    return bufferedResponse(
      response.status,
      collectHeaders(response.headers),
      await response.text(),
    );
  }

  /**
   * No-op: impit owns its connection pool with no explicit teardown.
   *
   * @returns Resolves immediately.
   */
  public async close(): Promise<void> {
    // Nothing to release.
  }
}
