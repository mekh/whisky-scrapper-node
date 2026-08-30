import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { SCRAPE_ADAPTER_FACTORY } from '~constants';
import { CoreWhiskyModule } from '~core/core-whisky.module';

import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { HttpClientFactory } from './http/http-client.factory';
import { KbApplyService } from './kb/kb-apply.service';
import { KbBootApplyService } from './kb/kb-boot-apply.service';
import { KbReconcileService } from './kb/kb-reconcile.service';
import { KbResolverService } from './kb/kb-resolver.service';
import { LlmClientService } from './llm/llm-client.service';
import { LlmEnrichmentService } from './llm/llm-enrichment.service';
import { LlmFlavorService } from './llm/llm-flavor.service';
import { LlmNameExtractionService } from './llm/llm-name-extraction.service';
import { LlmResearchService } from './llm/llm-research.service';
import { NormalizeService } from './normalize/normalize.service';
import { ScrapePersistService } from './persist/scrape-persist.service';
import { ScrapeService } from './scrape.service';

/**
 * The in-process scraping engine: normalization, HTTP/browser transports, the
 * LLM fallback, the persistence pipeline, and `ScrapeService.collectStore`.
 * The orchestrator (domain layer) depends on this module's `ScrapeService`.
 */
@Module({
  imports: [
    ConfigModule,
    CoreWhiskyModule,
  ],
  providers: [
    NormalizeService,
    LlmClientService,
    LlmEnrichmentService,
    LlmNameExtractionService,
    LlmFlavorService,
    LlmResearchService,
    HttpClientFactory,
    KbResolverService,
    KbApplyService,
    KbReconcileService,
    KbBootApplyService,
    AdapterRegistryService,
    ScrapePersistService,
    ScrapeService,
    {
      provide: SCRAPE_ADAPTER_FACTORY,
      useExisting: AdapterRegistryService,
    },
  ],
  exports: [
    ScrapeService,
    LlmFlavorService,
    LlmResearchService,
    KbResolverService,
    KbReconcileService,
  ],
})
export class ScrapeModule {}
