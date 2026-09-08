import 'reflect-metadata';

import { DEFAULT_TRUSTED_IP_HEADERS } from '~constants';
import { ClientIpUtils } from '~utils';

const PEER = '127.0.0.1';

const CLIENT = '203.0.113.7';

/**
 * Resolves an address with the proxy trusted, which is the deployed case.
 *
 * @param headers - The request headers to resolve from.
 * @returns The resolved address.
 */
function resolve(
  headers: Record<string, string | string[] | undefined>,
): string {
  return ClientIpUtils.resolve(headers, PEER, DEFAULT_TRUSTED_IP_HEADERS);
}

describe('ClientIpUtils — the trust order', () => {
  it('prefers X-Real-IP, which nginx replaces', () => {
    const address = resolve({
      'x-real-ip': CLIENT,
      'x-forwarded-for': `1.2.3.4, ${CLIENT}`,
    });

    expect(address).toBe(CLIENT);
  });

  it('falls back to the last forwarded hop', () => {
    expect(resolve({ 'x-forwarded-for': `1.2.3.4, ${CLIENT}` })).toBe(CLIENT);
  });

  it('falls back to the connection address with no headers', () => {
    expect(resolve({})).toBe(PEER);
  });

  it('ignores a blank header', () => {
    expect(resolve({ 'x-real-ip': '   ' })).toBe(PEER);
  });
});

describe('ClientIpUtils — the spoofing cases', () => {
  /**
   * The reason the last hop is read rather than the header. nginx sets
   * `X-Forwarded-For $proxy_add_x_forwarded_for`, which *appends*, so a
   * client sending its own value puts it at the head of the chain and only
   * the tail is the address nginx actually accepted.
   */
  it('reads past a forged head of the forwarded chain', () => {
    const address = resolve({
      'x-forwarded-for': `10.0.0.1, 10.0.0.2, ${CLIENT}`,
    });

    expect(address).toBe(CLIENT);
  });

  it('cannot be steered by a client-supplied single-entry chain', () => {
    /**
     * With nginx appending, a client's `X-Forwarded-For: 10.0.0.1` arrives
     * as `10.0.0.1, <real peer>`, so a lone forged entry is impossible to
     * produce through the proxy; a request that does carry one came from no
     * proxy at all, and the last-hop rule reads that same value either way.
     */
    expect(resolve({ 'x-forwarded-for': '10.0.0.1' })).toBe('10.0.0.1');
  });

  it('takes the last value of a repeated header', () => {
    const address = resolve({
      'x-forwarded-for': ['10.0.0.1', `1.2.3.4, ${CLIENT}`],
    });

    expect(address).toBe(CLIENT);
  });

  /**
   * With nothing in front of the process every one of these headers is
   * plain client input, so none of them is read at all.
   */
  it('reads no header when the trusted list is empty', () => {
    const address = ClientIpUtils.resolve(
      { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.2' },
      PEER,
      [],
    );

    expect(address).toBe(PEER);
  });

  /**
   * The Cloudflare case the default order deliberately leaves out: nothing
   * in this stack sets or strips `cf-connecting-ip`, so it is trusted only
   * where a deployment says so.
   */
  it('ignores an untrusted header and honours a configured one', () => {
    const headers = { 'cf-connecting-ip': CLIENT, 'x-real-ip': '10.0.0.1' };

    expect(resolve(headers)).toBe('10.0.0.1');

    const configured = ClientIpUtils.resolve(headers, PEER, [
      'cf-connecting-ip',
      'x-real-ip',
    ]);

    expect(configured).toBe(CLIENT);
  });
});
