import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  ValidateNested,
} from 'class-validator';

import { COLLECTION_PURCHASES_MAX_PER_REQUEST } from '~constants';
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
 *
 * Each group is capped at {@link COLLECTION_PURCHASES_MAX_PER_REQUEST}, and
 * that cap is the request's bound rather than a nicety: the service applies
 * the groups one statement at a time inside one transaction, so an
 * uncapped array turns a single 1 MiB body into hundreds of thousands of
 * statements holding a pooled connection — with `DB_POOL_SIZE` of them
 * enough to stall every other request in the process.
 */
export class CollectionPurchasesPatchDto
  implements CollectionPurchasesPatchInput {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COLLECTION_PURCHASES_MAX_PER_REQUEST)
  @ValidateNested({ each: true })
  @Type(() => CollectionPurchaseDto)
  public add?: CollectionPurchaseDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COLLECTION_PURCHASES_MAX_PER_REQUEST)
  @ValidateNested({ each: true })
  @Type(() => CollectionPurchaseChangeDto)
  public update?: CollectionPurchaseChangeDto[];

  @IsOptional()
  @ArrayMaxSize(COLLECTION_PURCHASES_MAX_PER_REQUEST)
  @GuidV7({ each: true })
  public remove?: ID[];
}
