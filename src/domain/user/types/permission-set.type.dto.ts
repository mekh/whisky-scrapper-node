import { Type } from 'class-transformer';
import { IsArray, IsEnum, ValidateNested } from 'class-validator';

import { Action, Resource } from '~enums';
import { PermissionGroup, PermissionSet } from '~types';

class PermissionGroupType implements PermissionGroup {
  @IsEnum(Resource)
  public resource!: Resource;

  @IsArray()
  @IsEnum(Action, { each: true })
  public actions!: Action[];
}

export class PermissionSetType implements PermissionSet {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionGroupType)
  public permissions!: PermissionGroupType[];
}
