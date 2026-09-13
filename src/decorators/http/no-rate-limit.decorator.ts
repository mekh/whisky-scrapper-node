import { SetMetadata, applyDecorators } from '@nestjs/common';

import { RATE_LIMIT_SKIP_META_INJECT_TOKEN } from '~constants';

/**
 * Takes a route out of the per-caller rate limiter entirely.
 *
 * For the liveness probe and nothing else. The probe is called by our own
 * balancer, from one address, for every replica — and the buckets are shared
 * across instances, so at enough replicas or a short enough interval the
 * limiter would start refusing probes. A refused probe reads as an unhealthy
 * replica, and since every replica is probed from that same address they
 * would all be drained at once: the limiter would become the outage.
 *
 * The route it is used on must therefore cost nothing to serve — no database,
 * no cache, no work a caller could amplify.
 *
 * @returns A class or method decorator marking the route exempt.
 */
export function NoRateLimit(): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(RATE_LIMIT_SKIP_META_INJECT_TOKEN, true),
  );
}
