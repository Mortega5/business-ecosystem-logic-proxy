import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { ChargingController } from './charging.controller';

@Module({ imports: [TmfModule], controllers: [ChargingController] })
export class ChargingModule {}
