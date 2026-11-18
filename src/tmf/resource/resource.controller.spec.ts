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
import { ResourceModule } from './resource.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, ResourceModule] })
class Root {}

// The legacy application answers anything under /resource
const legacy = express();
legacy.all('/resource/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

const SPEC_API = '/tmf-api/resourceCatalog/v4/resourceSpecification';
const PRODUCT_SPECS = '/tmf-api/productCatalogManagement/v4/productSpecification';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const spec = (extra: object = {}) => JSON.stringify({ id: 'r-1', name: 'Dataset', lifecycleStatus: 'Active', relatedParty: [SELLER], ...extra });

interface Reply {
    status: number;
    body: string;
}
interface Seen {
    method: string | undefined;
    url: string | undefined;
    body: string;
}

let app: NestExpressApplication;
let url: string;
let seen: Seen[];
// What the upstreams say: the specification that is read, what a write answers, and the product specifications by page
let current: Reply;
let written: Reply;
let productSpecs: (offset: number) => Reply;

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
    current = { status: 200, body: spec() };
    written = { status: 200, body: spec({ name: 'Changed' }) };
    productSpecs = () => ({ status: 200, body: '[]' });
    upstream.answer((res) => {
        const request = upstream.seen as Seen;
        seen.push({ method: request.method, url: request.url, body: request.body });
        let reply = written;
        if (request.url?.startsWith(PRODUCT_SPECS) === true) {
            reply = productSpecs(Number(new URL(`http://x${request.url}`).searchParams.get('offset')));
        } else if (request.method === 'GET') {
            reply = current;
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const methods = (): (string | undefined)[] => seen.map((request) => request.method);
const sentQuery = (): [string, string][] => [...new URL(`http://x${seen[0]?.url ?? ''}`).searchParams.entries()];
const seller = (extra: Record<string, string> = JSON_HEADERS) => ({ ...AS_SELLER, ...extra });

describe('GET /resource/resourceSpecification, the list', () => {
    it('is the list of the seller: every filter goes on, then the party and its role', async () => {
        const res = await call('/resource/resourceSpecification?limit=6&offset=0&lifecycleStatus=Active,Launched&sort=-lastUpdate&name*=data&relatedParty.id=p-victim', { headers: AS_SELLER });

        expect(res.status).toBe(200);
        expect(sentQuery()).toEqual([
            ['limit', '6'],
            ['offset', '0'],
            ['lifecycleStatus', 'Active,Launched'],
            ['sort', '-lastUpdate'],
            ['name*', 'data'],
            ['relatedParty.id', 'p-shop'],
            ['relatedParty.role', 'Seller']
        ]);
    });

    it('is private', async () => {
        expect((await call('/resource/resourceSpecification')).status).toBe(401);
        expect(seen).toEqual([]);
    });
});

describe('GET /resource/resourceSpecification/:id', () => {
    const read = (headers: Record<string, string> = {}) => call('/resource/resourceSpecification/r-1', { headers });

    it.each(['Launched', 'Retired', 'Obsolete', 'launched'])('is given to anybody when it is %s, and nothing of the query is sent', async (status) => {
        current = { status: 200, body: spec({ lifecycleStatus: status }) };
        const res = await call('/resource/resourceSpecification/r-1?fields=name');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(JSON.parse(spec({ lifecycleStatus: status })));
        expect(seen[0]?.url).toBe(`${SPEC_API}/r-1`);
    });

    it('is asked for with the identity of whoever is logged in', async () => {
        current = { status: 200, body: spec({ lifecycleStatus: 'Launched' }) };
        await read(LOGGED_IN);
        expect(upstream.seen?.headers).toMatchObject({ 'x-party-id': 'p-ana' });
    });

    it('is given to its owner while it is a draft', async () => {
        expect((await read(AS_SELLER)).status).toBe(200);
    });

    it.each([
        ['nobody who is not logged in', {}],
        ['a user who is not its owner', LOGGED_IN]
    ])('is not given to %s while it is a draft, and what the upstream said is not leaked', async (_name, headers) => {
        const res = await read(headers);

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Unauthorized to read a resource spec that is not launched' });
    });

    it.each([
        ['has no status', JSON.stringify({ id: 'r-1', relatedParty: [SELLER] })],
        ['has a status that is not a text', spec({ lifecycleStatus: 1 })]
    ])('is not given to anybody but its owner when it %s', async (_name, body) => {
        current = { status: 200, body };
        expect((await read()).status).toBe(403);
        expect((await read(AS_SELLER)).status).toBe(200);
    });

    it('is not given to a seller as a draft of another seller', async () => {
        current = { status: 200, body: spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }) };
        expect((await read(AS_SELLER)).status).toBe(403);
    });

    it.each([
        ['something that is not JSON', 'not json'],
        ['a list', '[]']
    ])('answers 502 when the upstream answers with %s', async (_name, body) => {
        current = { status: 200, body };
        const res = await read();
        expect(res.status).toBe(502);
        expect(JSON.stringify(await res.json())).not.toContain('not json');
    });

    it('passes on what the upstream answers when it is not a success', async () => {
        current = { status: 404, body: '{"error":"missing"}' };
        const res = await read();
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it.each(['a%20b', 'a;b'])('refuses the id %s', async (id) => {
        expect([400, 404]).toContain((await call(`/resource/resourceSpecification/${id}`)).status);
        expect(seen).toEqual([]);
    });
});

describe('POST /resource/resourceSpecification', () => {
    const post = (body: string, headers: Record<string, string> = seller()) => call('/resource/resourceSpecification', { method: 'POST', headers, body });

    it('creates the specification of the seller, as it was checked', async () => {
        const res = await post('{"name":"Dataset","name":"Other","relatedParty":[{"id":"p-shop","role":"Seller"}]}');

        expect(res.status).toBe(200);
        expect(seen).toEqual([{ method: 'POST', url: SPEC_API, body: '{"name":"Other","relatedParty":[{"id":"p-shop","role":"Seller"}]}' }]);
    });

    it.each([
        ['somebody else as the owner', spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] })],
        ['the seller and somebody else as owners', spec({ relatedParty: [SELLER, { id: 'p-other', role: 'Seller' }] })],
        ['the seller as a buyer', spec({ relatedParty: [{ id: 'p-shop', role: 'Buyer' }] })],
        ['no related parties', JSON.stringify({ name: 'x' })]
    ])('refuses %s and does not call the upstream', async (_name, body) => {
        const res = await post(body);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Unauthorized to create non-owned/non-seller resource specs' });
        expect(seen).toEqual([]);
    });

    it('refuses a user who is not a seller, even for their own party', async () => {
        const res = await post(spec({ relatedParty: [{ id: 'p-ana', role: 'Seller' }] }), { ...LOGGED_IN, ...JSON_HEADERS });
        expect(res.status).toBe(403);
        expect(seen).toEqual([]);
    });

    it.each([
        ['no name', JSON.stringify({ relatedParty: [SELLER] }), 'Resource spec name is mandatory'],
        ['a name that is not a string', spec({ name: 5 }), 'Resource spec name must be a string'],
        ['an empty name', spec({ name: '  ' }), 'Resource spec name is empty'],
        ['a name that is too long', spec({ name: 'x'.repeat(101) }), 'Resource spec name is too long, it must be less than 100 characters'],
        ['a description that is not a string', spec({ description: 5 }), 'Resource spec description must be a string'],
        ['a description that is too long', spec({ description: 'x'.repeat(100001) }), 'Resource spec description is too long, it must be less than 100.000 characters']
    ])('refuses %s with 422 and does not call the upstream', async (_name, body, error) => {
        const res = await post(body);
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error });
        expect(seen).toEqual([]);
    });

    it.each(['not json', '[]', 'null'])('refuses the body %s', async (body) => {
        expect((await post(body)).status).toBe(400);
        expect(seen).toEqual([]);
    });

    it('is private', async () => {
        expect((await post(spec(), JSON_HEADERS)).status).toBe(401);
        expect(seen).toEqual([]);
    });
});

describe('PATCH /resource/resourceSpecification/:id', () => {
    const patch = (body: string, headers: Record<string, string> = seller()) => call('/resource/resourceSpecification/r-1', { method: 'PATCH', headers, body });

    it('reads the specification and then changes it, as its seller', async () => {
        const res = await patch('{"name":"Changed"}');

        expect(res.status).toBe(200);
        expect(seen).toEqual([
            { method: 'GET', url: `${SPEC_API}/r-1`, body: '' },
            { method: 'PATCH', url: `${SPEC_API}/r-1`, body: '{"name":"Changed"}' }
        ]);
    });

    it('accepts the related parties as they are, in any order', async () => {
        current = { status: 200, body: spec({ relatedParty: [SELLER, { id: 'p-x', role: 'Buyer' }] }) };
        expect((await patch(JSON.stringify({ relatedParty: [{ id: 'p-x', role: 'Buyer' }, SELLER] }))).status).toBe(200);
    });

    it.each([
        ['another seller', spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] })],
        ['nobody', spec({ relatedParty: [] })]
    ])('refuses a specification of %s and does not change it', async (_name, body) => {
        current = { status: 200, body };
        const res = await patch('{"name":"Mine now"}');

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Unauthorized to update non-owned/non-seller resource specs' });
        expect(methods()).toEqual(['GET']);
    });

    it('refuses a user who is not a seller, and tells nothing about the specification', async () => {
        const res = await patch('{"lifecycleStatus":"Retired","relatedParty":[]}', { ...LOGGED_IN, ...JSON_HEADERS });
        expect(res.status).toBe(403);
        expect(methods()).toEqual(['GET']);
    });

    it.each([
        ['somebody else', [{ id: 'p-other', role: 'Seller' }]],
        ['nobody', []],
        ['more parties', [SELLER, { id: 'p-other', role: 'Seller' }]]
    ])('refuses to hand the specification to %s', async (_name, relatedParty) => {
        const res = await patch(JSON.stringify({ relatedParty }));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'The field "relatedParty" can not be modified' });
        expect(methods()).toEqual(['GET']);
    });

    it('passes on a 404 and does not change anything', async () => {
        current = { status: 404, body: '{"error":"missing"}' };
        const res = await patch('{"name":"x"}');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'The required resource does not exist' });
        expect(methods()).toEqual(['GET']);
    });

    it.each([
        ['an error', { status: 500, body: '{"error":"boom"}' }],
        ['something that is not JSON', { status: 200, body: 'not json' }]
    ])('answers 502 when the read answers with %s', async (_name, reply) => {
        current = reply;
        expect((await patch('{"name":"x"}')).status).toBe(502);
        expect(methods()).toEqual(['GET']);
    });

    describe('the lifecycle', () => {
        it.each([
            ['Active', 'Launched'],
            ['Launched', 'Launched'],
            ['Retired', 'Launched'],
            ['Active', 'Obsolete']
        ])('allows to go from %s to %s', async (from, to) => {
            current = { status: 200, body: spec({ lifecycleStatus: from }) };
            expect((await patch(JSON.stringify({ lifecycleStatus: to }))).status).toBe(200);
        });

        it.each([
            ['Active', 'Retired'],
            ['Launched', 'Active'],
            ['Obsolete', 'Launched'],
            ['Active', 'Nonsense']
        ])('refuses to go from %s to %s', async (from, to) => {
            current = { status: 200, body: spec({ lifecycleStatus: from }) };
            const res = await patch(JSON.stringify({ lifecycleStatus: to }));
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: `Cannot transition from lifecycle status ${from} to ${to}` });
            expect(methods()).toEqual(['GET']);
        });

        it('refuses a status when the specification has none, and does not fail', async () => {
            current = { status: 200, body: JSON.stringify({ id: 'r-1', relatedParty: [SELLER] }) };
            expect((await patch('{"lifecycleStatus":"Launched"}')).status).toBe(400);
        });

        it('retires a specification that no product specification uses any more', async () => {
            current = { status: 200, body: spec({ lifecycleStatus: 'Launched' }) };
            productSpecs = () => ({ status: 200, body: '[{"lifecycleStatus":"Retired"},{"lifecycleStatus":"obsolete"}]' });
            const res = await patch('{"lifecycleStatus":"Retired"}');

            expect(res.status).toBe(200);
            expect(seen[1]?.url).toBe(`${PRODUCT_SPECS}?resourceSpecification.id=r-1&fields=lifecycleStatus&limit=100&offset=0`);
            expect(methods()).toEqual(['GET', 'GET', 'PATCH']);
        });

        it.each([
            ['one that is launched', '[{"lifecycleStatus":"Retired"},{"lifecycleStatus":"Launched"}]'],
            ['one with no status', '[{}]']
        ])('does not retire a specification while %s uses it', async (_name, body) => {
            current = { status: 200, body: spec({ lifecycleStatus: 'Launched' }) };
            productSpecs = () => ({ status: 200, body });
            const res = await patch('{"lifecycleStatus":"Retired"}');

            expect(res.status).toBe(409);
            expect(await res.json()).toEqual({ error: 'Cannot retire a resource spec without retiring all product specs linked with it' });
            expect(methods()).toEqual(['GET', 'GET']);
        });

        it('looks at every page of product specifications, not only the first', async () => {
            current = { status: 200, body: spec({ lifecycleStatus: 'Launched' }) };
            const retired = JSON.stringify(Array.from({ length: 100 }, () => ({ lifecycleStatus: 'Retired' })));
            productSpecs = (offset) => ({ status: 200, body: offset === 0 ? retired : '[{"lifecycleStatus":"Launched"}]' });

            expect((await patch('{"lifecycleStatus":"Retired"}')).status).toBe(409);
            expect(methods()).toEqual(['GET', 'GET', 'GET']);
        });

        it.each([
            ['an error', { status: 500, body: '{}' }],
            ['something that is not a list', { status: 200, body: '{"a":1}' }]
        ])('does not retire a specification when the product specifications cannot be read: %s', async (_name, reply) => {
            current = { status: 200, body: spec({ lifecycleStatus: 'Launched' }) };
            productSpecs = () => reply;
            expect((await patch('{"lifecycleStatus":"Retired"}')).status).toBe(502);
            expect(methods()).toEqual(['GET', 'GET']);
        });
    });

    it.each([
        ['an empty name', '{"name":""}', 'Resource spec name is empty'],
        ['a description that is too long', JSON.stringify({ description: 'x'.repeat(100001) }), 'Resource spec description is too long, it must be less than 100.000 characters']
    ])('refuses %s with 422 and does not change anything', async (_name, body, error) => {
        const res = await patch(body);
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error });
        expect(methods()).toEqual(['GET']);
    });

    it.each(['not json', '[]', 'null'])('refuses the body %s before reading anything', async (body) => {
        expect((await patch(body)).status).toBe(400);
        expect(seen).toEqual([]);
    });

    it('is private', async () => {
        expect((await patch('{}', JSON_HEADERS)).status).toBe(401);
        expect(seen).toEqual([]);
    });
});

describe('DELETE /resource/resourceSpecification/:id', () => {
    const remove = (headers: Record<string, string> = AS_SELLER) => call('/resource/resourceSpecification/r-1', { method: 'DELETE', headers });

    it('retires the specification of the seller, which is a change of its status', async () => {
        const res = await remove();

        expect(res.status).toBe(200);
        expect(methods()).toEqual(['GET', 'GET', 'PATCH']);
        expect(seen[2]).toEqual({ method: 'PATCH', url: `${SPEC_API}/r-1`, body: '{"lifecycleStatus":"Retired"}' });
        expect(upstream.seen?.headers['content-type']).toBe('application/json');
    });

    it('does not retire it while a product specification that is not retired uses it', async () => {
        productSpecs = () => ({ status: 200, body: '[{"lifecycleStatus":"Active"}]' });
        const res = await remove();

        expect(res.status).toBe(409);
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it('refuses a specification that is retired already', async () => {
        current = { status: 200, body: spec({ lifecycleStatus: 'Retired' }) };
        const res = await remove();

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'The resource is already retired' });
        expect(methods()).toEqual(['GET']);
    });

    it('refuses the specification of somebody else and a user who is not a seller', async () => {
        current = { status: 200, body: spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }) };
        expect((await remove()).status).toBe(403);
        current = { status: 200, body: spec() };
        expect((await remove(LOGGED_IN)).status).toBe(403);
        expect(methods()).toEqual(['GET', 'GET']);
    });

    it('passes on a 404', async () => {
        current = { status: 404, body: '{}' };
        expect((await remove()).status).toBe(404);
        expect(methods()).toEqual(['GET']);
    });

    it('is private', async () => {
        expect((await remove({})).status).toBe(401);
        expect(seen).toEqual([]);
    });
});

describe('the rest of /resource', () => {
    it.each([
        ['GET', '/resource'],
        ['POST', '/resource'],
        ['PATCH', '/resource/x'],
        ['GET', '/resource/x'],
        ['PUT', '/resourceSpecification/x'],
        ['POST', '/resourceSpecification/x'],
        ['PATCH', '/resourceSpecification'],
        ['DELETE', '/resourceSpecification'],
        ['GET', '/resourceSpecification/x/history'],
        ['GET', '/other'],
        ['GET', '']
    ])('%s /resource%s is not found, neither here nor in the legacy application, and nothing is written', async (method, path) => {
        const res = await call(`/resource${path}`, { method, headers: seller(), ...(method === 'GET' ? {} : { body: '{"name":"x"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(seen).toEqual([]);
    });
});
