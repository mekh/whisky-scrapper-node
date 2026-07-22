import { GuidV7 } from '~decorators/fields';
import type { ID } from '~types';

export class UserIdParamDto {
  @GuidV7()
  public userId!: ID;
}
