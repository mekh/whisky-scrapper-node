import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { RETAIL_CHAIN_MAX_LENGTH, STORE_CATEGORY_MAX_LENGTH } from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type { EntityStore, EntityStoreConfig, ID } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('store_config')
export class StoreConfigEntity extends BaseRichEntity
  implements EntityStoreConfig {
  @GuidV7Column()
  @Index('store_config_store_uindex', { unique: true })
  public storeId!: ID;

  @IsInt()
  @Column({ type: 'int' })
  public tier!: number;

  @IsNumber()
  @Column({ type: 'real' })
  public delayFrom!: number;

  @IsNumber()
  @Column({ type: 'real' })
  public delayTo!: number;

  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  public needsBrowser!: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(RETAIL_CHAIN_MAX_LENGTH)
  @Column({ length: RETAIL_CHAIN_MAX_LENGTH, nullable: true })
  public retailChain?: string;

  @IsString()
  @IsOptional()
  @MaxLength(STORE_CATEGORY_MAX_LENGTH)
  @Column({ length: STORE_CATEGORY_MAX_LENGTH, nullable: true })
  public category?: string;

  @ManyToOne(
    'StoreEntity',
    (store: EntityStore) => store.id,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_store_config_store',
    name: 'storeId',
  })
  public store!: EntityStore;
}
