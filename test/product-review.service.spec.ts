import type { CoreFlavorService } from '~core/flavor';
import type { CoreProducerService } from '~core/producer';
import type { CoreProductService } from '~core/product';
import { ProducerReachService } from '~domain/product/producer-reach.service';
import { ProductReviewService } from '~domain/product/product-review.service';
import { NotFoundError } from '~errors';
import type { VersionedCacheService } from '~lib/cache';
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
  const flavors = {} as unknown as CoreFlavorService;
  const reach = {} as unknown as ProducerReachService;
  const reconcile = { run } as unknown as KbReconcileService;
  const cache = {
    bumpAfterCommit: (): void => undefined,
  } as unknown as VersionedCacheService;

  return {
    service: new ProductReviewService(
      producers,
      products,
      flavors,
      reach,
      reconcile,
      cache,
    ),
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

/**
 * The queue counters as the repository hands them back.
 */
const COUNTS = { pending: 12, verified: 340, rejected: 7, legacy: 3480 };

interface QueueDoubles {
  service: ProductReviewService;
  applyReviewStatus: jest.Mock;
  findReviewQueue: jest.Mock;
  countReviewStatuses: jest.Mock;
  bumpAfterCommit: jest.Mock;
}

/**
 * Builds the service with just the collaborators the new-product queue uses.
 *
 * @returns The service and the doubles a case asserts on.
 */
function buildQueue(): QueueDoubles {
  const applyReviewStatus = jest.fn().mockResolvedValue(2);
  const findReviewQueue = jest.fn().mockResolvedValue({ rows: [], total: 0 });
  const countReviewStatuses = jest.fn().mockResolvedValue(COUNTS);
  const bumpAfterCommit = jest.fn();

  const products = {
    applyReviewStatus,
    findReviewQueue,
    countReviewStatuses,
  } as unknown as CoreProductService;

  return {
    service: new ProductReviewService(
      {} as unknown as CoreProducerService,
      products,
      {} as unknown as CoreFlavorService,
      {} as unknown as ProducerReachService,
      {} as unknown as KbReconcileService,
      { bumpAfterCommit } as unknown as VersionedCacheService,
    ),
    applyReviewStatus,
    findReviewQueue,
    countReviewStatuses,
    bumpAfterCommit,
  };
}

describe('ProductReviewService.queuePage', () => {
  it('lists the pending bucket when the caller names none', async () => {
    /**
     * The default is the work. Defaulting to "all" would put the archive —
     * everything already verified — in front of a reviewer opening the tab.
     */
    const { service, findReviewQueue } = buildQueue();

    await service.queuePage({});

    expect(findReviewQueue).toHaveBeenCalledWith(
      'pending',
      50,
      0,
      undefined,
      undefined,
    );
  });

  it('passes the bucket, the search and the paging through', async () => {
    const { service, findReviewQueue } = buildQueue();

    const page = await service.queuePage({
      reviewStatus: 'rejected' as never,
      name: 'arran',
      store: 'goodwine',
      page: 3,
      perPage: 20,
    });

    expect(findReviewQueue).toHaveBeenCalledWith(
      'rejected',
      20,
      40,
      'arran',
      'goodwine',
    );
    expect(page).toEqual({ data: [], total: 0, limit: 20, offset: 40 });
  });
});

describe('ProductReviewService.setStatus', () => {
  it('writes the verdict and answers with the fresh counters', async () => {
    const { service, applyReviewStatus } = buildQueue();

    const result = await service.setStatus({
      productIds: ['a' as ID, 'b' as ID],
      reviewStatus: 'rejected' as never,
    });

    expect(applyReviewStatus).toHaveBeenCalledWith(['a', 'b'], 'rejected');
    expect(result).toEqual({ updated: 2, products: COUNTS });
  });

  it('stamps without the pending-only gate', async () => {
    /**
     * The gate belongs to the edit path, which must leave a legacy row null
     * and a rejected one rejected. Here the reviewer is deciding outright, so
     * every named row is written — which is also what makes un-rejecting and
     * putting a row back in the queue the same operation.
     */
    const { service, applyReviewStatus } = buildQueue();

    await service.setStatus({
      productIds: ['a' as ID],
      reviewStatus: 'pending' as never,
    });

    expect(applyReviewStatus).toHaveBeenCalledWith(['a'], 'pending');
  });

  it('bumps the catalogue cache whatever the verdict', async () => {
    /**
     * Deliberately unconditional, though only the `rejected` boundary changes
     * what a report returns. One request may carry both values, and a rule
     * about which ones matter is a rule that drifts — while the cost is
     * asymmetric: a spent bump regenerates a set that expires daily anyway, a
     * missed one serves a rejected bottling until the next sync. The bulk
     * shape is what keeps that cheap, since a pass over fifty rows is one
     * request and one bump.
     */
    const { service, bumpAfterCommit } = buildQueue();

    await service.setStatus({
      productIds: ['a' as ID],
      reviewStatus: 'verified' as never,
    });

    expect(bumpAfterCommit).toHaveBeenCalledTimes(1);
    expect(bumpAfterCommit).toHaveBeenCalledWith(
      'catalogue',
      'product:review',
    );
  });
});
