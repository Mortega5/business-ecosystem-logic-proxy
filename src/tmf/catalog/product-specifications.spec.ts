import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LoggingModule } from '../../logging/logging.module';
import { FakeFeaturesModule } from '../../testing/fake-features';
import { AS_SELLER, fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogModule } from './catalog.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeaturesModule, CatalogModule] })
class Root {}

const legacy = express();

const CHARGING = '/charging/api/assetManagement/assets/validateJob';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const OTHER = { id: 'p-other', role: 'Seller' };
const DIGITAL = [
    { id: 'ch-type', name: 'Asset type', productSpecCharacteristicValue: [{ value: 'file' }] },
    { id: 'ch-media', name: 'Media type', productSpecCharacteristicValue: [{ value: 'text/csv' }] },
    { id: 'ch-location', name: 'Location', productSpecCharacteristicValue: [{ value: 'http://a/1' }] }
];
const NEW_ASSET = DIGITAL.map((one) => ({ ...one, productSpecCharacteristicValue: [{ value: `${String(one.productSpecCharacteristicValue[0]?.value)}-2` }] }));

const product = (extra: object = {}) => ({ id: 'ps-1', name: 'Data', version: '1.0', lifecycleStatus: 'Active', relatedParty: [SELLER], ...extra });
const make = (extra: object = {}) => ({ name: 'Data', description: 'Some data', version: '1.0', lifecycleStatus: 'Active', relatedParty: [SELLER], ...extra });

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
// What the upstreams have, by kind of thing, and what the writes and the charging backend answer
let stored: Record<string, Record<string, object>>;
let created: Reply;
let patched: Reply;
let priceWrite: Reply;
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
    stored = {
        productSpecification: {
            'ps-1': product(),
            'ps-launched': product({ id: 'ps-launched', lifecycleStatus: 'Launched' }),
            'ps-other': product({ id: 'ps-other', relatedParty: [OTHER] }),
            'ps-other-launched': product({ id: 'ps-other-launched', lifecycleStatus: 'Launched', relatedParty: [OTHER] }),
            'ps-bundle': product({ id: 'ps-bundle', isBundle: true }),
            'ps-retired': product({ id: 'ps-retired', lifecycleStatus: 'Retired' }),
            'ps-digital': product({ id: 'ps-digital', productSpecCharacteristic: DIGITAL }),
            'ps-chars': product({
                id: 'ps-chars',
                productSpecCharacteristic: [
                    { id: 'ch-1', name: 'Size' },
                    { id: 'ch-2', name: 'Color' }
                ]
            })
        },
        productOffering: { 'o-1': { id: 'o-1', lifecycleStatus: 'Retired', productSpecification: { id: 'ps-chars' }, productOfferingPrice: [{ id: 'plan-1' }] } },
        productOfferingPrice: {
            'plan-1': { id: 'plan-1', isBundle: true, bundledPopRelationship: [{ id: 'comp-1' }, { id: 'comp-2' }] },
            'comp-1': { id: 'comp-1', prodSpecCharValueUse: [{ id: 'ch-1', name: 'Size' }, { id: 'ch-2', name: 'Color' }] },
            'comp-2': { id: 'comp-2', prodSpecCharValueUse: [{ id: 'ch-2', name: 'Color' }] }
        },
        serviceSpecification: { 'ss-1': { id: 'ss-1', lifecycleStatus: 'Launched' }, 'ss-2': { id: 'ss-2', lifecycleStatus: 'Active' } },
        resourceSpecification: { 'rs-1': { id: 'rs-1', lifecycleStatus: 'Launched' } }
    };
    created = { status: 201, body: JSON.stringify(product({ id: 'ps-new' })) };
    patched = { status: 200, body: JSON.stringify(product()) };
    priceWrite = { status: 200, body: '{}' };
    charging = () => ({ status: 200, body: '{}' });
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        const body = request?.body ?? '';
        seen.push({ method: request?.method, path: target.pathname, search: target.search, body });
        let reply: Reply = { status: 404, body: '{}' };
        const [, kind, id] = /^\/tmf-api\/\w+\/v4\/(\w+)(?:\/([^/]+))?$/.exec(target.pathname) ?? [];
        const ofKind = stored[kind ?? ''] ?? {};
        if (target.pathname === CHARGING) {
            reply = charging((JSON.parse(body) as { action: string }).action);
        } else if (kind === 'productSpecification' && request?.method === 'POST') {
            reply = created;
        } else if (kind === 'productSpecification' && request?.method === 'PATCH') {
            reply = patched;
        } else if (kind === 'productOfferingPrice' && request?.method === 'PATCH') {
            reply = priceWrite;
        } else if (kind !== undefined && id === undefined && request?.method === 'GET') {
            const ids = target.searchParams.get('id')?.split(',');
            const spec = target.searchParams.get('productSpecification.id');
            const found = Object.values(ofKind).filter(
                (one) => (ids === undefined || ids.includes((one as { id: string }).id)) && (spec === null || (one as { productSpecification?: { id: string } }).productSpecification?.id === spec)
            );
            reply = { status: 200, body: JSON.stringify(found) };
        } else if (id !== undefined && ofKind[decodeURIComponent(id)] !== undefined) {
            reply = { status: 200, body: JSON.stringify(ofKind[decodeURIComponent(id)]) };
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const writes = () => seen.filter((request) => request.method !== 'GET');
const toCharging = () => seen.filter((request) => request.path === CHARGING).map((request) => (JSON.parse(request.body) as { action: string }).action);
const sent = (request: Seen | undefined) => JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
const send = (method: string, path: string, headers: Record<string, string>, body?: object) =>
    fetch(`${url}${path}`, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? null : JSON.stringify(body) });
const post = (body: object, headers = AS_SELLER) => send('POST', '/catalog/productSpecification', headers, body);
const patch = (body: object, id = 'ps-1', headers = AS_SELLER) => send('PATCH', `/catalog/productSpecification/${id}`, headers, body);
const message = async (response: Response) => ((await response.json()) as { error?: string }).error ?? '';

describe('reading product specs', () => {
    it('gives a launched one to anybody and an active one only to its owner', async () => {
        expect((await fetch(`${url}/catalog/productSpecification/ps-launched`)).status).toBe(200);
        expect((await fetch(`${url}/catalog/productSpecification/ps-1`)).status).toBe(403);
        expect((await fetch(`${url}/catalog/productSpecification/ps-1`, { headers: LOGGED_IN })).status).toBe(403);
        expect((await fetch(`${url}/catalog/productSpecification/ps-1`, { headers: AS_SELLER })).status).toBe(200);
    });

    it('lists by ids what the caller may read, and nothing else', async () => {
        const response = await fetch(`${url}/catalog/productSpecification?id=ps-1,ps-launched,ps-other,ps-other-launched&limit=4`, { headers: LOGGED_IN });
        expect(((await response.json()) as { id: string }[]).map((one) => one.id)).toEqual(['ps-launched', 'ps-other-launched']);
        const owner = await fetch(`${url}/catalog/productSpecification?id=ps-1,ps-other&limit=2`, { headers: AS_SELLER });
        expect(((await owner.json()) as { id: string }[]).map((one) => one.id)).toEqual(['ps-1']);
    });

    it('lists by ids without a login only what is public', async () => {
        const response = await fetch(`${url}/catalog/productSpecification?id=ps-1,ps-launched`);
        expect(((await response.json()) as { id: string }[]).map((one) => one.id)).toEqual(['ps-launched']);
    });

    it('does not take other filters or fields in a list by ids, nor ids that are not ids', async () => {
        expect((await fetch(`${url}/catalog/productSpecification?id=../x`, { headers: LOGGED_IN })).status).toBe(400);
        expect(seen).toEqual([]);
        // With a field it is the list of the caller, which is theirs whatever the ids
        expect((await fetch(`${url}/catalog/productSpecification?id=ps-1&fields=name`, { headers: LOGGED_IN })).status).toBe(200);
        expect(seen[0]?.search).toContain('relatedParty.id=p-ana');
    });

    it('lists the products of the seller when no ids are asked for, and refuses it to anybody without a party', async () => {
        await fetch(`${url}/catalog/productSpecification?lifecycleStatus=Launched`, { headers: AS_SELLER });
        expect(seen[0]?.search).toContain('relatedParty.id=p-shop');
        expect((await fetch(`${url}/catalog/productSpecification`)).status).toBe(403);
    });
});

describe('creating a product spec', () => {
    it('asks the charging backend, makes it, and tells the backend what was made', async () => {
        const response = await post(make());
        expect(response.status).toBe(201);
        expect(seen.map((request) => `${request.method} ${request.path.split('/').slice(-1)[0]}`)).toEqual(['POST validateJob', 'POST productSpecification', 'POST validateJob']);
        expect(toCharging()).toEqual(['create', 'attach']);
        expect(sent(seen[2])['product']).toMatchObject({ id: 'ps-new' });
        // What the portal does not say is when it starts to be valid, which is now
        expect(sent(seen[0])['product']).toMatchObject({ validFor: { startDateTime: expect.any(String) as string } });
        expect(sent(seen[1])).toMatchObject({ validFor: { startDateTime: expect.any(String) as string } });
    });

    it('is only for a seller who is the owner', async () => {
        expect((await post(make(), LOGGED_IN)).status).toBe(403);
        const other = await post(make({ relatedParty: [OTHER] }));
        expect(other.status).toBe(403);
        expect(await message(other)).toBe('The user making the request and the specified owner are not the same user');
        expect(seen).toEqual([]);
    });

    it('does not make it when the charging backend refuses it, and says what it said', async () => {
        charging = () => ({ status: 409, body: JSON.stringify({ error: 'The asset is not reachable' }) });
        const response = await post(make());
        expect(response.status).toBe(409);
        expect(await message(response)).toBe('The asset is not reachable');
        expect(writes().map((request) => request.path)).toEqual([CHARGING]);
    });

    it('tells the charging backend to take it back when it cannot be made', async () => {
        created = { status: 500, body: '{}' };
        expect((await post(make())).status).toBe(500);
        expect(toCharging()).toEqual(['create', 'rollback_create']);
    });

    it('retires it and takes it back when the backend cannot be told that it was made', async () => {
        charging = (action) => (action === 'attach' ? { status: 500, body: '{}' } : { status: 200, body: '{}' });
        const response = await post(make());
        expect(response.status).toBe(502);
        expect(await message(response)).toContain('ps-new was created and the charging backend could not be told');
        expect(writes().map((request) => `${request.method} ${request.path.split('/').slice(-1)[0]}`)).toEqual([
            'POST validateJob',
            'POST productSpecification',
            'POST validateJob',
            'PATCH ps-new',
            'POST validateJob'
        ]);
        expect(toCharging()).toEqual(['create', 'attach', 'rollback_create']);
    });

    it.each([
        ['an invalid name', { name: '' }, 'Product spec name is empty'],
        ['a picture that is not an image', { attachment: [{ name: 'Profile Picture', attachmentType: 'application/pdf', url: 'http://a' }] }, 'Product profile picture must use a valid image format (SVG, PNG, JPEG or GIF)'],
        ['a characteristic twice', { productSpecCharacteristic: [{ name: 'Size' }, { name: 'Size' }] }, 'Invalid product spec characteristics'],
        ['an empty range', { productSpecCharacteristic: [{ name: 'Size', productSpecCharacteristicValue: [{ valueFrom: 5, valueTo: 5 }] }] }, 'Invalid product spec characteristics'],
        ['a compliance credential', { productSpecCharacteristic: [{ name: 'compliance:vc', productSpecCharacteristicValue: [{ value: 'x' }] }] }, 'Invalid product spec characteristics'],
        ['a plan without steps', { orchestrationPlan: {} }, 'orchestrationPlan must contain a steps array'],
        ['a step twice', { orchestrationPlan: { steps: [{ id: 'a' }, { id: 'a' }] } }, 'Duplicated orchestrationPlan step id: a'],
        [
            'a reference to a step it does not depend on',
            { orchestrationPlan: { steps: [{ id: 'a' }, { id: 'b', enforcedCharacteristic: { host: '<<steps.a.service.name>>' } }] } },
            'Step b: <<steps.a.service.name>> refers to a step that is not in its dependsOn - add the edge, with waitForHealthy false if you do not want to wait for it'
        ]
    ])('refuses %s before it asks anybody', async (_name, extra, expected) => {
        const response = await post(make(extra));
        expect(response.status).toBe(422);
        expect(await message(response)).toBe(expected);
        expect(seen).toEqual([]);
    });

    it('accepts a plan whose steps depend on each other', async () => {
        const plan = { steps: [{ id: 'a' }, { id: 'b', dependsOn: ['a'], enforcedCharacteristic: { host: '<<steps.a.service.name>>' } }] };
        expect((await post(make({ orchestrationPlan: plan }))).status).toBe(201);
    });

    describe('a bundle', () => {
        const bundle = (ids: string[], extra: object = {}) => make({ isBundle: true, bundledProductSpecification: ids.map((id) => ({ id, href: id })), ...extra });

        it('needs two products of the seller that are not bundles and are active or launched', async () => {
            expect((await post(bundle(['ps-1']))).status).toBe(422);
            expect((await post(make({ isBundle: true, bundledProductSpecification: [{ id: 'ps-1' }, { id: 'ps-launched' }] }))).status).toBe(422);
            expect((await post(bundle(['ps-1', 'ps-other']))).status).toBe(403);
            expect((await post(bundle(['ps-1', 'ps-bundle']))).status).toBe(422);
            expect((await post(bundle(['ps-1', 'ps-retired']))).status).toBe(422);
            expect((await post(bundle(['ps-1', 'ps-missing']))).status).toBe(422);
            expect(toCharging()).toEqual([]);
        });

        it('is made when it is right', async () => {
            expect((await post(bundle(['ps-1', 'ps-launched']))).status).toBe(201);
            expect(toCharging()).toEqual(['create', 'attach']);
        });
    });
});

describe('changing a product spec', () => {
    it('is only for the seller who owns it', async () => {
        expect((await patch({ description: 'x' }, 'ps-other')).status).toBe(403);
        expect((await patch({ description: 'x' }, 'ps-1', LOGGED_IN)).status).toBe(403);
        expect((await patch({ description: 'x' }, 'ps-missing')).status).toBe(404);
        expect((await patch({ relatedParty: [OTHER] })).status).toBe(409);
        expect(writes()).toEqual([]);
    });

    it('sets when it starts to be valid when it has no such date', async () => {
        expect((await patch({ description: 'x' })).status).toBe(200);
        expect(sent(writes()[0])).toMatchObject({ description: 'x', validFor: { startDateTime: expect.any(String) as string } });
        seen = [];
        stored['productSpecification']!['ps-1'] = product({ validFor: { startDateTime: '2020-01-01T00:00:00.000Z' } });
        expect((await patch({ description: 'y' })).status).toBe(200);
        expect(sent(writes()[0])).toEqual({ description: 'y' });
    });

    it('follows the life cycle', async () => {
        expect((await patch({ lifecycleStatus: 'Retired' }, 'ps-launched')).status).toBe(200);
        const skipped = await patch({ lifecycleStatus: 'Retired' });
        expect(skipped.status).toBe(400);
        expect(await message(skipped)).toBe('Cannot transition from lifecycle status Active to Retired');
    });

    it('is not retired while an offering of it is not', async () => {
        stored['productOffering'] = { 'o-1': { id: 'o-1', lifecycleStatus: 'Launched', productSpecification: { id: 'ps-launched' } } };
        const response = await patch({ lifecycleStatus: 'Retired' }, 'ps-launched');
        expect(response.status).toBe(409);
        expect(await message(response)).toContain('o-1');
        expect(writes()).toEqual([]);
    });

    it('is made obsolete only when all its offerings are', async () => {
        stored['productSpecification']!['ps-retired'] = product({ id: 'ps-retired', lifecycleStatus: 'Retired' });
        stored['productOffering'] = { 'o-1': { id: 'o-1', lifecycleStatus: 'Retired', productSpecification: { id: 'ps-retired' } } };
        expect((await patch({ lifecycleStatus: 'Obsolete' }, 'ps-retired')).status).toBe(409);
        stored['productOffering'] = { 'o-1': { id: 'o-1', lifecycleStatus: 'Obsolete', productSpecification: { id: 'ps-retired' } } };
        expect((await patch({ lifecycleStatus: 'Obsolete' }, 'ps-retired')).status).toBe(200);
    });

    it('is launched once its service and resource specs are', async () => {
        stored['productSpecification']!['ps-1'] = product({ serviceSpecification: [{ id: 'ss-1' }, { id: 'ss-2' }], resourceSpecification: [{ id: 'rs-1' }] });
        const waiting = await patch({ lifecycleStatus: 'Launched' });
        expect(waiting.status).toBe(409);
        expect(await message(waiting)).toBe('It is not allowed to launch a product spec without launching service spec previously');
        stored['productSpecification']!['ps-1'] = product({ serviceSpecification: [{ id: 'ss-1' }], resourceSpecification: [{ id: 'rs-1' }] });
        expect((await patch({ lifecycleStatus: 'Launched' })).status).toBe(200);
    });

    it('is not launched when a spec that it needs cannot be found', async () => {
        stored['productSpecification']!['ps-1'] = product({ serviceSpecification: [{ id: 'ss-1' }, { id: 'ss-gone' }] });
        expect((await patch({ lifecycleStatus: 'Launched' })).status).toBe(400);
    });

    it('does not change the bundle of a product that is not active', async () => {
        const response = await patch({ isBundle: false }, 'ps-launched');
        expect(response.status).toBe(200);
        expect((await patch({ bundledProductSpecification: [{ id: 'ps-1', href: 'ps-1' }] }, 'ps-launched')).status).toBe(422);
    });

    it('keeps the compliance credential that it has', async () => {
        const credential = { name: 'compliance:vc', productSpecCharacteristicValue: [{ value: 'jwt' }] };
        stored['productSpecification']!['ps-1'] = product({ productSpecCharacteristic: [credential] });
        expect((await patch({ productSpecCharacteristic: [credential, { name: 'Size' }] })).status).toBe(200);
        expect((await patch({ productSpecCharacteristic: [{ name: 'Size' }] })).status).toBe(422);
        expect((await patch({ productSpecCharacteristic: [{ ...credential, productSpecCharacteristicValue: [{ value: 'other' }] }] })).status).toBe(422);
    });

    describe('removing characteristics', () => {
        it('is only for an active product, which then no longer has them in its prices', async () => {
            const response = await patch({ productSpecCharacteristic: [{ id: 'ch-1', name: 'Size' }] }, 'ps-chars');
            expect(response.status).toBe(200);
            const prices = writes().filter((request) => request.path.endsWith('/productOfferingPrice/comp-1') || request.path.endsWith('/productOfferingPrice/comp-2'));
            expect(prices.map((request) => [request.path.split('/').slice(-1)[0], sent(request)])).toEqual([
                ['comp-1', { prodSpecCharValueUse: [{ id: 'ch-1', name: 'Size' }] }],
                ['comp-2', { prodSpecCharValueUse: [] }]
            ]);
        });

        it('is refused for a product that is launched', async () => {
            stored['productSpecification']!['ps-chars'] = product({ id: 'ps-chars', lifecycleStatus: 'Launched', productSpecCharacteristic: [{ id: 'ch-1', name: 'Size' }, { id: 'ch-2', name: 'Color' }] });
            const response = await patch({ productSpecCharacteristic: [{ id: 'ch-1', name: 'Size' }] }, 'ps-chars');
            expect(response.status).toBe(422);
            expect(await message(response)).toBe('Product specification characteristics can only be removed from active product specifications');
            expect(writes()).toEqual([]);
        });

        it('tells the client what is left when the prices cannot be cleaned', async () => {
            priceWrite = { status: 500, body: '{}' };
            const response = await patch({ productSpecCharacteristic: [{ id: 'ch-1', name: 'Size' }] }, 'ps-chars');
            expect(response.status).toBe(502);
            expect(await message(response)).toBe('The product spec ps-chars was changed and the references to the removed product specification characteristics could not be updated');
        });
    });

    describe('a digital product', () => {
        it('has a new version when it comes with its new asset, which the charging backend checks first and is told after', async () => {
            const response = await patch({ version: '2.0', productSpecCharacteristic: NEW_ASSET }, 'ps-digital');
            expect(response.status).toBe(200);
            expect(seen.filter((request) => request.method !== 'GET').map((request) => request.path.split('/').slice(-1)[0])).toEqual(['validateJob', 'ps-digital', 'validateJob']);
            expect(toCharging()).toEqual(['upgrade', 'attach_upgrade']);
            expect(sent(writes()[0])['product']).toMatchObject({ id: 'ps-digital', version: '2.0' });
        });

        it('does not change when the charging backend refuses the new version', async () => {
            charging = () => ({ status: 422, body: JSON.stringify({ error: 'The new asset is not valid' }) });
            const response = await patch({ version: '2.0', productSpecCharacteristic: NEW_ASSET }, 'ps-digital');
            expect(response.status).toBe(422);
            expect(await message(response)).toBe('The new asset is not valid');
            expect(writes().map((request) => request.path)).toEqual([CHARGING]);
        });

        it('tells the charging backend to go back when the change fails', async () => {
            patched = { status: 500, body: '{}' };
            expect((await patch({ version: '2.0', productSpecCharacteristic: NEW_ASSET }, 'ps-digital')).status).toBe(500);
            expect(toCharging()).toEqual(['upgrade', 'rollback_upgrade']);
        });

        it('tells the client when the charging backend cannot be told that it was upgraded', async () => {
            charging = (action) => (action === 'attach_upgrade' ? { status: 500, body: '{}' } : { status: 200, body: '{}' });
            const response = await patch({ version: '2.0', productSpecCharacteristic: NEW_ASSET }, 'ps-digital');
            expect(response.status).toBe(502);
            const said = await message(response);
            expect(said).toContain('was upgraded and the charging backend could not be told');
            expect(said).toContain('the previous version was restored');
            // The change, then what it was before, and the backend is told to go back
            const patches = writes().filter((request) => request.method === 'PATCH');
            expect(sent(patches[1])).toEqual({ version: '1.0', productSpecCharacteristic: DIGITAL });
            expect(toCharging()).toEqual(['upgrade', 'attach_upgrade', 'rollback_upgrade']);
        });

        it.each([
            ['a version without its asset', { version: '2.0' }, 'To upgrade product specifications it is required to provide new asset info'],
            ['characteristics without a version', { productSpecCharacteristic: [...DIGITAL, { name: 'Size' }] }, 'Product specification characteristics only can be updated for upgrading digital products'],
            ['the same version', { version: '1.0', productSpecCharacteristic: NEW_ASSET }, 'Product specification characteristics only can be updated for upgrading digital products'],
            ['other characteristics with a new version', { version: '2.0', productSpecCharacteristic: [...NEW_ASSET, { name: 'Size' }] }, 'It is not allowed to update custom characteristics during a product upgrade']
        ])('does not take %s', async (_name, changes, expected) => {
            const response = await patch(changes, 'ps-digital');
            expect(response.status).toBe(422);
            expect(await message(response)).toBe(expected);
            expect(writes()).toEqual([]);
        });
    });
});

describe('retiring a product spec', () => {
    it('retires it, and only for its owner', async () => {
        expect((await send('DELETE', '/catalog/productSpecification/ps-other', AS_SELLER)).status).toBe(403);
        expect((await send('DELETE', '/catalog/productSpecification/ps-retired', AS_SELLER)).status).toBe(409);
        expect((await send('DELETE', '/catalog/productSpecification/ps-1', AS_SELLER)).status).toBe(200);
        expect(sent(writes()[0])).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('waits for its offerings, which the legacy application did not', async () => {
        stored['productOffering'] = { 'o-1': { id: 'o-1', lifecycleStatus: 'Launched', productSpecification: { id: 'ps-1' } } };
        expect((await send('DELETE', '/catalog/productSpecification/ps-1', AS_SELLER)).status).toBe(409);
        expect(writes()).toEqual([]);
    });
});
