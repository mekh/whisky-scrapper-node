import { GuidV7 } from '~decorators/fields';
import type { CollectionPurchaseParams, ID } from '~types';

export class ByPurchaseIdParamsDto implements CollectionPurchaseParams {
  @GuidV7()
  public id!: ID;

  @GuidV7()
  public purchaseId!: ID;
}
