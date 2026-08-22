import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';

import { BrandController } from './brand.controller';
import { BrandService } from './brand.service';

@Module({
  imports: [
    CoreWhiskyModule,
  ],
  controllers: [
    BrandController,
  ],
  providers: [
    BrandService,
  ],
})
export class DomainBrandModule {}
