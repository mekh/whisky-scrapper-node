import { GuidV7 } from '~decorators/fields';
import type { ID } from '~types';

export class ByIdDto {
  @GuidV7()
  public id!: ID;
}
