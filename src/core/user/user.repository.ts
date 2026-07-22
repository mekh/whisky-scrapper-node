import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ServerError } from '~errors';
import { EntityAuthUser, ID, UserGetByInput } from '~types';

import { UserEntity } from './user.entity';

@TypeormRepository(UserEntity)
export class UserRepository extends BaseRepository<UserEntity> {
  public async getAuthInfo(
    { id, name, email }: UserGetByInput,
  ): Promise<EntityAuthUser | null> {
    if (!id && !email && !name) {
      throw new ServerError('id, email or name required');
    }

    const where = {
      ...(id ? { id: id } : {}),
      ...(!id && email ? { email: email } : {}),
      ...(!id && !email && name ? { name: name } : {}),
    };

    const select: Record<keyof Omit<EntityAuthUser, 'permissions'>, boolean> = {
      id: true,
      admin: true,
      active: true,
      password: true,
    };

    return this.findOne({
      where,
      select,
      relations: { permissions: true },
    });
  }

  /**
   * Loads the stored Argon2 hash of a single user's password.
   *
   * The `password` column is declared `select: false`, so it is re-enabled
   * explicitly here. The returned hash is an internal secret and must never
   * leave the core user layer.
   *
   * @param id - Identifier of the user whose hash is requested.
   * @returns The stored password hash, or `null` when no such user exists.
   */
  public async getPasswordHash(id: ID): Promise<string | null> {
    const user = await this.findOne({
      where: { id },
      select: { id: true, password: true },
    });

    return user?.password ?? null;
  }
}
