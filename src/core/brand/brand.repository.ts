import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { BrandEntity } from './brand.entity';

@TypeormRepository(BrandEntity)
export class BrandRepository extends BaseRepository<BrandEntity> {}
