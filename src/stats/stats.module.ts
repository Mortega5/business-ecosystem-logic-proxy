import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpClientModule } from '../http-client/http-client.module';
import { MongooseStatsStore } from './mongoose-stats.store';
import { ProviderStats } from './provider-stats';
import { StatsReader } from './stats-reader';
import { StatsController } from './stats.controller';
import { StatsEntry, StatsEntrySchema } from './stats.schema';
import { StatsService } from './stats.service';
import { StatsStore } from './stats.store';
import { TmfReader } from './tmf-reader';

@Module({
    imports: [HttpClientModule, MongooseModule.forFeature([{ name: StatsEntry.name, schema: StatsEntrySchema }])],
    controllers: [StatsController],
    providers: [{ provide: StatsStore, useClass: MongooseStatsStore }, TmfReader, StatsReader, StatsService, ProviderStats]
})
export class StatsModule {}
