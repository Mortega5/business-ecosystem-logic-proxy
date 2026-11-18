import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { LegacyPartyCache } from '../../legacy/legacy-party-cache';
import { RawTextMiddleware } from '../raw-text.middleware';
import { TmfModule } from '../tmf.module';
import { PartyController } from './party.controller';

@Module({ imports: [TmfModule], controllers: [PartyController], providers: [LegacyPartyCache] })
export class PartyModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RawTextMiddleware).forRoutes(PartyController);
    }
}
