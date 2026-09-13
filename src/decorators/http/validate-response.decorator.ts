import { SetMetadata, applyDecorators } from '@nestjs/common';

import { RESPONSE_VALIDATION_META_INJECT_TOKEN } from '~constants';

/**
 * Turns the outgoing DTO pipeline of a controller (or of one handler) on or
 * off: `@Plain`'s conversion into DTO instances and the outgoing validation
 * that inspects them. A handler's own flag overrides its controller's.
 *
 * Off is worth it where the pipeline is pure cost — a handler whose service
 * already returns the exact wire shape — and `/report` is measured at 3.5 ms
 * a page for it. What it buys elsewhere is an assertion, so a route that
 * opts out owes an equivalent test.
 *
 * The trap: outgoing validation runs with `whitelist: true`, which deletes
 * every property carrying no validation decorator. Turning it off therefore
 * makes the handler's return value the wire contract verbatim.
 *
 * @param enabled - False to skip conversion and validation for these routes.
 * @returns A class or method decorator recording the decision.
 */
export function ValidateResponse(
  enabled = true,
): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(RESPONSE_VALIDATION_META_INJECT_TOKEN, enabled),
  );
}
