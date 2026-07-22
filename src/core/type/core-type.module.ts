import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreTypeService } from './core-type.service';
import { TypeRepository } from './type.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(TypeRepository),
  ],
  providers: [
    CoreTypeService,
  ],
  exports: [
    CoreTypeService,
  ],
})
export class CoreTypeModule {}
