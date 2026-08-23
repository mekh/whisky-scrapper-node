import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit guard that buckets requests by the authenticated user instead of
 * by IP, so a single account cannot exhaust an endpoint regardless of how many
 * source addresses it comes from. Applied to the heavy read endpoints, which
 * load the full current-row set per request. Falls back to the client IP for
 * the unauthenticated case (a safety net — the guarded routes require auth).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  /**
   * Derives the throttling key for a request, preferring the authenticated
   * user id (placed on `req.ctx` by `AuthJwtGuard`) over the client IP.
   *
   * @param req - The incoming Fastify request.
   * @returns The tracker key: `user:<id>` when authenticated, else `ip:<ip>`.
   */
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const ctx = req.ctx as { user?: { id?: string } } | undefined;
    const userId = ctx?.user?.id;

    return Promise.resolve(
      userId ? `user:${userId}` : `ip:${req.ip as string}`,
    );
  }
}
