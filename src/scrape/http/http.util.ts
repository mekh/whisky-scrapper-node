import { ScrapeHttpResponse } from './http-client.interfaces';

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
