import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import express from 'express';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { TmfModule } from './tmf.module';
import { TmfProxy } from './tmf-proxy';

interface Seen {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingHttpHeaders;
}

let upstream: Server;
let seen: Seen | undefined;
let answer: (res: ServerResponse) => void;

@Controller('t')
class TestController {
    constructor(private readonly proxy: TmfProxy) {}

    @Get('forward')
    forward(@Req() req: Request, @Res() res: Response) {
        return this.proxy.forward(req, res, { upstream: 'charging', path: '/items' });
    }

    @Get('split')
    async split(@Req() req: Request, @Res() res: Response) {
        const response = await this.proxy.send(req, { upstream: 'charging', path: '/items' });
        this.proxy.reply(res, { ...response, body: response.body.toUpperCase() });
    }

    @Get('fixed')
    fixed(@Req() req: Request, @Res() res: Response) {
        return this.proxy.forward(req, res, {
            upstream: 'charging',
            path: '/items',
            search: '?format=xml-html',
            responseHeaders: { 'content-security-policy': 'sandbox', 'cache-control': 'no-store' }
        });
    }

    @Get('escape')
    escape(@Req() req: Request, @Res() res: Response) {
        return this.proxy.forward(req, res, { upstream: 'charging', path: '/items/../../other' });
    }
}

@Module({ imports: [AppConfigModule, LoggingModule, TmfModule], controllers: [TestController] })
class Root {}

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    upstream = createServer((req, res) => {
        seen = { method: req.method, url: req.url, headers: req.headers };
        answer(res);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address() as { port: number };
    Object.assign(process.env, {
        BAE_UPSTREAMS__CHARGING__HOST: '127.0.0.1',
        BAE_UPSTREAMS__CHARGING__PORT: String(port),
        BAE_UPSTREAMS__CHARGING__TIMEOUT_MS: '300'
    });
    app = await createApp(express(), Root);
    // Stands for the authentication, which has run before the controller
    app.use((req: Request & { user?: object }, _res: Response, next: () => void) => {
        req.user = { id: 'u-ana', username: 'ana', email: 'ana@example.org', partyId: 'p-ana', roles: [{ name: 'Seller' }], accessToken: 'token-1' };
        next();
    });
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
    seen = undefined;
    answer = (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    };
});

describe('TmfProxy', () => {
    it('sends the path the controller built, the query as it came and the verified identity', async () => {
        const res = await fetch(`${url}/t/forward?filter[status]=Launched&a=1&a=2&relatedParty.role=seller`, {
            headers: { 'x-actor-id': 'u-root', 'x-idp-id': 'fake', cookie: 'connect.sid=s1', accept: 'application/json' }
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(seen?.url).toBe('/items?filter[status]=Launched&a=1&a=2&relatedParty.role=seller');
        expect(seen?.headers).toMatchObject({ accept: 'application/json', 'x-actor-id': 'u-ana', 'x-party-id': 'p-ana', authorization: 'Bearer token-1' });
        expect(seen?.headers).not.toHaveProperty('x-idp-id');
        expect(seen?.headers).not.toHaveProperty('cookie');
    });

    it('passes the status and the body of an upstream error through', async () => {
        answer = (res) => {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"error":"missing"}');
        };
        const res = await fetch(`${url}/t/forward`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it('does not let an upstream set cookies, cross-origin policy or reveal its software on the proxy origin', async () => {
        answer = (res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
                'set-cookie': 'sid=1',
                'access-control-allow-origin': 'https://evil.example',
                server: 'Jetty(9.4)',
                'x-powered-by': 'Spring',
                'x-total-count': '7'
            });
            res.end('[]');
        };
        const res = await fetch(`${url}/t/forward`);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(res.headers.get('server')).toBeNull();
        expect(res.headers.get('x-powered-by')).toBeNull();
        expect(res.headers.get('x-total-count')).toBe('7');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('never serves an answer without a type as HTML', async () => {
        answer = (res) => {
            res.writeHead(200);
            res.end('<script>alert(1)</script>');
        };
        const res = await fetch(`${url}/t/forward`);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('lets a controller change the answer between send and reply', async () => {
        const res = await fetch(`${url}/t/split`);
        expect(await res.text()).toBe('{"OK":TRUE}');
    });

    it('sends the query the route fixed and not the client\'s, and sets its own answer headers', async () => {
        answer = (res) => {
            res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': 'default-src *' });
            res.end('<p>invoice</p>');
        };
        const res = await fetch(`${url}/t/fixed?format=pdf&evil=1`, {
            headers: { 'if-none-match': '"abc"', 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' }
        });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('<p>invoice</p>');
        expect(res.headers.get('content-security-policy')).toBe('sandbox');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(seen?.url).toBe('/items?format=xml-html');
    });

    it('answers 504 when the upstream is too slow', async () => {
        answer = (res) => {
            setTimeout(() => res.end('late'), 800);
        };
        const res = await fetch(`${url}/t/forward`);
        expect(res.status).toBe(504);
        expect(await res.json()).toEqual({ error: 'Service unreachable' });
    });

    it('answers 400 and does not call the upstream for a path that leaves its API', async () => {
        const res = await fetch(`${url}/t/escape`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Invalid request path' });
        expect(seen).toBeUndefined();
    });
});
