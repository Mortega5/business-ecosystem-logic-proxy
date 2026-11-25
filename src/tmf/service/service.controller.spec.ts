import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_SELLER, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { ServiceModule } from './service.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, ServiceModule] })
class Root {}

// The legacy application answers anything under /service
const legacy = express();
legacy.all('/service/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

const SPEC_API = '/tmf-api/serviceCatalogManagement/v4/serviceSpecification';
const PRODUCT_SPECS = '/tmf-api/productCatalogManagement/v4/productSpecification';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const spec = (extra: object = {}) => JSON.stringify({ id: 's-1', name: 'API', lifecycleStatus: 'Active', relatedParty: [SELLER], ...extra });

let app: NestExpressApplication;
let url: string;
let seen: { method: string | undefined; url: string | undefined; body: string }[];
let current: string;
let productSpecs: string;

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port) });
    app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    await upstream.stop();
});

beforeEach(() => {
    upstream.reset();
    seen = [];
    current = spec();
    productSpecs = '[]';
    upstream.answer((res) => {
        const request = upstream.seen as (typeof seen)[number];
        seen.push({ method: request.method, url: request.url, body: request.body });
        const isProductSpecs = request.url?.startsWith(PRODUCT_SPECS) === true;
        upstream.json(res, 200, isProductSpecs ? productSpecs : request.method === 'GET' ? current : spec({ name: 'Changed' }));
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}/service${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const methods = (): (string | undefined)[] => seen.map((request) => request.method);
const seller = { ...AS_SELLER, ...JSON_HEADERS };

describe('the service specifications', () => {
    it('are listed for the seller: the filters of the portal go on, then the party and its role', async () => {
        await call('/serviceSpecification?limit=6&offset=0&lifecycleStatus=Active&relatedParty.id=p-victim', { headers: AS_SELLER });

        expect([...new URL(`http://x${seen[0]?.url ?? ''}`).searchParams.entries()]).toEqual([
            ['limit', '6'],
            ['offset', '0'],
            ['lifecycleStatus', 'Active'],
            ['relatedParty.id', 'p-shop'],
            ['relatedParty.role', 'Seller']
        ]);
        expect(seen[0]?.url?.startsWith(`${SPEC_API}?`)).toBe(true);
        expect((await call('/serviceSpecification')).status).toBe(401);
    });

    it('are read by anybody once they are not a draft, and by their owner before', async () => {
        current = spec({ lifecycleStatus: 'Launched' });
        expect((await call('/serviceSpecification/s-1')).status).toBe(200);
        expect(seen[0]?.url).toBe(`${SPEC_API}/s-1`);

        current = spec();
        expect((await call('/serviceSpecification/s-1')).status).toBe(403);
        expect((await call('/serviceSpecification/s-1', { headers: LOGGED_IN })).status).toBe(403);
        expect((await call('/serviceSpecification/s-1', { headers: AS_SELLER })).status).toBe(200);
    });

    it('are created by a seller as their own, with the messages of v11 when they are not', async () => {
        const created = await call('/serviceSpecification', { method: 'POST', headers: seller, body: spec({ relatedParty: [SELLER] }) });
        expect(created.status).toBe(200);
        expect(seen[0]).toMatchObject({ method: 'POST', url: SPEC_API });
        expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({ relatedParty: [{ id: 'p-shop', href: 'p-shop', name: 'u-sam', role: 'Seller', '@referredType': 'Individual' }] });

        const stranger = await call('/serviceSpecification', { method: 'POST', headers: seller, body: spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }) });
        expect(stranger.status).toBe(403);
        expect(await stranger.json()).toEqual({ error: 'Unauthorized to create non-owned/non-seller service specs' });

        const nameless = await call('/serviceSpecification', { method: 'POST', headers: seller, body: JSON.stringify({ relatedParty: [SELLER] }) });
        expect(nameless.status).toBe(422);
        expect(await nameless.json()).toEqual({ error: 'Service spec name is mandatory' });
        expect(methods()).toEqual(['POST']);
    });

    it('are changed by the seller who owns them, after reading them', async () => {
        const res = await call('/serviceSpecification/s-1', { method: 'PATCH', headers: seller, body: '{"name":"Changed"}' });

        expect(res.status).toBe(200);
        expect(methods()).toEqual(['GET', 'PATCH']);

        current = spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] });
        const refused = await call('/serviceSpecification/s-1', { method: 'PATCH', headers: seller, body: '{"name":"Mine now"}' });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: 'Unauthorized to update non-owned/non-seller services' });
    });

    it('are retired only when no product specification uses them, by a change or by a delete', async () => {
        current = spec({ lifecycleStatus: 'Launched' });
        productSpecs = '[{"lifecycleStatus":"Launched"}]';
        const change = await call('/serviceSpecification/s-1', { method: 'PATCH', headers: seller, body: '{"lifecycleStatus":"Retired"}' });
        const remove = await call('/serviceSpecification/s-1', { method: 'DELETE', headers: AS_SELLER });

        for (const res of [change, remove]) {
            expect(res.status).toBe(409);
            expect(await res.json()).toEqual({ error: 'Cannot retire a service spec without retiring all service specs linked with it' });
        }
        expect(seen.filter((request) => request.url?.startsWith(PRODUCT_SPECS) === true).map((request) => request.url)).toEqual([
            `${PRODUCT_SPECS}?serviceSpecification.id=s-1&fields=lifecycleStatus&limit=100&offset=0`,
            `${PRODUCT_SPECS}?serviceSpecification.id=s-1&fields=lifecycleStatus&limit=100&offset=0`
        ]);
        expect(methods()).not.toContain('PATCH');

        productSpecs = '[]';
        seen = [];
        expect((await call('/serviceSpecification/s-1', { method: 'DELETE', headers: AS_SELLER })).status).toBe(200);
        expect(seen[2]).toEqual({ method: 'PATCH', url: `${SPEC_API}/s-1`, body: '{"lifecycleStatus":"Retired"}' });
    });

    it.each([
        ['GET', '/service'],
        ['POST', '/serviceSpecification/x'],
        ['PUT', '/serviceSpecification/x'],
        ['DELETE', '/serviceSpecification'],
        ['GET', '/resourceSpecification/x'],
        ['GET', '/other']
    ])('%s %s is not found, neither here nor in the legacy application', async (method, path) => {
        const res = await call(path, { method, headers: seller, ...(method === 'GET' ? {} : { body: '{"name":"x"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(seen).toEqual([]);
    });
});
