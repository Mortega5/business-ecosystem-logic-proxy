import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfigService } from '../config/app-config.service';
import { MetricsServer } from './metrics.server';
import type { MetricsService } from './metrics.service';

const freePort = (): Promise<number> =>
    new Promise((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });

const logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn() };
const metrics = { render: vi.fn().mockResolvedValue('# HELP x\nx 1\n'), contentType: () => 'text/plain; version=0.0.4' };

const serverFor = (config: object): MetricsServer =>
    new MetricsServer({ metrics: config } as unknown as AppConfigService, metrics as unknown as MetricsService, logger as unknown as PinoLogger);

describe('MetricsServer', () => {
    let running: MetricsServer | undefined;

    afterEach(async () => {
        await running?.onApplicationShutdown();
        running = undefined;
        vi.clearAllMocks();
    });

    it('serves the metrics on its port and path', async () => {
        const port = await freePort();
        running = serverFor({ enabled: true, host: '127.0.0.1', port, path: '/custom' });
        await running.onApplicationBootstrap();

        const res = await fetch(`http://127.0.0.1:${port}/custom`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
        expect(await res.text()).toBe('# HELP x\nx 1\n');
    });

    it('answers 404 to another path and 405 to a method that is not a read', async () => {
        const port = await freePort();
        running = serverFor({ enabled: true, host: '127.0.0.1', port, path: '/metrics' });
        await running.onApplicationBootstrap();

        expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(405);
    });

    it('does not listen when it is disabled', async () => {
        const port = await freePort();
        running = serverFor({ enabled: false, host: '127.0.0.1', port, path: '/metrics' });
        await running.onApplicationBootstrap();

        await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
    });

    it('says so and goes on when the port is taken', async () => {
        const taken = createServer();
        await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
        const { port } = taken.address() as { port: number };
        try {
            running = serverFor({ enabled: true, host: '127.0.0.1', port, path: '/metrics' });
            await expect(running.onApplicationBootstrap()).resolves.toBeUndefined();
            expect(logger.error).toHaveBeenCalledOnce();
        } finally {
            taken.close();
        }
    });

    it('stops listening when the application shuts down', async () => {
        const port = await freePort();
        running = serverFor({ enabled: true, host: '127.0.0.1', port, path: '/metrics' });
        await running.onApplicationBootstrap();
        await running.onApplicationShutdown();

        await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
    });
});
