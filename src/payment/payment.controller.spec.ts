import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { useFakeLogin, LOGGED_IN } from '../testing/fake-login';
import { FakeUpstream } from '../testing/fake-upstream';
import { PaymentModule } from './payment.module';

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, PaymentModule] })
class Root {}

const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const gateway = new FakeUpstream();
let app: NestExpressApplication;
let url: string;
const seen: { url: string; authorization: string | undefined }[] = [];

const start = async (env: Record<string, string>): Promise<void> => {
    Object.assign(process.env, env);
    app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
};
const stop = async (keys: string[]): Promise<void> => {
    await app.close();
    keys.forEach((key) => delete process.env[key]);
};
const info = (headers: Record<string, string> = LOGGED_IN, path = '/paymentInfo'): Promise<Response> => fetch(`${url}${path}`, { headers });

describe('GET /paymentInfo with the DPAS gateway', () => {
    beforeAll(async () => {
        await gateway.start();
        await start({ BAE_PURCHASE__PAYMENT_PROVIDER: 'dpas', BAE_PURCHASE__PAYMENT_GATEWAY: `http://127.0.0.1:${gateway.port}/` });
    });
    afterAll(async () => {
        await stop(['BAE_PURCHASE__PAYMENT_PROVIDER', 'BAE_PURCHASE__PAYMENT_GATEWAY']);
        await gateway.stop();
    });
    beforeEach(() => {
        seen.length = 0;
        gateway.answer((res) => {
            seen.push({ url: gateway.seen?.url ?? '', authorization: gateway.seen?.headers['authorization'] });
            if (gateway.seen?.url?.includes('/count') === true) {
                res.writeHead(200, { 'content-type': 'text/plain' });
                return void res.end('2');
            }
            gateway.json(res, 200, '"tok en"');
        });
    });

    it('counts the gateways of the party of the caller and gives the address to manage them, with the token of the party', async () => {
        const res = await info();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ gatewaysCount: 2, providerUrl: `http://127.0.0.1:${gateway.port}/provider-admin/#/login?productProviderToken=tok%20en` });
        expect(seen.find((request) => request.url.includes('/count'))?.url).toBe('/api/product-providers/payment-gateways/count?productProviderExternalId=p-ana');
        expect(seen.find((request) => request.url.includes('/admin-token'))).toEqual({ url: '/api/product-providers/p-ana/admin-token', authorization: 'Bearer ana' });
    });

    it('is private', async () => {
        expect((await info({})).status).toBe(401);
        expect(seen).toEqual([]);
    });

    it('gives the address to log in with the id of the party when the gateway gives no token', async () => {
        gateway.answer((res) => {
            if (gateway.seen?.url?.includes('/count') === true) {
                return void res.end('1');
            }
            gateway.json(res, 403, '{}');
        });

        const body = (await (await info()).json()) as { gatewaysCount: number; providerUrl: string };

        expect(body).toEqual({ gatewaysCount: 1, providerUrl: `http://127.0.0.1:${gateway.port}/provider-admin/#/login?productProviderId=p-ana` });
    });

    it('is a 502 when the gateway cannot count, and never says a count of zero', async () => {
        for (const answer of [(res: import('node:http').ServerResponse) => gateway.json(res, 500, '{}'), (res: import('node:http').ServerResponse) => void res.end('many')]) {
            gateway.answer(answer);
            expect((await info()).status).toBe(502);
        }
    });

    it('closes the rest', async () => {
        expect((await info(LOGGED_IN, '/paymentInfo/other')).status).toBe(404);
    });
});

describe('GET /paymentInfo with a provider that has no gateway to manage', () => {
    beforeAll(async () => {
        await start({ BAE_PURCHASE__PAYMENT_PROVIDER: 'stripe' });
    });
    afterAll(() => stop(['BAE_PURCHASE__PAYMENT_PROVIDER']));

    it('has one gateway and nothing to manage', async () => {
        expect(await (await info()).json()).toEqual({ gatewaysCount: 1, providerUrl: null });
    });
});
