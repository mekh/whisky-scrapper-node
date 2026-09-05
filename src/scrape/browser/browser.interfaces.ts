/**
 * What a stealth context needs to know to keep the browser's traffic on the
 * store it is scraping.
 */
export interface StealthContextOptions {
  /**
   * Registrable host of the store being scraped (`rozetka.com.ua`). Requests
   * to it and to its subdomains are the only ones allowed out of the context,
   * besides the Cloudflare challenge platform — see
   * `browser-request.policy.ts`.
   */
  firstPartyHost: string;
}
