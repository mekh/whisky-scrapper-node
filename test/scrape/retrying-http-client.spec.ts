import 'reflect-metadata';

import { RetryingHttpClient } from '../../src/scrape/http/retrying-http-client';
import { ScrapeHttpError } from '../../src/scrape/http/scrape-http.error';

import type {
  ScrapeHttpClient,
  ScrapeHttpResponse,
} from '../../src/scrape/http/http-client.interfaces';

/**
 * Backoff is wall-clock time and the network-error path deliberately ignores
 * the delay multiplier (a store that dropped the connection is not one to
 * hurry), so the waits are stubbed out rather than waited through. The jitter
 * itself is left real — nothing here asserts on it.
 */
jest.mock('../../src/scrape/scrape-timing.util', () => ({
  ...jest.requireActual('../../src/scrape/scrape-timing.util'),
  sleep: (): Promise<void> => Promise.resolve(),
}));

/**
 * The retry wrapper is what turns a transport failure into the typed error the
 * listing walks read, so what is under test here is the classification — which
 * status survives to the caller, and which statuses are worth another attempt.
 */
const URL = 'https://store.test/listing';

/**
 * A transport whose every attempt answers with the same canned status.
 *
 * @param status - The status to answer with.
 * @returns The stub client and its attempt counter.
 */
function respondingWith(
  status: number,
): { client: ScrapeHttpClient; attempts: () => number } {
  let attempts = 0;

  const client: ScrapeHttpClient = {
    get: (): Promise<ScrapeHttpResponse> => {
      attempts += 1;

      return Promise.resolve({
        status,
        headers: {},
        text: (): string => '',
        json: <T = unknown>(): T => ({}) as T,
      });
    },
    close: (): Promise<void> => Promise.resolve(),
  };

  return { client, attempts: (): number => attempts };
}

describe('RetryingHttpClient', () => {
  it('throws a typed error carrying the last status', async () => {
    const { client } = respondingWith(503);
    const retrying = new RetryingHttpClient(client, 0);

    const failure = await retrying.get(URL).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ScrapeHttpError);
    expect((failure as ScrapeHttpError).status).toBe(503);
    expect((failure as ScrapeHttpError).url).toBe(URL);
  });

  /**
   * A 404 is the end-of-catalogue answer several stores give, not a failure to
   * work around: retrying it spent three attempts and two backoffs on every
   * walk that ends the only way its store can end one.
   */
  it('does not retry an end-of-catalogue status', async () => {
    const { client, attempts } = respondingWith(404);
    const retrying = new RetryingHttpClient(client, 0);

    await expect(retrying.get(URL)).rejects.toBeInstanceOf(ScrapeHttpError);
    expect(attempts()).toBe(1);
  });

  it('retries a status that means the store is struggling', async () => {
    const { client, attempts } = respondingWith(500);
    const retrying = new RetryingHttpClient(client, 0);

    await expect(retrying.get(URL)).rejects.toBeInstanceOf(ScrapeHttpError);
    expect(attempts()).toBeGreaterThan(1);
  });

  /**
   * Nothing answered at all, so there is no status to classify — and a walk
   * must read that as an interruption rather than as the end of the listing.
   */
  it('reports a null status when every attempt failed to connect', async () => {
    const client: ScrapeHttpClient = {
      get: (): Promise<ScrapeHttpResponse> => {
        throw new Error('ECONNRESET');
      },
      close: (): Promise<void> => Promise.resolve(),
    };
    const retrying = new RetryingHttpClient(client, 0);

    const failure = await retrying.get(URL).catch((error: unknown) => error);

    expect((failure as ScrapeHttpError).status).toBeNull();
    expect((failure as ScrapeHttpError).message).toContain('ECONNRESET');
  });

  it('returns a successful response untouched', async () => {
    const { client, attempts } = respondingWith(200);
    const retrying = new RetryingHttpClient(client, 0);

    const response = await retrying.get(URL);

    expect(response.status).toBe(200);
    expect(attempts()).toBe(1);
  });
});
