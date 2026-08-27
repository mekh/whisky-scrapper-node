import 'reflect-metadata';

import type { ID } from '~types';

import { QuickFilterService } from '../src/domain/quick-filter/quick-filter.service';

import type { CoreQuickFilterService } from '~core/quick-filter';
import type { CoreUserService } from '~core/user';

const USER = 'user-1' as ID;

/**
 * Builds the domain service over mocked core services.
 *
 * @returns The service under test and both mocks.
 */
function makeService(): {
  service: QuickFilterService;
  quickFilters: Record<string, jest.Mock>;
  users: Record<string, jest.Mock>;
  } {
  const quickFilters = {
    findByUserId: jest.fn().mockResolvedValue([]),
    createForUser: jest.fn().mockResolvedValue([]),
    updateForUser: jest.fn().mockResolvedValue([]),
    deleteForUser: jest.fn().mockResolvedValue([]),
  };

  const users = {
    findByIdOrThrow: jest.fn().mockResolvedValue({ id: USER }),
  };

  const service = new QuickFilterService(
    quickFilters as unknown as CoreQuickFilterService,
    users as unknown as CoreUserService,
  );

  return { service, quickFilters, users };
}

describe('QuickFilterService', () => {
  it('reads own sets without an existence check', async () => {
    /**
     * The id came from a verified access token, so the extra round trip would
     * buy nothing.
     */
    const { service, quickFilters, users } = makeService();

    await service.getOwn(USER);

    expect(quickFilters.findByUserId).toHaveBeenCalledWith(USER);
    expect(users.findByIdOrThrow).not.toHaveBeenCalled();
  });

  it('checks the user exists before reading their sets', async () => {
    /**
     * Without this a mistyped id answers with an empty but entirely plausible
     * list instead of a 404.
     */
    const { service, quickFilters, users } = makeService();

    await service.getForUser('user-2' as ID);

    expect(users.findByIdOrThrow).toHaveBeenCalledWith('user-2');
    expect(quickFilters.findByUserId).toHaveBeenCalledWith('user-2');
  });

  it('propagates an unknown user instead of answering empty', async () => {
    const { service, quickFilters, users } = makeService();

    users.findByIdOrThrow.mockRejectedValueOnce(new Error('Not found'));

    await expect(service.getForUser('ghost' as ID)).rejects.toThrow();
    expect(quickFilters.findByUserId).not.toHaveBeenCalled();
  });

  it('hands the payload to the core service untouched', async () => {
    const { service, quickFilters } = makeService();
    const input = {
      name: 'Islay',
      filters: { countries: ['gb'], regions: ['islay'] },
    };

    await service.create(USER, input);

    expect(quickFilters.createForUser).toHaveBeenCalledWith(USER, input);

    const [, sent] = quickFilters.createForUser.mock.calls[0] as [
      ID,
      typeof input,
    ];

    expect(sent.filters).toEqual(input.filters);
  });

  it('scopes update and delete to the calling user', async () => {
    const { service, quickFilters } = makeService();

    await service.update(USER, 'qf-1' as ID, { name: 'Renamed' });
    await service.remove(USER, 'qf-1' as ID);

    expect(quickFilters.updateForUser)
      .toHaveBeenCalledWith(USER, 'qf-1', { name: 'Renamed' });
    expect(quickFilters.deleteForUser).toHaveBeenCalledWith(USER, 'qf-1');
  });
});
