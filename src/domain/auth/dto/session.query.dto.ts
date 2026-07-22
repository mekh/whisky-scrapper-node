import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive } from 'class-validator';

import type { SessionQuery } from '~types';

export class SessionQueryDto implements SessionQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  public limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  public page?: number;
}
