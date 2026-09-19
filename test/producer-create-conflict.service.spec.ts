import 'reflect-metadata';

import { CoreProducerService } from '~core/producer';
import { KbStatus, ProducerKind } from '~enums';
import { DuplicateError } from '~errors';
import { KbReconcileService } from '~scrape/kb';

import { ProducerRuleFactory } from '../src/domain/product/producer-rule.factory';
import { ProducerService } from '../src/domain/product/producer.service';

import type { ProducerConflict } from '~types';

/**
 * The producer the verification round ruled out, which is the case this whole
 * file is about: no picker offers a `rejected` row, so its name reads as free
 * until the create is refused.
 */
const RULED_OUT: ProducerConflict = {
  id: 'k9',
  slug: 'vulson',
  name: 'Vulson',
  status: KbStatus.REJECTED,
  note: 'Rye eau-de-vie, not cask-aged.',
};

/**
 * Builds the service over fakes, with the create always refused by the slug
 * index — `createProducer` answers null for exactly that.
 *
 * @param owner - What the slug lookup finds, or null.
 * @returns The service under test.
 */
function serviceWith(owner: ProducerConflict | null): ProducerService {
  const producers = {
    createProducer: jest.fn().mockResolvedValue(null),
    findSlugOwner: jest.fn().mockResolvedValue(owner),
    findExistingIds: jest.fn().mockResolvedValue(new Set()),
  } as unknown as CoreProducerService;

  const reconcile = {
    run: jest.fn().mockResolvedValue({ summary: {} }),
  } as unknown as KbReconcileService;

  const rules = {
    buildMany: jest.fn().mockResolvedValue([]),
  } as unknown as ProducerRuleFactory;

  return new ProducerService(producers, reconcile, rules);
}

describe('creating a producer whose name is taken', () => {
  /**
   * The refusal has to name the holder: without it the client can only print
   * «could not create», and the reviewer is left with a name no picker offers
   * and no way to reach the row that holds it.
   */
  it('answers with the producer holding the slug', async () => {
    const service = serviceWith(RULED_OUT);

    const failure = await service
      .create({ name: 'Vulson', kind: ProducerKind.BRAND })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DuplicateError);
    expect((failure as DuplicateError).expose).toBe(true);
    expect((failure as DuplicateError).data).toEqual({ producer: RULED_OUT });
  });

  /**
   * A slug taken between the insert and the lookup (or a row deleted in
   * between) still has to refuse — with nothing exposed, rather than with a
   * half-read producer the dialog would draw an empty name from.
   */
  it('refuses without a payload when the holder cannot be read', async () => {
    const service = serviceWith(null);

    const failure = await service
      .create({ name: 'Vulson', kind: ProducerKind.BRAND })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DuplicateError);
    expect((failure as DuplicateError).expose).toBe(false);
    expect((failure as DuplicateError).data).toBeUndefined();
  });
});
