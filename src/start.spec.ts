import { Controller, Get, Module } from '@nestjs/common';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthModule } from './auth/auth.module';
import { Public } from './auth/public.decorator';
import { AppConfigModule } from './config/app-config.module';
import { LoggingModule } from './logging/logging.module';
import { start } from './start';
import { freePort } from './testing/free-port';
import { createSelfSignedCertificate } from './testing/self-signed-certificate';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';

@Public()
@Controller('new')
class NewController {
    @Get()
    read() {
        return { from: 'nest' };
    }
}

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule], controllers: [NewController] })
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

@Module({
    imports: [AppConfigModule, LoggingModule],
    providers: [
        {
            provide: 'FAILS',
            useFactory: () => {
                throw new Error('connect ENOTFOUND mongo');
            }
        }
    ]
})
class FailingRootModule {}

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

    it('logs that it starts, listens, and serves the routes', async () => {
        const { lines, logStream } = capture();
        const env = await envFor();

        const { app } = await start({ env, rootModule: TestRootModule, logStream });

        const messages = lines.map((l) => l.msg);
        expect(messages[0]).toBe('Starting the server');
        expect(messages.at(-1)).toBe('Server listening');
        expect(lines[0]).toMatchObject({ context: 'Bootstrap', port: Number(env.BAE_APP__PORT) });

        const url = await app.getUrl();
        expect(await (await fetch(`${url}/new`)).json()).toEqual({ from: 'nest' });
        expect((await fetch(`${url}/nothing/here`, { headers: { accept: 'application/json' } })).status).toBe(404);
        await app.close();
    });

    it('warns about legacy variables it still applies, naming their replacement', async () => {
        const { lines, logStream } = capture();
        const port = await freePort();

        const { app } = await start({
            env: { BAE_LOGGING__FORMAT: 'json', BAE_APP__HOST: '127.0.0.1', BAE_LP_PORT: String(port) },
            rootModule: TestRootModule,
            logStream
        });

        expect(lines.find((l) => l.msg === 'Deprecated environment variable, still applied')).toMatchObject({
            level: 'warn',
            context: 'Bootstrap',
            variable: 'BAE_LP_PORT',
            key: 'app.port',
            replacement: 'BAE_APP__PORT'
        });
        expect(await app.getUrl()).toContain(`:${port}`);
        await app.close();
    });

    it('serves over HTTPS when it is enabled, and only over HTTPS', async () => {
        const { keyFile, certFile, cert } = createSelfSignedCertificate();
        const { lines, logStream } = capture();
        const port = await freePort();
        const env = await envFor({
            BAE_APP__PORT: String(port),
            BAE_APP__HTTPS__ENABLED: 'true',
            BAE_APP__HTTPS__KEY_FILE: keyFile,
            BAE_APP__HTTPS__CERT_FILE: certFile
        });

        const { app } = await start({ env, rootModule: TestRootModule, logStream });

        const get = (path: string): Promise<{ body: string; protocol: string | null }> =>
            new Promise((resolve, reject) => {
                const req = httpsRequest({ host: '127.0.0.1', port, path, ca: cert, servername: 'localhost' }, (res) => {
                    const protocol = (res.socket as TLSSocket).getProtocol();
                    let body = '';
                    res.on('data', (chunk: Buffer) => (body += chunk.toString()));
                    res.on('end', () => resolve({ body, protocol }));
                });
                req.on('error', reject);
                req.end();
            });
        const nest = await get('/new');

        expect(JSON.parse(nest.body)).toEqual({ from: 'nest' });
        expect(['TLSv1.2', 'TLSv1.3']).toContain(nest.protocol);
        expect(lines[0]).toMatchObject({ msg: 'Starting the server', https: true });

        const plain = await new Promise<string>((resolve) => {
            const req = httpRequest({ host: '127.0.0.1', port, path: '/new' }, () => resolve('answered'));
            req.on('error', () => resolve('refused'));
            req.end();
        });
        expect(plain).toBe('refused');
        await app.close();
    });

    it('logs a fatal error and rethrows when the application fails to start', async () => {
        const { lines, logStream } = capture();

        await expect(start({ env: await envFor(), rootModule: FailingRootModule, logStream })).rejects.toThrow('ENOTFOUND mongo');

        expect(lines.at(-1)).toMatchObject({ level: 'fatal', msg: 'The server could not start', context: 'Bootstrap' });
        expect(JSON.stringify(lines.at(-1))).toContain('ENOTFOUND mongo');
    });

    it('reports an invalid configuration on stderr, where there is no logger yet', async () => {
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await expect(
            start({ env: await envFor({ BAE_APP__PORT: 'not-a-port' }), rootModule: TestRootModule })
        ).rejects.toThrow('Invalid configuration');

        expect(write).toHaveBeenCalledWith(expect.stringContaining('app.port'));
    });
});
