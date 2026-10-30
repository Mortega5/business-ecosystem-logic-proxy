import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { MongoConnectionService } from '../persistence/mongo-connection.service';
import { HealthModule } from './health.module';

const mongo = { ping: vi.fn<(timeoutMs: number) => Promise<boolean>>() };

@Global()
@Module({
    providers: [
        { provide: AppConfigService, useValue: { app: { shutdownDelayMs: 0 }, health: { mongoPingTimeoutMs: 750 } } },
        { provide: MongoConnectionService, useValue: mongo }
    ],
    exports: [AppConfigService, MongoConnectionService]
})
class DependenciesStub {}

let app: INestApplication;
let url: string;

beforeAll(async () => {
    const module = await Test.createTestingModule({
        imports: [DependenciesStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), HealthModule]
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    mongo.ping.mockReset();
});

describe('health endpoints', () => {
    it('reports liveness without looking at any dependency', async () => {
        mongo.ping.mockResolvedValue(false);

        const res = await fetch(`${url}/health/live`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
        expect(mongo.ping).not.toHaveBeenCalled();
    });

    it('is ready while MongoDB answers', async () => {
        mongo.ping.mockResolvedValue(true);

        const res = await fetch(`${url}/health/ready`);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'ok', info: { mongodb: { status: 'up' } } });
        expect(mongo.ping).toHaveBeenCalledWith(750);
    });

    it('is not ready, with the reason, while MongoDB does not answer', async () => {
        mongo.ping.mockResolvedValue(false);

        const res = await fetch(`${url}/health/ready`);

        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
            status: 'error',
            error: { mongodb: { status: 'down', message: 'MongoDB is not reachable' } }
        });
    });

    it('follows MongoDB from one call to the next', async () => {
        mongo.ping.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        const statuses: number[] = [];
        for (let call = 0; call < 3; call++) {
            statuses.push((await fetch(`${url}/health/ready`)).status);
        }

        expect(statuses).toEqual([200, 503, 200]);
    });
});
