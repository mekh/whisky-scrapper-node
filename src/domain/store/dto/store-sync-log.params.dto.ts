import { IsString } from 'class-validator';

import { GuidV7 } from '~decorators/fields';

import type { ID, StoreSyncLogParams } from '~types';

export class StoreSyncLogParamsDto implements StoreSyncLogParams {
  @IsString()
  public slug!: string;

  @GuidV7()
  public id!: ID;
}
