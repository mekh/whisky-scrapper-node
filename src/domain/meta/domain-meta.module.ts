import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';

import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

@Module({
  imports: [
    CoreWhiskyModule,
  ],
  controllers: [
    MetaController,
  ],
  providers: [
    MetaService,
  ],
})
export class DomainMetaModule {}
