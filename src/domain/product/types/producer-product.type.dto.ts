import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

import type { ProducerProductRow } from '~types';

export class ProducerProductType implements ProducerProductRow {
  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsInt()
  public productCount!: number;

  @IsBoolean()
  public inStock!: boolean;
}
