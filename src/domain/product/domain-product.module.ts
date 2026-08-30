import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { ScrapeModule } from '~scrape/scrape.module';

import { ProducerReachService } from './producer-reach.service';
import { ProducerController } from './producer.controller';
import { ProductReviewController } from './product-review.controller';
import { ProductReviewService } from './product-review.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

@Module({
  imports: [
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
