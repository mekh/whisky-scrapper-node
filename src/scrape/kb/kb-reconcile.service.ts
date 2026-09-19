import { Injectable, Logger } from '@nestjs/common';

import { CACHE_GENERATION_CATALOGUE, KB_APPLIED_AT_KEY } from '~constants';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { ServerError } from '~errors';
import { VersionedCacheService } from '~lib/cache';
import { ValkeyClient, ValkeyCluster, ValkeyService } from '~lib/valkey';
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

  private readonly cache: VersionedCacheService;

  private readonly storage: ValkeyClient | ValkeyCluster;

  public constructor(
    producers: CoreProducerService,
    products: CoreProductService,
    apply: KbApplyService,
    cache: VersionedCacheService,
    valkey: ValkeyService,
  ) {
    this.producers = producers;
    this.products = products;
    this.apply = apply;
    this.cache = cache;
    this.storage = valkey.getClient();
  }

  /**
   * When the catalogue was last re-resolved against the knowledge base.
   *
   * Read by the curation screen's header, which says so beside the «База
   * знань» button — the one thing that tells a person whether the decision
   * they just recorded is already in the reports.
   *
   * @returns The moment, or null when no pass has run since the key was
   *   introduced or the store cannot answer.
   */
  public async lastAppliedAt(): Promise<Date | null> {
    try {
      const stamp = await this.storage.get(KB_APPLIED_AT_KEY);

      return stamp ? new Date(stamp) : null;
    } catch (error) {
      this.logger.warn('Could not read the apply stamp: %o', error);

      return null;
    }
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

    /**
     * One bump for the whole pass, and it covers every caller: the four
     * review endpoints, the boot apply, and `pnpm reconcile-flavors`. The
     * three writes above are separate autocommits, so there is no
     * transaction to wait for and this runs immediately — which is correct,
     * because by the time control reaches this line all three have
     * committed.
     */
    this.cache.bumpAfterCommit(CACHE_GENERATION_CATALOGUE, 'kb:reconcile');

    await this.stampApplied();

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
   * Records that a pass has just run, best-effort.
   *
   * A stamp that could not be written is not a failed reconciliation — the
   * catalogue is already correct — so the failure is logged and swallowed.
   *
   * @returns Resolves once the stamp is written or the failure is logged.
   */
  private async stampApplied(): Promise<void> {
    try {
      await this.storage.set(KB_APPLIED_AT_KEY, new Date().toISOString());
    } catch (error) {
      this.logger.warn('Could not stamp the apply time: %o', error);
    }
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
