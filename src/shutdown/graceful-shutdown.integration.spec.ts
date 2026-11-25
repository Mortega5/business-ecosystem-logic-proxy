import { EventEmitter } from 'node:events';
import { Controller, Get, Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { HealthModule } from '../health/health.module';
import { MongoConnectionService } from '../persistence/mongo-connection.service';
import { waitFor } from '../testing/wait-for';
import { installGracefulShutdown } from './graceful-shutdown';

const DELAY_MS = 400;
const SLOW_MS = 800;

@Controller('slow')
class SlowController {
    @Get()
    async slow(): Promise<{ status: string }> {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return { status: 'done' };
    }
}

@Global()
@Module({
    providers: [
        { provide: AppConfigService, useValue: { app: { shutdownDelayMs: DELAY_MS }, health: { mongoPingTimeoutMs: 500 } } },
        { provide: MongoConnectionService, useValue: { ping: vi.fn(async () => true) } }
    ],
    exports: [AppConfigService, MongoConnectionService]
})
class DependenciesStub {}

@Module({
    imports: [DependenciesStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), HealthModule],
    controllers: [SlowController]
})
class TestModule {}

let app: INestApplication;
let url: string;

beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close().catch(() => undefined);
});

describe('shutdown of a running application', () => {
    it('keeps serving during the delay with readiness at 503, finishes the request in flight, then stops listening', async () => {
        const order: string[] = [];
        const exit = vi.fn((code: number) => order.push(`exit(${code})`));
        // the typings of INestApplication.close() omit the signal that the implementation accepts
        const originalClose = app.close.bind(app) as (signal?: string) => Promise<void>;
        vi.spyOn(app, 'close').mockImplementation(async (signal?: string) => {
            order.push('app.close');
            await originalClose(signal);
            order.push('app.closed');
        });
        const signals = new EventEmitter();
        installGracefulShutdown(
            { app, logger: { info: vi.fn(), fatal: vi.fn() }, timeoutMs: 10_000 },
            { signals: signals as unknown as NodeJS.Process, exit }
        );

        const inFlight = fetch(`${url}/slow`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const signalledAt = Date.now();
        signals.emit('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 100));

        const ready = await fetch(`${url}/health/ready`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toMatchObject({ status: 'shutting_down' });
        expect((await fetch(`${url}/health/live`)).status).toBe(200);

        const finished = await inFlight;
        expect(finished.status).toBe(200);
        expect(await finished.json()).toEqual({ status: 'done' });

        await waitFor(() => exit.mock.calls.length > 0, 10_000);
        expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(SLOW_MS - 100);
        await expect(fetch(`${url}/health/live`)).rejects.toThrow();
        expect(order).toEqual(['app.close', 'app.closed', 'exit(0)']);
    }, 30_000);
});
