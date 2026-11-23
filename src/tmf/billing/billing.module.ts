import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { BillingController } from './billing.controller';

@Module({ imports: [TmfModule], controllers: [BillingController] })
export class BillingModule {}
