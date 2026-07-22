import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { GuidV7Column } from '~decorators/columns';
import type { EntityStore, EntitySyncLog, ID } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('sync_log')
@Index('sync_log_store_created_idx', ['storeId', 'createdAt'])
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
