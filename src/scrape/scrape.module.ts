import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { SCRAPE_ADAPTER_FACTORY } from '~constants';
import { CoreWhiskyModule } from '~core/core-whisky.module';

import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { HttpClientFactory } from './http/http-client.factory';
import { LlmEnrichmentService } from './llm/llm-enrichment.service';
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
    LlmEnrichmentService,
    HttpClientFactory,
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
  ],
})
export class ScrapeModule {}
