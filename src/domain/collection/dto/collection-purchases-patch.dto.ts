import { Type } from 'class-transformer';
import { IsArray, IsOptional, ValidateNested } from 'class-validator';

import { GuidV7 } from '~decorators/fields';
import type { CollectionPurchasesPatchInput, ID } from '~types';

import { CollectionPurchaseChangeDto } from './collection-purchase-change.dto';
import { CollectionPurchaseDto } from './collection-purchase.dto';

/**
 * The `purchases` block of `CollectionUpdateDto`: the bottles to record,
 * the recorded ones to patch, and the ones to delete, all in one request so
 * a client's single «save» is a single transaction here. Each group is
 * optional and validated element by element; the overlap rule (a purchase
 * both patched and deleted) is the service's, since class-validator cannot
 * relate two fields.
 */
export class CollectionPurchasesPatchDto
  implements CollectionPurchasesPatchInput {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionPurchaseDto)
  public add?: CollectionPurchaseDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionPurchaseChangeDto)
  public update?: CollectionPurchaseChangeDto[];

  @GuidV7({ each: true }, { nullable: true })
  public remove?: ID[];
}
