/**
 * Chrome user-agent presented by both the HTTP clients and the browser
 * context, kept in one place so they stay consistent.
 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Realistic Chrome header set for HTML requests. `Accept-Encoding` is left
 * unset: undici negotiates and decodes compression on its own.
 */
export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
    + 'image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", '
    + '"Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Header set for JSON API requests.
 */
export const JSON_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
};
