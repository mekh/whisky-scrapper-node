import 'reflect-metadata';

import { CACHE_GZIP_MIN_BYTES } from '~constants';
import { CacheCodec } from '~lib/cache';

describe('CacheCodec', () => {
  it('round-trips a small value uncompressed', async () => {
    const value = { hello: 'world' };
    const payload = await CacheCodec.encode(value);

    expect(payload.byteLength).toBeLessThan(CACHE_GZIP_MIN_BYTES);
    expect(payload.toString('utf8')).toBe(JSON.stringify(value));
    expect(await CacheCodec.decode(payload)).toEqual(value);
  });

  it('compresses a large value and reads it back', async () => {
    const value = Array.from({ length: 500 }, (_item, index) => ({
      id: `bottling-${index}`,
      name: 'Whisky Sample',
    }));

    const raw = Buffer.from(JSON.stringify(value), 'utf8');
    const payload = await CacheCodec.encode(value);

    expect(payload.byteLength).toBeLessThan(raw.byteLength);
    expect(await CacheCodec.decode(payload)).toEqual(value);
  });

  it('recognises a compressed payload by its magic bytes', async () => {
    const value = 'x'.repeat(CACHE_GZIP_MIN_BYTES * 2);
    const payload = await CacheCodec.encode(value);

    expect(payload[0]).toBe(0x1f);
    expect(payload[1]).toBe(0x8b);
    expect(await CacheCodec.decode(payload)).toBe(value);
  });

  it('round-trips a value holding null and empty collections', async () => {
    const value = { items: [], missing: null, nested: { flag: false } };

    expect(await CacheCodec.decode(await CacheCodec.encode(value)))
      .toEqual(value);
  });

  it('rejects bytes it did not write', async () => {
    await expect(CacheCodec.decode(Buffer.from('not json', 'utf8')))
      .rejects.toThrow();
  });
});
