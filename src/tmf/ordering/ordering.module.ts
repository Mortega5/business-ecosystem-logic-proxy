import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { OrderingController } from './ordering.controller';
import { Orders } from './orders';

@Module({ imports: [TmfModule], controllers: [OrderingController], providers: [Orders] })
export class OrderingModule {}
