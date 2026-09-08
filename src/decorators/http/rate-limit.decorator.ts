import { SetMetadata, applyDecorators } from '@nestjs/common';

import { RATE_LIMIT_META_INJECT_TOKEN } from '~constants';
import { RateLimitProfile } from '~enums';

/**
 * Opts a controller (or one handler) into a stricter rate-limit profile on
 * top of the per-caller cap every request already pays.
 *
 * The profile's bucket is separate from the global one and is keyed by the
 * controller, so the routes of one controller share it: "one collection
 * request per second" is a statement about the feature, not about each of
 * its endpoints in isolation.
 *
 * @param profile - Which profile's numbers to apply; see
 *   {@link RateLimitProfile}.
 * @returns A class or method decorator recording the profile.
 */
export function RateLimit(
  profile: RateLimitProfile,
): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(RATE_LIMIT_META_INJECT_TOKEN, profile),
  );
}
