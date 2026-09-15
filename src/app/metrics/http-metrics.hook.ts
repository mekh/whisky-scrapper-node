import { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { METRIC_ROUTE_UNMATCHED } from '~constants';
import { HttpMetricsService } from '~lib/metrics';

/**
 * Marks a request whose in-flight slot has already been released, so a hook
 * firing twice cannot drive the gauge negative.
 */
const RELEASED = Symbol('whisky.metrics.released');

type TrackedRequest = FastifyRequest & { [RELEASED]?: boolean };

/**
 * Milliseconds in a second; Fastify reports elapsed time in milliseconds and
 * Prometheus expects seconds.
 */
const MS_PER_SEC = 1000;

/**
 * Reads the **registered route pattern** a request matched.
 *
 * Never `request.url`, which carries ids: labelling by it would mint one
 * time series per product and put the cardinality in a caller's hands.
 *
 * @param request - The request being measured.
 * @returns The route pattern, or the unmatched marker.
 */
function routeOf(request: FastifyRequest): string {
  return request.routeOptions.url ?? METRIC_ROUTE_UNMATCHED;
}

/**
 * Reads the response body size the reply declared.
 *
 * @param reply - The reply being measured.
 * @returns The size in bytes, or null when the reply declared none.
 */
function bytesOf(reply: FastifyReply): number | null {
  const header = reply.getHeader('content-length');
  const parsed = Number(header);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Times every response the server sends.
 *
 * Fastify hooks and **not** a Nest interceptor, deliberately: an interceptor
 * sees only requests that reach a handler, so a 404 from the router, a
 * request refused in `AuthJwtGuard` and a body rejected by the pipe would all
 * be invisible — and those are exactly the ones worth counting. The status is
 * read at `onResponse`, after the exception filter has had its say, so no
 * error-to-status mapping is duplicated here.
 *
 * @param app - The application to install the hooks on, before it listens.
 * @param metrics - The recorder the hooks report to.
 */
export const registerHttpMetricsHooks = (
  app: NestFastifyApplication,
  metrics: HttpMetricsService,
): void => {
  const instance = app.getHttpAdapter().getInstance();

  instance.addHook('onRequest', (request, _reply, done): void => {
    metrics.started(request.method);

    done();
  });

  instance.addHook('onResponse', (request, reply, done): void => {
    const tracked = request as TrackedRequest;

    if (tracked[RELEASED]) {
      done();

      return;
    }

    tracked[RELEASED] = true;

    metrics.finished({
      method: request.method,
      route: routeOf(request),
      status: reply.statusCode,
      durationSec: reply.elapsedTime / MS_PER_SEC,
      bytes: bytesOf(reply),
    });

    done();
  });
};
