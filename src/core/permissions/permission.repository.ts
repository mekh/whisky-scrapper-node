import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID } from '~types';

import { PermissionEntity } from './permission.entity';

@TypeormRepository(PermissionEntity)
export class PermissionRepository extends BaseRepository<PermissionEntity> {
  /**
   * Loads every permission row that belongs to a single user.
   *
   * @param userId - Identifier of the owning user.
   * @returns The user's permission rows; an empty array when the user has
   *   none.
   */
  public async findByUserId(userId: ID): Promise<PermissionEntity[]> {
    return this.find({ where: { userId } });
  }
}
