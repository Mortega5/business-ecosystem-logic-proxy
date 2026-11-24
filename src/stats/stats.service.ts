import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { StatsReader } from './stats-reader';
import { StatsStore, type Figures } from './stats.store';

/**
 * The figures of the landing page. They are kept in Mongo with the date they were read, and a request that finds them older than
 * `stats.ttlMs` makes the proxy read them again in the background while it answers with what is kept. Only one read runs at a time in a
 * process; the replicas share the result through Mongo and, if two read at once, the last one to save stays. A read that fails leaves what
 * was kept, and is not tried again before `stats.retryDelayMs`.
 */
@Injectable()
export class StatsService implements OnApplicationShutdown {
    private reading: Promise<void> | undefined;
    private retryAt = 0;
    private readonly stop = new AbortController();

    constructor(
        private readonly store: StatsStore,
        private readonly reader: StatsReader,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(StatsService.name);
    }

    async current(): Promise<Figures> {
        const kept = await this.store.latest();
        const now = Date.now();
        if (kept?.computedAt === undefined || now - kept.computedAt.getTime() >= this.config.stats.ttlMs) {
            this.refresh(now);
        }
        return { services: kept?.services ?? [], organizations: kept?.organizations ?? [] };
    }

    private refresh(now: number): void {
        if (this.reading !== undefined || now < this.retryAt || this.stop.signal.aborted) {
            return;
        }
        this.reading = this.reader
            .read(this.stop.signal)
            .then(async (figures) => {
                await this.store.save(figures, new Date());
                this.logger.info({ services: figures.services.length, organizations: figures.organizations.length }, 'The figures of the landing page were read');
            })
            .catch((err: unknown) => {
                if (!this.stop.signal.aborted) {
                    this.retryAt = Date.now() + this.config.stats.retryDelayMs;
                    this.logger.warn({ err, retryDelayMs: this.config.stats.retryDelayMs }, 'The figures of the landing page could not be read: the ones kept stay');
                }
            })
            .finally(() => {
                this.reading = undefined;
            });
    }

    /** A read in flight stops at its next request and is waited for, so that the process does not end in the middle of a write. */
    async onApplicationShutdown(): Promise<void> {
        this.stop.abort();
        await this.reading;
    }
}
