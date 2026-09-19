import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CacheModule } from '~lib/cache';
import { ScrapeModule } from '~scrape/scrape.module';

import { ProducerReachService } from './producer-reach.service';
import { ProducerReviewService } from './producer-review.service';
import { ProducerRuleFactory } from './producer-rule.factory';
import { ProducerController } from './producer.controller';
import { ProducerService } from './producer.service';
import { ProductReviewController } from './product-review.controller';
import { ProductReviewService } from './product-review.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ReviewCommitService } from './review-commit.service';
import { ReviewPreviewService } from './review-preview.service';

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
    ProducerReviewService,
    ProducerRuleFactory,
    ProducerService,
    ReviewCommitService,
    ReviewPreviewService,
  ],
})
export class DomainProductModule {}
