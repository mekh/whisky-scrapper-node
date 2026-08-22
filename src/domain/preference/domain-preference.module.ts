import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CoreUserModule } from '~core/user';

import { PreferenceController } from './preference.controller';
import { PreferenceService } from './preference.service';

@Module({
  imports: [
    CoreWhiskyModule,
    CoreUserModule,
  ],
  controllers: [
    PreferenceController,
  ],
  providers: [
    PreferenceService,
  ],
})
export class DomainPreferenceModule {}
