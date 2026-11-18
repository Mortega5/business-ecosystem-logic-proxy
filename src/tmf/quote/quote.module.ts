import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RawTextMiddleware } from '../raw-text.middleware';
import { TmfModule } from '../tmf.module';
import { QuoteController } from './quote.controller';

@Module({ imports: [TmfModule], controllers: [QuoteController] })
export class QuoteModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RawTextMiddleware).forRoutes(QuoteController);
    }
}
