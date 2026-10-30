import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { MongoPersistenceModule } from '../persistence/mongo-persistence.module';
import { ManagedMongod } from '../testing/managed-mongod';
import { waitFor } from '../testing/wait-for';
import { HealthModule } from './health.module';

let mongod: ManagedMongod;
let app: INestApplication;
let url: string;

const status = async (path: string): Promise<number> => (await fetch(`${url}${path}`)).status;

beforeAll(async () => {
    mongod = await ManagedMongod.create();

    @Global()
    @Module({
        providers: [
            {
                provide: AppConfigService,
                useValue: {
                    app: { shutdownDelayMs: 0 },
                    health: { mongoPingTimeoutMs: 500 },
                    mongo: {
                        uri: `${mongod.uri}/bae_health`,
                        maxPoolSize: 5,
                        serverSelectionTimeoutMs: 500,
                        heartbeatFrequencyMs: 500,
                        retryInitialDelayMs: 100,
                        retryMaxDelayMs: 300
                    }
                }
            }
        ],
        exports: [AppConfigService]
    })
    class ConfigStub {}

    const module = await Test.createTestingModule({
        imports: [ConfigStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), MongoPersistenceModule, HealthModule]
    }).compile();
    app = module.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
}, 60_000);

afterAll(async () => {
    await app.close();
    await mongod.destroy();
});

describe('readiness against a real MongoDB that goes away and comes back', () => {
    it('is alive but not ready while MongoDB has never been up, then becomes ready', async () => {
        expect(await status('/health/live')).toBe(200);
        expect(await status('/health/ready')).toBe(503);

        await mongod.start();

        await waitFor(async () => (await status('/health/ready')) === 200, 20_000);
        expect(await status('/health/live')).toBe(200);
    }, 40_000);

    it('turns not ready when MongoDB stops, stays alive, and recovers when it returns', async () => {
        await mongod.stop();

        await waitFor(async () => (await status('/health/ready')) === 503, 15_000);
        expect(await status('/health/live')).toBe(200);

        await mongod.start();

        await waitFor(async () => (await status('/health/ready')) === 200, 30_000);
    }, 60_000);
});
