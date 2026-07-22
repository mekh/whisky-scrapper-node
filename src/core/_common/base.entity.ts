import { IsDate } from 'class-validator';
import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

import { GuidV7PrimaryGeneratedColumn } from '~decorators/columns';
import { EntityBaseRich, type ID } from '~types';

export abstract class BaseRichEntity implements EntityBaseRich {
  @GuidV7PrimaryGeneratedColumn()
  public id!: ID;

  @IsDate()
  @CreateDateColumn({
    precision: null,
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt!: Date;

  @IsDate()
  @UpdateDateColumn({
    precision: null,
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  public updatedAt!: Date;
}
