import { Controller, Get, Headers, Res } from '@nestjs/common';

import { MetricsConfig } from '~config';
import { Permission } from '~decorators/auth';
import { CacheControl, NoRateLimit } from '~decorators/http';
import { Resource } from '~enums';
import { NotAuthenticatedError } from '~errors';
import { MetricsService } from '~lib/metrics';
import type { Response } from '~types';

/**
 * Prefix an `Authorization` header carries before the token.
 */
const BEARER = 'Bearer ';

/**
 * The Prometheus exposition of this replica.
 *
 * Unauthenticated by default, because a scraper holds no token and this
 * endpoint is reached on the compose network only — the host nginx returns
 * 404 for `/api/metrics`, and the app publishes no port of its own. A
 * deployment that wants it closed on the private network too sets
 * `METRICS_TOKEN`.
 *
 * It is outside the rate limiter for the reason the liveness probe is: every
 * replica is scraped from one address on a fixed interval against buckets the
 * whole fleet shares, and a refused scrape reads as a replica that is gone.
 * The rule that comes with `@NoRateLimit()` holds — rendering the registry is
 * string concatenation over numbers already in memory, and nothing here
 * touches the database.
 *
 * It takes the reply over rather than using `@Plain`: the payload is text in
 * Prometheus's own format, which the outgoing DTO pipeline would reject.
 */
@Controller('metrics')
export class MetricsController {
  public constructor(
    private readonly metrics: MetricsService,
    private readonly config: MetricsConfig,
  ) {}

  @Get()
  @CacheControl('no-cache')
  @NoRateLimit()
  @Permission(Resource.PUBLIC)
  public async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: Response,
  ): Promise<void> {
    this.authorize(authorization);

    const body = await this.metrics.render();

    await reply
      .header('Content-Type', this.metrics.contentType)
      .send(body);
  }

  /**
   * Refuses the scrape when a token is configured and not presented.
   *
   * @param authorization - The request's `Authorization` header, if any.
   * @throws {NotAuthenticatedError} When the token does not match.
   */
  private authorize(authorization: string | undefined): void {
    if (!this.config.token) {
      return;
    }

    const presented = authorization?.startsWith(BEARER)
      ? authorization.slice(BEARER.length)
      : null;

    if (presented !== this.config.token) {
      throw new NotAuthenticatedError('Invalid metrics token');
    }
  }
}
