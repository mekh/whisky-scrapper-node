import { Injectable } from '@nestjs/common';
import { DeepPartial } from 'typeorm';

import { CoreBaseService } from '~core/_common';
import { Hash } from '~utils';

import { UserEntity } from './user.entity';
import { UserRepository } from './user.repository';

import { EntityAuthUser, ID, UserGetByInput } from '~types';

/**
 * Persistence-layer public API for the `user` entity. Inherits the generic
 * CRUD surface from {@link CoreBaseService} and adds the password-specific
 * operations.
 */
@Injectable()
export class CoreUserService extends CoreBaseService<UserEntity> {
  protected readonly uniqueFields: 'email'[] = ['email'];

  public constructor(protected readonly repo: UserRepository) {
    super(repo);
  }

  public async getAuthInfo(
    { id, name, email }: UserGetByInput,
  ): Promise<EntityAuthUser | null> {
    return id || name || email
      ? this.repo.getAuthInfo({ id, name, email })
      : null;
  }

  /**
   * Checks a plaintext password against a user's stored hash.
   *
   * @param id - Identifier of the user to check.
   * @param password - The plaintext password to verify.
   * @returns `true` when the password matches; `false` when it does not or
   *   the user has no stored hash.
   */
  public async verifyPassword(id: ID, password: string): Promise<boolean> {
    const hash = await this.repo.getPasswordHash(id);

    if (!hash) {
      return false;
    }

    return Hash.verifyAsync(password, hash);
  }

  /**
   * Replaces a user's password. The new value is hashed on write by the
   * entity's column transformer.
   *
   * @param id - Identifier of the user whose password is changed.
   * @param password - The new plaintext password.
   * @throws {NotFoundError} When no user has the given id.
   */
  public async changePassword(id: ID, password: string): Promise<void> {
    await this.findByIdOrThrow(id);

    await this.repo.save({ id, password } as DeepPartial<UserEntity>);
  }
}
