import { IsoDate } from '~decorators/fields';
import type { PushDispatchInput } from '~types';

export class PushDispatchDto implements PushDispatchInput {
  @IsoDate(true)
  public capturedOn?: string;
}
