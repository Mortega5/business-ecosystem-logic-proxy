import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_SELLER, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeFeaturesModule, featuresOn } from '../../testing/fake-features';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeaturesModule, CatalogModule] })
class Root {}

const legacy = express();

const API = '/tmf-api/productCatalogManagement/v4';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const OTHER = { id: 'p-other', role: 'Seller' };
const EU = [{ name: 'Region', productSpecCharacteristicValue: [{ value: 'EU' }] }];
const US = [{ name: 'Region', productSpecCharacteristicValue: [{ value: 'US' }] }];

type Price = Record<string, unknown>;
const price = (extra: Price = {}): Price => ({ id: 'comp-1', isBundle: false, priceType: 'recurring', price: { value: 5, unit: 'EUR' }, relatedParty: [SELLER], ...extra });
const plan = (extra: Price = {}): Price => ({ id: 'plan-1', isBundle: true, bundledPopRelationship: [{ id: 'comp-1' }], relatedParty: [SELLER], ...extra });
const constraint = (extra: Price = {}): Price => ({ id: 'cons-1', isBundle: false, priceType: 'constraint', prodSpecCharValueUse: EU, relatedParty: [SELLER], ...extra });

interface Seen {
    method: string | undefined;
    path: string;
    search: URLSearchParams;
    body: string;
}

let app: NestExpressApplication;
let url: string;
let seen: Seen[];
let stored: Record<string, Price>;
let failing: string | undefined;

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

const refersTo = (list: unknown, id: string): boolean => Array.isArray(list) && list.some((one: { id?: string }) => one.id === id);

beforeEach(() => {
    upstream.reset();
    seen = [];
    failing = undefined;
    featuresOn.clear();
    stored = { 'comp-1': price(), 'plan-1': plan(), 'cons-1': constraint(), 'comp-other': price({ id: 'comp-other', relatedParty: [OTHER] }) };
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        seen.push({ method: request?.method, path: target.pathname, search: target.searchParams, body: request?.body ?? '' });
        const [, kind, id] = /^\/tmf-api\/productCatalogManagement\/v4\/(\w+)(?:\/([^/]+))?$/.exec(target.pathname) ?? [];
        if (target.pathname.startsWith('/tmf-api/party/v4/')) {
            upstream.json(res, 200, JSON.stringify({ id: 'p-ana', externalReference: [] }));
        } else if (kind !== 'productOfferingPrice') {
            upstream.json(res, 404, '{}');
        } else if (request?.method === 'POST') {
            upstream.json(res, 201, JSON.stringify({ id: 'new-1' }));
        } else if (request?.method === 'PATCH') {
            upstream.json(res, 200, JSON.stringify({ id }));
        } else if (id !== undefined) {
            const found = stored[decodeURIComponent(id)];
            upstream.json(res, found === undefined ? 404 : 200, JSON.stringify(found ?? {}));
        } else if (failing !== undefined && target.search.includes(failing)) {
            upstream.json(res, 500, '{}');
        } else {
            const ids = target.searchParams.get('id')?.split(',');
            const bundled = target.searchParams.get('bundledPopRelationship.id');
            const related = target.searchParams.get('popRelationship.id');
            const found = Object.values(stored).filter(
                (one) => (ids === undefined || ids.includes(String(one['id']))) && (bundled === null || refersTo(one['bundledPopRelationship'], bundled)) && (related === null || refersTo(one['popRelationship'], related))
            );
            upstream.json(res, 200, JSON.stringify(found));
        }
    });
});

const writes = () => seen.filter((request) => request.method !== 'GET');
const sent = (request: Seen | undefined) => JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
const send = (method: string, path: string, headers: Record<string, string>, body?: object) =>
    fetch(`${url}${path}`, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? null : JSON.stringify(body) });
const post = (body: object, headers = AS_SELLER) => send('POST', '/catalog/productOfferingPrice', headers, body);
const patch = (body: object, id = 'comp-1', headers = AS_SELLER) => send('PATCH', `/catalog/productOfferingPrice/${id}`, headers, body);
const said = async (response: Response): Promise<string> => ((await response.json()) as { error?: string }).error ?? '';

const make = (extra: Price = {}): Price => ({ name: 'Monthly', priceType: 'recurring', isBundle: false, price: { value: '9.99', unit: 'EUR' }, ...extra });

describe('reading the prices', () => {
    it('gives one to anybody, and the list with the filters that the portal asks', async () => {
        expect((await fetch(`${url}/catalog/productOfferingPrice/comp-1`)).status).toBe(200);
        expect((await fetch(`${url}/catalog/productOfferingPrice?id=comp-1,plan-1&limit=2`)).status).toBe(200);
        const filtered = seen.at(-1)?.search;
        expect(filtered?.get('id')).toBe('comp-1,plan-1');
        expect((await fetch(`${url}/catalog/productOfferingPrice?bundledPopRelationship.id=comp-1&offset=0&limit=100`)).status).toBe(200);
        expect((await fetch(`${url}/catalog/productOfferingPrice?usageSpecId=us-1`)).status).toBe(200);
    });

    it('refuses a filter that the portal does not ask, and an id that is not one', async () => {
        expect((await fetch(`${url}/catalog/productOfferingPrice?relatedParty.id=p-shop`)).status).toBe(400);
        expect((await fetch(`${url}/catalog/productOfferingPrice?id=a/../b`)).status).toBe(400);
        expect((await fetch(`${url}/catalog/productOfferingPrice/a%2F..%2Fb`)).status).toBe(400);
    });
});

describe('creating a price', () => {
    it('is made by a seller, who is its seller whatever the body says, with the schema of what it is', async () => {
        const response = await post(make({ relatedParty: [OTHER] }));
        expect(response.status).toBe(201);
        const [made] = writes();
        expect(made).toMatchObject({ method: 'POST', path: `${API}/productOfferingPrice` });
        const body = sent(made);
        expect((body['relatedParty'] as { id: string; role: string }[]).map((party) => `${party.id}:${party.role}`)).toEqual(['p-shop:Seller']);
        expect(body['@schemaLocation']).toMatch(/PriceComponent/);
        expect(body['validFor']).toBeTruthy();
        await post({ ...make(), isBundle: true, price: undefined, bundledPopRelationship: [{ id: 'comp-1' }] });
        expect(sent(writes()[1])['@schemaLocation']).toMatch(/^https:/);
        expect(sent(writes()[1])['@schemaLocation']).not.toMatch(/PriceComponent/);
    });

    it('is for a seller, and the body names its parties', async () => {
        expect((await post(make(), LOGGED_IN)).status).toBe(403);
        expect((await post(make({ relatedParty: [null] }))).status).toBe(400);
        expect(writes()).toEqual([]);
    });

    it('refuses amounts that are not amounts', async () => {
        expect(await said(await post(make({ price: { value: 'abc', unit: 'EUR' } })))).toMatch(/^Price must be/);
        expect((await post(make({ price: { value: 0, unit: 'EUR' } }))).status).toBe(422);
        expect((await post(make({ price: { value: 2_000_000_000, unit: 'EUR' } }))).status).toBe(422);
        expect((await post(make({ price: { value: 1.234, unit: 'EUR' } }))).status).toBe(422);
        expect((await post(make({ price: { value: 1, unit: 'XXY' } }))).status).toBe(422);
        expect((await post(make({ price: { value: 1 } }))).status).toBe(422);
        expect(await said(await post(make({ unitOfMeasure: { amount: 0, units: 'GB' } })))).toMatch(/^Amount must be/);
        expect(await said(await post(make({ priceType: 'discount', percentage: 120, price: undefined })))).toMatch(/^Discount must be/);
        expect(writes()).toEqual([]);
    });

    it('takes a price in a currency with no decimals, a unit of measure, and a discount', async () => {
        expect((await post(make({ price: { value: 500, unit: 'JPY' } }))).status).toBe(201);
        expect((await post(make({ unitOfMeasure: { amount: '10', units: 'GB' } }))).status).toBe(201);
        expect((await post(make({ priceType: 'discount', percentage: '15', price: undefined }))).status).toBe(201);
    });

    it('holds components that exist, that are components and that its constraint allows', async () => {
        stored['comp-eu'] = price({ id: 'comp-eu', prodSpecCharValueUse: EU });
        stored['comp-us'] = price({ id: 'comp-us', prodSpecCharValueUse: US });
        stored['cons-2'] = constraint({ id: 'cons-2' });
        const made = (extra: Price) => post(make({ isBundle: true, price: undefined, ...extra }));
        expect((await made({ bundledPopRelationship: [{ id: 'comp-1' }, { id: 'comp-us' }], popRelationship: [{ id: 'cons-1', relationshipType: 'constraint' }] })).status).toBe(201);
        expect(await said(await made({ bundledPopRelationship: [{ id: 'comp-eu' }], popRelationship: [{ id: 'cons-1', relationshipType: 'Constraint' }] }))).toBe('The price plan contains a price component that uses a forbidden characteristic');
        expect(await said(await made({ bundledPopRelationship: [{ id: 'nobody' }] }))).toBe('The price component nobody referenced by the price plan cannot be accessed or does not exist');
        expect(await said(await made({ bundledPopRelationship: [{}] }))).toBe('The price plan contains a price component reference without an id');
        expect(await said(await made({ bundledPopRelationship: [{ id: 'plan-1' }] }))).toBe('The price plan can only contain price components with isBundle set to false');
        expect(await said(await made({ bundledPopRelationship: [{ id: 'cons-1' }] }))).toBe('A constraint price cannot be included as a price component of a price plan');
        expect(await said(await made({ bundledPopRelationship: [{ id: 'comp-1' }], prodSpecCharValueUse: EU, popRelationship: [{ id: 'cons-1', relationshipType: 'constraint' }] }))).toBe(
            'A price plan with prodSpecCharValueUse cannot reference a constraint'
        );
        expect(
            await said(await made({ bundledPopRelationship: [{ id: 'comp-1' }], popRelationship: [{ id: 'cons-1', relationshipType: 'constraint' }, { id: 'cons-2', relationshipType: 'constraint' }] }))
        ).toBe('The price plan can only reference one constraint price');
        expect(await said(await made({ bundledPopRelationship: [{ id: 'comp-1' }], popRelationship: [{ relationshipType: 'constraint' }] }))).toBe('The price plan contains a constraint reference without an id');
        expect(await said(await made({ bundledPopRelationship: [{ id: 'comp-1' }], popRelationship: [{ id: 'comp-1', relationshipType: 'constraint' }] }))).toBe(
            'The constraint relationship must reference a non-bundled ProductOfferingPrice with priceType constraint'
        );
        expect(await said(await made({ bundledPopRelationship: [{ id: 'comp-1' }], popRelationship: [{ id: 'gone', relationshipType: 'constraint' }] }))).toBe(
            'The constraint gone referenced by the price plan cannot be accessed or does not exist'
        );
    });

    it('is refused when what it is made of cannot be read', async () => {
        failing = 'id=comp-1';
        expect(await said(await post(make({ isBundle: true, price: undefined, bundledPopRelationship: [{ id: 'comp-1' }] })))).toBe('The price components referenced by the price plan cannot be retrieved');
        expect((await post(make({ isBundle: true, price: undefined, bundledPopRelationship: [{ id: 'a/b' }] }))).status).toBe(422);
    });

    it('does not let a constraint name a compliance characteristic', async () => {
        const body = make({ priceType: 'constraint', prodSpecCharValueUse: [{ name: ' Compliance:VC ', productSpecCharacteristicValue: [{ value: 'x' }] }], price: undefined });
        expect(await said(await post(body))).toBe('Compliance characteristics cannot be used in price constraints');
        expect((await post({ ...body, prodSpecCharValueUse: EU })).status).toBe(201);
    });
});

describe('changing a price', () => {
    it('is for its seller, who changes it with the schema of a component and a start date it did not have', async () => {
        expect((await patch({ name: 'New' })).status).toBe(200);
        const [made] = writes();
        expect(made).toMatchObject({ method: 'PATCH', path: `${API}/productOfferingPrice/comp-1` });
        expect(sent(made)).toMatchObject({ name: 'New', '@schemaLocation': expect.stringMatching(/PriceComponent/) as string });
        expect(sent(made)['validFor']).toBeTruthy();
        stored['comp-1'] = price({ validFor: { startDateTime: '2020-01-01T00:00:00Z' } });
        await patch({ name: 'Newer' });
        expect(sent(writes()[1])['validFor']).toBeUndefined();
        await patch({ name: 'Plan' }, 'plan-1');
        expect(sent(writes()[2])['@schemaLocation']).toBeUndefined();
    });

    it('is not for anybody else, and the price has to exist', async () => {
        expect((await patch({ name: 'New' }, 'comp-other')).status).toBe(403);
        expect((await patch({ name: 'New' }, 'comp-1', LOGGED_IN)).status).toBe(403);
        expect((await patch({ name: 'New' }, 'nobody')).status).toBe(404);
        expect(writes()).toEqual([]);
    });

    it('keeps its parties, its kind and its states in order', async () => {
        expect((await patch({ relatedParty: [OTHER] })).status).toBe(409);
        expect((await patch({ isBundle: true })).status).toBe(403);
        stored['comp-1'] = price({ lifecycleStatus: 'Active' });
        expect((await patch({ lifecycleStatus: 'Rejected' })).status).toBe(400);
        expect((await patch({ lifecycleStatus: 'Launched' })).status).toBe(200);
        expect((await patch({ price: { value: 'x', unit: 'EUR' } })).status).toBe(422);
    });

    it('does not let a component use what the constraint of its plans forbids', async () => {
        stored['plan-1'] = plan({ popRelationship: [{ id: 'cons-1', relationshipType: 'constraint' }] });
        expect(await said(await patch({ prodSpecCharValueUse: EU }))).toBe('The price component uses a characteristic forbidden by one of its price plans');
        expect((await patch({ prodSpecCharValueUse: US })).status).toBe(200);
        expect((await patch({ prodSpecCharValueUse: [] })).status).toBe(200);
        stored['plan-1'] = plan({ popRelationship: [{ id: 'missing', relationshipType: 'constraint' }] });
        expect(await said(await patch({ prodSpecCharValueUse: US }))).toBe('A price plan references an invalid constraint price');
        failing = 'bundledPopRelationship.id';
        expect(await said(await patch({ prodSpecCharValueUse: US }))).toBe('The price plans referencing the price component cannot be retrieved');
    });

    it('does not let a constraint forbid what the components of its plans use', async () => {
        stored['comp-1'] = price({ prodSpecCharValueUse: EU });
        stored['plan-1'] = plan({ popRelationship: [{ id: 'cons-1', relationshipType: 'constraint' }] });
        expect(await said(await patch({ prodSpecCharValueUse: EU }, 'cons-1'))).toBe('The price plan contains a price component that uses a forbidden characteristic');
        expect((await patch({ prodSpecCharValueUse: US }, 'cons-1')).status).toBe(200);
        expect((await patch({ name: 'Renamed' }, 'cons-1')).status).toBe(200);
        expect(await said(await patch({ prodSpecCharValueUse: [{ name: 'compliance:x', productSpecCharacteristicValue: [{ value: 'y' }] }] }, 'cons-1'))).toBe(
            'Compliance characteristics cannot be used in price constraints'
        );
    });

    it('takes a plan with other components when its constraint allows them, and checks them only when they change', async () => {
        stored['comp-eu'] = price({ id: 'comp-eu', prodSpecCharValueUse: EU });
        stored['plan-1'] = plan({ popRelationship: [{ id: 'cons-1', relationshipType: 'constraint' }] });
        expect((await patch({ name: 'Renamed' }, 'plan-1')).status).toBe(200);
        expect(seen.filter((request) => request.method === 'GET' && request.search.has('id'))).toEqual([]);
        expect((await patch({ bundledPopRelationship: [{ id: 'comp-eu' }] }, 'plan-1')).status).toBe(422);
        expect((await patch({ bundledPopRelationship: [{ id: 'comp-1' }] }, 'plan-1')).status).toBe(200);
    });
});

describe('deleting a price', () => {
    it('is not done: an offering stops naming it', async () => {
        const response = await send('DELETE', '/catalog/productOfferingPrice/comp-1', AS_SELLER);
        expect([404, 405]).toContain(response.status);
        expect(writes()).toEqual([]);
    });
});
