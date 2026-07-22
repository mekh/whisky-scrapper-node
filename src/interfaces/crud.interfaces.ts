import { EntityBase, ID } from './entity.interfaces';

export type CreateInputBase<
  T extends EntityBase,
> = {
  [
    K in keyof Omit<
      T,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'createdBy'
      | 'updatedBy'
    >
  ]: NonNullable<T[K]> extends EntityBase ? ID
    : NonNullable<T[K]> extends (infer U)[] ? U extends EntityBase ? ID[]
      : T[K][]
    : T[K];
};

export interface PaginatedInputBase {
  /**
   * Maximum number of records to return in one page. Falls back to the
   * service default when omitted.
   */
  limit?: number;

  /**
   * Number of records to skip before the page starts. Falls back to the
   * service default when omitted.
   */
  offset?: number;

  /**
   * Sort direction applied to the ordering column. Defaults to `DESC`.
   */
  order?: 'ASC' | 'DESC';
}

export interface PaginatedInput<T extends EntityBase>
  extends PaginatedInputBase {
  /**
   * Entity column to order the page by. Defaults to `createdAt`.
   */
  orderBy?: keyof T;
}
