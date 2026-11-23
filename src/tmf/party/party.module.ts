import { Module } from '@nestjs/common';
import { LegacyPartyCache } from '../../legacy/legacy-party-cache';
import { TmfModule } from '../tmf.module';
import { PartyController } from './party.controller';
import { ProviderDirectory } from './provider-directory';

@Module({ imports: [TmfModule], controllers: [PartyController], providers: [LegacyPartyCache, ProviderDirectory] })
export class PartyModule {}
