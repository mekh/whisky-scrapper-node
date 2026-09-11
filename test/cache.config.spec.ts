import 'reflect-metadata';

import { CacheConfig } from '~config';

/**
 * Every variable these cases touch, cleared around each one so a developer's
 * own environment cannot decide the result.
 */
const VARS = [
  'CACHE_ENABLED',
  'CACHE_BOOT_BUMP',
  'CACHE_TTL_SEC',
  'CACHE_READ_TIMEOUT_MS',
  'CACHE_MAX_ENTRY_BYTES',
  'CACHE_VALKEY_HOST',
  'CACHE_VALKEY_PORT',
  'CACHE_VALKEY_PREFIX',
  'CACHE_VALKEY_PASSWORD',
  'VALKEY_HOST',
  'VALKEY_PORT',
  'VALKEY_PREFIX',
  'VALKEY_PASSWORD',
];

beforeEach(() => {
  VARS.forEach((name) => delete process.env[name]);
});

afterEach(() => {
  VARS.forEach((name) => delete process.env[name]);
});

describe('CacheConfig', () => {
  it('is on by default and bounds every wait', () => {
    const config = new CacheConfig();

    expect(config.enabled).toBe(true);
    expect(config.ttlSec).toBeGreaterThan(0);
    expect(config.readTimeoutMs).toBeGreaterThan(0);
    expect(config.maxEntryBytes).toBeGreaterThan(0);
    expect(config.commandTimeoutMs).toBeGreaterThan(0);
  });

  it('keeps the read deadline under the command timeout', () => {
    /**
     * The two bound different failures: the command timeout stops an outage,
     * the read deadline stops a merely slow cache from costing more than the
     * query it replaces. The second is only meaningful while it is the
     * tighter of the two.
     */
    const config = new CacheConfig();

    expect(config.readTimeoutMs).toBeLessThan(config.commandTimeoutMs);
  });

  it('shares the session instance when nothing else is configured', () => {
    process.env.VALKEY_HOST = 'shared-host';
    process.env.VALKEY_PORT = '6380';

    const config = new CacheConfig();

    expect(config.host).toBe('shared-host');
    expect(config.port).toBe(6380);
  });

  it('takes its own instance over the shared one', () => {
    process.env.VALKEY_HOST = 'shared-host';
    process.env.CACHE_VALKEY_HOST = 'cache-host';

    expect(new CacheConfig().host).toBe('cache-host');
  });

  it('treats an empty override as unset, not as an empty host', () => {
    /**
     * Compose forwards a variable the host does not define as an empty
     * string, so every deployment that does not split the instances passes
     * `CACHE_VALKEY_HOST=`. Reading that as a configured value would point
     * the client at nothing and make the documented fallback unreachable in
     * production — the mistake that once disabled push.
     */
    process.env.VALKEY_HOST = 'shared-host';
    process.env.CACHE_VALKEY_HOST = '';

    expect(new CacheConfig().host).toBe('shared-host');
  });

  it('falls back to a local instance when nothing at all is set', () => {
    const config = new CacheConfig();

    expect(config.host).toBe('127.0.0.1');
    expect(config.keyPrefix).toBe('');
  });

  it('bumps at boot unless the process is told not to', () => {
    expect(new CacheConfig().bootBump).toBe(true);

    process.env.CACHE_BOOT_BUMP = 'false';

    expect(new CacheConfig().bootBump).toBe(false);
  });

  it('can be switched off', () => {
    process.env.CACHE_ENABLED = 'false';

    expect(new CacheConfig().enabled).toBe(false);
  });
});
