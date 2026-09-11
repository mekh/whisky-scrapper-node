import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import { CACHE_GZIP_MIN_BYTES } from '~constants';

const compress = promisify(gzip);

const decompress = promisify(gunzip);

/**
 * The two bytes every gzip stream starts with.
 */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * Turns a cached value into bytes and back.
 *
 * Compression is worth its own step here rather than being left to the
 * client: a full report page is several megabytes of JSON and about a tenth
 * of that compressed, which is the difference between an entry worth storing
 * and one that is mostly network time. Both directions are asynchronous so
 * that a multi-megabyte payload is deflated on the thread pool instead of
 * blocking the event loop — the loop whose lag the watchdog reports.
 */
export class CacheCodec {
  /**
   * Serializes a value for storage, compressing anything large enough to
   * benefit.
   *
   * @param value - The value to store; must be JSON-serializable.
   * @returns The bytes to write.
   */
  public static async encode(value: unknown): Promise<Buffer> {
    const json = Buffer.from(JSON.stringify(value), 'utf8');

    if (json.byteLength < CACHE_GZIP_MIN_BYTES) {
      return json;
    }

    return compress(json);
  }

  /**
   * Reads bytes back into a value, whether or not they were compressed.
   *
   * @param payload - The bytes read from the cache.
   * @returns The stored value.
   * @throws {Error} When the bytes are not a payload this codec wrote.
   */
  public static async decode<T>(payload: Buffer): Promise<T> {
    const json = CacheCodec.isCompressed(payload)
      ? await decompress(payload)
      : payload;

    return JSON.parse(json.toString('utf8')) as T;
  }

  /**
   * Tells a compressed payload from a plain one.
   *
   * Sniffing the magic bytes needs no flag beside the entry and cannot be
   * ambiguous: JSON text can only begin with a brace, a bracket, a quote, a
   * digit, a sign or a letter, never with `0x1f`.
   *
   * @param payload - The bytes read from the cache.
   * @returns Whether they are a gzip stream.
   */
  private static isCompressed(payload: Buffer): boolean {
    return payload.byteLength > GZIP_MAGIC.length
      && payload[0] === GZIP_MAGIC[0]
      && payload[1] === GZIP_MAGIC[1];
  }
}
