import { Module } from '@nestjs/common';
import { HttpClientModule } from '../../http-client/http-client.module';
import { TmfModule } from '../tmf.module';
import { BillingController } from './billing.controller';
import { OrderSimulator } from './order-simulator';

@Module({ imports: [TmfModule, HttpClientModule], controllers: [BillingController], providers: [OrderSimulator] })
export class BillingModule {}
