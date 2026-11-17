import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import type { AppConfig } from '../config/config.schema';
import { FetchUpstreamClient } from './fetch-upstream-client';
import { forwardableHeaders, UpstreamError } from './upstream-client';

interface Seen {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingMessage['headers'];
    body: string;
}

let server: Server;
let port: number;
let seen: Seen | undefined;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), setContext: vi.fn() };

const clientFor = (baseUrl: string, timeoutMs = 1000): FetchUpstreamClient => {
    const url = new URL(baseUrl);
    const path = url.pathname === '/' ? '' : url.pathname;
    return new FetchUpstreamClient(
        new AppConfigService({
            upstreams: { timeoutMs, charging: { host: url.hostname, port: Number(url.port), path }, search: {} }
        } as unknown as AppConfig),
        logger as unknown as PinoLogger
    );
};

const reply = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, headers);
    res.end(body);
};

beforeAll(async () => {
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
            handler(req, res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    seen = undefined;
    vi.clearAllMocks();
    handler = (_req, res) => reply(res, 200, '{"ok":true}', { 'content-type': 'application/json' });
});

describe('FetchUpstreamClient.send', () => {
    it('joins base url and path, repeats array query parameters and sends headers', async () => {
        const client = clientFor(`http://127.0.0.1:${port}/api/v4/`);

        const response = await client.send({
            upstream: 'charging',
            path: '/productOffering',
            query: { limit: '2', fields: ['name', 'id'] },
            headers: { 'x-nick-name': 'seller' }
        });

        expect(seen?.url).toBe('/api/v4/productOffering?limit=2&fields=name&fields=id');
        expect(seen?.headers['x-nick-name']).toBe('seller');
        expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
        expect(response.headers.get('content-type')).toBe('application/json');
    });

    it('sends the body of a POST untouched', async () => {
        const client = clientFor(`http://127.0.0.1:${port}`);

        await client.send({
            upstream: 'charging',
            method: 'POST',
            path: '/orders',
            headers: { 'content-type': 'application/json' },
            body: '{"a": 1}'
        });

        expect(seen).toMatchObject({ method: 'POST', body: '{"a": 1}' });
    });

    it('resolves with non-2xx responses instead of throwing', async () => {
        handler = (_req, res) => reply(res, 404, '{"error":"missing"}');

        const response = await clientFor(`http://127.0.0.1:${port}`).send({ upstream: 'charging', path: '/x' });

        expect(response).toMatchObject({ status: 404, body: '{"error":"missing"}' });
    });

    it('does not follow redirects', async () => {
        handler = (_req, res) => reply(res, 302, '', { location: '/elsewhere' });

        const response = await clientFor(`http://127.0.0.1:${port}`).send({ upstream: 'charging', path: '/x' });

        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/elsewhere');
    });

    it('rejects with a timeout error when the upstream is too slow', async () => {
        handler = (_req, res) => {
            setTimeout(() => reply(res, 200, 'late'), 300);
        };

        const error = await clientFor(`http://127.0.0.1:${port}`, 50)
            .send({ upstream: 'charging', path: '/slow' })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamError);
        expect(error).toMatchObject({ kind: 'timeout', upstream: 'charging' });
    });

    it('rejects with a network error when nothing is listening', async () => {
        const error = await clientFor('http://127.0.0.1:1')
            .send({ upstream: 'charging', path: '/x' })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({ kind: 'network', upstream: 'charging' });
    });

    it('fails clearly for an upstream that is not configured', async () => {
        await expect(clientFor(`http://127.0.0.1:${port}`).send({ upstream: 'search', path: '/x' })).rejects.toThrow(
            'Upstream "search" has no host'
        );
    });
});

describe('FetchUpstreamClient logging', () => {
    it('logs completed calls with upstream, status and duration and masks sensitive parameters', async () => {
        await clientFor(`http://127.0.0.1:${port}`).send({ upstream: 'charging', path: '/x', query: { code: 'secret' } });

        expect(logger.info).toHaveBeenCalledTimes(1);
        const [fields, message] = logger.info.mock.calls[0] as [Record<string, unknown>, string];
        expect(message).toBe('upstream request completed');
        expect(fields).toMatchObject({ upstream: 'charging', method: 'GET', statusCode: 200 });
        expect(typeof fields.durationMs).toBe('number');
        expect(JSON.stringify(fields)).not.toContain('secret');
    });

    it('logs upstream server errors as warnings and failures as errors', async () => {
        handler = (_req, res) => reply(res, 502, 'bad gateway');
        await clientFor(`http://127.0.0.1:${port}`).send({ upstream: 'charging', path: '/x' });
        expect(logger.warn).toHaveBeenCalledTimes(1);

        await clientFor('http://127.0.0.1:1')
            .send({ upstream: 'charging', path: '/x' })
            .catch(() => undefined);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });
});

describe('UpstreamClient.json', () => {
    it('parses the body of a successful response', async () => {
        await expect(clientFor(`http://127.0.0.1:${port}`).json({ upstream: 'charging', path: '/x' })).resolves.toEqual({
            ok: true
        });
    });

    it('rejects non-2xx responses keeping status and body', async () => {
        handler = (_req, res) => reply(res, 409, '{"error":"conflict"}');

        const error = await clientFor(`http://127.0.0.1:${port}`)
            .json({ upstream: 'charging', path: '/x' })
            .catch((e: unknown) => e);

        expect(error).toMatchObject({ kind: 'http', status: 409, body: '{"error":"conflict"}' });
    });

    it('returns undefined for an empty body', async () => {
        handler = (_req, res) => reply(res, 204, '');

        await expect(clientFor(`http://127.0.0.1:${port}`).json({ upstream: 'charging', path: '/x' })).resolves.toBeUndefined();
    });
});

describe('forwardableHeaders', () => {
    it('drops hop-by-hop headers and the encoding of an already decoded body', async () => {
        handler = (_req, res) =>
            reply(res, 200, gzipSync('{"zipped":true}') as unknown as string, {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'x-total-count': '7'
            });

        const response = await clientFor(`http://127.0.0.1:${port}`).send({ upstream: 'charging', path: '/x' });

        expect(response.body).toBe('{"zipped":true}');
        const forwarded = forwardableHeaders(response.headers);
        expect(forwarded).toMatchObject({ 'content-type': 'application/json', 'x-total-count': '7' });
        expect(forwarded).not.toHaveProperty('content-encoding');
        expect(forwarded).not.toHaveProperty('content-length');
        expect(forwarded).not.toHaveProperty('connection');
    });
});
