import { Module } from '@nestjs/common';
import { ValkeyModule as ValkeyBaseModule } from '@toxicoder/nestjs-valkey';

@Module({
  imports: [
    ValkeyBaseModule,
  ],
  exports: [
    ValkeyBaseModule,
  ],
})
export class ValkeyModule {}
