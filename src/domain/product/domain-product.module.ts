import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';

import { ProductController } from './product.controller';
import { ProductService } from './product.service';

@Module({
  imports: [
    CoreWhiskyModule,
  ],
  controllers: [
    ProductController,
  ],
  providers: [
    ProductService,
  ],
})
export class DomainProductModule {}
