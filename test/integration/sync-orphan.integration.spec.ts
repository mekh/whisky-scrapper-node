import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreSyncLogService } from '~core/sync-log';
import { SyncTrigger } from '~enums';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const SLUG = `__it_orphan_${Date.now()}`;

/**
 * Longer than anything this suite backdates a row by, so the age floor never
 * fires unless a case asks it to.
 */
const MAX_AGE_MS = 3600_000;

const LIVE = 'host:1:aaaaaa';

const DEAD = 'host:2:bbbbbb';

describe('the sync orphan sweep (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let syncLogs: CoreSyncLogService;
  let storeId: ID;
  let otherStoreId: ID;

  /**
   * Opens a run directly, so a case can state its owner and its age rather
   * than having to be a sync.
   *
   * @param owner - The instance to record as the run's owner.
   * @param store - Which store the run is for.
   * @param ageMs - How long ago the row was last touched.
   * @returns The row's id.
   */
  const openRun = async (
    owner: string | null,
    store: ID,
    ageMs = 0,
  ): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO sync_log ("storeId", trigger, "ownerId", "updatedAt")
       VALUES ($1, $2, $3, now() - make_interval(secs => $4::float / 1000))
       RETURNING id`,
      [store, SyncTrigger.MANUAL, owner, ageMs],
    ) as { id: ID }[];

    return rows[0]!.id;
  };

  /**
   * Reads back whether a run is still open.
   *
   * @param id - The run's id.
   * @returns The row's `success` and `error`.
   */
  const stateOf = async (
    id: ID,
  ): Promise<{ success: boolean | null; error: string | null }> => {
    const rows = await dataSource.query(
      'SELECT success, error FROM sync_log WHERE id = $1',
      [id],
    ) as { success: boolean | null; error: string | null }[];

    return rows[0]!;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    syncLogs = moduleRef.get(CoreSyncLogService, { strict: false });

    const stores = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Orphan A', 'https://example.test', true),
              ($2, 'IT Orphan B', 'https://example.test', true)
       RETURNING id`,
      [SLUG, `${SLUG}_b`],
    ) as { id: ID }[];

    storeId = stores[0]!.id;
    otherStoreId = stores[1]!.id;
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM sync_log WHERE "storeId" = ANY($1)', [
      [storeId, otherStoreId],
    ]);
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM sync_log WHERE "storeId" = ANY($1)', [
      [storeId, otherStoreId],
    ]);
    await dataSource.query('DELETE FROM store WHERE id = ANY($1)', [
      [storeId, otherStoreId],
    ]);
    await closeIntegrationModule(moduleRef);
  });

  /**
   * The whole point of the owner column: a restart must not close the run a
   * sibling is still driving, because closing it releases the store's lock
   * and lets a second sync start on top of the first.
   */
  it('leaves a live instance its run', async () => {
    const mine = await openRun(LIVE, storeId);

    const closed = await syncLogs.sweepOrphaned([LIVE], MAX_AGE_MS);

    expect(closed).toBe(0);
    await expect(stateOf(mine)).resolves.toMatchObject({ success: null });
  });

  it('closes a run whose instance is gone', async () => {
    const abandoned = await openRun(DEAD, storeId);

    const closed = await syncLogs.sweepOrphaned([LIVE], MAX_AGE_MS);

    expect(closed).toBe(1);

    const state = await stateOf(abandoned);

    expect(state.success).toBe(false);
    expect(state.error).toContain('the instance that started this run is gone');
  });

  /**
   * A row from before the column existed names nobody, and no live process
   * can claim it.
   */
  it('closes a run that names no instance', async () => {
    const legacy = await openRun(null, storeId);

    const closed = await syncLogs.sweepOrphaned([LIVE], MAX_AGE_MS);

    expect(closed).toBe(1);
    await expect(stateOf(legacy)).resolves.toMatchObject({ success: false });
  });

  it('sorts a mixed set in one pass', async () => {
    const mine = await openRun(LIVE, storeId);
    const abandoned = await openRun(DEAD, otherStoreId);

    const closed = await syncLogs.sweepOrphaned([LIVE], MAX_AGE_MS);

    expect(closed).toBe(1);
    await expect(stateOf(mine)).resolves.toMatchObject({ success: null });
    await expect(stateOf(abandoned)).resolves.toMatchObject({
      success: false,
    });
  });

  describe('when liveness cannot be established', () => {
    /**
     * Null is not "none of them": sweeping on an unknown answer would close a
     * live sibling's run, so only the age floor applies.
     */
    it('leaves a young run alone', async () => {
      const running = await openRun(DEAD, storeId);

      const closed = await syncLogs.sweepOrphaned(null, MAX_AGE_MS);

      expect(closed).toBe(0);
      await expect(stateOf(running)).resolves.toMatchObject({ success: null });
    });

    /**
     * The floor that still holds: every run is bounded by its store timeout,
     * so a row untouched past that plus a margin cannot be live.
     */
    it('closes one older than any run may be', async () => {
      const stale = await openRun(DEAD, storeId, MAX_AGE_MS * 2);

      const closed = await syncLogs.sweepOrphaned(null, MAX_AGE_MS);

      expect(closed).toBe(1);

      const state = await stateOf(stale);

      expect(state.success).toBe(false);
      expect(state.error).toContain('outlived the longest a run may take');
    });
  });

  /**
   * The age floor is independent of the owner test, so a row an instance
   * still claims is closed once it is provably past any run's bound — which
   * is what covers an instance whose heartbeat lives on while its run does
   * not.
   */
  it('closes a live instance run that is past the age bound', async () => {
    const stuck = await openRun(LIVE, storeId, MAX_AGE_MS * 2);

    const closed = await syncLogs.sweepOrphaned([LIVE], MAX_AGE_MS);

    expect(closed).toBe(1);

    const state = await stateOf(stuck);

    expect(state.error).toContain('outlived the longest a run may take');
  });

  it('frees the lock it closed', async () => {
    await openRun(DEAD, storeId);

    const blocked = await syncLogs.tryStart(storeId, null, SyncTrigger.MANUAL);

    expect(blocked).toBeNull();

    await syncLogs.sweepOrphaned([LIVE], MAX_AGE_MS);

    const started = await syncLogs.tryStart(
      storeId,
      null,
      SyncTrigger.MANUAL,
      null,
      LIVE,
    );

    expect(started).not.toBeNull();
    expect(started?.ownerId).toBe(LIVE);
  });

  it('lists the instances holding an open run', async () => {
    await openRun(LIVE, storeId);
    await openRun(null, otherStoreId);

    await expect(syncLogs.openOwners()).resolves.toEqual([LIVE]);
  });
});
