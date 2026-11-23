import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LoggingModule } from '../../logging/logging.module';
import { AS_SELLER, fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, CatalogModule] })
class Root {}

// The legacy application answers the list of catalogs, which is not here yet
const legacy = express();
legacy.get('/catalog', (_req, res) => {
    res.json({ from: 'legacy' });
});

const API = '/tmf-api/productCatalogManagement/v4';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const catalog = (extra: object = {}) =>
    JSON.stringify({ id: 'cat-1', name: 'Mine', lifecycleStatus: 'Active', relatedParty: [SELLER], category: [{ id: 'c-1', name: 'Mine' }], ...extra });

interface Reply {
    status: number;
    body: string;
}
interface Seen {
    method: string | undefined;
    path: string;
    search: string;
    body: string;
}

let app: NestExpressApplication;
let url: string;
let seen: Seen[];
// What the catalog API says: the catalog that is read, the catalogs with a name, the offerings, and what each write answers
let current: Reply;
let same: Reply;
let offerings: Reply;
let categoryWrite: Reply;
let catalogWrite: Reply;

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
    seen = [];
    current = { status: 200, body: catalog() };
    same = { status: 200, body: '[]' };
    offerings = { status: 200, body: '[]' };
    categoryWrite = { status: 201, body: JSON.stringify({ id: 'c-new', href: 'c-new', name: 'Mine', isRoot: true }) };
    catalogWrite = { status: 201, body: catalog() };
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        seen.push({ method: request?.method, path: target.pathname, search: target.search, body: request?.body ?? '' });
        let reply: Reply = { status: 404, body: '{}' };
        if (target.pathname.startsWith(`${API}/category`)) {
            reply = categoryWrite;
        } else if (target.pathname === `${API}/productOffering`) {
            reply = offerings;
        } else if (target.pathname === `${API}/catalog`) {
            reply = request?.method === 'POST' ? catalogWrite : same;
        } else if (target.pathname.startsWith(`${API}/catalog/`)) {
            reply = request?.method === 'PATCH' ? catalogWrite : current;
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const writes = () => seen.filter((request) => request.method !== 'GET');
const send = (method: string, path: string, headers: Record<string, string>, body?: object) =>
    fetch(`${url}${path}`, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? null : JSON.stringify(body) });
const make = (extra: object = {}) => ({ name: 'Mine', description: 'Shop', lifecycleStatus: 'Active', relatedParty: [SELLER], ...extra });

describe('reading a catalog', () => {
    it('gives a launched catalog to anybody, and a draft only to its owner', async () => {
        current = { status: 200, body: catalog({ lifecycleStatus: 'Launched' }) };
        expect((await fetch(`${url}/catalog/cat-1`)).status).toBe(200);
        current = { status: 200, body: catalog() };
        expect((await fetch(`${url}/catalog/cat-1`)).status).toBe(403);
        expect((await fetch(`${url}/catalog/cat-1`, { headers: AS_SELLER })).status).toBe(200);
    });

    it('leaves the list to the legacy application', async () => {
        expect(await (await fetch(`${url}/catalog`, { headers: AS_SELLER })).json()).toEqual({ from: 'legacy' });
        expect(seen).toEqual([]);
    });
});

describe('creating a catalog', () => {
    it('makes its root category first and lists it in the catalog', async () => {
        const response = await send('POST', '/catalog', AS_SELLER, make());
        expect(response.status).toBe(201);
        const [category, created] = writes();
        expect(category?.path).toBe(`${API}/category`);
        expect(JSON.parse(category?.body ?? '{}')).toMatchObject({ isRoot: true, name: 'Mine', lifecycleStatus: 'Launched' });
        expect(JSON.parse(created?.body ?? '{}')).toMatchObject({ name: 'Mine', category: [{ id: 'c-new', href: 'c-new', name: 'Mine' }] });
        expect(JSON.parse(created?.body ?? '{}').validFor.startDateTime).toBeTruthy();
    });

    it('is only for a seller who is the owner', async () => {
        expect((await send('POST', '/catalog', LOGGED_IN, make())).status).toBe(403);
        expect((await send('POST', '/catalog', AS_SELLER, make({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }))).status).toBe(403);
        expect(seen).toEqual([]);
    });

    it('refuses a name that is taken or has characters that are not allowed, before it makes anything', async () => {
        same = { status: 200, body: JSON.stringify([{ id: 'cat-9' }]) };
        expect((await send('POST', '/catalog', AS_SELLER, make())).status).toBe(409);
        expect((await send('POST', '/catalog', AS_SELLER, make({ name: 'a<b' }))).status).toBe(400);
        expect((await send('POST', '/catalog', AS_SELLER, make({ name: undefined }))).status).toBe(422);
        expect(writes()).toEqual([]);
    });

    it('retires the category again when the catalog cannot be made', async () => {
        catalogWrite = { status: 500, body: '{}' };
        expect((await send('POST', '/catalog', AS_SELLER, make())).status).toBe(500);
        const [category, , retired] = writes();
        expect(category?.path).toBe(`${API}/category`);
        expect(retired).toMatchObject({ method: 'PATCH', path: `${API}/category/c-new` });
        expect(JSON.parse(retired?.body ?? '{}')).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('tells the client when the category cannot be made, and makes nothing else', async () => {
        categoryWrite = { status: 500, body: '{}' };
        const refused = await send('POST', '/catalog', AS_SELLER, make());
        expect(refused.status).toBe(502);
        expect(writes()).toHaveLength(1);
    });
});

describe('changing a catalog', () => {
    it('changes the description and the status of its own catalog', async () => {
        const response = await send('PATCH', '/catalog/cat-1', AS_SELLER, { description: 'New', lifecycleStatus: 'Launched' });
        expect(response.status).toBe(201);
        expect(writes()).toHaveLength(1);
        expect(JSON.parse(writes()[0]?.body ?? '{}')).toEqual({ description: 'New', lifecycleStatus: 'Launched' });
    });

    it('is only for the owner', async () => {
        current = { status: 200, body: catalog({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }) };
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { description: 'New' })).status).toBe(403);
        expect(writes()).toEqual([]);
    });

    it('does not take other categories nor another owner', async () => {
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { category: [{ id: 'c-2' }] })).status).toBe(409);
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { relatedParty: [{ id: 'p-other', role: 'Seller' }] })).status).toBe(409);
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { category: [{ id: 'c-1' }] })).status).toBe(201);
    });

    it('takes a new name that is free, and not one that another catalog has', async () => {
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { name: 'Other' })).status).toBe(201);
        same = { status: 200, body: JSON.stringify([{ id: 'cat-9' }]) };
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { name: 'Taken' })).status).toBe(409);
    });

    it('waits to retire until the offerings of the catalog are retired', async () => {
        current = { status: 200, body: catalog({ lifecycleStatus: 'Launched' }) };
        offerings = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Launched' }]) };
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { lifecycleStatus: 'Retired' })).status).toBe(409);
        expect(seen.some((request) => request.path === `${API}/productOffering` && request.search.includes('category.id=c-1'))).toBe(true);
        expect(writes()).toEqual([]);
        offerings = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Retired' }]) };
        expect((await send('PATCH', '/catalog/cat-1', AS_SELLER, { lifecycleStatus: 'Retired' })).status).toBe(201);
    });
});

describe('deleting a catalog', () => {
    it('retires it, and only when its offerings are', async () => {
        current = { status: 200, body: catalog({ lifecycleStatus: 'Launched' }) };
        offerings = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Active' }]) };
        expect((await send('DELETE', '/catalog/cat-1', AS_SELLER)).status).toBe(409);
        offerings = { status: 200, body: '[]' };
        expect((await send('DELETE', '/catalog/cat-1', AS_SELLER)).status).toBe(201);
        expect(JSON.parse(writes()[0]?.body ?? '{}')).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('does not retire a catalog that has no owner, such as the default one', async () => {
        current = { status: 200, body: JSON.stringify({ id: 'cat-1', name: 'default', lifecycleStatus: 'Launched' }) };
        expect((await send('DELETE', '/catalog/cat-1', AS_SELLER)).status).toBe(403);
        expect(writes()).toEqual([]);
    });
});
