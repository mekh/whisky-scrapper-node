import { INestApplicationContext } from '@nestjs/common';

import { CACHE_GENERATION_CATALOGUE } from '~constants';
import { VersionedCacheService } from '~lib/cache';

/**
 * Stops this process from bumping the generation as it starts.
 *
 * Call it before the Nest context is created — the setting is read while the
 * module graph initialises.
 *
 * The startup bump exists for a process that serves reads: it discards
 * entries cached before writes it could not see. A script serves none, so
 * its own startup bump only throws away entries the API is about to have
 * superseded anyway by the bump at the *end* of the run. Worse, it fires on
 * a dry run too, which is supposed to leave everything exactly as it found
 * it.
 */
export function suppressBootBump(): void {
  process.env.CACHE_BOOT_BUMP = 'false';
}

/**
 * Tells a running application that this script has changed the catalogue.
 *
 * The generation counter lives in Valkey, not in either process, so a bump
 * from here is visible to the API immediately — which is the only reason a
 * script can invalidate a cache it does not own. Without it the API would go
 * on serving what it cached before the script ran, for as long as the
 * entries live.
 *
 * Call it **after** the writes and only when they happened: a dry run has
 * changed nothing, and a bump before the writes would merely invalidate the
 * catalogue the script is about to replace, leaving the stale version to be
 * cached again under the new generation.
 *
 * Best-effort, like every other cache operation: `bump` never rejects, and a
 * script must not fail because the cache could not be told. When it cannot
 * be, the entries expire on their own within a day.
 *
 * @param app - The script's Nest context.
 * @param script - The script's name, for the log line the API will show.
 * @returns Resolves once the bump has been attempted.
 */
export async function bumpCatalogueCache(
  app: INestApplicationContext,
  script: string,
): Promise<void> {
  await app
    .get(VersionedCacheService, { strict: false })
    .bump(CACHE_GENERATION_CATALOGUE, `script:${script}`);
}
