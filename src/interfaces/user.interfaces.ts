import { CreateInputBase, PaginatedInputBase } from './crud.interfaces';
import { EntityUser } from './entity.interfaces';

export type UserGetByInput = Pick<
  Partial<EntityUser>,
  'id' | 'email' | 'name'
>;

export type UserCreateInput = Omit<
  CreateInputBase<EntityUser>,
  | 'lastActiveAt'
  | 'admin'
>;
export type UserUpdateInput = Partial<Omit<UserCreateInput, 'password'>>;

export interface UserChangePasswordInput {
  /**
   * The user's current plaintext password. Required when users change their
   * own password (it is verified first); omitted when a privileged actor
   * (`USER:UPDATE`) changes another user's password.
   */
  oldPassword?: string;

  /**
   * The new plaintext password to set. Hashed by the persistence layer.
   */
  newPassword: string;
}

export type UserPaginateInput = PaginatedInputBase;
