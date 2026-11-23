import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ORGANISATION, AS_SELLER, fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeFeaturesModule, featuresOn } from '../../testing/fake-features';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeaturesModule, CatalogModule] })
class Root {}

// The legacy application answers the lists, which are not here yet
const legacy = express();
legacy.get('/catalog/productOffering', (_req, res) => {
    res.json({ from: 'legacy' });
});

const API = '/tmf-api/productCatalogManagement/v4';
const CHARGING = '/charging/api/assetManagement/assets/offeringJob';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const BUYER = { id: 'p-ana', role: 'Buyer' };

const product = (extra: object = {}) => ({ id: 'ps-1', name: 'Data', lifecycleStatus: 'Launched', relatedParty: [SELLER], ...extra });
const offering = (extra: object = {}) =>
    ({ id: 'o-1', name: 'Offer', lifecycleStatus: 'Active', productSpecification: { id: 'ps-1' }, relatedParty: [SELLER], category: [{ id: 'c-open', name: 'Open' }], ...extra });
const make = (extra: object = {}) => ({ name: 'Offer', description: 'For sale', lifecycleStatus: 'Active', productSpecification: { id: 'ps-1' }, category: [{ id: 'c-open' }], ...extra });

interface Reply {
    status: number;
    body: string;
}
interface Seen {
    method: string | undefined;
    path: string;
    body: string;
}

let app: NestExpressApplication;
let url: string;
let seen: Seen[];
// What the upstreams say, by kind of thing, and what a write answers
let stored: Record<string, Record<string, object>>;
let created: Reply;
let patched: Reply;
let charging: (action: string) => Reply;

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, {
        BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1',
        BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port),
        BAE_UPSTREAMS__CHARGING__HOST: '127.0.0.1',
        BAE_UPSTREAMS__CHARGING__PORT: String(upstream.port)
    });
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
    featuresOn.clear();
    stored = {
        productOffering: { 'o-1': offering(), 'o-2': offering({ id: 'o-2' }), 'o-bundle': offering({ id: 'o-bundle', productSpecification: undefined, isBundle: true }) },
        productSpecification: { 'ps-1': product(), 'ps-draft': product({ id: 'ps-draft', lifecycleStatus: 'In design' }), 'ps-other': product({ id: 'ps-other', relatedParty: [{ id: 'p-other', role: 'Seller' }] }) },
        catalog: {
            'cat-1': { id: 'cat-1', lifecycleStatus: 'Launched', relatedParty: [SELLER], category: [{ id: 'c-mine' }] },
            'cat-other': { id: 'cat-other', lifecycleStatus: 'Launched', relatedParty: [{ id: 'p-other', role: 'Seller' }], category: [{ id: 'c-theirs' }] },
            'cat-draft': { id: 'cat-draft', lifecycleStatus: 'Retired', relatedParty: [SELLER], category: [{ id: 'c-mine' }] }
        },
        category: {
            'c-open': { id: 'c-open', href: 'c-open', name: 'Open', isRoot: false },
            'c-system': { id: 'c-system', href: 'c-system', name: 'Dataset', isRoot: true },
            'c-mine': { id: 'c-mine', href: 'c-mine', name: 'Mine', isRoot: true, relatedParty: [SELLER] },
            'c-theirs': { id: 'c-theirs', href: 'c-theirs', name: 'Theirs', isRoot: true, relatedParty: [{ id: 'p-other', role: 'Seller' }] }
        }
    };
    created = { status: 201, body: JSON.stringify(offering({ id: 'o-new' })) };
    patched = { status: 200, body: JSON.stringify(offering()) };
    charging = () => ({ status: 200, body: '{}' });
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        const body = request?.body ?? '';
        seen.push({ method: request?.method, path: target.pathname, body });
        let reply: Reply = { status: 404, body: '{}' };
        const [, kind, id] = /^\/tmf-api\/productCatalogManagement\/v4\/(\w+)(?:\/([^/]+))?$/.exec(target.pathname) ?? [];
        if (target.pathname.startsWith('/tmf-api/party/v4/')) {
            reply = { status: 200, body: JSON.stringify({ id: 'p-ana', externalReference: [{ externalReferenceType: 'idm_id', name: 'ana' }] }) };
        } else if (target.pathname === CHARGING) {
            reply = charging((JSON.parse(body) as { action: string }).action);
        } else if (kind === 'productOffering' && request?.method === 'POST') {
            reply = created;
        } else if (kind === 'productOffering' && request?.method === 'PATCH') {
            reply = patched;
        } else if (kind !== undefined && id !== undefined && stored[kind]?.[decodeURIComponent(id)] !== undefined) {
            reply = { status: 200, body: JSON.stringify(stored[kind][decodeURIComponent(id)]) };
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const writes = () => seen.filter((request) => request.method !== 'GET');
const sent = (request: Seen | undefined) => JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
const send = (method: string, path: string, headers: Record<string, string>, body?: object) =>
    fetch(`${url}${path}`, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? null : JSON.stringify(body) });
const post = (body: object, headers = AS_SELLER, path = '/catalog/productOffering') => send('POST', path, headers, body);
const patch = (body: object, headers = AS_SELLER, id = 'o-1') => send('PATCH', `/catalog/productOffering/${id}`, headers, body);

describe('reading an offering', () => {
    it('gives it to anybody, and leaves the list to the legacy application', async () => {
        expect((await fetch(`${url}/catalog/productOffering/o-1`)).status).toBe(200);
        expect(await (await fetch(`${url}/catalog/productOffering`)).json()).toEqual({ from: 'legacy' });
    });

    it('hides an offering made for a buyer from everybody but the buyer and the seller', async () => {
        stored['productOffering']!['o-1'] = offering({ relatedParty: [BUYER, SELLER] });
        expect((await fetch(`${url}/catalog/productOffering/o-1`)).status).toBe(404);
        expect((await fetch(`${url}/catalog/productOffering/o-1`, { headers: AS_ORGANISATION })).status).toBe(404);
        const buyer = await fetch(`${url}/catalog/productOffering/o-1`, { headers: LOGGED_IN });
        expect(buyer.status).toBe(200);
        expect(buyer.headers.get('cache-control')).toMatch(/private|no-store/);
        expect((await fetch(`${url}/catalog/productOffering/o-1`, { headers: AS_SELLER })).status).toBe(200);
    });
});

describe('creating an offering', () => {
    it('is checked by the charging backend, made, and told to the charging backend, with the seller that the proxy finds', async () => {
        const response = await post(make({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }));
        expect(response.status).toBe(201);
        const [validated, made, attached] = writes();
        expect(validated).toMatchObject({ path: CHARGING });
        expect(sent(validated)['action']).toBe('create');
        expect(made).toMatchObject({ method: 'POST', path: `${API}/productOffering` });
        expect(attached).toMatchObject({ path: CHARGING });
        expect(sent(attached)).toMatchObject({ action: 'attach', offering: { id: 'o-new' } });
        const body = sent(made);
        expect((body['relatedParty'] as { id: string; role: string }[]).map((party) => `${party.id}:${party.role}`)).toEqual(['p-shop:Seller']);
        expect(body['@schemaLocation']).toMatch(/^https:/);
        expect(body['validFor']).toBeTruthy();
        expect(body['category']).toEqual([{ id: 'c-open', href: 'c-open', name: 'Open' }]);
    });

    it('is for a seller, for products of their own that are active or launched', async () => {
        expect((await post(make(), LOGGED_IN)).status).toBe(403);
        expect((await post(make({ productSpecification: { id: 'ps-other' } }))).status).toBe(403);
        expect((await post(make({ productSpecification: { id: 'ps-draft' } }))).status).toBe(400);
        expect((await post(make({ productSpecification: undefined }))).status).toBe(422);
        expect((await post(make({ name: undefined }))).status).toBe(422);
        expect(writes()).toEqual([]);
    });

    it('makes an offering for a buyer with the buyer named and the caller as the seller', async () => {
        const response = await post(make({ relatedParty: [BUYER, { id: 'p-other', role: 'Seller' }] }));
        expect(response.status).toBe(201);
        const body = sent(writes()[1]);
        expect((body['relatedParty'] as { id: string; role: string }[]).map((party) => `${party.id}:${party.role}`)).toEqual(['p-ana:Buyer', 'p-shop:Seller']);
    });

    it('refuses related parties that are not parties', async () => {
        expect((await post(make({ relatedParty: [null] }))).status).toBe(400);
        expect((await post(make({ relatedParty: [{ id: 'p-ana' }] }))).status).toBe(400);
        expect(writes()).toEqual([]);
    });

    it('retires the offering and says so when the charging backend cannot be told that it was made', async () => {
        charging = (action) => (action === 'attach' ? { status: 500, body: '{}' } : { status: 200, body: '{}' });
        const response = await post(make());
        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: string }).error).toContain('o-new');
        const retired = writes().at(-1);
        expect(retired).toMatchObject({ method: 'PATCH', path: `${API}/productOffering/o-new` });
        expect(sent(retired)).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('makes nothing when the charging backend refuses it, and says why', async () => {
        charging = () => ({ status: 422, body: JSON.stringify({ error: 'Not for sale' }) });
        const response = await post(make());
        expect(response.status).toBe(422);
        expect(((await response.json()) as { error: string }).error).toBe('Not for sale');
        expect(writes()).toHaveLength(1);
    });

    it('makes a bundle of two offerings of the seller, and refuses one that is not', async () => {
        const bundle = (ids: string[]) => ({ name: 'Pack', lifecycleStatus: 'Active', isBundle: true, category: [{ id: 'c-open' }], bundledProductOffering: ids.map((id) => ({ id, href: id })) });
        expect((await post(bundle(['o-1', 'o-2']))).status).toBe(201);
        expect((await post(bundle(['o-1']))).status).toBe(422);
        expect((await post(bundle(['o-1', 'o-bundle']))).status).toBe(422);
        stored['productOffering']!['o-3'] = offering({ id: 'o-3', relatedParty: [{ id: 'p-other', role: 'Seller' }] });
        expect((await post(bundle(['o-1', 'o-3']))).status).toBe(403);
        expect((await post({ ...bundle(['o-1', 'o-2']), productSpecification: { id: 'ps-1' } })).status).toBe(422);
    });
});

describe('creating an offering in a catalog', () => {
    const inCatalog = (id: string, body = make()) => post(body, AS_SELLER, `/catalog/catalog/${id}/productOffering`);

    it('carries the category of the catalog', async () => {
        expect((await inCatalog('cat-1')).status).toBe(201);
        expect((sent(writes()[1])['category'] as { id: string }[]).map((category) => category.id).toSorted()).toEqual(['c-mine', 'c-open']);
    });

    it('is only in a catalog of the seller that is active or launched', async () => {
        expect((await inCatalog('cat-other')).status).toBe(403);
        expect((await inCatalog('cat-draft')).status).toBe(400);
        expect((await inCatalog('cat-missing')).status).toBe(404);
        expect(writes()).toEqual([]);
    });
});

describe('the categories of an offering', () => {
    it('can be the ones of the system, and not the root category of the catalog of another seller', async () => {
        expect((await post(make({ category: [{ id: 'c-system' }] }))).status).toBe(201);
        expect((await post(make({ category: [{ id: 'c-theirs' }] }))).status).toBe(403);
        expect((await post(make({ category: [{ id: 'c-missing' }] }))).status).toBe(422);
        expect((await post(make({ category: [{ id: 'bad id' }] }))).status).toBe(422);
    });

    it('are kept with the one of the catalog when a change leaves it out', async () => {
        stored['productOffering']!['o-1'] = offering({ category: [{ id: 'c-open' }, { id: 'c-mine' }] });
        expect((await patch({ category: [{ id: 'c-system' }, { id: 'c-system' }] })).status).toBe(200);
        expect((sent(writes()[0])['category'] as { id: string }[]).map((category) => category.id).toSorted()).toEqual(['c-mine', 'c-system']);
    });
});

describe('changing an offering', () => {
    it('is for its owner, and is told to the charging backend', async () => {
        expect((await patch({ description: 'New' })).status).toBe(200);
        const [changed, told] = writes();
        expect(changed).toMatchObject({ method: 'PATCH', path: `${API}/productOffering/o-1` });
        expect(sent(told)).toMatchObject({ action: 'update', offering: { id: 'o-1' } });
        expect((await patch({ description: 'New' }, LOGGED_IN)).status).toBe(403);
        expect((await patch({ description: 'New' }, AS_SELLER, 'o-missing')).status).toBe(404);
    });

    it('does not hand the offering to another owner nor change what it is made of', async () => {
        expect((await patch({ relatedParty: [{ id: 'p-other', role: 'Seller' }] })).status).toBe(409);
        expect((await patch({ productSpecification: { id: 'ps-other' } })).status).toBe(403);
        expect((await patch({ isBundle: true })).status).toBe(403);
        expect((await patch({ lifecycleStatus: 'Obsolete', name: '' })).status).toBe(422);
        expect((await patch({ lifecycleStatus: 'Retired' })).status).toBe(400);
        expect(writes()).toEqual([]);
    });

    it('is launched only when its product is launched', async () => {
        stored['productSpecification']!['ps-1'] = product({ lifecycleStatus: 'Active' });
        expect((await patch({ lifecycleStatus: 'Launched' })).status).toBe(400);
        stored['productSpecification']!['ps-1'] = product();
        expect((await patch({ lifecycleStatus: 'Launched' })).status).toBe(200);
    });

    it('tells the client when the charging backend could not be told', async () => {
        charging = () => ({ status: 500, body: '{}' });
        const response = await patch({ description: 'New' });
        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: string }).error).toContain('was changed');
    });
});

describe('launching with the requirements on', () => {
    const picture = { name: 'Profile Picture', attachmentType: 'image/png', url: 'https://x/y.png' };

    it('does not launch what does not meet them, and does not ask for them when they are off', async () => {
        stored['productSpecification']!['ps-1'] = product();
        expect((await patch({ lifecycleStatus: 'Launched' })).status).toBe(200);
        featuresOn.add('launchValidation');
        const refused = await patch({ lifecycleStatus: 'Launched' });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toContain('profile picture');
        stored['productSpecification']!['ps-1'] = product({ attachment: [picture] });
        // The seller is a person, not an organisation, so it is still refused
        const person = await post(make({ lifecycleStatus: 'Launched' }));
        expect(person.status).toBe(400);
        expect(((await person.json()) as { error: string }).error).toContain('not an organisation');
    });
});

describe('retiring an offering', () => {
    it('retires it for its owner and tells the charging backend', async () => {
        expect((await send('DELETE', '/catalog/productOffering/o-1', AS_SELLER)).status).toBe(200);
        const [retired, told] = writes();
        expect(sent(retired)).toEqual({ lifecycleStatus: 'Retired' });
        expect(sent(told)).toMatchObject({ action: 'update' });
    });

    it('is refused for who does not own it, and when it is retired already', async () => {
        expect((await send('DELETE', '/catalog/productOffering/o-1', LOGGED_IN)).status).toBe(403);
        stored['productOffering']!['o-1'] = offering({ lifecycleStatus: 'Retired' });
        expect((await send('DELETE', '/catalog/productOffering/o-1', AS_SELLER)).status).toBe(409);
        expect(writes()).toEqual([]);
    });
});
