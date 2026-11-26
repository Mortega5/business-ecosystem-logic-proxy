import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ORGANISATION, LOGGED_IN, useFakeLogin } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { BillingModule } from './billing.module';

const tmforum = new FakeUpstream();
const engine = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, BillingModule] })
class Root {}

const JSON_HEADERS = { 'content-type': 'application/json' };
const PREFERRED = { id: 'acc-1', relatedParty: [{ id: 'p-ana' }], contact: [{ contactMedium: [{ mediumType: 'PostalAddress', preferred: true }] }] };

let app: NestExpressApplication;
let url: string;
let tmforumPaths: string[];
let answers: Record<string, { status: number; body: unknown }>;

const order = (extra: Record<string, unknown> = {}, items: string[] = ['o-1']) =>
    JSON.stringify({ productOrder: { productOrderItem: items.map((id) => ({ productOffering: { id } })), ...extra } });
const price = (body: string, headers: Record<string, string> = LOGGED_IN) => fetch(`${url}/billing/order`, { method: 'POST', headers: { ...headers, ...JSON_HEADERS }, body });
const sent = (): Record<string, unknown> => JSON.parse(engine.seen?.body ?? '{}') as Record<string, unknown>;

beforeAll(async () => {
    await tmforum.start();
    await engine.start();
    Object.assign(process.env, {
        BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1',
        BAE_UPSTREAMS__TMFORUM__PORT: String(tmforum.port),
        BAE_UPSTREAMS__BILLING_ENGINE__HOST: '127.0.0.1',
        BAE_UPSTREAMS__BILLING_ENGINE__PORT: String(engine.port),
        BAE_UPSTREAMS__BILLING_ENGINE__PATH: '/preview'
    });
    app = await createApp(Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    await tmforum.stop();
    await engine.stop();
});

beforeEach(() => {
    tmforum.reset();
    engine.reset();
    tmforumPaths = [];
    answers = {
        '/productOffering/o-1': { status: 200, body: { id: 'o-1', productSpecification: { id: 's-1' } } },
        '/productOffering/o-2': { status: 200, body: { id: 'o-2', productSpecification: { id: 's-2' } } },
        '/productSpecification/s-1': { status: 200, body: { relatedParty: [{ id: 'p-shop', role: 'Seller' }, { id: 'p-owner', role: 'Owner' }] } },
        '/productSpecification/s-2': { status: 200, body: { relatedParty: [{ id: 'p-shop', role: 'seller' }, { id: 'p-other', role: 'Seller' }] } },
        '/billingAccount/acc-1': { status: 200, body: PREFERRED },
        '/billingAccount/acc-other': { status: 200, body: { id: 'acc-other', relatedParty: [{ id: 'p-victim' }] } },
        '/billingAccount?relatedParty.id=p-ana': { status: 200, body: [{ id: 'acc-0', contact: [] }, PREFERRED] }
    };
    tmforum.answer((res) => {
        const path = (res.req.url ?? '').replace(/^\/tmf-api\/[A-Za-z]+\/v4/, '');
        tmforumPaths.push(path);
        const found = answers[path];
        tmforum.json(res, found?.status ?? 404, JSON.stringify(found?.body ?? {}));
    });
    engine.answer((res) => engine.json(res, 200, '{"price":"10"}'));
});

describe('POST /billing/order', () => {
    it('prices the order with the caller as the customer and the sellers of its offerings, once each', async () => {
        const res = await price(order({ relatedParty: [{ id: 'p-victim', role: 'Customer' }] }, ['o-1', 'o-2', 'o-1']));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ price: '10' });
        expect(engine.seen?.url).toBe('/preview');
        const { productOrder } = sent() as { productOrder: { relatedParty: unknown[]; productOrderItem: unknown[] } };
        expect(productOrder.relatedParty).toEqual([
            { id: 'p-ana', role: 'Buyer', href: 'p-ana', '@referredType': 'organization' },
            { id: 'p-shop', role: 'Seller', href: 'p-shop', '@referredType': 'organization' },
            { id: 'p-other', role: 'Seller', href: 'p-other', '@referredType': 'organization' }
        ]);
        expect(productOrder.productOrderItem).toHaveLength(3);
        expect(tmforumPaths.filter((path) => path === '/productOffering/o-1')).toHaveLength(1);
    });

    it('does not send the credentials of the user to the engine', async () => {
        await price(order());
        expect(engine.seen?.headers['authorization']).toBeUndefined();
        expect(engine.seen?.headers['cookie']).toBeUndefined();
    });

    it('uses the account of the caller that the order names, and sends it resolved', async () => {
        await price(order({ billingAccount: { id: 'acc-1' } }));
        expect((sent() as { productOrder: { billingAccount: unknown } }).productOrder.billingAccount).toEqual({ id: 'acc-1', resolved: PREFERRED });
    });

    it('refuses an account of somebody else, also when the caller acts for an organisation', async () => {
        for (const headers of [LOGGED_IN, AS_ORGANISATION]) {
            const res = await price(order({ billingAccount: { id: 'acc-other' } }), headers);
            expect(res.status).toBe(403);
        }
        expect(engine.seen).toBeUndefined();
    });

    it('refuses an account that does not exist', async () => {
        expect((await price(order({ billingAccount: { id: 'acc-none' } }))).status).toBe(400);
        expect(engine.seen).toBeUndefined();
    });

    it('takes the preferred account of the caller when the order names none, or none when they have no postal address', async () => {
        await price(order());
        expect((sent() as { productOrder: { billingAccount: unknown } }).productOrder.billingAccount).toEqual({ resolved: PREFERRED });
        answers['/billingAccount?relatedParty.id=p-ana'] = { status: 200, body: [] };
        await price(order());
        expect((sent() as { productOrder: { billingAccount: unknown } }).productOrder.billingAccount).toEqual({ resolved: null });
    });

    it('refuses the order when an offering, or the specification of one, cannot be read', async () => {
        expect((await price(order({}, ['o-1', 'o-none']))).status).toBe(400);
        answers['/productSpecification/s-2'] = { status: 404, body: {} };
        expect((await price(order({}, ['o-2']))).status).toBe(400);
        expect(engine.seen).toBeUndefined();
    });

    it.each([
        ['is not an object', '[]'],
        ['has no productOrder', '{}'],
        ['has no items', JSON.stringify({ productOrder: { productOrderItem: [] } })],
        ['has an item without offering', JSON.stringify({ productOrder: { productOrderItem: [{}] } })],
        ['has an offering id that is not an id', JSON.stringify({ productOrder: { productOrderItem: [{ productOffering: { id: '../x?y' } }] } })],
        ['has a billing account id that is not an id', order({ billingAccount: { id: 'a/b' } })]
    ])('refuses an order that %s', async (_name, body) => {
        expect((await price(body)).status).toBe(400);
        expect(tmforum.seen).toBeUndefined();
        expect(engine.seen).toBeUndefined();
    });

    it('does not pass on the error of the engine, but does tell the caller that the order is wrong', async () => {
        engine.answer((res) => engine.json(res, 500, '{"trace":"secret"}'));
        const failed = await price(order());
        expect(failed.status).toBe(502);
        expect(await failed.text()).not.toContain('secret');
        engine.answer((res) => engine.json(res, 422, '{"error":"no price plan"}'));
        const refused = await price(order());
        expect(refused.status).toBe(422);
        expect(await refused.json()).toEqual({ error: 'no price plan' });
    });

    it('asks for a login', async () => {
        const res = await fetch(`${url}/billing/order`, { method: 'POST', headers: JSON_HEADERS, body: order() });
        expect(res.status).toBe(401);
        expect(engine.seen).toBeUndefined();
    });

    it('leaves orderRaw closed', async () => {
        const res = await fetch(`${url}/billing/orderRaw`, { method: 'POST', headers: { ...LOGGED_IN, ...JSON_HEADERS }, body: '{}' });
        expect(res.status).toBe(404);
        expect(engine.seen).toBeUndefined();
    });
});
