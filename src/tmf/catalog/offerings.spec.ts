import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ORGANISATION, AS_SELLER, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeFeaturesModule, featuresOn } from '../../testing/fake-features';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeaturesModule, CatalogModule] })
class Root {}

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
    search: URLSearchParams;
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
// What the search engine says, and whether the catalog API leaves out the offerings for a buyer when it is asked to
let engine: Reply;
let honoursRoles: boolean;

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, {
        BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1',
        BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port),
        BAE_UPSTREAMS__CHARGING__HOST: '127.0.0.1',
        BAE_UPSTREAMS__CHARGING__PORT: String(upstream.port),
        BAE_UPSTREAMS__SEARCH__HOST: '127.0.0.1',
        BAE_UPSTREAMS__SEARCH__PORT: String(upstream.port),
        BAE_SEARCH__ENABLED: 'true'
    });
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
    engine = { status: 200, body: JSON.stringify([{ id: 'o-2' }, { id: 'o-1' }]) };
    honoursRoles = true;
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        const body = request?.body ?? '';
        seen.push({ method: request?.method, path: target.pathname, search: target.searchParams, body });
        let reply: Reply = { status: 404, body: '{}' };
        const [, kind, id] = /^\/tmf-api\/productCatalogManagement\/v4\/(\w+)(?:\/([^/]+))?$/.exec(target.pathname) ?? [];
        if (target.pathname.startsWith('/tmf-api/party/v4/')) {
            reply = { status: 200, body: JSON.stringify({ id: 'p-ana', externalReference: [{ externalReferenceType: 'idm_id', name: 'ana' }] }) };
        } else if (target.pathname === CHARGING) {
            reply = charging((JSON.parse(body) as { action: string }).action);
        } else if (target.pathname.startsWith('/api/SearchProduct')) {
            reply = engine;
        } else if (kind === 'productOffering' && id === undefined && request?.method === 'GET') {
            reply = { status: 200, body: JSON.stringify(listed(target.searchParams)) };
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

// What the catalog API finds for a list: the ids, a category of the ones that are asked, the party, and no offering that names a buyer when it is asked to leave them out
const listed = (query: URLSearchParams): object[] => {
    const ids = query.get('id')?.split(',');
    const categories = (query.get('category') ?? query.get('category.id'))?.split(',');
    const party = query.get('relatedParty.id');
    return Object.values(stored['productOffering'] ?? {}).filter((one) => {
        const found = one as { id: string; category?: { id: string }[]; relatedParty?: { id: string; role: string }[] };
        return (
            (ids === undefined || ids.includes(found.id)) &&
            (categories === undefined || (found.category ?? []).some((category) => categories.includes(category.id))) &&
            (party === null || (found.relatedParty ?? []).some((one) => one.id === party)) &&
            (!honoursRoles || query.get('relatedParty.role*') === null || !(found.relatedParty ?? []).some((one) => one.role === 'Buyer'))
        );
    });
};

const writes = () => seen.filter((request) => request.method !== 'GET');
const sent = (request: Seen | undefined) => JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
const send = (method: string, path: string, headers: Record<string, string>, body?: object) =>
    fetch(`${url}${path}`, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? null : JSON.stringify(body) });
const post = (body: object, headers = AS_SELLER, path = '/catalog/productOffering') => send('POST', path, headers, body);
const patch = (body: object, headers = AS_SELLER, id = 'o-1') => send('PATCH', `/catalog/productOffering/${id}`, headers, body);

describe('reading an offering', () => {
    it('gives it to anybody', async () => {
        expect((await fetch(`${url}/catalog/productOffering/o-1`)).status).toBe(200);
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

const ids = async (response: Response): Promise<string[]> => ((await response.json()) as { id: string }[]).map((one) => one.id);
const lastQuery = () => seen.filter((request) => request.method === 'GET' && request.path.endsWith('/productOffering')).at(-1)?.search;

describe('listing the offerings', () => {
    it('is the list of the catalog API as it is asked for, with no offering for a buyer', async () => {
        stored['productOffering']!['o-buyer'] = offering({ id: 'o-buyer', relatedParty: [BUYER, SELLER] });
        const response = await fetch(`${url}/catalog/productOffering?lifecycleStatus=Launched&limit=12&offset=0&sort=-lastUpdate&isBundle=false`);
        expect(response.status).toBe(200);
        expect(await ids(response)).toEqual(['o-1', 'o-2', 'o-bundle']);
        const query = lastQuery();
        expect(Object.fromEntries(query ?? [])).toMatchObject({ lifecycleStatus: 'Launched', limit: '12', offset: '0', sort: '-lastUpdate', isBundle: 'false', 'relatedParty.role*': '^(?!Buyer$).*$' });
    });

    it('gives the offerings for a buyer to the buyer and the seller who ask for their own', async () => {
        stored['productOffering']!['o-buyer'] = offering({ id: 'o-buyer', relatedParty: [BUYER, SELLER] });
        const buyer = await fetch(`${url}/catalog/productOffering?relatedParty.id=p-ana&relatedParty.role=Buyer`, { headers: LOGGED_IN });
        expect(await ids(buyer)).toEqual(['o-buyer']);
        expect(buyer.headers.get('cache-control')).toMatch(/private|no-store/);
        expect(lastQuery()?.has('relatedParty.role*')).toBe(false);
        const seller = await fetch(`${url}/catalog/productOffering?relatedParty.id=p-shop`, { headers: AS_SELLER });
        expect(await ids(seller)).toEqual(['o-1', 'o-2', 'o-bundle', 'o-buyer']);
        // Somebody else asking for the same is not asking for their own
        const other = await fetch(`${url}/catalog/productOffering?relatedParty.id=p-shop`, { headers: LOGGED_IN });
        expect(await ids(other)).toEqual(['o-1', 'o-2', 'o-bundle']);
    });

    it('does not take what the client says about the roles, and leaves out an offering for a buyer that the filter let in', async () => {
        stored['productOffering']!['o-buyer'] = offering({ id: 'o-buyer', relatedParty: [BUYER, SELLER] });
        honoursRoles = false;
        const response = await fetch(`${url}/catalog/productOffering?relatedParty.role*=.*`);
        expect(await ids(response)).toEqual(['o-1', 'o-2', 'o-bundle']);
        expect(lastQuery()?.get('relatedParty.role*')).toBe('^(?!Buyer$).*$');
    });

    it('refuses filters that the portal does not use, and ids that are not ids', async () => {
        for (const query of ['q=x', 'name=x', 'relatedParty.id=a/b', 'id=a,b/c', 'lifecycleStatus=a;b', 'category.id=a&category.id=b', 'limit=-1']) {
            expect((await fetch(`${url}/catalog/productOffering?${query}`)).status, query).toBe(400);
        }
        expect(seen.filter((request) => request.path.endsWith('/productOffering'))).toEqual([]);
        expect((await fetch(`${url}/catalog/productOffering?category.id=a::b`)).status).toBe(200);
    });

    it('lists the offerings of the categories of a catalog, and none when it has none', async () => {
        stored['productOffering']!['o-1'] = offering({ category: [{ id: 'c-mine' }] });
        const response = await fetch(`${url}/catalog/catalog/cat-1/productOffering?lifecycleStatus=Launched`);
        expect(await ids(response)).toEqual(['o-1']);
        expect(lastQuery()?.get('category')).toBe('c-mine');
        stored['catalog']!['cat-1'] = { id: 'cat-1', lifecycleStatus: 'Launched', relatedParty: [SELLER] };
        seen = [];
        const none = await fetch(`${url}/catalog/catalog/cat-1/productOffering`);
        expect(await none.json()).toEqual([]);
        expect(none.headers.get('x-total-count')).toBe('0');
        expect(seen.filter((request) => request.path.endsWith('/productOffering'))).toEqual([]);
        expect((await fetch(`${url}/catalog/catalog/nobody/productOffering`)).status).toBe(422);
    });

    it('asks the search engine for a keyword and for categories, which pages and sorts, and gives the offerings in its order', async () => {
        const response = await fetch(`${url}/catalog/productOffering?keyword=${encodeURIComponent('data set')}&category.id=c-open,country::Spain&sort=-lastUpdate&offset=2&limit=2&relatedParty.id=p-shop&lifecycleStatus=Launched`);
        expect(response.status).toBe(200);
        expect(await ids(response)).toEqual(['o-2', 'o-1']);
        const searched = seen.find((request) => request.path.startsWith('/api/SearchProduct'));
        expect(searched).toMatchObject({ method: 'POST', path: '/api/SearchProduct/data%20set' });
        expect(Object.fromEntries(searched?.search ?? [])).toEqual({ sort: 'productOfferingLastUpdate,desc', page: '1', size: '2' });
        expect(sent(searched)).toEqual({ categories: ['Open'], country: ['Spain'], organizationId: 'p-shop' });
        const query = lastQuery();
        expect(query?.get('id')).toBe('o-2,o-1');
        expect(query?.get('limit')).toBe('2');
        expect(query?.has('keyword')).toBe(false);
        expect(query?.has('lifecycleStatus')).toBe(false);
    });

    it('answers an empty list when the search engine finds nothing, and when the engine cannot be asked', async () => {
        engine = { status: 200, body: '[]' };
        const none = await fetch(`${url}/catalog/productOffering?keyword=zzz`);
        expect(await none.json()).toEqual([]);
        expect(seen.filter((request) => request.path.endsWith('/productOffering'))).toEqual([]);
        engine = { status: 500, body: '{}' };
        expect((await fetch(`${url}/catalog/productOffering?keyword=zzz`)).status).toBe(502);
    });

    it('does not let a filter of the engine replace what the proxy sets in the search, and needs the categories to exist', async () => {
        expect((await fetch(`${url}/catalog/productOffering?category.id=${encodeURIComponent('organizationId::p-other')}`)).status).toBe(400);
        expect((await fetch(`${url}/catalog/productOffering?category.id=${encodeURIComponent('categories::x')}`)).status).toBe(400);
        expect((await fetch(`${url}/catalog/productOffering?category.id=c-nobody`)).status).toBe(400);
        // The keyword goes in the path of the engine, which takes no separators in a segment
        expect((await fetch(`${url}/catalog/productOffering?keyword=${encodeURIComponent('a/b')}`)).status).toBe(400);
        expect((await fetch(`${url}/catalog/productOffering?keyword=${encodeURIComponent('..')}`)).status).toBe(400);
        expect(seen.some((request) => request.path.startsWith('/api/SearchProduct'))).toBe(false);
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
