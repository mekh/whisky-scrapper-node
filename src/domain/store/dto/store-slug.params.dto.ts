import { IsString } from 'class-validator';

import { StoreSlugParams } from '~types';

export class StoreSlugParamsDto implements StoreSlugParams {
  @IsString()
  public slug!: string;
}
