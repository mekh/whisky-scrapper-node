import { GuidV7 } from '~decorators/fields';
import type { ID } from '~types';

export class ByUserIdDto {
  @GuidV7()
  public userId!: ID;
}
