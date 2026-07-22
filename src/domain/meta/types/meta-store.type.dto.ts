import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

import { MetaStore } from '~types';

export class MetaStoreType implements MetaStore {
  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsInt()
  public tier!: number;

  @IsBoolean()
  public needsBrowser!: boolean;

  @IsOptional()
  @IsString()
  public color!: string | null;

  @IsBoolean()
  public active!: boolean;
}
