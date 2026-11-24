import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { ProviderStats } from '../stats/provider-stats';
import { StatsReader } from '../stats/stats-reader';
import { StatsController } from '../stats/stats.controller';
import { StatsService } from '../stats/stats.service';
import { StatsStore, type Figures, type StoredFigures } from '../stats/stats.store';
import { TmfReader } from '../stats/tmf-reader';

/** Where the figures are kept in a test, with no database. */
export class MemoryStatsStore extends StatsStore {
    kept: StoredFigures | undefined;

    latest(): Promise<StoredFigures | undefined> {
        return Promise.resolve(this.kept);
    }

    save(figures: Figures, computedAt: Date): Promise<void> {
        this.kept = { ...figures, computedAt };
        return Promise.resolve();
    }
}

export const statsStore = new MemoryStatsStore();

/** The stats routes as `StatsModule` has them, with the figures kept in memory. */
@Module({
    imports: [HttpClientModule],
    controllers: [StatsController],
    providers: [{ provide: StatsStore, useValue: statsStore }, TmfReader, StatsReader, StatsService, ProviderStats]
})
export class FakeStatsModule {}
