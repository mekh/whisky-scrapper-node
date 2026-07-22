import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { StoreConfigEntity } from './store-config.entity';

@TypeormRepository(StoreConfigEntity)
export class StoreConfigRepository extends BaseRepository<StoreConfigEntity> {}
