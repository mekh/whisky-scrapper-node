import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CacheModule } from '~lib/cache';

import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

@Module({
  imports: [
    CacheModule,
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
