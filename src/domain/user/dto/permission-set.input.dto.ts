import { Type } from 'class-transformer';
import { IsArray, IsEnum, ValidateNested } from 'class-validator';

import { Action, Resource } from '~enums';
import { PermissionGroup, PermissionSet } from '~types';

class PermissionGroupInputDto implements PermissionGroup {
  @IsEnum(Resource)
  public resource!: Resource;

  @IsArray()
  @IsEnum(Action, { each: true })
  public actions!: Action[];
}

export class PermissionSetInputDto implements PermissionSet {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PermissionGroupInputDto)
  public permissions!: PermissionGroupInputDto[];
}
