import 'reflect-metadata';

import { validateOrReject } from 'class-validator';

import {
  HEALTH_OK,
  PERMISSION_META_INJECT_TOKEN,
  RATE_LIMIT_SKIP_META_INJECT_TOKEN,
} from '~constants';
import { Health } from '~domain/health';
import { Resource } from '~enums';

import { HealthController } from '../src/domain/health/health.controller';

/**
 * Reads one piece of decorator metadata off the handler, through its property
 * descriptor rather than the method itself — the method is never called here,
 * only inspected.
 *
 * @param token - The metadata key the decorator records under.
 * @returns Whatever it recorded.
 */
function metaOf(token: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    HealthController.prototype,
    'health',
  )?.value as object;

  return Reflect.getMetadata(token, handler);
}

/**
 * `@Plain` wraps the handler: it turns the returned shape into a validated
 * instance of the response type and hands back a promise, which is why every
 * call below is awaited even though the handler itself is synchronous.
 *
 * @returns Whatever the decorated handler answers.
 */
async function answer(): Promise<Health> {
  return await (new HealthController().health() as unknown as Promise<Health>);
}

describe('HealthController', () => {
  it('answers that the process is up', async () => {
    await expect(answer()).resolves.toEqual({ status: HEALTH_OK });
  });

  /**
   * The load balancer is the caller and it carries no token, so the route has
   * to be public — a probe that needed one could not be a probe.
   */
  it('is public', () => {
    expect(JSON.stringify(metaOf(PERMISSION_META_INJECT_TOKEN)))
      .toContain(Resource.PUBLIC);
  });

  /**
   * The probe must never be refused: the balancer calls it for every replica
   * from one address, against buckets the fleet shares.
   */
  it('is outside the rate limiter', () => {
    expect(metaOf(RATE_LIMIT_SKIP_META_INJECT_TOKEN)).toBe(true);
  });

  it('is never cached', () => {
    expect(JSON.stringify(metaOf('__headers__'))).toContain('no-store');
  });

  /**
   * The body is what the outgoing validation will check, so the two have to
   * agree: a status the type does not allow would answer 500 instead of 200,
   * and the balancer would drain every replica.
   */
  it('answers a body its own response type accepts', async () => {
    const body = await answer();

    expect(body).toBeInstanceOf(Health);
    await expect(validateOrReject(body)).resolves.toBeUndefined();
  });

  it('rejects any other status', async () => {
    const body = Object.assign(new Health(), { status: 'degraded' });

    await expect(validateOrReject(body)).rejects.toBeDefined();
  });
});
