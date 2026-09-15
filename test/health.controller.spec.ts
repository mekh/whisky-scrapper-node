import 'reflect-metadata';

import { validateOrReject } from 'class-validator';

import {
  HEALTH_OK,
  PERMISSION_META_INJECT_TOKEN,
  RATE_LIMIT_SKIP_META_INJECT_TOKEN,
  RESPONSE_VALIDATION_META_INJECT_TOKEN,
} from '~constants';
import { Health } from '~domain/health';
import { Resource } from '~enums';

import type { DependencyHealthService } from '../src/domain/health/dependency-health.service';
import { HealthController } from '../src/domain/health/health.controller';

/**
 * Reads one piece of decorator metadata off a handler, through its property
 * descriptor rather than the method itself — the method is never called here,
 * only inspected.
 *
 * @param handlerName - Which handler to inspect.
 * @param token - The metadata key the decorator records under.
 * @returns Whatever it recorded.
 */
function metaOf(handlerName: string, token: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    HealthController.prototype,
    handlerName,
  )?.value as object;

  return Reflect.getMetadata(token, handler);
}

/**
 * Builds a controller over a stub that records whether it was consulted.
 *
 * @param result - What the dependency check should answer.
 * @returns The controller and the call counter behind it.
 */
function build(result: unknown = { status: 'ok' }): {
  controller: HealthController;
  calls: () => number;
} {
  let calls = 0;

  const dependencies = {
    check: async (): Promise<unknown> => {
      calls += 1;

      return result;
    },
  } as unknown as DependencyHealthService;

  return {
    controller: new HealthController(dependencies),
    calls: () => calls,
  };
}

/**
 * `@Plain` wraps the liveness handler: it turns the returned shape into a
 * validated instance of the response type and hands back a promise, which is
 * why the call is awaited even though the handler is synchronous.
 *
 * @returns Whatever the decorated handler answers.
 */
async function live(): Promise<Health> {
  const { controller } = build();

  return await (controller.live() as unknown as Promise<Health>);
}

describe('HealthController liveness', () => {
  it('answers that the process is up', async () => {
    await expect(live()).resolves.toEqual({ status: HEALTH_OK });
  });

  /**
   * The invariant the whole split exists to protect: HAProxy probes this
   * route on every replica at once, so a check that could fail on a wobbling
   * dependency would drain the entire backend.
   */
  it('consults no dependency at all', async () => {
    const { controller, calls } = build();

    await (controller.live() as unknown as Promise<Health>);

    expect(calls()).toBe(0);
  });

  /**
   * The load balancer is the caller and it carries no token, so the route has
   * to be public — a probe that needed one could not be a probe.
   */
  it('is public', () => {
    expect(JSON.stringify(metaOf('live', PERMISSION_META_INJECT_TOKEN)))
      .toContain(Resource.PUBLIC);
  });

  /**
   * The probe must never be refused: the balancer calls it for every replica
   * from one address, against buckets the fleet shares.
   */
  it('is outside the rate limiter', () => {
    expect(metaOf('live', RATE_LIMIT_SKIP_META_INJECT_TOKEN)).toBe(true);
  });

  it('is never cached', () => {
    expect(JSON.stringify(metaOf('live', '__headers__'))).toContain('no-store');
  });

  /**
   * The body is what the outgoing validation will check, so the two have to
   * agree: a status the type does not allow would answer 500 instead of 200,
   * and the balancer would drain every replica.
   */
  it('answers a body its own response type accepts', async () => {
    const body = await live();

    expect(body).toBeInstanceOf(Health);
    await expect(validateOrReject(body)).resolves.toBeUndefined();
  });

  it('rejects any other status', async () => {
    const body = Object.assign(new Health(), { status: 'degraded' });

    await expect(validateOrReject(body)).rejects.toBeDefined();
  });
});

describe('HealthController deep checks', () => {
  it('reports what the dependency check found', async () => {
    const result = { status: 'ok', details: { postgres: { status: 'up' } } };
    const { controller } = build(result);

    await expect(controller.deep()).resolves.toBe(result);
  });

  it('answers readiness from the same check', async () => {
    const { controller, calls } = build();

    await controller.ready();

    expect(calls()).toBe(1);
  });

  /**
   * The payload is terminus's own result, not a DTO, so the outgoing pipeline
   * would reject it. Both deep routes must opt out.
   */
  it('opts out of the outgoing DTO pipeline', () => {
    expect(metaOf('deep', RESPONSE_VALIDATION_META_INJECT_TOKEN)).toBe(false);
    expect(metaOf('ready', RESPONSE_VALIDATION_META_INJECT_TOKEN)).toBe(false);
  });

  /**
   * They do real work per call, so unlike the probe they stay inside the
   * limiter — the rule that comes with `@NoRateLimit()` is that it may only
   * go on a route that costs nothing to serve.
   */
  it('stays inside the rate limiter', () => {
    expect(metaOf('deep', RATE_LIMIT_SKIP_META_INJECT_TOKEN)).toBeUndefined();
    expect(metaOf('ready', RATE_LIMIT_SKIP_META_INJECT_TOKEN)).toBeUndefined();
  });
});
