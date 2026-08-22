/**
 * A GET that failed every attempt, carrying the status of the last one.
 *
 * The status is the whole reason this type exists. A listing walk has to tell
 * "the page past the end of the catalogue" (a 404, which several stores use as
 * their only end-of-listing signal) from "the source is having a bad minute" (a
 * 429, a 503, a dropped connection). Both used to arrive as a bare `Error`
 * whose message had the status baked into a string, so the walk treated them
 * identically: it kept whatever it had and returned, and the run reported
 * success on a fragment of the listing.
 */
export class ScrapeHttpError extends Error {
  /**
   * Status of the last attempt, or null when every attempt failed at the
   * transport level (DNS, TLS, connection reset) and no response was seen.
   */
  public readonly status: number | null;

  /**
   * The URL that could not be fetched.
   */
  public readonly url: string;

  public constructor(url: string, status: number | null, detail: string) {
    super(`Failed to fetch ${url}: ${detail}`);

    this.name = 'ScrapeHttpError';
    this.status = status;
    this.url = url;
  }
}
