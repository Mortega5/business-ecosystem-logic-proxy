import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { APP_CONFIG, AppConfigService } from './app-config.service';
import type { AppConfig } from './config.schema';

const VALUE: AppConfig = {
    app: { host: '0.0.0.0', port: 8004, shutdownTimeoutMs: 1000 },
    http: { trustedProxies: [], bodyLimit: '50mb' },
    logging: { level: 'info', format: 'json', prettyOptions: {} },
    mongo: { uri: 'mongodb://localhost/test' },
    upstreams: { catalog: { baseUrl: 'http://catalog:8080/tmf-api', timeoutMs: 5000 } }
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
        expect(service.upstreams.catalog?.timeoutMs).toBe(5000);
    });
});
