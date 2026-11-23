import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LegacyOperator } from '../../legacy/legacy-operator';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ADMIN, fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogDefaults } from './catalog-defaults';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, CatalogModule] })
class Root {}

// The legacy application answers whatever of /catalog is not here
const legacy = express();
legacy.get('/catalog/productOffering', (_req, res) => {
    res.json({ from: 'legacy' });
});

const CATALOG = '/tmf-api/productCatalogManagement/v4';
const JSON_HEADERS = { 'content-type': 'application/json' };
const admin = (extra: Record<string, string> = JSON_HEADERS) => ({ ...AS_ADMIN, ...extra });

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
// What the catalog API says: the categories and catalogs by id, the launched ones that have a name, and what a write answers
let stored: Record<string, object>;
let same: Reply;
let written: Reply;
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
    app.get(CatalogDefaults).set('cat-default', { api: 'cat-api' });
    stored = {
        'cat-default': { id: 'cat-default', name: 'default', category: [{ id: 'c-1', name: 'Data' }] },
        'cat-api': { id: 'cat-api', name: 'API', isRoot: true, lifecycleStatus: 'Launched' },
        'c-1': { id: 'c-1', name: 'Data', isRoot: true, lifecycleStatus: 'Launched', relatedParty: [] },
        'c-2': { id: 'c-2', name: 'Open', isRoot: false, parentId: 'c-1', lifecycleStatus: 'Launched' }
    };
    same = { status: 200, body: '[]' };
    written = { status: 201, body: JSON.stringify({ id: 'c-new', href: 'c-new', name: 'New', isRoot: true, lifecycleStatus: 'Launched' }) };
    catalogWrite = { status: 200, body: '{}' };
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        seen.push({ method: request?.method, path: target.pathname, search: target.search, body: request?.body ?? '' });
        const id = decodeURIComponent(target.pathname.split('/').at(-1) ?? '');
        let reply: Reply = { status: 404, body: '{}' };
        if (target.pathname === `${CATALOG}/category`) {
            reply = request?.method === 'POST' ? written : target.searchParams.has('name') ? same : { status: 200, body: '[]' };
        } else if (target.pathname.startsWith(`${CATALOG}/category/`)) {
            reply = request?.method === 'PATCH' ? written : stored[id] === undefined ? reply : { status: 200, body: JSON.stringify(stored[id]) };
        } else if (target.pathname.startsWith(`${CATALOG}/catalog/`)) {
            reply = request?.method === 'PATCH' ? catalogWrite : stored[id] === undefined ? reply : { status: 200, body: JSON.stringify(stored[id]) };
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const post = (body: object, headers = admin()) => call('/catalog/category', { method: 'POST', headers, body: JSON.stringify(body) });
const patch = (id: string, body: object, headers = admin()) => call(`/catalog/category/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
const sentTo = (method: string, path: string): Seen | undefined => seen.find((request) => request.method === method && request.path === `${CATALOG}${path}`);
const bodyOf = (request: Seen | undefined): Record<string, unknown> => JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
const writes = (): string[] => seen.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path.replace(CATALOG, '')}`);

describe('GET /catalog/category', () => {
    it('is open to anybody, and sends only the filters that are allowed', async () => {
        const res = await call('/catalog/category?limit=50&lifecycleStatus=Launched,Active&parentId=c-1&isRoot=false&sort=-name');

        expect(res.status).toBe(200);
        expect(seen[0]?.search).toBe('?limit=50&lifecycleStatus=Launched%2CActive&parentId=c-1&isRoot=false&sort=-name');
        expect((await call('/catalog/category')).status).toBe(200);
    });

    it('refuses a filter that is not one of the portal, and a value that is not valid', async () => {
        expect((await call('/catalog/category?relatedParty.id=p-1')).status).toBe(400);
        expect((await call('/catalog/category?limit=abc')).status).toBe(400);
        expect((await call('/catalog/category?parentId=a%26b')).status).toBe(400);
        expect((await call('/catalog/category?limit=1&limit=2')).status).toBe(400);
        expect(seen).toEqual([]);
    });

    it('gives one category, whoever asks, and refuses an id that is not one', async () => {
        const res = await call('/catalog/category/c-1');

        expect(((await res.json()) as { id: string }).id).toBe('c-1');
        expect((await call('/catalog/category/a%20b')).status).toBe(400);
    });
});

describe('POST /catalog/category', () => {
    it('makes a root category, says so, and lists it in the default catalog', async () => {
        const res = await post({ name: 'New', id: 'forged', href: 'forged' });

        expect(res.status).toBe(201);
        const sent = bodyOf(sentTo('POST', '/category'));
        expect(sent).toMatchObject({ name: 'New', isRoot: true });
        expect(sent['id']).toBeUndefined();
        expect(Number.isNaN(Date.parse((sent['validFor'] as { startDateTime: string }).startDateTime))).toBe(false);
        expect(bodyOf(sentTo('PATCH', '/catalog/cat-default'))['category']).toEqual([{ id: 'c-1', name: 'Data' }, { id: 'c-new', href: 'c-new', name: 'New' }]);
    });

    it('is owned by the operator of the marketplace when there is one, with the schema of the related party', async () => {
        const operator = [{ id: 'urn:ngsi-ld:organization:op', role: 'Seller' }, { id: 'urn:ngsi-ld:organization:op', role: 'SellerOperator' }];
        vi.spyOn(app.get(LegacyOperator), 'owner').mockReturnValue(operator);

        await post({ name: 'New', relatedParty: [{ id: 'p-forged', role: 'Seller' }] });

        const sent = bodyOf(sentTo('POST', '/category'));
        expect(sent['relatedParty']).toEqual(operator);
        expect(typeof sent['@schemaLocation']).toBe('string');
        vi.restoreAllMocks();
    });

    it('keeps what the client sent about its owners when the marketplace has no operator', async () => {
        await post({ name: 'New', relatedParty: [{ id: 'p-1', role: 'Seller' }] });

        expect(bodyOf(sentTo('POST', '/category'))['relatedParty']).toEqual([{ id: 'p-1', role: 'Seller' }]);
    });

    it('makes a category below another, which has to exist, and does not list it in the default catalog', async () => {
        written = { status: 201, body: JSON.stringify({ id: 'c-sub', name: 'Sub', isRoot: false, parentId: 'c-1' }) };

        expect((await post({ name: 'Sub', isRoot: false, parentId: 'c-1' })).status).toBe(201);
        expect(writes()).toEqual(['POST /category']);
        expect((await post({ name: 'Lost', isRoot: false, parentId: 'c-404' })).status).toBe(400);
    });

    it('asks for the name among the launched ones of the same parent, and refuses one that is taken', async () => {
        await post({ name: 'A&b=1' });
        expect(new URL(`http://x${seen.find((request) => request.search.includes('name='))?.search ?? ''}`).searchParams.get('name')).toBe('A&b=1');
        seen = [];
        same = { status: 200, body: '[{"id":"c-1"}]' };

        expect((await post({ name: 'Data' })).status).toBe(409);
        expect(writes()).toEqual([]);
    });

    it('does not list it in a default catalog when there is none, and does not fail', async () => {
        app.get(CatalogDefaults).set('', {});

        expect((await post({ name: 'New' })).status).toBe(201);
        expect(writes()).toEqual(['POST /category']);
    });

    it('tells the client that the category was made when the default catalog cannot be changed', async () => {
        catalogWrite = { status: 500, body: '{}' };

        const res = await post({ name: 'New' });

        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toBe('The category c-new was created and could not be added to the default catalog');
    });

    it('is for an administrator, and is refused for a name that is not there, a root with a parent and a child with none', async () => {
        expect((await post({ name: 'New' }, { ...LOGGED_IN, ...JSON_HEADERS })).status).toBe(403);
        expect((await call('/catalog/category', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(401);
        expect((await post({ description: 'x' })).status).toBe(400);
        expect((await post({ name: 'A', parentId: 'c-1' })).status).toBe(400);
        expect((await post({ name: 'A', isRoot: false })).status).toBe(400);
        expect((await call('/catalog/category', { method: 'POST', headers: admin(), body: 'not json' })).status).toBe(400);
        expect(writes()).toEqual([]);
    });
});

describe('PATCH /catalog/category/:id', () => {
    it('changes a category without asking again for what did not move', async () => {
        written = { status: 200, body: JSON.stringify({ id: 'c-1', lifecycleStatus: 'Launched' }) };

        expect((await patch('c-1', { description: 'New text' })).status).toBe(200);
        expect(seen.some((request) => request.search.includes('name='))).toBe(false);
        expect(bodyOf(sentTo('PATCH', '/category/c-1'))).toMatchObject({ description: 'New text' });
    });

    it('takes a category out of the default catalog when it is retired', async () => {
        written = { status: 200, body: JSON.stringify({ id: 'c-1', lifecycleStatus: 'Retired' }) };

        expect((await patch('c-1', { lifecycleStatus: 'Retired' })).status).toBe(200);
        expect(bodyOf(sentTo('PATCH', '/catalog/cat-default'))['category']).toEqual([]);
    });

    it('checks the name when it is changed, and refuses one that is taken', async () => {
        same = { status: 200, body: '[{"id":"c-other"}]' };

        expect((await patch('c-1', { name: 'Taken' })).status).toBe(409);
        same = { status: 200, body: '[{"id":"c-1"}]' };
        written = { status: 200, body: JSON.stringify({ id: 'c-1', name: 'Data again', lifecycleStatus: 'Launched' }) };
        expect((await patch('c-1', { name: 'Data again' })).status).toBe(200);
    });

    it('does not put a category below itself or below what is below it', async () => {
        expect((await patch('c-1', { isRoot: false, parentId: 'c-1' })).status).toBe(400);
        expect((await patch('c-1', { isRoot: false, parentId: 'c-2' })).status).toBe(400);
        expect(writes()).toEqual([]);
    });

    it('does not change the owners, and follows the lifecycle', async () => {
        expect((await patch('c-1', { relatedParty: [{ id: 'p-other', role: 'Seller' }] })).status).toBe(409);
        expect((await patch('c-1', { lifecycleStatus: 'Active' })).status).toBe(400);
        expect(writes()).toEqual([]);
    });

    it('is refused for what the platform keeps, and for who is not an administrator', async () => {
        expect((await patch('cat-api', { lifecycleStatus: 'Retired' })).status).toBe(403);
        expect((await patch('cat-api', { name: 'Other' })).status).toBe(403);
        expect((await patch('c-1', { name: 'Other' }, { ...LOGGED_IN, ...JSON_HEADERS })).status).toBe(403);
        expect((await patch('c-404', { description: 'x' })).status).toBe(404);
        expect(writes()).toEqual([]);
    });

    it('tells the client that the category was changed when the default catalog cannot be changed', async () => {
        written = { status: 200, body: JSON.stringify({ id: 'c-1', lifecycleStatus: 'Retired' }) };
        catalogWrite = { status: 500, body: '{}' };

        const res = await patch('c-1', { lifecycleStatus: 'Retired' });

        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toBe('The category c-1 was changed and could not be removed from the default catalog');
    });
});

describe('what the portal does not use, and what is not here yet', () => {
    it('closes the delete of a category and the other methods of the category routes', async () => {
        for (const [method, path] of [['DELETE', '/catalog/category/c-1'], ['PUT', '/catalog/category/c-1'], ['GET', '/catalog/category/c-1/x']] as const) {
            expect((await call(path, { method, headers: admin() })).status).toBe(404);
        }
        expect(seen).toEqual([]);
    });

    it('leaves the rest of the catalog API to the legacy application', async () => {
        const res = await call('/catalog/productOffering', { headers: admin() });

        expect(await res.json()).toEqual({ from: 'legacy' });
        expect(seen).toEqual([]);
    });
});
