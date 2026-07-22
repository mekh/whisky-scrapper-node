import { Injectable } from '@nestjs/common';

import { CoreUserService as UserCoreService } from '~core/user';
import { BadRequestError } from '~errors';

import { DomainBaseService } from '../_common';

import type { CtxUser, EntityUser, ID, UserChangePasswordInput } from '~types';

/**
 * Business-layer user operations behind the REST controller. Inherits generic
 * CRUD from {@link DomainBaseService} and adds password management.
 */
@Injectable()
export class DomainUserService extends DomainBaseService<EntityUser> {
  public constructor(private readonly users: UserCoreService) {
    super(users);
  }

  /**
   * Changes a user's password. When the actor changes their own password, the
   * current password is required and verified; when a privileged actor
   * (authorized via `USER:UPDATE`) targets another user, the old-password
   * check is skipped. The guard enforces authorization, so any
   * cross-user target reaching here is already permitted.
   *
   * @param data - The new password and, for self-changes, the old one.
   * @param actor - The authenticated user performing the change.
   * @param targetId - The user to update; defaults to the actor.
   * @throws {BadRequestError} When changing one's own password and the old
   *   password is missing or incorrect.
   */
  public async changePassword(
    data: UserChangePasswordInput,
    actor: CtxUser,
    targetId?: ID,
  ): Promise<void> {
    const userId = targetId ?? actor.id;

    if (userId === actor.id) {
      await this.verifyCurrentPassword(userId, data.oldPassword);
    }

    await this.users.changePassword(userId, data.newPassword);
  }

  /**
   * Verifies a user's current password, rejecting a missing or wrong one.
   *
   * @param userId - The user whose password is being verified.
   * @param oldPassword - The supplied current plaintext password.
   * @throws {BadRequestError} When the password is missing or incorrect.
   */
  private async verifyCurrentPassword(
    userId: ID,
    oldPassword?: string,
  ): Promise<void> {
    if (!oldPassword) {
      throw new BadRequestError('Current password is required');
    }

    const valid = await this.users.verifyPassword(userId, oldPassword);

    if (!valid) {
      throw new BadRequestError('Current password is incorrect');
    }
  }
}
