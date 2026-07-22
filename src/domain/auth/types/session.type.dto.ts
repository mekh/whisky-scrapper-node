import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

import type { TypeSessionPublic } from '~types';

export class Session implements TypeSessionPublic {
  @IsString()
  @IsNotEmpty()
  public sid!: string;

  @IsString()
  public ip!: string;

  @IsString()
  public userAgent!: string;

  @IsInt()
  @Min(0)
  public expires!: number;
}
