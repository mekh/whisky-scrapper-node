import 'reflect-metadata';

import { CacheControl } from '~decorators/http';

/**
 * Metadata key Nest's `@Header()` writes onto the handler function.
 */
const HEADERS_METADATA = '__headers__';

/**
 * Applies the decorator to a bare handler and reads back the `Cache-Control`
 * value Nest would respond with.
 *
 * @param value - The decorator argument under test.
 * @returns The header value.
 */
function headerFor(value: number | 'no-cache'): string {
  const descriptor: PropertyDescriptor = { value: (): void => {} };

  CacheControl(value)({}, 'handler', descriptor);

  const headers = Reflect.getMetadata(
    HEADERS_METADATA,
    descriptor.value,
  ) as { name: string; value: string }[];

  return headers.find((header) => header.name === 'Cache-Control')?.value ?? '';
}

describe('CacheControl', () => {
  it('caches privately for the given number of seconds', () => {
    expect(headerFor(600)).toBe('private, max-age=600');
  });

  it('forbids caching for the no-cache literal', () => {
    const value = headerFor('no-cache');

    expect(value).toContain('no-cache');
    expect(value).toContain('no-store');
    expect(value).not.toContain('max-age');
  });
});
