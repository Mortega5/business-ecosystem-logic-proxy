import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RawTextMiddleware } from '../raw-text.middleware';
import { TmfModule } from '../tmf.module';
import { SearchController } from './search.controller';

@Module({ imports: [TmfModule], controllers: [SearchController] })
export class SearchModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RawTextMiddleware).forRoutes(SearchController);
    }
}
