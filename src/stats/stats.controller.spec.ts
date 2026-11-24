import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LegacyAuthBridge } from '../legacy/legacy-auth.bridge';
import { LoggingModule } from '../logging/logging.module';
import { AS_ADMIN, AS_ORGANISATION, fakeLogin, LOGGED_IN } from '../testing/fake-login';
import { FakeStatsModule, statsStore } from '../testing/fake-stats';
import { FakeUpstream } from '../testing/fake-upstream';

const upstream = new FakeUpstream();

const store = statsStore;

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeStatsModule] })
class Root {}

// The legacy application answers anything else
const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

let app: NestExpressApplication;
let url: string;
let paths: string[];

const call = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> => fetch(`${url}${path}`, { method, headers });
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 50));
};

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
    paths = [];
    store.kept = undefined;
    upstream.answer((res) => {
        const request = new URL(`http://x${upstream.seen?.url ?? ''}`);
        paths.push(`${request.pathname}${request.search}`);
        if (request.searchParams.get('relatedParty.id') !== null) {
            return upstream.json(res, 200, JSON.stringify([{ lifecycleStatus: 'launched' }, { lifecycleStatus: 'Active' }, { lifecycleStatus: 'Draft' }, {}]));
        }
        if (request.pathname.endsWith('/productOffering')) {
            return upstream.json(res, 200, JSON.stringify([
                { name: 'Offer A', relatedParty: [{ id: 'p-acme', role: 'Seller' }, { id: 'p-buyer', role: 'Buyer' }] },
                { name: 'Offer B', relatedParty: [{ id: 'p-acme', role: 'seller' }] }
            ]));
        }
        if (request.pathname.endsWith('/organization')) {
            return upstream.json(res, 200, JSON.stringify([{ id: 'p-acme', tradingName: 'Acme' }]));
        }
        return upstream.json(res, 200, '[]');
    });
});

describe('GET /stats', () => {
    it('is public, answers empty lists the first time and reads the figures in the background', async () => {
        const first = await call('/stats');

        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ services: [], organizations: [] });
        await settle();
        expect(paths.some((path) => path.includes('/productOffering') && path.includes('lifecycleStatus=Launched'))).toBe(true);
        expect(await (await call('/stats')).json()).toEqual({ services: ['Offer A', 'Offer B'], organizations: ['Acme'] });
    });

    it('asks for the organisations that sell, once each, and none of the buyers', async () => {
        await call('/stats');
        await settle();

        const organizations = paths.find((path) => path.includes('/organization')) ?? '';
        expect(new URL(`http://x${organizations}`).searchParams.get('id')).toBe('p-acme');
    });

    it('is not asked to read again while the figures are young', async () => {
        await call('/stats');
        await settle();
        paths = [];

        await call('/stats');
        await settle();
        expect(paths).toEqual([]);
    });

    it('closes the rest of /stats, for who is logged in, and asks for the login of the others', async () => {
        expect((await call('/stats/other', LOGGED_IN)).status).toBe(404);
        expect((await call('/stats', LOGGED_IN, 'POST')).status).toBe(404);
        expect((await call('/stats/other')).status).toBe(401);
    });
});

describe('GET /stats/provider/:organizationId', () => {
    it('is private', async () => {
        expect((await call('/stats/provider/p-acme')).status).toBe(401);
        expect(paths).toEqual([]);
    });

    it('is not for the member of another organisation', async () => {
        expect((await call('/stats/provider/p-other', LOGGED_IN)).status).toBe(403);
        expect(paths).toEqual([]);
    });

    it('counts the lifecycle status of the six collections of the organisation, in either case, for its own members', async () => {
        const res = await call('/stats/provider/p-acme', AS_ORGANISATION);

        expect(res.status).toBe(200);
        const counts = { Active: 1, Launched: 1, Retired: 0, Obsolete: 0 };
        expect(await res.json()).toEqual({ productOffering: counts, catalog: counts, productSpecification: counts, serviceSpecification: counts, resourceSpecification: counts, usageSpecification: counts });
        expect(paths).toHaveLength(6);
    });

    it('is for an administrator, for any organisation, and is kept for a while', async () => {
        expect((await call('/stats/provider/p-other', AS_ADMIN)).status).toBe(200);
        paths = [];
        expect((await call('/stats/provider/p-other', AS_ADMIN)).status).toBe(200);
        expect(paths).toEqual([]);
    });

    it('refuses an id that is not one', async () => {
        expect((await call('/stats/provider/..%2Fx', AS_ADMIN)).status).toBe(400);
    });

    it('is a 502 when one of the APIs does not answer', async () => {
        upstream.answer((res) => upstream.json(res, 500, '{}'));

        expect((await call('/stats/provider/p-fail', AS_ADMIN)).status).toBe(502);
    });
});
