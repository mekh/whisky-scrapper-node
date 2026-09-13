import { Controller, Get } from '@nestjs/common';

import { HEALTH_OK } from '~constants';
import { CacheControl, NoRateLimit } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Resource } from '~enums';
import type { HealthStatus } from '~types';

import { Health } from './health.type.dto';

/**
 * Liveness, for the load balancer in front of the replicas.
 *
 * It answers from the process alone and names no dependency, deliberately. A
 * probe that checked Postgres or Valkey would take **every** replica out of
 * rotation the moment that one dependency wobbled, turning a degradation into
 * a total outage — and it would answer no question the balancer is asking.
 * What the balancer needs to know is whether this process still turns its
 * event loop, which a handler that returns a constant answers exactly: a
 * blocked or dying replica does not reply at all.
 *
 * Public on purpose — a probe that needed a token could not be a probe — so
 * it states nothing about the deployment beyond "this is up". Anything
 * richer (which instance, which version, how deep the pool is) belongs on the
 * monitoring surface, not here.
 *
 * It is also the one route outside the rate limiter: every replica is probed
 * from the balancer's single address against buckets the whole fleet shares,
 * so a refused probe would read as an unhealthy replica and drain all of them
 * at once.
 */
@Controller('health')
export class HealthController {
  @Get()
  @CacheControl('no-cache')
  @NoRateLimit()
  @Plain(Health, Resource.PUBLIC)
  public health(): HealthStatus {
    return { status: HEALTH_OK };
  }
}
