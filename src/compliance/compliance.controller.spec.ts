import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { FeatureGuard } from '../features/feature.guard';
import { LoggingModule } from '../logging/logging.module';
import { FakeFeaturesModule, featuresOn } from '../testing/fake-features';
import { AS_ADMIN, AS_SELLER, LOGGED_IN, useFakeLogin } from '../testing/fake-login';
import { FakeUpstream } from '../testing/fake-upstream';
import { ComplianceModule } from './compliance.module';

@Module({
    imports: [AppConfigModule, LoggingModule, FakeFeaturesModule, AuthModule, ComplianceModule],
    providers: [{ provide: APP_GUARD, useClass: FeatureGuard }]
})
class Root {}

const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const tmforum = new FakeUpstream();
const compliance = new FakeUpstream();
const SPEC_ID = 'urn:ngsi-ld:product-specification:7a1c0f3e';
const credential = jwt.sign({ vc: {} }, 'secret');
const json = { 'content-type': 'application/json' };
const KEYS = [
    'BAE_UPSTREAMS__TMFORUM__HOST',
    'BAE_UPSTREAMS__TMFORUM__PORT',
    'BAE_COMPLIANCE__SERVER_URL'
];

let seen: { method?: string, url?: string, body: string }[] = [];
let stored: Record<string, unknown>;
const apps: NestExpressApplication[] = [];

const serve = async (env: Record<string, string> = {}): Promise<string> => {
    Object.assign(process.env, {
        BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1',
        BAE_UPSTREAMS__TMFORUM__PORT: String(tmforum.port),
        BAE_COMPLIANCE__SERVER_URL: `http://127.0.0.1:${compliance.port}`,
        ...env
    });
    const app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    apps.push(app);
    return app.getUrl();
};

let url: string;

beforeAll(async () => {
    await tmforum.start();
    await compliance.start();
    url = await serve();
});
afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    KEYS.forEach((key) => delete process.env[key]);
    await tmforum.stop();
    await compliance.stop();
});
beforeEach(() => {
    featuresOn.add('compliance');
    seen = [];
    stored = {
        id: SPEC_ID,
        name: 'Dataset',
        version: '1',
        relatedParty: [{ id: 'p-shop', role: 'Seller' }],
        productSpecCharacteristic: [{ name: 'Other', productSpecCharacteristicValue: [{ value: 'x' }] }]
    };
    tmforum.answer((res) => {
        const request = tmforum.seen;
        seen.push({
            ...(request?.method === undefined ? {} : { method: request.method }),
            ...(request?.url === undefined ? {} : { url: request.url }),
            body: request?.body ?? ''
        });
        if (/\/productSpecification\//.test(request?.url ?? '')) {
            return tmforum.json(res, 200, JSON.stringify(stored));
        }
        if (/\/organization\//.test(request?.url ?? '')) {
            return tmforum.json(
                res,
                200,
                JSON.stringify({
                    tradingName: 'Shop',
                    externalReference: [{ externalReferenceType: 'idm_id', name: 'VATES-1' }]
                })
            );
        }
        tmforum.json(res, 404, '{}');
    });
    compliance.reset();
    compliance.answer((res) => compliance.json(res, 200, JSON.stringify({ certificate: 'issued' })));
});

const certificate = (headers: Record<string, string> = AS_SELLER, base = url, id = SPEC_ID) =>
    fetch(`${base}/compliance/certificate`, {
        method: 'POST',
        headers: { ...json, ...headers },
        body: JSON.stringify({ id })
    });
const upload = (
    headers: Record<string, string> = AS_ADMIN,
    body: unknown = { vc: credential },
    base = url,
    id = SPEC_ID
) =>
    fetch(`${base}/admin/uploadcertificate/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...json, ...headers },
        body: JSON.stringify(body)
    });

describe('POST /compliance/certificate', () => {
    it('asks the compliance service for the certificate of the product of the seller and gives its answer', async () => {
        const res = await certificate();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ certificate: 'issued' });
        expect(compliance.seen?.url).toBe('/api/v1/product-offering/certificate');
        expect(compliance.seen?.body).toContain('name="service_name"\r\n\r\nDataset');
        expect(compliance.seen?.body).toContain('name="organization_name"\r\n\r\nShop');
    });

    it('is for logged in sellers of the product', async () => {
        expect((await certificate({})).status).toBe(401);
        expect((await certificate(LOGGED_IN)).status).toBe(403);
        stored['relatedParty'] = [{ id: 'p-other', role: 'Seller' }];
        expect((await certificate()).status).toBe(403);
        expect(compliance.seen).toBeUndefined();
    });

    it('refuses an id that cannot be one, and a body that is not an object', async () => {
        expect((await certificate(AS_SELLER, url, '../admin')).status).toBe(400);
        const wrong = await fetch(`${url}/compliance/certificate`, {
            method: 'POST',
            headers: { ...json, ...AS_SELLER },
            body: 'not json'
        });
        expect(wrong.status).toBe(400);
    });

    it('closes everything else under /compliance', async () => {
        expect((await fetch(`${url}/compliance/other`, { headers: AS_SELLER })).status).toBe(404);
        expect((await fetch(`${url}/compliance/certificate`, { headers: AS_SELLER })).status).toBe(404);
    });
});

describe('PATCH /admin/uploadcertificate/:specId', () => {
    it('puts the credential in the product for an administrator', async () => {
        const res = await upload();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: SPEC_ID });
        const patch = seen.find((request) => request.method === 'PATCH');
        expect(patch?.url).toContain(`/productSpecification/${encodeURIComponent(SPEC_ID)}`);
        expect(
            JSON.parse(patch?.body ?? '{}').productSpecCharacteristic.map(
                (characteristic: { name: string }) => characteristic.name
            )
        ).toEqual(['Other', 'Compliance:VC']);
    });

    it('is not for a seller or a buyer, nor for who is not logged in', async () => {
        expect((await upload(AS_SELLER)).status).toBe(403);
        expect((await upload(LOGGED_IN)).status).toBe(403);
        expect((await upload({})).status).toBe(401);
        expect(seen.some((request) => request.method === 'PATCH')).toBe(false);
    });

    it('refuses a credential that is not there or is not a signed token, and an id that cannot be one', async () => {
        expect((await upload(AS_ADMIN, {})).status).toBe(400);
        expect((await upload(AS_ADMIN, { vc: 'text' })).status).toBe(422);
        expect((await upload(AS_ADMIN, { vc: credential }, url, '../x')).status).toBe(400);
    });

    it('closes the rest of its prefix and leaves the other admin routes to who serves them', async () => {
        expect((await fetch(`${url}/admin/uploadcertificate/${SPEC_ID}/extra`, { headers: AS_ADMIN })).status).toBe(
            404
        );
        const other = await fetch(`${url}/admin/somethingelse`, { headers: AS_ADMIN });
        expect(await other.json()).toEqual({ from: 'legacy' });
    });
});

describe('with the compliance feature off', () => {
    it('has none of these routes, and does not depend on the DOME extension', async () => {
        featuresOn.clear();
        expect((await certificate(AS_SELLER)).status).toBe(404);
        expect((await upload(AS_ADMIN, { vc: credential })).status).toBe(404);
        expect(compliance.seen).toBeUndefined();
    });
});

afterEach(() => featuresOn.clear());
