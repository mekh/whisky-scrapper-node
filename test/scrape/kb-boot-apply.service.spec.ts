import 'reflect-metadata';

import { KbBootApplyService } from '../../src/scrape/kb/kb-boot-apply.service';

import type { ScrapeConfig } from '~config';
import type { KbReconcileService } from '../../src/scrape/kb/kb-reconcile.service';
import type { KbReconcileRun } from '../../src/scrape/kb/kb.interfaces';

/**
 * Builds the service around a fake reconcile pass and a config stub.
 *
 * @param enabled - The `KB_APPLY_ON_BOOT` value under test.
 * @param run - What the fake pass does when called.
 * @returns The service and the spy behind it.
 */
function build(
  enabled: boolean,
  run: jest.Mock,
): { service: KbBootApplyService; run: jest.Mock } {
  const reconcile = { run } as unknown as KbReconcileService;
  const config = { kbApplyOnBoot: enabled } as ScrapeConfig;

  return { service: new KbBootApplyService(reconcile, config), run };
}

/**
 * A plausible successful pass, for the happy path.
 *
 * @returns The run result.
 */
function summary(): KbReconcileRun {
  return {
    plan: {} as KbReconcileRun['plan'],
    rows: [],
    summary: {
      groups: 10,
      resolved: 8,
      producerWrites: 3,
      factWrites: 2,
      flavorWrites: 1,
    },
  };
}

describe('KbBootApplyService', () => {
  it('runs the apply pass once at bootstrap', async () => {
    const { service, run } = build(
      true,
      jest.fn().mockResolvedValue(summary()),
    );

    await service.onApplicationBootstrap();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith();
  });

  it('does nothing when disabled', async () => {
    const { service, run } = build(false, jest.fn());

    await service.onApplicationBootstrap();

    expect(run).not.toHaveBeenCalled();
  });

  it('swallows a failed pass instead of failing the boot', async () => {
    const { service, run } = build(
      true,
      jest.fn().mockRejectedValue(new Error('relation does not exist')),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
