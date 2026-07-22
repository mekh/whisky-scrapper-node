import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

import { GuidV7 } from '~decorators/fields';
import type { AuthMe, CtxUser, ID, PermissionMap } from '~types';

/**
 * Flattens a permission map into `resource:action` strings for the client.
 *
 * @param permissions - The user's permission map, if resolved.
 * @returns The permissions as `resource:action` strings (empty when none).
 */
function toScopeList(permissions?: PermissionMap): string[] {
  if (!permissions) {
    return [];
  }

  return [...permissions].flatMap(([resource, actions]) =>
    [...actions].map((action) => `${resource}:${action}`)
  );
}

export class Me implements AuthMe {
  @GuidV7()
  public id!: ID;

  @IsString()
  @IsNotEmpty()
  public sid!: string;

  @IsOptional()
  @IsBoolean()
  public admin?: boolean;

  @IsArray()
  @IsString({ each: true })
  @Transform(({ obj }: { obj: CtxUser }) => toScopeList(obj.permissions))
  public permissions!: string[];
}
