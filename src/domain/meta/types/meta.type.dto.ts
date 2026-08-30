import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, ValidateNested } from 'class-validator';

import { Meta } from '~types';

import { MetaCountryType } from './meta-country.type.dto';
import { MetaStoreType } from './meta-store.type.dto';

export class MetaType implements Meta {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetaStoreType)
  public stores!: MetaStoreType[];

  @IsArray()
  @IsString({ each: true })
  public flavors!: string[];

  @IsArray()
  @IsString({ each: true })
  public types!: string[];

  /**
   * Scotland's regions by the market convention, `islands` included — the list
   * a filter chip should offer. The client's label must say "common", because
   * five of these producers are legally Highland.
   */
  @IsArray()
  @IsString({ each: true })
  public regions!: string[];

  /**
   * The five protected SWA regions. Display only; `islands` is never here.
   */
  @IsArray()
  @IsString({ each: true })
  public legalRegions!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetaCountryType)
  public countries!: MetaCountryType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetaCountryType)
  public allCountries!: MetaCountryType[];

  @IsArray()
  @IsString({ each: true })
  public windows!: string[];

  @IsArray()
  @IsInt({ each: true })
  public perPageOptions!: number[];

  @IsInt()
  public defaultPerPage!: number;
}
