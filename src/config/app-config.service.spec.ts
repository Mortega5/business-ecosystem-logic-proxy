import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { APP_CONFIG, AppConfigService } from './app-config.service';
import type { AppConfig } from './config.schema';
import { TMFORUM_APIS } from './upstream-names';

const EMPTY_APIS = Object.fromEntries(TMFORUM_APIS.map((api) => [api, {}])) as AppConfig['upstreams']['tmforum']['apis'];

const VALUE: AppConfig = {
    app: { host: '0.0.0.0', port: 8004, shutdownTimeoutMs: 1000, shutdownDelayMs: 0, https: { enabled: false } },
    http: { trustedProxies: [], bodyLimit: '50mb' },
    logging: { level: 'info', format: 'json', prettyOptions: {} },
    mongo: {
        uri: 'mongodb://localhost/test',
        maxPoolSize: 10,
        serverSelectionTimeoutMs: 5000,
        heartbeatFrequencyMs: 10000,
        retryInitialDelayMs: 1000,
        retryMaxDelayMs: 30000
    },
    purchase: { enabled: true, paymentProvider: 'none' },
    quotes: { enabled: true, api: '/quote/quoteManagement' },
    tendering: { enabled: true, devButtonsOpenClose: false },
    dsp: { enabled: false },
    launchValidation: { enabled: false },
    dataSpace: { enabled: false },
    catalogManagement: { enabled: true },
    catalog: {
        offeringSchema: 'https://schemas.example.org/offering.json',
        priceCompSchema: 'https://schemas.example.org/price.json',
        blueprintSchema: 'https://schemas.example.org/blueprint.json'
    },
    health: { mongoPingTimeoutMs: 1000 },
    upstreams: {
        timeoutMs: 5000,
        tmforum: { host: 'tmforum', port: 8080, apis: { ...EMPTY_APIS, catalog: { path: '/catalog' } } },
        charging: { host: 'charging', port: 8006 },
        rss: {},
        revenue: {},
        search: {}
    }
};

describe('AppConfigService', () => {
    it('exposes each section of the injected configuration', async () => {
        const module = await Test.createTestingModule({
            providers: [{ provide: APP_CONFIG, useValue: VALUE }, AppConfigService]
        }).compile();
        const service = module.get(AppConfigService);

        expect(service.app.port).toBe(8004);
        expect(service.http.bodyLimit).toBe('50mb');
        expect(service.logging.format).toBe('json');
        expect(service.mongo.uri).toBe('mongodb://localhost/test');
        expect(service.upstream('tmforum.catalog')).toEqual({ baseUrl: 'http://tmforum:8080/catalog', timeoutMs: 5000 });
        expect(service.health.mongoPingTimeoutMs).toBe(1000);
        expect(service.purchase.enabled).toBe(true);
    });
});
