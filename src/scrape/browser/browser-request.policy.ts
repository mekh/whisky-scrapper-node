/**
 * Hosts a page may reach besides the store's own: the Cloudflare challenge
 * platform, whose script and iframe must load for the managed challenge to
 * clear. Everything it serves is allowed, whatever the resource type — the
 * challenge is the one thing this policy must never get in the way of.
 */
const CHALLENGE_HOSTS: ReadonlySet<string> = new Set([
  'challenges.cloudflare.com',
]);

/**
 * Path prefix under which Cloudflare serves its own resources from the
 * store's origin — the challenge platform's scripts and the challenge's
 * answer POST among them. Allowed whatever the resource type, for the same
 * reason as {@link CHALLENGE_HOSTS}.
 */
const CLOUDFLARE_PATH_PREFIX = '/cdn-cgi/';

/**
 * Resource types dropped on the store's own hosts. None of them carries
 * anything a DOM extractor reads — the tiles are server-rendered — and
 * together they were ~300 of the ~360 requests one Rozetka listing page made
 * (measured 2026-09-05).
 */
const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'image',
  'media',
  'font',
]);

/**
 * Reads the host a store's requests are allowed to go to out of its base URL.
 *
 * @param baseUrl - The store's base URL (`https://rozetka.com.ua`).
 * @returns The bare hostname.
 */
export function firstPartyHostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

/**
 * Whether a hostname is the store itself or one of its subdomains.
 *
 * @param hostname - Host of the request.
 * @param firstPartyHost - The store's host.
 * @returns True for the host itself and any subdomain of it.
 */
export function isFirstPartyHost(
  hostname: string,
  firstPartyHost: string,
): boolean {
  return hostname === firstPartyHost
    || hostname.endsWith(`.${firstPartyHost}`);
}

/**
 * Decides whether a request a rendered page is about to make may leave the
 * browser at all.
 *
 * The policy exists because the browser tier is the only scraper whose
 * traffic is not under the adapter's control: a listing page pulls in
 * analytics, session replay, error reporters, sign-in widgets and CDNs of its
 * own choosing, and Chromium reaches several of them over QUIC (UDP 443),
 * which a plain HTTP scraper never produces. Everything the extractors need
 * is the store's own server-rendered document plus whatever the Cloudflare
 * challenge has to load, so that is all that is allowed through: a request
 * to any other host is aborted, and images, media and fonts are aborted on
 * the store's hosts too. The challenge platform's host and Cloudflare's own
 * `/cdn-cgi/` paths on the store's origin are exempt from the type filter,
 * so the policy can never be what keeps a challenge from clearing.
 *
 * An unparsable URL is refused as well — the safe reading of "cannot tell
 * where this goes" is "do not send it".
 *
 * @param url - Absolute URL of the request.
 * @param resourceType - Playwright's resource type for the request
 *   (`document`, `script`, `image`, ...).
 * @param firstPartyHost - The store's host.
 * @returns True when the request may proceed.
 */
export function isRequestAllowed(
  url: string,
  resourceType: string,
  firstPartyHost: string,
): boolean {
  let target: URL;

  try {
    target = new URL(url);
  } catch {
    return false;
  }

  if (CHALLENGE_HOSTS.has(target.hostname)) {
    return true;
  }

  if (!isFirstPartyHost(target.hostname, firstPartyHost)) {
    return false;
  }

  if (target.pathname.startsWith(CLOUDFLARE_PATH_PREFIX)) {
    return true;
  }

  return !BLOCKED_RESOURCE_TYPES.has(resourceType);
}
