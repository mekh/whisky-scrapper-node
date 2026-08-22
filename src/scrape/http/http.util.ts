import { ScrapeHttpResponse } from './http-client.interfaces';
import { ScrapeHttpError } from './scrape-http.error';

/**
 * Statuses a store uses to say "there is no such page" rather than "come
 * back later". A listing walk that asks for one page past the end gets one
 * of these, and for several stores it is the only end-of-listing signal
 * there is.
 */
const END_OF_CATALOG_STATUSES = new Set([404, 410]);

/**
 * Appends query parameters to a URL, stringifying numbers.
 *
 * @param url - Absolute base URL.
 * @param params - Parameters to append; skipped when absent.
 * @returns The URL with the parameters applied.
 */
export function buildUrl(
  url: string,
  params?: Record<string, string | number>,
): string {
  if (!params) {
    return url;
  }

  const target = new URL(url);

  Object.entries(params).forEach(([key, value]) => {
    target.searchParams.set(key, String(value));
  });

  return target.toString();
}

/**
 * Collects fetch-style headers into a plain lower-cased record.
 *
 * @param headers - The headers object.
 * @returns Header name/value pairs.
 */
export function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};

  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });

  return out;
}

/**
 * Builds a buffered response whose body text is read once and reused.
 *
 * @param status - HTTP status code.
 * @param headers - Lower-cased response headers.
 * @param body - The already-read body text.
 * @returns A response exposing the buffered body as text or JSON.
 */
export function bufferedResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
): ScrapeHttpResponse {
  return {
    status,
    headers,
    text: (): string => body,
    json: <T = unknown>(): T => JSON.parse(body) as T,
  };
}

/**
 * Whether a status means the requested page does not exist, as opposed to the
 * source being temporarily unable to serve it.
 *
 * @param status - HTTP status code.
 * @returns True for the end-of-catalogue statuses.
 */
export function isEndOfCatalogStatus(status: number): boolean {
  return END_OF_CATALOG_STATUSES.has(status);
}

/**
 * Whether a thrown value is a fetch failure that means the walk ran off the end
 * of the listing. Anything else — a 5xx, a 429, a network error, a parse error
 * — means the walk was interrupted and has collected only a fragment.
 *
 * @param error - The value a page fetch threw.
 * @returns True when the failure is an end-of-catalogue answer.
 */
export function isEndOfCatalog(error: unknown): boolean {
  return error instanceof ScrapeHttpError
    && error.status !== null
    && isEndOfCatalogStatus(error.status);
}
