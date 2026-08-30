import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { QUICK_FILTER_MAX_PER_USER } from '~constants';
import { CoreQuickFilterService } from '~core/quick-filter';
import { DuplicateError, NotFoundError } from '~errors';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const MISSING_ID = '0198d1f6-0000-7000-8000-00000000dead' as ID;

/**
 * Saved filter sets against a real database. Four claims carry the feature and
 * none can be checked without Postgres: an unknown filter dimension survives
 * the `jsonb` round trip untouched, the unique index really is per user, a
 * foreign id is invisible rather than forbidden, and deleting a user takes
 * their sets with them.
 */
describe('quick filters (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let quickFilters: CoreQuickFilterService;
  let userA: ID;
  let userB: ID;

  /**
   * Creates a throwaway user.
   *
   * @param suffix - Distinguishes the row from the suite's other user.
   * @returns The new user id.
   */
  const makeUser = async (suffix: string): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO "user" (name, password, active)
       VALUES ($1, 'x', false)
       RETURNING id`,
      [`itq${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    quickFilters = moduleRef.get(CoreQuickFilterService);
    userA = await makeUser('a');
    userB = await makeUser('b');
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "user" WHERE id = ANY($1)', [
      [userA, userB],
    ]);

    await closeIntegrationModule(moduleRef);
  });

  afterEach(async () => {
    await dataSource.query(
      'DELETE FROM quick_filter WHERE "userId" = ANY($1)',
      [[userA, userB]],
    );
  });

  it('stores and returns an unknown dimension verbatim', async () => {
    /**
     * The whole extensibility contract: a client shipping a filter dimension
     * this backend has never heard of must get it back byte-identical.
     */
    const filters = {
      stores: ['silpo'],
      minPrice: 800,
      favoritesOnly: true,
      window: null,
      regions: ['islay', 'speyside'],
      peatMin: 3,
    };

    const saved = await quickFilters.createForUser(userA, {
      name: 'Islay',
      filters,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0].filters).toEqual(filters);

    const read = await quickFilters.findByUserId(userA);

    expect(read[0].filters).toEqual(filters);
  });

  it('leaves the payload alone when only the name changes', async () => {
    /**
     * A rename from a client that cannot parse a newer dimension must not
     * destroy it. The patch carries `name` alone, so the blob is untouched.
     */
    const filters = { regions: ['islay'], peatMin: 4 };

    const [saved] = await quickFilters.createForUser(userA, {
      name: 'Before',
      filters,
    });

    const updated = await quickFilters.updateForUser(userA, saved.id, {
      name: 'After',
    });

    expect(updated[0].name).toBe('After');
    expect(updated[0].filters).toEqual(filters);
  });

  it('replaces the payload when filters are sent', async () => {
    const [saved] = await quickFilters.createForUser(userA, {
      name: 'Set',
      filters: { stores: ['silpo'] },
    });

    const updated = await quickFilters.updateForUser(userA, saved.id, {
      filters: { countries: ['gb'] },
    });

    expect(updated[0].filters).toEqual({ countries: ['gb'] });
  });

  it('rejects a duplicate name ignoring case and whitespace', async () => {
    await quickFilters.createForUser(userA, {
      name: 'Айла торф',
      filters: {},
    });

    await expect(
      quickFilters.createForUser(userA, {
        name: '  айла   ТОРФ  ',
        filters: {},
      }),
    ).rejects.toBeInstanceOf(DuplicateError);

    const read = await quickFilters.findByUserId(userA);

    expect(read).toHaveLength(1);
  });

  it('lets two users hold the same name', async () => {
    await quickFilters.createForUser(userA, { name: 'Shared', filters: {} });
    await quickFilters.createForUser(userB, { name: 'Shared', filters: {} });

    await expect(quickFilters.findByUserId(userA)).resolves.toHaveLength(1);
    await expect(quickFilters.findByUserId(userB)).resolves.toHaveLength(1);
  });

  it("allows a rename to the set's own current name", async () => {
    const [saved] = await quickFilters.createForUser(userA, {
      name: 'Same',
      filters: {},
    });

    const updated = await quickFilters.updateForUser(userA, saved.id, {
      name: 'Same',
      filters: { stores: ['silpo'] },
    });

    expect(updated[0].filters).toEqual({ stores: ['silpo'] });
  });

  it('caps how many sets one user may hold', async () => {
    const names = Array.from(
      { length: QUICK_FILTER_MAX_PER_USER },
      (_, index) => `Set ${index}`,
    );

    for (const name of names) {
      await quickFilters.createForUser(userA, { name, filters: {} });
    }

    await expect(
      quickFilters.createForUser(userA, { name: 'One too many', filters: {} }),
    ).rejects.toThrow(/at most/);
  });

  it('orders the list case-insensitively by name', async () => {
    await quickFilters.createForUser(userA, { name: 'bravo', filters: {} });
    await quickFilters.createForUser(userA, { name: 'Alpha', filters: {} });
    await quickFilters.createForUser(userA, { name: 'charlie', filters: {} });

    const read = await quickFilters.findByUserId(userA);

    expect(read.map((item) => item.name))
      .toEqual(['Alpha', 'bravo', 'charlie']);
  });

  it("hides another user's set behind a 404 rather than a 403", async () => {
    /**
     * Ownership is a `WHERE` clause, not a check: the row simply matches
     * nothing, so nothing confirms it exists.
     */
    const [ownedByA] = await quickFilters.createForUser(userA, {
      name: 'Private',
      filters: {},
    });

    await expect(
      quickFilters.updateForUser(userB, ownedByA.id, { name: 'Stolen' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      quickFilters.deleteForUser(userB, ownedByA.id),
    ).rejects.toBeInstanceOf(NotFoundError);

    const read = await quickFilters.findByUserId(userA);

    expect(read[0].name).toBe('Private');
  });

  it('answers 404 for an id that exists nowhere', async () => {
    await expect(
      quickFilters.deleteForUser(userA, MISSING_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes a set and answers with the remaining list', async () => {
    const [first] = await quickFilters.createForUser(userA, {
      name: 'Alpha',
      filters: {},
    });

    await quickFilters.createForUser(userA, { name: 'Bravo', filters: {} });

    const remaining = await quickFilters.deleteForUser(userA, first.id);

    expect(remaining.map((item) => item.name)).toEqual(['Bravo']);
  });

  it('cascades when the owning user is deleted', async () => {
    const doomed = await makeUser('c');

    await quickFilters.createForUser(doomed, { name: 'Doomed', filters: {} });
    await dataSource.query('DELETE FROM "user" WHERE id = $1', [doomed]);

    const rows = await dataSource.query(
      'SELECT count(*)::int AS count FROM quick_filter WHERE "userId" = $1',
      [doomed],
    ) as { count: number }[];

    expect(rows[0].count).toBe(0);
  });

  it('enforces the unique index at the database level', async () => {
    /**
     * The service pre-check cannot be atomic on its own, so the index is the
     * race backstop — and the pre-check is bypassed here to prove it exists.
     */
    await quickFilters.createForUser(userA, { name: 'Once', filters: {} });

    await expect(
      dataSource.query(
        `INSERT INTO quick_filter ("userId", name, filters)
         VALUES ($1, $2, '{}'::jsonb)`,
        [userA, 'Once'],
      ),
    ).rejects.toThrow(/quick_filter_user_name_uindex/);
  });
});
