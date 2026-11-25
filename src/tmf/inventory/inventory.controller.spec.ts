import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ORGANISATION, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { InventoryModule } from './inventory.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, InventoryModule] })
class Root {}

const APIS = [
    { prefix: '/inventory', resource: 'product', upstream: '/tmf-api/productInventory/v4/product', filter: 'status' },
    { prefix: '/serviceInventory', resource: 'service', upstream: '/tmf-api/serviceInventory/v4/service', filter: 'state' },
    { prefix: '/resourceInventory', resource: 'resource', upstream: '/tmf-api/resourceInventoryManagement/v4/resource', filter: 'resourceStatus' }
];

let app: NestExpressApplication;
let url: string;
const MINE = JSON.stringify({ id: 'x-1', relatedParty: [{ id: 'p-ana', role: 'Buyer' }, { id: 'p-shop', role: 'Seller' }] });
const answerWith = (status: number, body: string): void => upstream.answer((res) => upstream.json(res, status, body));

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
    answerWith(200, '[]');
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: { ...LOGGED_IN, ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) });
const sentQuery = (): [string, string][] => [...new URL(`http://x${upstream.seen?.url ?? ''}`).searchParams.entries()];

describe.each(APIS)('$prefix/$resource, the list', ({ prefix, resource, upstream: target, filter }) => {
    it('is the list of the caller: every filter goes on, then the party and its role', async () => {
        const res = await call(
            `${prefix}/${resource}?limit=5&offset=10&${filter}=active,suspended&sort=-name&name*=cloud&productOffering.id=urn:ngsi-ld:offering:1&fields=relatedParty&relatedParty.id=p-victim&relatedParty.role=Seller`
        );

        expect(res.status).toBe(200);
        expect(upstream.seen?.url?.startsWith(`${target}?`)).toBe(true);
        expect(sentQuery()).toEqual([
            ['limit', '5'],
            ['offset', '10'],
            [filter, 'active,suspended'],
            ['sort', '-name'],
            ['name*', 'cloud'],
            ['productOffering.id', 'urn:ngsi-ld:offering:1'],
            ['fields', 'relatedParty'],
            ['relatedParty.id', 'p-ana'],
            ['relatedParty.role', 'Buyer']
        ]);
        expect(upstream.seen?.headers).toMatchObject({ 'x-actor-id': 'u-ana', 'x-party-id': 'p-ana' });
    });

    it.each(['relatedParty.id=p-x', 'relatedParty.role=Seller', 'relatedParty.name=Bob', 'relatedParty[id]=p-x', 'RelatedParty.Id=p-x', 'relatedParty=p-x', 'x.relatedParty.id=p-x'])(
        'sets the party itself and drops %s',
        async (filterOfTheClient) => {
            await call(`${prefix}/${resource}?limit=5&${filterOfTheClient}`);
            expect(sentQuery()).toEqual([
                ['limit', '5'],
                ['relatedParty.id', 'p-ana'],
                ['relatedParty.role', 'Buyer']
            ]);
        }
    );

    it('is the list of the organisation the caller acts for', async () => {
        await call(`${prefix}/${resource}?limit=5`, { headers: AS_ORGANISATION });
        expect(sentQuery().slice(-2)).toEqual([
            ['relatedParty.id', 'p-acme'],
            ['relatedParty.role', 'Buyer']
        ]);
    });

    it('is a list with no filters when it is asked for none', async () => {
        await call(`${prefix}/${resource}`);
        expect(sentQuery()).toEqual([
            ['relatedParty.id', 'p-ana'],
            ['relatedParty.role', 'Buyer']
        ]);
    });

    it('leaves the values to the upstream, whatever they are, as long as they cannot carry another parameter', async () => {
        await call(`${prefix}/${resource}?limit=abc&offset=-1&${filter}=a%20b`);
        expect(sentQuery().slice(0, 3)).toEqual([
            ['limit', 'abc'],
            ['offset', '-1'],
            [filter, 'a b']
        ]);
    });

    it.each([
        ['a value that carries another parameter', 'body=a%26relatedParty.id%3Dp-victim'],
        ['a value with a semicolon', 'status=active%3Brelatedparty.id%3Dp-victim'],
        ['a name that carries a separator', 'a%26b=1'],
        ['a name that is not a field', 'a%20b=1'],
        ['a name that starts with a digit', '1a=1'],
        ['a name that is too long', `${'a'.repeat(81)}=1`],
        ['a value that is too long', `x=${'a'.repeat(501)}`],
        ['a control character in a value', 'x=a%0Ab'],
        ['the raw query', 'q=relatedParty.id%3D%3Dp-victim'],
        ['a parameter twice', 'limit=1&limit=2'],
        ['a nested parameter', 'limit[a]=1'],
        ['too many parameters', Array.from({ length: 21 }, (_, index) => `f${index}=1`).join('&')]
    ])('refuses %s and does not call the upstream', async (_name, query) => {
        const res = await call(`${prefix}/${resource}?${query}`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Invalid query' });
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await fetch(`${url}${prefix}/${resource}`)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe.each(APIS)('$prefix/$resource/:id, one resource', ({ prefix, resource, upstream: target }) => {
    it('is given to a party related to it as a customer, and nothing else of the query is sent', async () => {
        answerWith(200, MINE);
        const res = await call(`${prefix}/${resource}/urn%3Angsi-ld%3A${resource}%3A1?fields=name&relatedParty.id=p-victim`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(JSON.parse(MINE));
        expect(upstream.seen?.url).toBe(`${target}/urn%3Angsi-ld%3A${resource}%3A1`);
    });

    it('is given to the organisation the caller acts for, and not to the individual behind it when they act as themselves', async () => {
        answerWith(200, JSON.stringify({ id: 'x', relatedParty: [{ id: 'p-acme', role: 'buyer' }] }));
        expect((await call(`${prefix}/${resource}/x`, { headers: AS_ORGANISATION })).status).toBe(200);
        expect((await call(`${prefix}/${resource}/x`)).status).toBe(403);
    });

    it.each([
        ['somebody else', JSON.stringify({ id: 'x', relatedParty: [{ id: 'p-other', role: 'Buyer' }] })],
        ['the caller as a seller', JSON.stringify({ id: 'x', relatedParty: [{ id: 'p-ana', role: 'Seller' }] })],
        ['no related parties', JSON.stringify({ id: 'x' })],
        ['related parties that are not a list', JSON.stringify({ id: 'x', relatedParty: { id: 'p-ana', role: 'Buyer' } })],
        ['a list', JSON.stringify([{ id: 'x', relatedParty: [{ id: 'p-ana', role: 'Buyer' }] }])],
        ['something that is not JSON', 'not json'],
        ['null', 'null']
    ])('is refused when the upstream answers with %s, and what it said is not leaked', async (_name, body) => {
        answerWith(200, body);
        const res = await call(`${prefix}/${resource}/x`);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: `You are not authorized to retrieve the specified ${resource} from the inventory` });
    });

    it('passes on what the upstream answers when it is not a success', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await call(`${prefix}/${resource}/x`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it.each(['..', '%2e%2e', 'a%2Fb', 'a%20b', 'a;b'])('refuses the id %s and does not call the upstream', async (id) => {
        const res = await call(`${prefix}/${resource}/${id}`);
        expect([400, 404]).toContain(res.status);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await fetch(`${url}${prefix}/${resource}/x`)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe.each(APIS)('the rest of $prefix', ({ prefix, resource }) => {
    it.each([
        ['PATCH', `/${resource}/x`],
        ['PUT', `/${resource}/x`],
        ['DELETE', `/${resource}/x`],
        ['POST', `/${resource}`],
        ['POST', `/${resource}/x`],
        ['PATCH', `/${resource}`],
        ['GET', `/${resource}/x/history`],
        ['GET', '/other'],
        ['GET', ''],
        ['GET', '/']
    ])('%s %s is not found, and nothing is written', async (method, path) => {
        const res = await call(`${prefix}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{"status":"terminated"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
