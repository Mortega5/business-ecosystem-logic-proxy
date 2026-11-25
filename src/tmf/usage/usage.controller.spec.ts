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
import { UsageModule } from './usage.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, UsageModule] })
class Root {}

// The legacy application answers anything under /usage
const legacy = express();
legacy.all('/usage/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

const USAGE_API = '/tmf-api/usageManagement/v4/usageSpecification';
const PRICES = '/tmf-api/productCatalogManagement/v4/productOfferingPrice';
const OFFERS = '/tmf-api/productCatalogManagement/v4/productOffering';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const spec = (extra: object = {}) => JSON.stringify({ id: 'u-1', name: 'Calls', lifecycleStatus: 'Launched', relatedParty: [SELLER], ...extra });

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
// What the upstreams say: the usage spec that is read, what a write answers, the list by offset, and the prices and offers of the catalog
let current: Reply;
let written: Reply;
let prices: (query: URLSearchParams) => Reply;
let offers: Reply;

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
    current = { status: 200, body: spec() };
    written = { status: 200, body: spec({ name: 'Changed' }) };
    prices = () => ({ status: 200, body: '[]' });
    offers = { status: 200, body: '[]' };
    upstream.answer((res) => {
        const request = upstream.seen as Seen;
        seen.push({ method: request.method, url: request.url, body: request.body });
        const target = new URL(`http://x${request.url ?? ''}`);
        let reply = written;
        if (target.pathname === PRICES) {
            reply = prices(target.searchParams);
        } else if (target.pathname === OFFERS) {
            reply = offers;
        } else if (request.method === 'GET') {
            reply = current;
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const seller = (extra: Record<string, string> = JSON_HEADERS) => ({ ...AS_SELLER, ...extra });
const sentTo = (method: string): Seen | undefined => seen.find((request) => request.method === method && request.url?.startsWith(USAGE_API) === true);
const sentQuery = (index = 0): [string, string][] => [...new URL(`http://x${seen[index]?.url ?? ''}`).searchParams.entries()];

describe('GET /usage/usageSpecification, the list', () => {
    it('is the list of the seller: every filter goes on, then the party and its role', async () => {
        const res = await call('/usage/usageSpecification?limit=6&offset=0&lifecycleStatus=Active,Launched&sort=-lastUpdate&relatedParty.id=p-victim', { headers: AS_SELLER });

        expect(res.status).toBe(200);
        expect(sentQuery()).toEqual([
            ['limit', '6'],
            ['offset', '0'],
            ['lifecycleStatus', 'Active,Launched'],
            ['sort', '-lastUpdate'],
            ['relatedParty.id', 'p-shop'],
            ['relatedParty.role', 'Seller']
        ]);
    });

    it('is private', async () => {
        expect((await call('/usage/usageSpecification')).status).toBe(401);
        expect(seen).toEqual([]);
    });
});

describe('POST /usage/usageSpecification', () => {
    it('is made by a seller for themselves, with the time of the change', async () => {
        const res = await call('/usage/usageSpecification', { method: 'POST', headers: seller(), body: JSON.stringify({ name: 'Calls', relatedParty: [SELLER], id: 'forged' }) });

        expect(res.status).toBe(200);
        const sent = JSON.parse(sentTo('POST')?.body ?? '{}') as { name?: string; id?: string; lastUpdate: string };
        expect(sent).toMatchObject({ name: 'Calls' });
        expect(sent.id).toBeUndefined();
        expect(Number.isNaN(Date.parse(sent.lastUpdate))).toBe(false);
    });

    it('is refused to who is not a seller, and for another party', async () => {
        const body = JSON.stringify({ name: 'Calls', relatedParty: [SELLER] });
        const other = JSON.stringify({ name: 'Calls', relatedParty: [{ id: 'p-other', role: 'Seller' }] });

        expect((await call('/usage/usageSpecification', { method: 'POST', headers: { ...LOGGED_IN, ...JSON_HEADERS }, body })).status).toBe(403);
        expect((await call('/usage/usageSpecification', { method: 'POST', headers: seller(), body: other })).status).toBe(403);
        expect((await call('/usage/usageSpecification', { method: 'POST', headers: seller(), body: 'not json' })).status).toBe(400);
        expect(seen).toEqual([]);
    });
});

describe('PATCH /usage/usageSpecification/:id', () => {
    it('changes the usage spec of the seller, with the time of the change', async () => {
        const res = await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: JSON.stringify({ name: 'Changed' }) });

        expect(res.status).toBe(200);
        expect(JSON.parse(sentTo('PATCH')?.body ?? '{}')).toMatchObject({ name: 'Changed' });
        expect((JSON.parse(sentTo('PATCH')?.body ?? '{}') as { lastUpdate?: string }).lastUpdate).toBeTruthy();
    });

    it('is refused when it is not the usage spec of the seller, or it does not exist', async () => {
        current = { status: 200, body: spec({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }) };
        expect((await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{}' })).status).toBe(403);
        current = { status: 404, body: '{}' };
        expect((await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{}' })).status).toBe(404);
        expect(sentTo('PATCH')).toBeUndefined();
    });

    it('does not change who owns it, and follows the lifecycle', async () => {
        const owner = JSON.stringify({ relatedParty: [{ id: 'p-other', role: 'Seller' }] });

        expect((await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: owner })).status).toBe(409);
        expect((await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{"lifecycleStatus":"Active"}' })).status).toBe(400);
    });

    it('retires when no offer that is alive charges for it, through a price or the plan that bundles it', async () => {
        prices = (query) =>
            query.has('usageSpecId')
                ? { status: 200, body: JSON.stringify([{ id: 'price-1', isBundle: false }]) }
                : { status: 200, body: JSON.stringify([{ id: 'plan-1', isBundle: true }, { id: 'plan-2', isBundle: false }]) };
        offers = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Retired' }, { id: 'o-2', lifecycleStatus: 'Obsolete' }]) };

        const res = await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{"lifecycleStatus":"Retired"}' });

        expect(res.status).toBe(200);
        const asked = seen.filter((request) => new URL(`http://x${request.url ?? ''}`).pathname === OFFERS);
        expect(asked).toHaveLength(1);
        expect(new URL(`http://x${asked[0]?.url ?? ''}`).searchParams.get('productOfferingPrice.id')).toBe('plan-1');
    });

    it('looks for the plans of all its prices with one query', async () => {
        prices = (query) =>
            query.has('usageSpecId')
                ? { status: 200, body: JSON.stringify([{ id: 'price-1', isBundle: false }, { id: 'price-2', isBundle: false }, { id: 'plan-0', isBundle: true }]) }
                : { status: 200, body: '[]' };

        await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{"lifecycleStatus":"Retired"}' });

        const plans = seen.map((request) => new URL(`http://x${request.url ?? ''}`)).filter((target) => target.searchParams.has('bundledPopRelationship.id'));
        expect(plans).toHaveLength(1);
        expect(plans[0]?.searchParams.get('bundledPopRelationship.id')).toBe('price-1,price-2');
    });

    it('is not retired while an offer that is alive charges for it', async () => {
        prices = (query) => ({ status: 200, body: JSON.stringify(query.has('usageSpecId') ? [{ id: 'plan-1', isBundle: true }] : []) });
        offers = { status: 200, body: JSON.stringify([{ id: 'o-1', lifecycleStatus: 'Launched' }]) };

        const res = await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{"lifecycleStatus":"Retired"}' });

        expect(res.status).toBe(409);
        expect(sentTo('PATCH')).toBeUndefined();
    });

    it('is not retired when the catalog cannot be read, and the client is told', async () => {
        prices = () => ({ status: 500, body: '{}' });

        const res = await call('/usage/usageSpecification/u-1', { method: 'PATCH', headers: seller(), body: '{"lifecycleStatus":"Retired"}' });

        expect(res.status).toBe(502);
        expect(sentTo('PATCH')).toBeUndefined();
    });
});

describe('what the portal does not use', () => {
    it('is closed: the delete of a usage spec, its read and the usage records', async () => {
        const closed: [string, string][] = [['DELETE', '/usage/usageSpecification/u-1'], ['GET', '/usage/usageSpecification/u-1'], ['GET', '/usage/usage'], ['POST', '/usage/usage'], ['GET', '/usage']];
        for (const [method, path] of closed) {
            expect((await call(path, { method, headers: seller() })).status).toBe(404);
        }
        expect(seen).toEqual([]);
    });
});
