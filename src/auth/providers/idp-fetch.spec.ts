import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enterRequest } from '../../logging/request-id';
import { listenToMetricEvents, type MetricEvents } from '../../metrics/metric-events';
import { idpFetch } from './idp-http';

let server: Server;
let port: number;
let seen: IncomingMessage | undefined;
let status = 200;
let stopListening: (() => void) | undefined;

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
    stopListening?.();
    vi.restoreAllMocks();
    status = 200;
});

const listen = (): ReturnType<typeof vi.fn> => {
    const upstreamCall = vi.fn();
    stopListening = listenToMetricEvents({ upstreamCall } as unknown as MetricEvents);
    return upstreamCall;
};

describe('idpFetch', () => {
    it('does not send the id of the request to the identity provider', async () => {
        enterRequest('req-9');
        await idpFetch(`http://127.0.0.1:${port}/token`, { method: 'POST' });
        expect(seen?.headers['x-request-id']).toBeUndefined();
    });

    it('measures every call under one name, with the outcome of its status', async () => {
        const upstreamCall = listen();
        await idpFetch(`http://127.0.0.1:${port}/jwks`);
        status = 401;
        await idpFetch(`http://127.0.0.1:${port}/token`, { method: 'POST' });

        expect(upstreamCall.mock.calls.map(([name, method, outcome]) => [name, method, outcome])).toEqual([
            ['idp', 'GET', '2xx'],
            ['idp', 'POST', '4xx']
        ]);
    });

    it('measures a call that could not be made and throws it again, without writing the code of a login in the log', async () => {
        const upstreamCall = listen();
        const error = vi.spyOn(Logger.prototype, 'error');

        await expect(idpFetch('http://127.0.0.1:1/token?code=secret')).rejects.toThrow();

        expect(upstreamCall.mock.calls[0]?.slice(0, 3)).toEqual(['idp', 'GET', 'network']);
        expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
    });

    it('lets a call that has a timeout end as a timeout', async () => {
        const upstreamCall = listen();
        const slow = createServer(() => undefined);
        await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
        try {
            const slowPort = (slow.address() as { port: number }).port;
            await expect(idpFetch(`http://127.0.0.1:${slowPort}/token`, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
            expect(upstreamCall.mock.calls[0]?.[2]).toBe('timeout');
        } finally {
            slow.closeAllConnections();
            slow.close();
        }
    });
});
