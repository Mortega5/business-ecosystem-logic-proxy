import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { QuoteController } from './quote.controller';

@Module({ imports: [TmfModule], controllers: [QuoteController] })
export class QuoteModule {}
