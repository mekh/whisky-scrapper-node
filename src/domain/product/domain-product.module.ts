import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CacheModule } from '~lib/cache';
import { ScrapeModule } from '~scrape/scrape.module';

import { ProducerReachService } from './producer-reach.service';
import { ProducerController } from './producer.controller';
import { ProductReviewController } from './product-review.controller';
import { ProductReviewService } from './product-review.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

@Module({
  imports: [
    CacheModule,
    CoreWhiskyModule,
    ScrapeModule,
  ],
  controllers: [
    ProductController,
    ProductReviewController,
    ProducerController,
  ],
  providers: [
    ProductService,
    ProductReviewService,
    ProducerReachService,
  ],
})
export class DomainProductModule {}
