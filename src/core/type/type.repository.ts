import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { TypeEntity } from './type.entity';

@TypeormRepository(TypeEntity)
export class TypeRepository extends BaseRepository<TypeEntity> {}
