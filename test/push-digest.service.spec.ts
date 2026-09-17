import type { PushConfig } from '~config';
import type { CoreMessageService } from '~core/message';
import type { CorePriceSnapshotService } from '~core/price-snapshot';
import type { CorePushService } from '~core/push';
import type { MessageStreamService } from '~domain/message';
import type { PlatformMetricsService } from '~lib/metrics';
import type { WebPushService } from '~lib/web-push';
import type {
  ID,
  MessageDeliverInput,
  PushDropRow,
  WebPushOutcome,
} from '~types';

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
  metrics: Record<string, jest.Mock>;
  messages: Record<string, jest.Mock>;
  streams: Record<string, jest.Mock>;
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

  /**
   * A recorder that swallows everything: the digest counters have their own
   * coverage and these specs assert what was sent.
   */
  const metrics = {
    pushDigest: jest.fn(),
    pushSent: jest.fn(),
  };

  /**
   * The inbox write. It is what the dispatch records whether or not push is
   * configured, so the specs assert against it as much as against the sends.
   */
  const messages = {
    deliver: jest.fn().mockResolvedValue('message-1'),
  };

  /** The event fan-out, which the dispatch fires but does not depend on. */
  const streams = {
    announce: jest.fn().mockResolvedValue(undefined),
  };

  const service = new PushDigestService(
    core as unknown as CorePushService,
    messages as unknown as CoreMessageService,
    streams as unknown as MessageStreamService,
    snapshots as unknown as CorePriceSnapshotService,
    webPush as unknown as WebPushService,
    config as PushConfig,
    metrics as unknown as PlatformMetricsService,
  );

  return { service, core, webPush, metrics, messages, streams };
}

describe('PushDigestService.dispatch', () => {
  it('still claims and records while push is disabled', async () => {
    /*
     * The guard used to sit above the claim, which meant an unconfigured
     * VAPID key silently emptied the inbox as well as the push channel. The
     * inbox is the durable record and does not depend on push at all.
     */
    const { service, core, webPush, messages } = makeService({
      enabled: false,
      drops: [drop({})],
    });

    const report = await service.dispatch();

    expect(core.claimDrops).toHaveBeenCalled();
    expect(messages.deliver).toHaveBeenCalledTimes(1);
    expect(webPush.send).not.toHaveBeenCalled();
    expect(report.sent).toBe(0);
  });

  it('still claims and records when nobody is subscribed', async () => {
    const { service, core, webPush, messages } = makeService({
      hasAny: false,
      drops: [drop({})],
    });

    const report = await service.dispatch();

    expect(core.claimDrops).toHaveBeenCalled();
    expect(messages.deliver).toHaveBeenCalledTimes(1);
    expect(webPush.send).not.toHaveBeenCalled();
    expect(report.items).toBe(1);
  });

  it('records the message before it tries to send anything', async () => {
    const { service, messages } = makeService({
      drops: [
        drop({ storeProductId: 'offer-1' as ID }),
        drop({ storeProductId: 'offer-2' as ID, storeName: 'silpo' }),
      ],
    });

    await service.dispatch();

    expect(messages.deliver).toHaveBeenCalledTimes(1);

    const calls = messages.deliver.mock.calls as [MessageDeliverInput][];
    const delivered = calls[0]![0];

    expect(delivered.kind).toBe('discount_digest');
    expect(delivered.userIds).toEqual(['user-1']);
    expect(delivered.payload.total).toBe(1);

    const items = delivered.payload.items ?? [];

    expect(items).toHaveLength(1);

    /*
     * The prices the push body never names: the inbox renders them, and they
     * come from the same reduction that picked the winning offer.
     */
    expect(items[0]).toMatchObject({
      name: 'Ardbeg 10yo',
      price: expect.any(Number),
      previousPrice: expect.any(Number),
      currency: 'UAH',
    });
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
