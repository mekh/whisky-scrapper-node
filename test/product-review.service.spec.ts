import type { CoreProducerService } from '~core/producer';
import type { CoreProductService } from '~core/product';
import { ProducerReachService } from '~domain/product/producer-reach.service';
import { ProductReviewService } from '~domain/product/product-review.service';
import { NotFoundError } from '~errors';
import type { KbReconcileService } from '~scrape/kb';
import type { ID, ProducerReviewRow } from '~types';

/**
 * A promoted producer, as the repository hands it back.
 */
const PROMOTED = {
  id: 'p1' as ID,
  slug: 'jura',
  name: 'Jura',
  status: 'verified',
} as unknown as ProducerReviewRow;

/**
 * What one reconciliation pass reports.
 */
const SUMMARY = {
  groups: 2942,
  resolved: 1775,
  producerWrites: 106,
  factWrites: 61,
  flavorWrites: 104,
};

interface Doubles {
  service: ProductReviewService;
  applyReview: jest.Mock;
  run: jest.Mock;
}

/**
 * Builds the service with fake collaborators.
 *
 * @param updated - What `applyReview` resolves to; null means no such row.
 * @returns The service and the two doubles a case asserts on.
 */
function build(updated: ProducerReviewRow | null = PROMOTED): Doubles {
  const applyReview = jest.fn().mockResolvedValue(updated);
  const run = jest.fn().mockResolvedValue({
    plan: {
      groups: [],
      resolutions: [],
      producers: [],
      facts: [],
      flavors: [],
    },
    rows: [],
    summary: SUMMARY,
  });

  const producers = { applyReview } as unknown as CoreProducerService;
  const products = {} as unknown as CoreProductService;
  const reach = {} as unknown as ProducerReachService;
  const reconcile = { run } as unknown as KbReconcileService;

  return {
    service: new ProductReviewService(producers, products, reach, reconcile),
    applyReview,
    run,
  };
}

describe('ProductReviewService.patchProducer', () => {
  it('applies the knowledge base in the same request', async () => {
    /**
     * The behaviour this test exists for. Storing the decision alone changes
     * nothing a filter reads — no bottling points at the producer until the
     * catalogue is re-resolved — which is how promoting two producers left the
     * review counts untouched. There is no reason to defer the pass: it costs
     * ~200 ms, is idempotent, and never touches a `manual` value.
     */
    const { service, run } = build();

    const result = await service.patchProducer('p1' as ID, {
      status: 'verified',
    } as never);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.producer).toBe(PROMOTED);
    expect(result.applied).toEqual(SUMMARY);
  });

  it('applies on every edit, not only on a promotion', async () => {
    /**
     * Deliberately unconditional: a rule about which fields can change
     * resolution is a rule that drifts, and the pass writes nothing when
     * nothing changed.
     */
    const { service, run } = build();

    await service.patchProducer('p1' as ID, { note: 'checked' } as never);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs the pass when no producer matched', async () => {
    const { service, run } = build(null);

    await expect(service.patchProducer('nope' as ID, {} as never))
      .rejects.toBeInstanceOf(NotFoundError);

    expect(run).not.toHaveBeenCalled();
  });
});
