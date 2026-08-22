import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Resource } from '~enums';

import { DashboardController } from '../../src/domain/dashboard/dashboard.controller';

import type { AuthPermissionMeta } from '~types';
import type { DashboardService } from '../../src/domain/dashboard/dashboard.service';

const HANDLERS = [
  'meta',
  'summary',
  'series',
  'breakdown',
  'movers',
  'syncActivity',
] as const;

describe('DashboardController permissions', () => {
  it.each([...HANDLERS])(
    '%s carries the authenticated-read metadata',
    (handler) => {
      /**
       * A handler shipped without `@Plain` would pass every unit test and
       * then 500 at runtime — `ContextManager.getMetaOrThrow` treats missing
       * metadata as an unexposed resource. This is the guard against that.
       */
      const method = Object.getOwnPropertyDescriptor(
        DashboardController.prototype,
        handler,
      )?.value as object;
      const meta = Reflect.getMetadata(
        PERMISSION_META_INJECT_TOKEN,
        method,
      ) as AuthPermissionMeta | undefined;

      expect(meta?.permissions).toEqual([[Resource.AUTHENTICATED]]);
      expect(meta?.isPublic).toBe(false);
    },
  );
});

describe('DashboardController delegation', () => {
  it('hands the query DTOs to the service untouched', async () => {
    const service = {
      meta: jest.fn().mockResolvedValue('meta'),
      summary: jest.fn().mockResolvedValue('summary'),
      series: jest.fn().mockResolvedValue('series'),
      breakdown: jest.fn().mockResolvedValue('breakdown'),
      movers: jest.fn().mockResolvedValue('movers'),
      syncActivity: jest.fn().mockResolvedValue('sync'),
    };
    const controller = new DashboardController(
      service as unknown as DashboardService,
    );
    const range = { from: '2026-08-01', to: '2026-08-21' };

    await controller.meta();
    await controller.summary(range);
    await controller.series({ ...range, byStore: true });
    await controller.movers({ ...range, limit: 5 });
    await controller.syncActivity(range);

    expect(service.meta).toHaveBeenCalled();
    expect(service.summary).toHaveBeenCalledWith(range);
    expect(service.series).toHaveBeenCalledWith({ ...range, byStore: true });
    expect(service.movers).toHaveBeenCalledWith({ ...range, limit: 5 });
    expect(service.syncActivity).toHaveBeenCalledWith(range);
  });
});
