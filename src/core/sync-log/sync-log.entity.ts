import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { STORE_GROUP_MAX_LENGTH, SYNC_TRIGGER_MAX_LENGTH } from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type { EntityStore, EntitySyncLog, ID } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('sync_log')
@Index('sync_log_store_created_idx', ['storeId', 'createdAt'])
// The concurrency lock: a partial unique index over an expression
// (group ?? storeId) with a WHERE success IS NULL predicate. TypeORM's
// decorator cannot express either, so it is created by hand in the migration
// and kept out of schema management with synchronize: false.
@Index('sync_log_running_uindex', { synchronize: false })
export class SyncLogEntity extends BaseRichEntity implements EntitySyncLog {
  @GuidV7Column()
  public storeId!: ID;

  @IsInt()
  @Column({ type: 'int', default: 0 })
  public added!: number;

  @IsInt()
  @Column({ type: 'int', default: 0 })
  public removed!: number;

  @IsInt()
  @Column({ type: 'int', default: 0 })
  public updated!: number;

  @IsInt()
  @Column({ type: 'int', default: 0 })
  public total!: number;

  @IsBoolean()
  @IsOptional()
  @Column({ type: 'boolean', nullable: true })
  public success?: boolean;

  @IsString()
  @IsOptional()
  @Column({ type: 'text', nullable: true })
  public error?: string;

  @IsDate()
  @IsOptional()
  @Column({ type: 'timestamp', precision: null, nullable: true })
  public finishedAt?: Date;

  @IsString()
  @IsOptional()
  @MaxLength(STORE_GROUP_MAX_LENGTH)
  @Column({ length: STORE_GROUP_MAX_LENGTH, nullable: true })
  public group?: string;

  @IsString()
  @IsOptional()
  @MaxLength(SYNC_TRIGGER_MAX_LENGTH)
  @Column({ length: SYNC_TRIGGER_MAX_LENGTH, nullable: true })
  public trigger?: string;

  @ManyToOne(
    'StoreEntity',
    (store: EntityStore) => store.id,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_synclog_store',
    name: 'storeId',
  })
  public store!: EntityStore;
}
