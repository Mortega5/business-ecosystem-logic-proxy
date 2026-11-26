import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enterRequest } from '../logging/request-id';
import { outboundFetch } from './outbound-fetch';

let server: Server;
let port: number;
let seen: IncomingMessage | undefined;
let status = 200;

beforeAll(async () => {
    server = createServer((req, res) => {
        seen = req;
        res.writeHead(status).end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

afterAll(() => {
    server.close();
});

afterEach(() => {
    vi.restoreAllMocks();
    status = 200;
});

describe('outboundFetch', () => {
    it('passes on the id of the request being served, unless the call has its own', async () => {
        enterRequest('req-5');
        await outboundFetch('files', `http://127.0.0.1:${port}/a`);
        expect(seen?.headers['x-request-id']).toBe('req-5');

        await outboundFetch('files', `http://127.0.0.1:${port}/a`, { headers: { 'x-request-id': 'own' } });
        expect(seen?.headers['x-request-id']).toBe('own');
    });

    it('writes down a call that went well at debug and one that failed at the server as a warning, masking the token', async () => {
        const debug = vi.spyOn(Logger.prototype, 'debug');
        const warn = vi.spyOn(Logger.prototype, 'warn');
        await outboundFetch('payment', `http://127.0.0.1:${port}/a?token=secret`);
        status = 503;
        await outboundFetch('payment', `http://127.0.0.1:${port}/a`);

        expect(debug).toHaveBeenCalledTimes(1);
        expect(debug.mock.calls[0]?.[0]).toMatchObject({ target: 'payment', method: 'GET', statusCode: 200 });
        expect(JSON.stringify(debug.mock.calls)).not.toContain('secret');
        expect(warn.mock.calls[0]?.[0]).toMatchObject({ statusCode: 503 });
    });

    it('writes down a call that could not be made, with the error, and throws it again', async () => {
        const error = vi.spyOn(Logger.prototype, 'error');
        await expect(outboundFetch('analytics', 'http://127.0.0.1:1/a')).rejects.toThrow();
        expect(error.mock.calls[0]?.[0]).toMatchObject({ target: 'analytics', err: expect.any(Error) });
    });
});
