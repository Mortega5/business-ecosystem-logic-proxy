import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../config/app-config.service';
import { FakeApis } from '../../../testing/fake-platform-apis';
import { InMemoryPlatformRecords } from '../../../testing/in-memory-platform-records';
import { CatalogDefaults } from '../catalog-defaults';
import { CatalogBootstrapService } from './catalog-bootstrap.service';
import type { UpstreamPlatformApi } from './upstream-platform-api';

const RECORDS = { defaultCatalog: 'default', supportPackageSpec: 'global' };
const config = (bootstrap: { enabled: boolean; retryDelayMs: number }, defaultCatalogId = ''): AppConfigService =>
    ({
        catalog: { bootstrap: { ...bootstrap, records: RECORDS }, defaultCatalogId, defaultCatalogName: 'default', systemCategories: [{ key: 'dataset', name: 'Dataset', description: 'Datasets' }] },
        auth: { roles: { seller: 'Seller' } }
    }) as unknown as AppConfigService;
const logger = { setContext: () => undefined, info: () => undefined, warn: () => undefined } as unknown as PinoLogger;

let apis: FakeApis;
let records: InMemoryPlatformRecords;
const start = (settings: AppConfigService): { service: CatalogBootstrapService; defaults: CatalogDefaults } => {
    const defaults = new CatalogDefaults(settings);
    const service = new CatalogBootstrapService(settings, defaults, records, apis as unknown as UpstreamPlatformApi, logger);
    service.onApplicationBootstrap();
    return { service, defaults };
};

beforeEach(() => {
    apis = new FakeApis();
    records = new InMemoryPlatformRecords();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('CatalogBootstrapService', () => {
    it('does nothing when it is off: nothing is asked of the TMForum, nothing is stored, and the default catalog is the one that is configured', async () => {
        const { service, defaults } = start(config({ enabled: false, retryDelayMs: 5 }, 'catalog-set'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        service.onApplicationShutdown();

        expect(apis.calls).toEqual([]);
        expect(apis.catalogs).toEqual([]);
        expect(records.records.defaultcatalog).toEqual([]);
        expect(defaults.defaultCatalogId).toBe('catalog-set');
        expect(defaults.supportPackageSpecId).toBe('');
    });

    it('makes sure of the platform in the background and tells what it found, with the support package spec apart', async () => {
        const { service, defaults } = start(config({ enabled: true, retryDelayMs: 5 }));

        await vi.waitFor(() => {
            expect(defaults.defaultCatalogId).not.toBe('');
            expect(defaults.supportPackageSpecId).not.toBe('');
        });
        service.onApplicationShutdown();

        // The ids are given in the order in which the two tasks ask, so they are what the TMForum has and not a number
        const [catalog] = apis.catalogs;
        const [dataset] = apis.categories;
        expect(defaults.defaultCatalogId).toBe(catalog?.id);
        expect(defaults.systemCategoryIds).toEqual({ dataset: dataset?.id });
        expect(defaults.supportPackageSpecId).toBe(apis.specs[0]?.id);
        expect(defaults.isDefaultCatalog(catalog?.id ?? '')).toBe(true);
        expect(defaults.isSystemCategory(dataset?.id ?? '')).toBe(true);
        expect(defaults.isSystemCategory('category-99')).toBe(false);
    });

    it('tries again while the TMForum does not answer, and the support package spec does not wait for the catalog', async () => {
        let up = false;
        let refused = 0;
        const create = apis.createCatalog;
        apis.createCatalog = (body) => {
            if (!up) {
                refused += 1;
                return Promise.reject(new Error('catalog API is down'));
            }
            return create(body);
        };

        const { service, defaults } = start(config({ enabled: true, retryDelayMs: 5 }));
        await vi.waitFor(() => expect(defaults.supportPackageSpecId).not.toBe(''));
        await vi.waitFor(() => expect(refused).toBeGreaterThan(1));
        expect(defaults.defaultCatalogId).toBe('');
        up = true;
        await vi.waitFor(() => expect(defaults.defaultCatalogId).not.toBe(''));
        service.onApplicationShutdown();

        expect(defaults.defaultCatalogId).toBe(apis.catalogs[0]?.id);
    });

    it('stops trying when the server shuts down', async () => {
        apis.listCatalogs = () => Promise.reject(new Error('down'));
        const spy = vi.spyOn(apis, 'listCatalogs');
        const { service } = start(config({ enabled: true, retryDelayMs: 5 }));
        await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(1));

        service.onApplicationShutdown();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const calls = spy.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(spy.mock.calls.length).toBe(calls);
    });
});
