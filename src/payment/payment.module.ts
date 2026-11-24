import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentInfoService } from './payment-info.service';

@Module({ controllers: [PaymentController], providers: [PaymentInfoService] })
export class PaymentModule {}
