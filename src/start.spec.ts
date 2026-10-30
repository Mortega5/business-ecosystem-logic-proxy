import { Controller, Get, Module } from '@nestjs/common';
import { Writable } from 'node:stream';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigModule } from './config/app-config.module';
import { LoggingModule } from './logging/logging.module';
import { start, type LegacyServer } from './start';
import { freePort } from './testing/free-port';

@Controller('new')
class NewController {
    @Get()
    read() {
        return { from: 'nest' };
    }
}

@Module({ imports: [AppConfigModule, LoggingModule], controllers: [NewController] })
class TestRootModule {}

const capture = () => {
    const lines: Record<string, unknown>[] = [];
    const logStream = new Writable({
        write(chunk: Buffer, _encoding, done) {
            lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
            done();
        }
    });
    return { lines, logStream };
};

const legacyApp = express();
legacyApp.get('/legacy', (_req, res) => {
    res.json({ from: 'legacy' });
});

const loadedAfter = (ms: number, onlistening = vi.fn()): (() => Promise<LegacyServer>) => {
    return () =>
        new Promise((resolve) =>
            setTimeout(
                () => resolve({ app: legacyApp, onlistening, stopBackgroundLoaders: vi.fn(), close: vi.fn() }),
                ms
            )
        );
};

const envFor = async (extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> => ({
    BAE_LOGGING__FORMAT: 'json',
    BAE_APP__PORT: String(await freePort()),
    BAE_APP__HOST: '127.0.0.1',
    ...extra
});

describe('start', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs while it waits for the legacy application, then loads, listens and starts the legacy loaders', async () => {
        const { lines, logStream } = capture();
        const onlistening = vi.fn();
        const env = await envFor();

        const { app } = await start({
            env,
            loadLegacy: loadedAfter(120, onlistening),
            rootModule: TestRootModule,
            waitLogIntervalMs: 30,
            logStream
        });

        const messages = lines.map((l) => l.msg);
        expect(messages[0]).toBe('Starting the server');
        expect(messages.filter((m) => String(m).startsWith('Still loading the legacy application')).length).toBeGreaterThanOrEqual(2);
        expect(messages).toContain('Legacy application loaded');
        expect(messages.at(-1)).toBe('Server listening');
        expect(lines[0]).toMatchObject({ context: 'Bootstrap', port: Number(env.BAE_APP__PORT) });
        expect(onlistening).toHaveBeenCalledTimes(1);

        const url = await app.getUrl();
        expect(await (await fetch(`${url}/new`)).json()).toEqual({ from: 'nest' });
        expect(await (await fetch(`${url}/legacy`)).json()).toEqual({ from: 'legacy' });

        const waitedBefore = lines.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(lines.length).toBe(waitedBefore);
        await app.close();
    });

    it('warns about legacy variables it still applies, naming their replacement', async () => {
        const { lines, logStream } = capture();
        const port = await freePort();

        const { app } = await start({
            env: { BAE_LOGGING__FORMAT: 'json', BAE_APP__HOST: '127.0.0.1', BAE_LP_PORT: String(port) },
            loadLegacy: loadedAfter(0),
            rootModule: TestRootModule,
            logStream
        });

        expect(lines.find((l) => l.msg === 'Deprecated environment variable, still applied')).toMatchObject({
            level: 40,
            context: 'Bootstrap',
            variable: 'BAE_LP_PORT',
            key: 'app.port',
            replacement: 'BAE_APP__PORT'
        });
        expect(await app.getUrl()).toContain(`:${port}`);
        await app.close();
    });

    it('logs a fatal error and rethrows when the legacy application fails to load', async () => {
        const { lines, logStream } = capture();
        const failure = new Error('connect ENOTFOUND mongo');

        await expect(
            start({
                env: await envFor(),
                loadLegacy: () => Promise.reject(failure),
                rootModule: TestRootModule,
                logStream
            })
        ).rejects.toBe(failure);

        expect(lines.at(-1)).toMatchObject({ level: 60, msg: 'The server could not start', context: 'Bootstrap' });
        expect(JSON.stringify(lines.at(-1))).toContain('ENOTFOUND mongo');
    });

    it('reports an invalid configuration on stderr, where there is no logger yet', async () => {
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await expect(
            start({ env: await envFor({ BAE_APP__PORT: 'not-a-port' }), loadLegacy: loadedAfter(0), rootModule: TestRootModule })
        ).rejects.toThrow('Invalid configuration');

        expect(write).toHaveBeenCalledWith(expect.stringContaining('app.port'));
    });
});
