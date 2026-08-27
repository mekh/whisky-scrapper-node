import { IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { QUICK_FILTER_NAME_MAX_LENGTH } from '~constants';
import { GuidV7Column } from '~decorators/columns';
import { FilterPayload } from '~decorators/fields';
import type {
  EntityQuickFilter,
  EntityUser,
  ID,
  QuickFilterPayload,
} from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One user's named catalogue filter set.
 *
 * `filters` is the schema's first `jsonb` column, and the choice is deliberate:
 * the payload is read whole and never queried into, future filter dimensions
 * are not uniformly arrays of strings (a peat scalar and a region list are both
 * planned), and a normalized child table would force every one of them through
 * a `text` column plus a type discriminator — JSON, rebuilt relationally. It is
 * `jsonb` rather than `json`/`text` so key order and whitespace normalize on
 * write and a future rename is one `WHERE filters ? 'oldKey'` data migration.
 *
 * The unique `(userId, name)` index also serves every per-user lookup, since it
 * leads with `userId` — no separate `userId` index. Uniqueness is
 * case-*sensitive* here; the service additionally rejects a case-insensitive
 * duplicate, and this index is the race backstop.
 */
@Entity('quick_filter')
@Index('quick_filter_user_name_uindex', ['userId', 'name'], { unique: true })
export class QuickFilterEntity extends BaseRichEntity
  implements EntityQuickFilter {
  @GuidV7Column()
  public userId!: ID;

  @IsString()
  @MaxLength(QUICK_FILTER_NAME_MAX_LENGTH)
  @Column({ length: QUICK_FILTER_NAME_MAX_LENGTH })
  public name!: string;

  @FilterPayload()
  @Column({ type: 'jsonb', default: () => "'{}'" })
  public filters!: QuickFilterPayload;

  @ManyToOne(
    'UserEntity',
    (user: EntityUser) => user.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_quick_filter_user',
    name: 'userId',
  })
  public user!: EntityUser;
}
