import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RawTextMiddleware } from '../raw-text.middleware';
import { TmfModule } from '../tmf.module';
import { ResourceController } from './resource.controller';

@Module({ imports: [TmfModule], controllers: [ResourceController] })
export class ResourceModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RawTextMiddleware).forRoutes(ResourceController);
    }
}
