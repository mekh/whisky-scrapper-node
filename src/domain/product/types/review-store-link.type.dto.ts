import { IsBoolean, IsString } from 'class-validator';

import type { ReviewStoreLink } from '~types';

export class ReviewStoreLinkType implements ReviewStoreLink {
  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsString()
  public url!: string;

  @IsBoolean()
  public inStock!: boolean;
}
