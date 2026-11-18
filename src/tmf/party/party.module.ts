import { Module } from '@nestjs/common';
import { LegacyPartyCache } from '../../legacy/legacy-party-cache';
import { TmfModule } from '../tmf.module';
import { PartyController } from './party.controller';

@Module({ imports: [TmfModule], controllers: [PartyController], providers: [LegacyPartyCache] })
export class PartyModule {}
