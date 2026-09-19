/**
 * Chrome user-agent presented by both the HTTP clients and the browser
 * context, kept in one place so they stay consistent. The build segment is
 * `0.0.0` because Chrome's own user agent has been reduced for years.
 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/**
 * Realistic Chrome header set for HTML requests. `Accept-Encoding` is left
 * unset: undici negotiates and decodes compression on its own.
 */
export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
    + 'image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
  'Sec-Ch-Ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", '
    + '"Chromium";v="151"',
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

/**
 * Chrome major and full version the {@link USER_AGENT} claims, restated so the
 * browser tier can put them in its client hints. They track the Chromium
 * Playwright bundles, so the engine really is the version it announces —
 * `browser-version.integration.spec.ts` fails when a Playwright bump drifts.
 */
export const CHROME_MAJOR_VERSION = '151';

export const CHROME_FULL_VERSION = '151.0.7922.34';

/**
 * The GREASE brand Chromium 151 emits. It varies between builds by design, so
 * it is copied from the bundled engine rather than invented.
 */
export const CHROME_GREASE_BRAND = 'Not=A?Brand';

/**
 * The platform the client hints report, spelled the two ways Chromium wants:
 * `Sec-Ch-Ua-Platform` takes the first, `navigator.platform` the second.
 *
 * The version is the real macOS one, not the `10_15_7` frozen into the user
 * agent: that token is a constant Chrome has sent for years, while this hint
 * reports the truth — and no machine on Catalina could run Chrome 151.
 */
export const CHROME_PLATFORM = 'macOS';

export const CHROME_PLATFORM_VERSION = '26.6.2';

export const CHROME_NAVIGATOR_PLATFORM = 'MacIntel';

/**
 * The CPU the client hints report. Apple Silicon, which is what a Mac running
 * a current Chrome now overwhelmingly is; the user agent still says `Intel`
 * there, because that token is frozen too.
 */
export const CHROME_ARCHITECTURE = 'arm';

export const CHROME_BITNESS = '64';

/**
 * Language list handed to Chromium's user-agent override, without the quality
 * values it appends itself — passing them twice yields `uk;q=0.9;q=0.9`.
 */
export const ACCEPT_LANGUAGE_LIST = 'uk-UA,uk,en';
