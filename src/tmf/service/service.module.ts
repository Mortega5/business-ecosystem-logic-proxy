import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RawTextMiddleware } from '../raw-text.middleware';
import { TmfModule } from '../tmf.module';
import { ServiceController } from './service.controller';

@Module({ imports: [TmfModule], controllers: [ServiceController] })
export class ServiceModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RawTextMiddleware).forRoutes(ServiceController);
    }
}
