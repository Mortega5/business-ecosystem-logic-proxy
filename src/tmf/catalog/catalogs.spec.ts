import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ADMIN, AS_SELLER, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeFeaturesModule } from '../../testing/fake-features';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogDefaults } from './catalog-defaults';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeaturesModule, CatalogModule] })
class Root {}

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
    app = await createApp(Root);
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
        expect((await fetch(`${url}/catalog/catalog/cat-1`)).status).toBe(200);
        current = { status: 200, body: catalog() };
        expect((await fetch(`${url}/catalog/catalog/cat-1`)).status).toBe(403);
        expect((await fetch(`${url}/catalog/catalog/cat-1`, { headers: AS_SELLER })).status).toBe(200);
    });
});

describe('listing the catalogs', () => {
    it('gives anybody the launched catalogs that have a launched offering, and the token to go on', async () => {
        same = { status: 200, body: `[${catalog({ lifecycleStatus: 'Launched' })}]` };
        offerings = { status: 200, body: '[{"id":"o-1"}]' };
        const response = await fetch(`${url}/catalog/catalog?limit=1&offset=0&lifecycleStatus=Launched`);
        expect(response.status).toBe(200);
        expect(await response.json()).toHaveLength(1);
        expect(response.headers.get('x-filtered-pagination-token')).not.toBeNull();
        const asked = seen.find((request) => request.path === `${API}/productOffering`);
        expect(new URLSearchParams(asked?.search).get('category')).toBe('c-1');
        expect(new URLSearchParams(asked?.search).get('lifecycleStatus')).toBe('Launched');
    });

    it('leaves out a launched catalog that has no launched offering, with no token when there is no more', async () => {
        same = { status: 200, body: `[${catalog({ lifecycleStatus: 'Launched' })}]` };
        offerings = { status: 200, body: '[]' };
        const response = await fetch(`${url}/catalog/catalog?limit=5&offset=0&lifecycleStatus=Launched`);
        expect(await response.json()).toEqual([]);
        expect(response.headers.get('x-filtered-pagination-token')).toBeNull();
    });

    it('gives the launched catalogs of a seller as the API pages them', async () => {
        same = { status: 200, body: `[${catalog({ lifecycleStatus: 'Launched' })}]` };
        const response = await fetch(`${url}/catalog/catalog?limit=5&offset=0&lifecycleStatus=Launched&relatedParty.id=p-shop`);
        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
    });

    it('gives the catalogs of a seller in the states that anybody reads', async () => {
        const response = await fetch(`${url}/catalog/catalog?lifecycleStatus=Launched,Retired&relatedParty.id=p-shop`);
        expect(response.status).toBe(200);
    });

    it('keeps the drafts for their owner, who asks for them with their own party', async () => {
        const drafts = `/catalog/catalog?lifecycleStatus=Active,Launched&relatedParty.id=p-shop`;
        expect((await fetch(`${url}${drafts}`)).status).toBe(403);
        expect((await fetch(`${url}/catalog/catalog?relatedParty.id=p-shop`, { headers: AS_SELLER })).status).toBe(200);
        expect((await fetch(`${url}/catalog/catalog?lifecycleStatus=Active&relatedParty.id=other`, { headers: AS_SELLER })).status).toBe(403);
        expect((await fetch(`${url}/catalog/catalog`)).status).toBe(403);
        expect(seen).toHaveLength(1);
    });

    it('lists them all for an administrator', async () => {
        expect((await fetch(`${url}/catalog/catalog?limit=200&offset=0`, { headers: AS_ADMIN })).status).toBe(200);
        expect(seen[0]?.search).toBe('?limit=200&offset=0');
    });

    it('refuses a filter it does not know', async () => {
        expect((await fetch(`${url}/catalog/catalog?lifecycleStatus=Launched&name=a`)).status).toBe(400);
        expect((await fetch(`${url}/catalog/catalog?lifecycleStatus=Launched&limit=abc`)).status).toBe(400);
    });
});

describe('creating a catalog', () => {
    it('makes its root category first and lists it in the catalog', async () => {
        const response = await send('POST', '/catalog/catalog', AS_SELLER, make());
        expect(response.status).toBe(201);
        const [category, created] = writes();
        expect(category?.path).toBe(`${API}/category`);
        expect(JSON.parse(category?.body ?? '{}')).toMatchObject({ isRoot: true, name: 'Mine', lifecycleStatus: 'Launched' });
        expect(JSON.parse(created?.body ?? '{}')).toMatchObject({ name: 'Mine', category: [{ id: 'c-new', href: 'c-new', name: 'Mine' }] });
        expect(JSON.parse(created?.body ?? '{}').validFor.startDateTime).toBeTruthy();
    });

    it('is only for a seller who is the owner', async () => {
        expect((await send('POST', '/catalog/catalog', LOGGED_IN, make())).status).toBe(403);
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }))).status).toBe(403);
        expect(seen).toEqual([]);
    });

    it('refuses a name that is taken or has characters that are not allowed, before it makes anything', async () => {
        same = { status: 200, body: JSON.stringify([{ id: 'cat-9' }]) };
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make())).status).toBe(409);
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make({ name: 'a<b' }))).status).toBe(400);
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make({ name: undefined }))).status).toBe(422);
        expect(writes()).toEqual([]);
    });

    it('retires the category again when the catalog cannot be made', async () => {
        catalogWrite = { status: 500, body: '{}' };
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make())).status).toBe(500);
        const [category, , retired] = writes();
        expect(category?.path).toBe(`${API}/category`);
        expect(retired).toMatchObject({ method: 'PATCH', path: `${API}/category/c-new` });
        expect(JSON.parse(retired?.body ?? '{}')).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('tells the client when the category cannot be made, and makes nothing else', async () => {
        categoryWrite = { status: 500, body: '{}' };
        const refused = await send('POST', '/catalog/catalog', AS_SELLER, make());
        expect(refused.status).toBe(502);
        expect(writes()).toHaveLength(1);
    });
});

describe('changing a catalog', () => {
    it('changes the description and the status of its own catalog', async () => {
        const response = await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { description: 'New', lifecycleStatus: 'Launched' });
        expect(response.status).toBe(201);
        expect(writes()).toHaveLength(1);
        expect(JSON.parse(writes()[0]?.body ?? '{}')).toEqual({ description: 'New', lifecycleStatus: 'Launched' });
    });

    it('is only for the owner', async () => {
        current = { status: 200, body: catalog({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }) };
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { description: 'New' })).status).toBe(403);
        expect(writes()).toEqual([]);
    });

    it('does not take other categories nor another owner', async () => {
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { category: [{ id: 'c-2' }] })).status).toBe(409);
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { relatedParty: [{ id: 'p-other', role: 'Seller' }] })).status).toBe(409);
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { category: [{ id: 'c-1' }] })).status).toBe(201);
    });

    it('takes a new name that is free, and not one that another catalog has', async () => {
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { name: 'Other' })).status).toBe(201);
        same = { status: 200, body: JSON.stringify([{ id: 'cat-9' }]) };
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { name: 'Taken' })).status).toBe(409);
    });

    it('waits to retire until the offerings of the catalog are retired', async () => {
        current = { status: 200, body: catalog({ lifecycleStatus: 'Launched' }) };
        offerings = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Launched' }]) };
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { lifecycleStatus: 'Retired' })).status).toBe(409);
        expect(seen.some((request) => request.path === `${API}/productOffering` && request.search.includes('category.id=c-1'))).toBe(true);
        expect(writes()).toEqual([]);
        offerings = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Retired' }]) };
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { lifecycleStatus: 'Retired' })).status).toBe(201);
    });
});

describe('what the platform keeps', () => {
    it('does not give a catalog the name of a system category, nor the catalog type of the default one', async () => {
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make({ name: ' Dataset ' }))).status).toBe(409);
        expect((await send('POST', '/catalog/catalog', AS_SELLER, make({ catalogType: 'Default' }))).status).toBe(403);
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { name: 'API' })).status).toBe(409);
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { catalogType: 'default' })).status).toBe(403);
        expect(writes()).toEqual([]);
    });

    it('does not take the default catalog out, even for its owner', async () => {
        const defaults = app.get(CatalogDefaults);
        defaults.set('cat-1', {});
        onTestFinished(() => defaults.set('', {}));

        expect((await send('DELETE', '/catalog/catalog/cat-1', AS_SELLER)).status).toBe(403);
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { lifecycleStatus: 'Retired' })).status).toBe(403);
        expect((await send('PATCH', '/catalog/catalog/cat-1', AS_SELLER, { catalogType: 'other' })).status).toBe(403);
        expect(writes()).toEqual([]);
    });
});

describe('deleting a catalog', () => {
    it('retires it, and only when its offerings are', async () => {
        current = { status: 200, body: catalog({ lifecycleStatus: 'Launched' }) };
        offerings = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Active' }]) };
        expect((await send('DELETE', '/catalog/catalog/cat-1', AS_SELLER)).status).toBe(409);
        offerings = { status: 200, body: '[]' };
        expect((await send('DELETE', '/catalog/catalog/cat-1', AS_SELLER)).status).toBe(201);
        expect(JSON.parse(writes()[0]?.body ?? '{}')).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('does not retire a catalog that has no owner, such as the default one', async () => {
        current = { status: 200, body: JSON.stringify({ id: 'cat-1', name: 'default', lifecycleStatus: 'Launched' }) };
        expect((await send('DELETE', '/catalog/catalog/cat-1', AS_SELLER)).status).toBe(403);
        expect(writes()).toEqual([]);
    });
});
