import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreFlavorService } from './core-flavor.service';
import { FlavorRepository } from './flavor.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(FlavorRepository),
  ],
  providers: [
    CoreFlavorService,
  ],
  exports: [
    CoreFlavorService,
  ],
})
export class CoreFlavorModule {}
