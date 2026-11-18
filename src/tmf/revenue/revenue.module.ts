import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { RevenueController } from './revenue.controller';

@Module({ imports: [TmfModule], controllers: [RevenueController] })
export class RevenueModule {}
