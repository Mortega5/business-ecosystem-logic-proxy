import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { UsageController } from './usage.controller';

@Module({ imports: [TmfModule], controllers: [UsageController] })
export class UsageModule {}
