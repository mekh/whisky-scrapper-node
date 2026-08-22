import type { PushConfig } from '~config';
import type { CorePriceSnapshotService } from '~core/price-snapshot';
import type { CorePushService } from '~core/push';
import type { WebPushService } from '~lib/web-push';
import type { ID, PushDropRow, WebPushOutcome } from '~types';

import { PushDigestService } from '../src/domain/push/push-digest.service';

const DAY = '2026-08-23';

/**
 * Builds a claimed drop with sane defaults, overridable per test.
 *
 * @param overrides - Fields to replace.
 * @returns The drop row.
 */
function drop(overrides: Partial<PushDropRow>): PushDropRow {
  return {
    userId: 'user-1' as ID,
    productId: 'product-1' as ID,
    storeProductId: 'offer-1' as ID,
    name: 'Ardbeg',
    nameOrig: 'Ardbeg 10yo',
    age: 10,
    storeName: 'rozetka',
    price: 880,
    previousPrice: 1000,
    currency: 'UAH',
    discountPct: 12,
    ...overrides,
  };
}

/**
 * Builds the service over fully mocked collaborators.
 *
 * @param options - Per-test behavior knobs.
 * @returns The service and every mock it talks to.
 */
function makeService(options?: {
  enabled?: boolean;
  hasAny?: boolean;
  drops?: PushDropRow[];
  outcomes?: WebPushOutcome[];
}): {
  service: PushDigestService;
  core: Record<string, jest.Mock>;
  webPush: { enabled: boolean; send: jest.Mock };
  } {
  const outcomes = [...options?.outcomes ?? []];

  const core = {
    hasAnySubscription: jest.fn().mockResolvedValue(options?.hasAny ?? true),
    claimDrops: jest.fn().mockResolvedValue(options?.drops ?? []),
    findTargetsByUserIds: jest.fn().mockResolvedValue([
      {
        userId: 'user-1',
        endpoint: 'https://p.example/e1',
        p256dh: 'k',
        auth: 'a',
      },
      {
        userId: 'user-1',
        endpoint: 'https://p.example/e2',
        p256dh: 'k',
        auth: 'a',
      },
    ]),
    dropDeadEndpoints: jest.fn().mockResolvedValue(undefined),
    touchSuccess: jest.fn().mockResolvedValue(undefined),
    pruneDigestLog: jest.fn().mockResolvedValue(undefined),
  };

  const snapshots = {
    latestDate: jest.fn().mockResolvedValue(DAY),
  };

  const webPush = {
    enabled: options?.enabled ?? true,
    send: jest.fn().mockImplementation(() =>
      Promise.resolve(outcomes.shift() ?? 'sent')
    ),
  };

  const config = { concurrency: 2, logRetentionDays: 30 };

  const service = new PushDigestService(
    core as unknown as CorePushService,
    snapshots as unknown as CorePriceSnapshotService,
    webPush as unknown as WebPushService,
    config as PushConfig,
  );

  return { service, core, webPush };
}

describe('PushDigestService.dispatch', () => {
  it('does nothing while push is disabled', async () => {
    const { service, core } = makeService({ enabled: false });

    const report = await service.dispatch();

    expect(report.sent).toBe(0);
    expect(core.hasAnySubscription).not.toHaveBeenCalled();
    expect(core.claimDrops).not.toHaveBeenCalled();
  });

  it('skips the claim entirely when nobody is subscribed', async () => {
    const { service, core } = makeService({ hasAny: false });

    const report = await service.dispatch();

    expect(report.items).toBe(0);
    expect(core.claimDrops).not.toHaveBeenCalled();
  });

  it('sends one rendered digest to every device of a user', async () => {
    const drops = [
      drop({ storeProductId: 'offer-1' as ID }),
      drop({ storeProductId: 'offer-2' as ID, storeName: 'silpo' }),
    ];

    const { service, core, webPush } = makeService({ drops });

    const report = await service.dispatch();

    expect(core.claimDrops).toHaveBeenCalledWith(DAY, expect.any(Number));
    expect(core.findTargetsByUserIds).toHaveBeenCalledWith(['user-1']);
    expect(webPush.send).toHaveBeenCalledTimes(2);

    const payload = JSON.parse(
      (webPush.send.mock.calls[0] as [unknown, string])[1],
    ) as { body: string };

    expect(payload.body).toContain('Ardbeg 10yo −12%');
    expect(report).toMatchObject({
      capturedOn: DAY,
      users: 1,
      items: 2,
      sent: 2,
      gone: 0,
      failed: 0,
    });
  });

  it('deletes dead endpoints and stamps the accepted ones', async () => {
    const { service, core } = makeService({
      drops: [drop({})],
      outcomes: ['sent', 'gone'],
    });

    const report = await service.dispatch();

    expect(core.dropDeadEndpoints)
      .toHaveBeenCalledWith(['https://p.example/e2']);
    expect(core.touchSuccess).toHaveBeenCalledWith(['https://p.example/e1']);
    expect(report).toMatchObject({ sent: 1, gone: 1, failed: 0 });
  });

  it('prunes the dedup log by the retention window', async () => {
    const { service, core } = makeService({ drops: [drop({})] });

    await service.dispatch({ capturedOn: '2026-08-23' });

    expect(core.pruneDigestLog).toHaveBeenCalledWith('2026-07-24');
  });
});

describe('PushDigestService.dispatchAfterSync', () => {
  it('swallows a failing dispatch — a sync must never pay for it', async () => {
    const { service, core } = makeService();

    core.hasAnySubscription.mockRejectedValue(new Error('db down'));

    await expect(service.dispatchAfterSync()).resolves.toBeUndefined();
  });
});
