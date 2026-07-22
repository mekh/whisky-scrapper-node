import { IsArray, IsEnum } from 'class-validator';

import { Action, Resource } from '~enums';
import { PermissionConfig } from '~types';

export class PermissionConfigType implements PermissionConfig {
  @IsArray()
  @IsEnum(Resource, { each: true })
  public resources!: Resource[];

  @IsArray()
  @IsEnum(Action, { each: true })
  public actions!: Action[];
}
