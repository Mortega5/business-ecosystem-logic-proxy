import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Controller, Get, Module, Post, Req, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { waitFor } from '../testing/wait-for';
import { installGracefulShutdown } from './graceful-shutdown';

const SLOW_MS = 600;

@Controller()
class ConnectionsController {
    @Get('slow')
    async slow(): Promise<{ status: string }> {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return { status: 'done' };
    }

    @Post('upload')
    upload(@Req() req: Request): Promise<{ bytes: number }> {
        return new Promise((resolve, reject) => {
            let bytes = 0;
            req.on('data', (chunk: Buffer) => (bytes += chunk.length));
            req.on('end', () => resolve({ bytes }));
            req.on('error', reject);
        });
    }
}

@Module({ controllers: [ConnectionsController] })
class TestModule {}

let app: INestApplication;
let port: number;
let agent: http.Agent;
let signals: EventEmitter;
let exit: Mock<(code: number) => void>;

beforeEach(async () => {
    const module = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as { port: number }).port;
    agent = new http.Agent({ keepAlive: true });
    signals = new EventEmitter();
    exit = vi.fn<(code: number) => void>();
    installGracefulShutdown(
        { app, logger: { info: vi.fn(), fatal: vi.fn() }, timeoutMs: 10_000, server: app.getHttpServer() as http.Server },
        { signals: signals as unknown as NodeJS.Process, exit }
    );
});

afterEach(async () => {
    agent.destroy();
    await app.close().catch(() => undefined);
});

const get = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });

describe('shutdown with connections that are kept open', () => {
    it('does not wait for the keep-alive timeout of the connection that served the last request', async () => {
        await get('/slow');
        const inFlight = get('/slow');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const signalledAt = Date.now();
        signals.emit('SIGTERM');

        expect(JSON.parse(await inFlight)).toEqual({ status: 'done' });
        await waitFor(() => exit.mock.calls.length > 0, 10_000);

        // The server keeps an idle connection for 5 seconds; the shutdown must end shortly after the answer instead
        expect(Date.now() - signalledAt).toBeLessThan(SLOW_MS + 2000);
        expect(exit).toHaveBeenCalledWith(0);
    }, 30_000);

    it('lets an upload that is still arriving finish, and answers it', async () => {
        const parts = 6;
        const answer = new Promise<string>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/upload', method: 'POST', agent }, (res) => {
                let body = '';
                res.on('data', (chunk: Buffer) => (body += chunk.toString()));
                res.on('end', () => resolve(body));
            });
            req.on('error', reject);
            let sent = 0;
            const timer = setInterval(() => {
                req.write('x'.repeat(1000));
                sent += 1;
                if (sent === parts) {
                    clearInterval(timer);
                    req.end();
                }
            }, 200);
        });

        await new Promise((resolve) => setTimeout(resolve, 500));
        signals.emit('SIGTERM');

        expect(JSON.parse(await answer)).toEqual({ bytes: parts * 1000 });
        await waitFor(() => exit.mock.calls.length > 0, 10_000);
        expect(exit).toHaveBeenCalledWith(0);
    }, 30_000);
});
