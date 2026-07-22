import { GuidV7 } from '~decorators/fields';
import type { ID, SessionOwnerParams } from '~types';

export class SessionOwnerParamsDto implements SessionOwnerParams {
  @GuidV7()
  public userId!: ID;
}
