import { IsBoolean, IsOptional, IsString } from 'class-validator';

import type { PushClientConfig } from '~types';

/**
 * Named `PushConfigType` because the plain name belongs to the `~config`
 * class. `publicKey` is null (not absent) while push is off, so the client's
 * discriminated rendering stays trivial.
 */
export class PushConfigType implements PushClientConfig {
  @IsBoolean()
  public enabled!: boolean;

  @IsString()
  @IsOptional()
  public publicKey!: string | null;
}
