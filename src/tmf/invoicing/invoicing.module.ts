import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { InvoicingController } from './invoicing.controller';

@Module({ imports: [TmfModule], controllers: [InvoicingController] })
export class InvoicingModule {}
