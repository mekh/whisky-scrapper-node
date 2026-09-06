import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  COLLECTION_BARCODE_PATTERN,
  COLLECTION_NOTE_MAX_LENGTH,
  COLLECTION_RATING_MAX,
  COLLECTION_RATING_MIN,
  COLLECTION_RATING_SCALE,
} from '~constants';
import { GuidV7 } from '~decorators/fields';
import type { CollectionCreateInput, ID } from '~types';

import { CollectionPurchaseDto } from './collection-purchase.dto';

export class CollectionCreateDto implements CollectionCreateInput {
  @GuidV7()
  public productId!: ID;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: COLLECTION_RATING_SCALE })
  @Min(COLLECTION_RATING_MIN)
  @Max(COLLECTION_RATING_MAX)
  public rating?: number;

  @IsOptional()
  @Matches(COLLECTION_BARCODE_PATTERN)
  public barcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public nose?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public palate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public finish?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionPurchaseDto)
  public purchase?: CollectionPurchaseDto;
}
