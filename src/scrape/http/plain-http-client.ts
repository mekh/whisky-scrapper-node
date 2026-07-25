import { DEFAULT_HEADERS } from './headers.constants';
import { bufferedResponse, buildUrl, collectHeaders } from './http.util';

import type {
  ScrapeHttpClient,
  ScrapeHttpRequestOptions,
  ScrapeHttpResponse,
} from './http-client.interfaces';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The cheapest transport: Node's global `fetch` (undici) with a realistic
 * Chrome header set. Cloudflare can fingerprint its TLS handshake as
 * non-browser, so it is used only for stores the spike cleared for plain fetch.
 */
export class PlainHttpClient implements ScrapeHttpClient {
  /**
   * Performs a GET request via global fetch.
   *
   * @param url - Absolute URL.
   * @param options - Optional query parameters and headers.
   * @returns The buffered response.
   */
  public async get(
    url: string,
    options?: ScrapeHttpRequestOptions,
  ): Promise<ScrapeHttpResponse> {
    const response = await fetch(buildUrl(url, options?.params), {
      headers: { ...DEFAULT_HEADERS, ...options?.headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    return bufferedResponse(
      response.status,
      collectHeaders(response.headers),
      await response.text(),
    );
  }

  /**
   * No-op: undici manages its own global agent.
   *
   * @returns Resolves immediately.
   */
  public async close(): Promise<void> {
    // Nothing to release.
  }
}
