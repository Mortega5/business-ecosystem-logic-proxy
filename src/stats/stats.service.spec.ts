import { describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfigService } from '../config/app-config.service';
import type { StatsReader } from './stats-reader';
import { StatsService } from './stats.service';
import { StatsStore, type Figures, type StoredFigures } from './stats.store';

const DAY = 86400000;
const CONFIG = { stats: { ttlMs: DAY, retryDelayMs: 600000, providerTtlMs: 60000 } } as AppConfigService;
const LOGGER = { setContext: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
const FRESH: Figures = { services: ['Offer'], organizations: ['Acme'] };

class FakeStore extends StatsStore {
    saved: { figures: Figures; computedAt: Date }[] = [];
    constructor(public kept?: StoredFigures) {
        super();
    }
    latest(): Promise<StoredFigures | undefined> {
        return Promise.resolve(this.kept);
    }
    save(figures: Figures, computedAt: Date): Promise<void> {
        this.saved.push({ figures, computedAt });
        this.kept = { ...figures, computedAt };
        return Promise.resolve();
    }
}

const build = (store: FakeStore, read: StatsReader['read']): StatsService => new StatsService(store, { read } as StatsReader, CONFIG, LOGGER);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('StatsService', () => {
    it('answers empty lists, not nothing, when no figures are kept yet, and reads them for the next request', async () => {
        const store = new FakeStore();
        const service = build(store, () => Promise.resolve(FRESH));

        expect(await service.current()).toEqual({ services: [], organizations: [] });
        await settle();
        expect(store.saved).toHaveLength(1);
        expect(await service.current()).toEqual(FRESH);
    });

    it('answers what is kept, and reads nothing, while it is younger than the ttl', async () => {
        const store = new FakeStore({ ...FRESH, computedAt: new Date(Date.now() - DAY / 2) });
        const read = vi.fn(() => Promise.resolve({ services: [], organizations: [] }));
        const service = build(store, read);

        expect(await service.current()).toEqual(FRESH);
        expect(read).not.toHaveBeenCalled();
    });

    it('answers what is kept, old as it is, and reads again in the background', async () => {
        const store = new FakeStore({ services: ['Old'], organizations: [], computedAt: new Date(Date.now() - DAY - 1) });
        const service = build(store, () => Promise.resolve(FRESH));

        expect(await service.current()).toEqual({ services: ['Old'], organizations: [] });
        await settle();
        expect(await service.current()).toEqual(FRESH);
    });

    it('takes the figures of v11, which have no date, as old ones', async () => {
        const read = vi.fn(() => Promise.resolve(FRESH));
        const service = build(new FakeStore({ services: ['v11'], organizations: ['v11'] }), read);

        expect(await service.current()).toEqual({ services: ['v11'], organizations: ['v11'] });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('runs one read at a time, however many ask', async () => {
        let finish: (figures: Figures) => void = () => undefined;
        const read = vi.fn(() => new Promise<Figures>((resolve) => (finish = resolve)));
        const service = build(new FakeStore(), read);

        await Promise.all([service.current(), service.current(), service.current()]);
        expect(read).toHaveBeenCalledTimes(1);
        finish(FRESH);
    });

    it('keeps what it had when a read fails, and does not try again before the delay', async () => {
        const store = new FakeStore({ services: ['Old'], organizations: [], computedAt: new Date(0) });
        const read = vi.fn(() => Promise.reject(new Error('down')));
        const service = build(store, read);

        await service.current();
        await settle();
        await service.current();
        await settle();

        expect(read).toHaveBeenCalledTimes(1);
        expect(store.saved).toEqual([]);
        expect(await service.current()).toEqual({ services: ['Old'], organizations: [] });
    });

    it('tries again once the delay has passed', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const read = vi.fn(() => Promise.reject(new Error('down')));
            const service = build(new FakeStore(), read);

            await service.current();
            await vi.waitFor(() => expect(LOGGER.warn).toHaveBeenCalled());
            vi.setSystemTime(Date.now() + 600001);
            await service.current();

            expect(read).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops a read in flight at the shutdown, waits for it, and starts no other', async () => {
        const read = vi.fn((signal: AbortSignal) => new Promise<Figures>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
        const store = new FakeStore();
        const service = build(store, read);

        await service.current();
        await service.onApplicationShutdown();
        await service.current();

        expect(read).toHaveBeenCalledTimes(1);
        expect(store.saved).toEqual([]);
    });
});
