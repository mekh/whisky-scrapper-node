import type {
  ScrapeHttpClient,
  ScrapeHttpRequestOptions,
  ScrapeHttpResponse,
} from '../../src/scrape/http/http-client.interfaces';

/**
 * One canned response of the fake client.
 */
export interface FakeHttpReply {
  /**
   * The JSON body the response yields.
   */
  body: unknown;

  /**
   * Response headers, lower-cased.
   */
  headers?: Record<string, string>;
}

/**
 * Handles one request; returning a reply serves it, throwing simulates a
 * transport failure.
 */
export type FakeHttpHandler = (
  url: string,
  options?: ScrapeHttpRequestOptions,
) => FakeHttpReply;

/**
 * An in-memory `ScrapeHttpClient` that serves canned JSON, so adapter tests
 * exercise the real pagination and mapping code without any network.
 */
export class FakeHttpClient implements ScrapeHttpClient {
  public readonly calls: { url: string; params: Record<string, unknown> }[] =
    [];

  public closed = false;

  private readonly handler: FakeHttpHandler;

  public constructor(handler: FakeHttpHandler) {
    this.handler = handler;
  }

  /**
   * Serves one request from the handler and records the call.
   *
   * @param url - Requested URL.
   * @param options - Query parameters and headers.
   * @returns The canned response.
   */
  public async get(
    url: string,
    options?: ScrapeHttpRequestOptions,
  ): Promise<ScrapeHttpResponse> {
    this.calls.push({ url, params: { ...options?.params } });

    const reply = this.handler(url, options);
    const body = JSON.stringify(reply.body);

    return {
      status: 200,
      headers: reply.headers ?? {},
      text: (): string => body,
      json: <T = unknown>(): T => JSON.parse(body) as T,
    };
  }

  /**
   * Records that the adapter released the client.
   *
   * @returns Resolves immediately.
   */
  public async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * The `page` query parameter of every request made so far.
   *
   * @returns Requested page numbers, in call order.
   */
  public pages(): number[] {
    return this.calls
      .filter((call) => call.params.page !== undefined)
      .map((call) => Number(call.params.page));
  }
}
