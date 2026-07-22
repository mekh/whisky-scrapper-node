import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { BrandRepository } from './brand.repository';
import { CoreBrandService } from './core-brand.service';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(BrandRepository),
  ],
  providers: [
    CoreBrandService,
  ],
  exports: [
    CoreBrandService,
  ],
})
export class CoreBrandModule {}
