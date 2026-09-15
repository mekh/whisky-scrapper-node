import { Controller, Get } from '@nestjs/common';
import { HealthCheckResult } from '@nestjs/terminus';

import { HEALTH_OK } from '~constants';
import { Permission } from '~decorators/auth';
import { CacheControl, NoRateLimit, ValidateResponse } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Resource } from '~enums';
import type { HealthStatus } from '~types';

import { DependencyHealthService } from './dependency-health.service';
import { Health } from './health.type.dto';

/**
 * Three answers to three different questions, and keeping them apart is the
 * design rather than a convenience.
 *
 * `/health/live` is **the load balancer's probe**. It names no dependency and
 * answers from the process alone, because every replica is probed on the same
 * route at the same instant: a probe that could fail on a wobbling Postgres
 * would fail on all of them at once and drain the whole backend, turning one
 * dependency's bad minute into a total outage. What it does detect is the
 * failure that matters there — a replica whose event loop is blocked does not
 * reply at all. It is public and outside the rate limiter for the same
 * reasons, and it is the only health route the host nginx leaves reachable.
 *
 * `/health` and `/health/ready` are **for a person and for Grafana**: they
 * probe Postgres and both Valkeys and answer 503 when a hard dependency is
 * down. Blocked at the edge, inside the rate limiter, and never what HAProxy
 * reads.
 */
@Controller('health')
export class HealthController {
  public constructor(
    private readonly dependencies: DependencyHealthService,
  ) {}

  @Get()
  @CacheControl('no-cache')
  @ValidateResponse(false)
  @Permission(Resource.PUBLIC)
  public deep(): Promise<HealthCheckResult> {
    return this.dependencies.check();
  }

  @Get('live')
  @CacheControl('no-cache')
  @NoRateLimit()
  @Plain(Health, Resource.PUBLIC)
  public live(): HealthStatus {
    return { status: HEALTH_OK };
  }

  @Get('ready')
  @CacheControl('no-cache')
  @ValidateResponse(false)
  @Permission(Resource.PUBLIC)
  public ready(): Promise<HealthCheckResult> {
    return this.dependencies.check();
  }
}
