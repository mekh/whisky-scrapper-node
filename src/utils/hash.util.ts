import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import * as argon from '@node-rs/argon2';

const pbkdf2Async = promisify(pbkdf2);

// Legacy Python hashes are `pbkdf2_sha256$<iters>$<salt_hex>$<hash_hex>`.
const PBKDF2_PREFIX = 'pbkdf2_sha256$';
const PBKDF2_DIGEST = 'sha256';
const PBKDF2_PARTS = 4;

export class Hash {
  // `algorithm` is intentionally omitted: Argon2id is the library default and
  // referencing the ambient const enum breaks under `isolatedModules`.
  private static opts: argon.Options = {
    parallelism: 1,
    memoryCost: 32 * 1024,
    timeCost: 10,
  };

  /**
   * Hashes a secret with Argon2id synchronously.
   *
   * @param secret - The plaintext secret to hash.
   * @returns The encoded Argon2 hash string.
   */
  public static hashSync(secret: string | Uint8Array): string {
    return argon.hashSync(secret, this.opts);
  }

  /**
   * Hashes a secret with Argon2id asynchronously.
   *
   * @param secret - The plaintext secret to hash.
   * @returns A promise resolving to the encoded Argon2 hash string.
   */
  public static hashAsync(secret: string | Uint8Array): Promise<string> {
    return argon.hash(secret, this.opts);
  }

  /**
   * Verifies a plaintext secret against a stored hash, supporting both the
   * current Argon2 format and legacy `pbkdf2_sha256$...` hashes migrated from
   * the Python app (dual-hash). The format is detected from the hash prefix.
   *
   * @param secret - The plaintext secret to check.
   * @param hash - The stored hash (Argon2 or legacy pbkdf2).
   * @returns A promise resolving to `true` when the secret matches.
   */
  public static verifyAsync(secret: string, hash: string): Promise<boolean> {
    if (hash.startsWith(PBKDF2_PREFIX)) {
      return Hash.verifyPbkdf2(secret, hash);
    }

    return argon.verify(hash, secret);
  }

  /**
   * Reports whether a stored hash should be upgraded to Argon2 on the next
   * successful login (true for legacy pbkdf2 hashes).
   *
   * @param hash - The stored hash to inspect.
   * @returns `true` when the hash is a legacy pbkdf2 hash.
   */
  public static needsRehash(hash: string): boolean {
    return hash.startsWith(PBKDF2_PREFIX);
  }

  /**
   * Verifies a secret against a legacy Python pbkdf2 hash in the format
   * `pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>`.
   *
   * @param secret - The plaintext secret to check.
   * @param hash - The legacy pbkdf2 hash string.
   * @returns A promise resolving to `true` when the secret matches.
   */
  private static async verifyPbkdf2(
    secret: string,
    hash: string,
  ): Promise<boolean> {
    const parts = hash.split('$');

    if (parts.length !== PBKDF2_PARTS) {
      return false;
    }

    const iterations = Number.parseInt(parts[1], 10);

    if (!Number.isInteger(iterations) || iterations <= 0) {
      return false;
    }

    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');

    const derived = await pbkdf2Async(
      secret,
      salt,
      iterations,
      expected.length,
      PBKDF2_DIGEST,
    );

    return expected.length === derived.length
      && timingSafeEqual(expected, derived);
  }
}
