import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RawTextMiddleware } from '../raw-text.middleware';
import { TmfModule } from '../tmf.module';
import { AccountController } from './account.controller';

@Module({ imports: [TmfModule], controllers: [AccountController] })
export class AccountModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RawTextMiddleware).forRoutes(AccountController);
    }
}
