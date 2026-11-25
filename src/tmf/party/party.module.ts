import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { PartyController } from './party.controller';
import { ProviderDirectory } from './provider-directory';

@Module({ imports: [TmfModule], controllers: [PartyController], providers: [ProviderDirectory] })
export class PartyModule {}
