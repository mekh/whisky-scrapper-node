import { Injectable, Logger } from '@nestjs/common';

import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { ServerError } from '~errors';
import type { KbApplyPlan, KbReconcileSummary } from '~types';

import { KbApplyService } from './kb-apply.service';

import type { KbReconcileRequest, KbReconcileRun } from './kb.interfaces';

/**
 * One reconciliation pass over the catalogue: resolve every bottling against
 * the knowledge base and write what it implies.
 *
 * **This exists because recording a decision and applying it are two different
 * things.** Promoting a producer on the review screen stores a claim; until the
 * catalogue is re-resolved, no bottling points at that producer and no filter
 * behaves differently — which is exactly how a reviewer promotes two producers
 * and sees the review queue not move. A store sync re-resolves only the
 * bottlings that run touched, so on its own it applies a promotion in
 * unpredictable instalments.
 *
 * The pass lives here, and not a second time in the CLI, for the reason
 * `CLAUDE.md` gives about `KbApplyService`: two implementations of the same
 * rule is the defect class this whole body of work removes. `pnpm
 * reconcile-flavors` and `POST /product/review/apply` are two front doors onto
 * this method.
 *
 * It is idempotent by construction — every write states what the knowledge
 * base says rather than changing it — so a second run straight after the first
 * reports zeros.
 */
@Injectable()
export class KbReconcileService {
  private readonly logger = new Logger(KbReconcileService.name);

  private readonly producers: CoreProducerService;

  private readonly products: CoreProductService;

  private readonly apply: KbApplyService;

  public constructor(
    producers: CoreProducerService,
    products: CoreProductService,
    apply: KbApplyService,
  ) {
    this.producers = producers;
    this.products = products;
    this.apply = apply;
  }

  /**
   * Plans the pass and, unless asked not to, writes it.
   *
   * @param request - What to narrow the pass to, and whether to write.
   * @returns The plan, the rows it was built from, and what was written.
   * @throws {ServerError} When the knowledge base is empty. Reconciling
   *   against nothing would strip every peat tag in the catalogue with nothing
   *   to put back, so this fails closed rather than "succeeding" destructively.
   */
  public async run(request: KbReconcileRequest = {}): Promise<KbReconcileRun> {
    const index = await this.producers.loadIndex();

    if (!index.aliases.length) {
      throw new ServerError(
        'The knowledge base is empty — run the seed migrations first.',
      );
    }

    const rows = await this.products.findKbReconcileCandidates(
      request.store,
      request.brand,
      request.ids,
    );

    const typeIds = await this.producers.resolveTypeIds(
      KbReconcileService.typeNames(index.aliases),
    );

    const plan = this.apply.plan(rows, index, typeIds, {
      ...(request.keepUnknownPeat === undefined
        ? {}
        : { keepUnknownPeat: request.keepUnknownPeat }),
    });

    if (request.dryRun) {
      return {
        plan,
        rows,
        summary: KbReconcileService.summarize(plan, 0, 0, 0),
      };
    }

    const producerWrites = await this.products.setProducers(plan.producers);
    const factWrites = await this.products.applyKbFacts(plan.facts);
    const flavorWrites = plan.flavors.filter((write) =>
      write.insertFlavorIds.length || write.deleteFlavorIds.length
    );

    await this.products.applyKbFlavors(flavorWrites);

    this.logger.log(
      'Reconciled the catalogue: %d producer, %d fact, %d flavor rows',
      producerWrites,
      factWrites,
      flavorWrites.length,
    );

    return {
      plan,
      rows,
      summary: KbReconcileService.summarize(
        plan,
        producerWrites,
        factWrites,
        flavorWrites.length,
      ),
    };
  }

  /**
   * The distinct whisky-type names the knowledge base states, so their ids can
   * be resolved in one read.
   *
   * @param aliases - The loaded alias index.
   * @returns Type names, without duplicates or blanks.
   */
  private static typeNames(
    aliases: { producer: { defaultTypeName: string | null } }[],
  ): string[] {
    const names = new Set<string>();

    aliases.forEach((alias) => {
      const name = alias.producer.defaultTypeName;

      if (name) {
        names.add(name);
      }
    });

    return [...names];
  }

  /**
   * Reduces a plan and its write counts to the numbers both callers report.
   *
   * @param plan - The plan that was built.
   * @param producerWrites - Producer rows written.
   * @param factWrites - Fact rows written.
   * @param flavorWrites - Flavour rows written.
   * @returns The summary.
   */
  private static summarize(
    plan: KbApplyPlan,
    producerWrites: number,
    factWrites: number,
    flavorWrites: number,
  ): KbReconcileSummary {
    return {
      groups: plan.groups.length,
      resolved: plan.resolutions.filter((one) => one.producer).length,
      producerWrites,
      factWrites,
      flavorWrites,
    };
  }
}
