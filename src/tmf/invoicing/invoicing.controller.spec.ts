import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { request } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LoggingModule } from '../../logging/logging.module';
import { fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { InvoicingModule } from './invoicing.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, InvoicingModule] })
class Root {}

// What the legacy application would answer for anything under /invoicing, as v11 does
const legacy = express();
legacy.all('/invoicing/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

let app: NestExpressApplication;
let url: string;
const ID = 'urn:ngsi-ld:invoice:7a1c0f3e';
const INVOICE = `/invoicing/invoices/${encodeURIComponent(ID)}?format=xml-html`;
const HTML = '<html><body><h1>Invoice</h1></body></html>';

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port) });
    app = await createApp(legacy, Root);
    app.get(LegacyAuthBridge).attach([fakeLogin]);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    await upstream.stop();
});

beforeEach(() => {
    upstream.reset();
    upstream.answer((res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: { ...LOGGED_IN, ...init.headers } });

// fetch normalises dot segments, so what an attacker sends is sent here exactly as written
const raw = (path: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = request({ host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, path, headers: LOGGED_IN }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
    });

describe('GET /invoicing/invoices/:id', () => {
    it('reads the invoice from the invoicing API and shows it sandboxed', async () => {
        const res = await call(INVOICE);

        expect(res.status).toBe(200);
        expect(await res.text()).toBe(HTML);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-security-policy')).toBe('sandbox');
        expect(upstream.seen?.url).toBe(`/tmf-api/invoicing/v4/invoices/${encodeURIComponent(ID)}?format=xml-html`);
        expect(upstream.seen?.headers).toMatchObject({ 'x-actor-id': 'u-ana', 'x-party-id': 'p-ana' });
    });

    it('sandboxes the invoice whatever policy the upstream sent', async () => {
        upstream.answer((res) => {
            res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': 'default-src *' });
            res.end(HTML);
        });
        expect((await call(INVOICE)).headers.get('content-security-policy')).toBe('sandbox');
    });

    it('tells the browser to keep no copy of the invoice, whatever the upstream said', async () => {
        upstream.answer((res) => {
            res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'public, max-age=86400' });
            res.end(HTML);
        });
        expect((await call(INVOICE)).headers.get('cache-control')).toBe('no-store');
    });

    it('sends only the format, whatever else the client put in the query', async () => {
        await call(`${INVOICE}&download=1&token=x`);
        expect(upstream.seen?.url).toBe(`/tmf-api/invoicing/v4/invoices/${encodeURIComponent(ID)}?format=xml-html`);
    });

    it('is private: without a user it answers 401 and calls nothing', async () => {
        const res = await fetch(`${url}${INVOICE}`);
        expect(res.status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });

    it.each([
        ['no format', ''],
        ['another format', '?format=pdf'],
        ['an empty format', '?format='],
        ['a format with more in it', '?format=xml-html,pdf']
    ])('refuses %s and does not call the upstream', async (_name, query) => {
        const res = await call(`/invoicing/invoices/${encodeURIComponent(ID)}${query}`);
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it.each([
        ['an encoded slash', 'a%2Fb'],
        ['a path parameter', 'a;b'],
        ['a space', 'a%20b'],
        ['a very long id', 'a'.repeat(201)],
        ['a query in the id', 'a%3Fb']
    ])('refuses an id with %s and does not call the upstream', async (_name, id) => {
        const res = await call(`/invoicing/invoices/${id}?format=xml-html`);
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it.each([['..'], ['%2e%2e'], ['.%2e']])('refuses the id %s sent exactly as written', async (id) => {
        expect(await raw(`/invoicing/invoices/${id}?format=xml-html`)).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the rest of /invoicing', () => {
    it.each([
        ['GET', '/invoicing/invoices?format=xml-html'],
        ['GET', `/invoicing/invoices/${ID}/lines?format=xml-html`],
        ['GET', '/invoicing/other'],
        ['GET', '/invoicing'],
        ['GET', '/invoicing/'],
        ['POST', `/invoicing/invoices/${ID}?format=xml-html`],
        ['PUT', `/invoicing/invoices/${ID}?format=xml-html`],
        ['DELETE', `/invoicing/invoices/${ID}?format=xml-html`]
    ])('%s %s is not found, neither here nor in the legacy application', async (method, path) => {
        const res = await call(path, { method });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
