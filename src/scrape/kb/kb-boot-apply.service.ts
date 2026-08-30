import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { ScrapeConfig } from '~config';

import { KbReconcileService } from './kb-reconcile.service';

/**
 * Re-applies the knowledge base to the catalogue once, at application
 * bootstrap.
 *
 * A knowledge-base change that arrives through a migration — a verification
 * import, a promoted producer shipped from another environment — changes
 * nothing a filter reads until the catalogue is re-resolved. The review
 * screen solves this for its own edits by applying inline; deploys had no
 * equivalent, so every one of them owed a manual `pnpm reconcile-flavors` (or
 * a press of the review screen's apply button) that was easy to forget and
 * invisible when forgotten. Running the pass at bootstrap closes that gap:
 * deploy, migrate, boot — applied.
 *
 * Safe to run every boot by construction: the pass is idempotent (a second
 * run reports zeros), never touches a `manual` value, costs ~200 ms over the
 * whole catalogue, and `KbReconcileService` fails closed on an empty
 * knowledge base rather than stripping tags with nothing to put back. A boot
 * on a database that predates the knowledge-base schema logs the failure and
 * starts anyway — applying the catalogue is never worth failing the boot.
 *
 * Registered via `onApplicationBootstrap`, which runs after every module's
 * `onModuleInit` — the same ordering argument the sync cron documents.
 */
@Injectable()
export class KbBootApplyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KbBootApplyService.name);

  private readonly reconcile: KbReconcileService;

  private readonly config: ScrapeConfig;

  public constructor(reconcile: KbReconcileService, config: ScrapeConfig) {
    this.reconcile = reconcile;
    this.config = config;
  }

  /**
   * Runs the apply pass once, unless disabled by `KB_APPLY_ON_BOOT`.
   *
   * @returns Resolves when the pass finished or was skipped; never rejects —
   *   a failed apply is logged and the boot proceeds.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.config.kbApplyOnBoot) {
      this.logger.log('Knowledge-base boot apply is disabled');

      return;
    }

    try {
      const run = await this.reconcile.run();

      this.logger.log(
        'Knowledge base applied at boot: %d/%d groups resolved, '
          + '%d producer writes, %d fact writes, %d flavor writes',
        run.summary.resolved,
        run.summary.groups,
        run.summary.producerWrites,
        run.summary.factWrites,
        run.summary.flavorWrites,
      );
    } catch (error) {
      this.logger.error(
        'Knowledge-base boot apply failed: %s',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
