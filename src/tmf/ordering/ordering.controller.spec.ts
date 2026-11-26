import { Logger, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_SELLER, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { OrderingModule } from './ordering.module';

// One server stands for the TMForum APIs and for the charging backend
const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, OrderingModule] })
class Root {}

const ORDERING = '/tmf-api/productOrderingManagement/v4/productOrder';
const CATALOG = '/tmf-api/productCatalogManagement/v4';
const ACCOUNT = '/tmf-api/accountManagement/v4/billingAccount';
const PARTY = '/tmf-api/party/v4';
const CHARGING = '/charging/api/orderManagement/orders';
const JSON_HEADERS = { 'content-type': 'application/json' };
const ANA = { id: 'p-ana', role: 'Buyer' };
const SHOP = { id: 'p-shop', role: 'Seller' };
const OTHER = { id: 'p-other', role: 'Seller' };

interface Reply {
    status: number;
    body: string;
}
interface Seen {
    method: string | undefined;
    path: string;
    search: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
}

const item = (id: string, seller: object, state = 'acknowledged') => ({ id, state, action: 'add', productOffering: { id: 'o-1' }, product: { relatedParty: [seller] } });
const order = (extra: object = {}) =>
    JSON.stringify({
        id: 'urn:ngsi-ld:product-order:1',
        orderDate: '2026-11-01T00:00:00.000Z',
        state: 'acknowledged',
        relatedParty: [SHOP, OTHER, ANA],
        productOrderItem: [item('i-1', SHOP), item('i-2', OTHER)],
        note: [],
        ...extra
    });
const NEW_ORDER = (extra: object = {}) =>
    JSON.stringify({ relatedParty: [ANA], billingAccount: { id: 'ba-1', href: 'forged' }, priority: '4', productOrderItem: [{ id: 'i-1', action: 'add', productOffering: { id: 'o-1' }, product: {} }], ...extra });

let app: NestExpressApplication;
let url: string;
let seen: Seen[];
// What the upstreams say
let current: Reply; // the order that is read
let written: Reply; // what a write to the ordering API answers
let offering: Reply;
let bundled: Reply; // the offering o-2, which a bundle has
let specification: Reply;
let account: Reply;
let list: Reply;
let charging: (path: string) => Reply;

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, {
        BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1',
        BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port),
        BAE_UPSTREAMS__CHARGING__HOST: '127.0.0.1',
        BAE_UPSTREAMS__CHARGING__PORT: String(upstream.port)
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
    current = { status: 200, body: order() };
    written = { status: 200, body: order() };
    offering = { status: 200, body: JSON.stringify({ id: 'o-1', relatedParty: [SHOP, { id: 'p-shop', role: 'SellerOperator' }] }) };
    bundled = { status: 200, body: JSON.stringify({ relatedParty: [SHOP] }) };
    specification = { status: 200, body: JSON.stringify({ relatedParty: [SHOP] }) };
    account = { status: 200, body: JSON.stringify({ id: 'ba-1', relatedParty: [{ id: 'p-ana', role: 'Seller' }] }) };
    list = { status: 200, body: '[]' };
    charging = () => ({ status: 200, body: '{}' });
    upstream.answer((res) => {
        const request = upstream.seen;
        const target = new URL(`http://x${request?.url ?? ''}`);
        seen.push({ method: request?.method, path: target.pathname, search: target.search, body: request?.body ?? '', headers: request?.headers ?? {} });
        let reply: Reply = { status: 404, body: '{}' };
        if (target.pathname.startsWith(CHARGING)) {
            reply = charging(target.pathname);
        } else if (target.pathname === ORDERING) {
            reply = request?.method === 'GET' ? list : written;
        } else if (target.pathname.startsWith(`${ORDERING}/`)) {
            reply = request?.method === 'GET' ? current : written;
        } else if (target.pathname.startsWith(`${CATALOG}/productOffering/`)) {
            reply = target.pathname.endsWith('/o-2') ? bundled : offering;
        } else if (target.pathname.startsWith(`${CATALOG}/productSpecification/`)) {
            reply = specification;
        } else if (target.pathname.startsWith(ACCOUNT)) {
            reply = account;
        } else if (target.pathname.startsWith(`${PARTY}/`)) {
            reply = { status: 200, body: JSON.stringify({ externalReference: [{ externalReferenceType: 'idm_id', name: 'shop-idm' }] }) };
        }
        upstream.json(res, reply.status, reply.body);
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const ana = (extra: Record<string, string> = JSON_HEADERS) => ({ ...LOGGED_IN, ...extra });
const seller = (extra: Record<string, string> = JSON_HEADERS) => ({ ...AS_SELLER, ...extra });
const sentTo = (method: string, path: string): Seen | undefined => seen.find((request) => request.method === method && request.path.startsWith(path));
const bodyOf = (request: Seen | undefined): Record<string, unknown> => JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
const ID = 'urn:ngsi-ld:product-order:1';
const post = (headers: Record<string, string>, body = NEW_ORDER()) => call('/ordering/productOrder', { method: 'POST', headers, body });
const patch = (headers: Record<string, string>, body: object) => call(`/ordering/productOrder/${ID}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

describe('GET /ordering/productOrder, the list', () => {
    it('is the list of the caller as a customer: every filter goes on, then the party and its role, whatever the client said', async () => {
        const res = await call('/ordering/productOrder?limit=6&offset=0&state=acknowledged,completed&sort=-orderDate&relatedParty.id=p-victim&relatedParty.role=Anything', { headers: LOGGED_IN });

        expect(res.status).toBe(200);
        expect([...new URLSearchParams(seen[0]?.search).entries()]).toEqual([
            ['limit', '6'],
            ['offset', '0'],
            ['state', 'acknowledged,completed'],
            ['sort', '-orderDate'],
            ['relatedParty.id', 'p-ana'],
            ['relatedParty.role', 'Buyer']
        ]);
    });

    it('is the list as a seller when the client asks for that role', async () => {
        await call('/ordering/productOrder?relatedParty.role=seller', { headers: AS_SELLER });

        expect([...new URLSearchParams(seen[0]?.search).entries()].slice(-2)).toEqual([
            ['relatedParty.id', 'p-shop'],
            ['relatedParty.role', 'Seller']
        ]);
    });

    it('asks the API for the newest orders first when the client asks for no order', async () => {
        await call('/ordering/productOrder?limit=5', { headers: LOGGED_IN });
        expect([...new URLSearchParams(seen[0]?.search).entries()]).toEqual([
            ['limit', '5'],
            ['sort', '-orderDate'],
            ['relatedParty.id', 'p-ana'],
            ['relatedParty.role', 'Buyer']
        ]);
    });

    it('gives a seller the items that are theirs, in the order of the API, and nothing of an order they are not in', async () => {
        list = {
            status: 200,
            body: JSON.stringify([
                JSON.parse(order({ id: 'new', orderDate: '2026-06-01T00:00:00.000Z' })),
                JSON.parse(order({ id: 'old', orderDate: '2026-01-01T00:00:00.000Z' })),
                JSON.parse(order({ id: 'not-mine', relatedParty: [OTHER, ANA] }))
            ])
        };

        const res = await call('/ordering/productOrder?relatedParty.role=Seller', { headers: AS_SELLER });
        const orders = (await res.json()) as { id: string; productOrderItem: { id: string }[] }[];

        expect(orders.map((o) => o.id)).toEqual(['new', 'old']);
        expect(orders[0]?.productOrderItem.map((i) => i.id)).toEqual(['i-1']);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
    });

    it('is private, and tells the client when the API cannot be read', async () => {
        expect((await call('/ordering/productOrder')).status).toBe(401);
        list = { status: 200, body: 'not json' };
        expect((await call('/ordering/productOrder', { headers: LOGGED_IN })).status).toBe(502);
    });
});

describe('GET /ordering/productOrder/:id', () => {
    it('gives the customer the whole order, with the notes in order', async () => {
        current = { status: 200, body: order({ note: [{ date: '2026-02-01' }, { date: '2026-01-01' }] }) };

        const res = await call(`/ordering/productOrder/${ID}`, { headers: LOGGED_IN });
        const body = (await res.json()) as { productOrderItem: unknown[]; note: { date: string }[] };

        expect(body.productOrderItem).toHaveLength(2);
        expect(body.note.map((n) => n.date)).toEqual(['2026-01-01', '2026-02-01']);
    });

    it('gives a seller the items that are theirs, and nobody else the order', async () => {
        const mine = (await (await call(`/ordering/productOrder/${ID}`, { headers: AS_SELLER })).json()) as { productOrderItem: { id: string }[] };
        current = { status: 200, body: order({ relatedParty: [OTHER] }) };

        expect(mine.productOrderItem.map((i) => i.id)).toEqual(['i-1']);
        expect((await call(`/ordering/productOrder/${ID}`, { headers: LOGGED_IN })).status).toBe(403);
    });

    it('answers what the API answers when it fails, and refuses an id that is not one', async () => {
        current = { status: 404, body: '{"error":"no"}' };

        expect((await call(`/ordering/productOrder/${ID}`, { headers: LOGGED_IN })).status).toBe(404);
        expect((await call('/ordering/productOrder/a%20b', { headers: LOGGED_IN })).status).toBe(400);
    });
});

describe('POST /ordering/productOrder', () => {
    it('is made with the parties that the proxy finds, never the ones the client sent', async () => {
        const res = await post({ ...ana(), 'x-terms-accepted': 'true' }, NEW_ORDER({ id: 'forged', state: 'completed', note: [{ text: 'x' }] }));

        expect(res.status).toBe(200);
        const sent = bodyOf(sentTo('POST', ORDERING));
        expect(sent['relatedParty']).toEqual([
            { id: 'p-shop', href: 'p-shop', name: 'shop-idm', role: 'Seller', '@referredType': 'Individual' },
            { id: 'p-ana', href: 'p-ana', name: 'u-ana', role: 'Buyer', '@referredType': 'Individual' }
        ]);
        expect(sent['billingAccount']).toEqual({ id: 'ba-1', href: 'ba-1' });
        expect(sent['id']).toBeUndefined();
        expect(sent['state']).toBeUndefined();
        expect(sent['note']).toBeUndefined();
        const [product] = (sent['productOrderItem'] as { product: { relatedParty: Record<string, unknown>[] } }[]).map((i) => i.product);
        expect(product?.relatedParty.map((p) => [p['id'], p['role']])).toEqual([['p-ana', 'Buyer'], ['p-shop', 'Seller']]);
        expect(product?.relatedParty[0]?.['href']).toMatch(/\/party\/individual\/p-ana$/);
    });

    it('tells the charging backend about it with the terms that were accepted, and gives the buyer where to pay', async () => {
        charging = () => ({ status: 200, body: '{"redirectUrl":"https://pay.example.org/1"}' });
        const res = await post({ ...ana(), 'x-terms-accepted': 'TRUE' });

        expect(res.headers.get('x-redirect-url')).toBe('https://pay.example.org/1');
        const notified = sentTo('POST', CHARGING);
        expect(notified?.headers['x-terms-accepted']).toBe('True');
        expect(bodyOf(notified)['id']).toBe(ID);
        await post(ana());
        expect(seen.filter((request) => request.path === CHARGING).at(-1)?.headers['x-terms-accepted']).toBeUndefined();
    });

    it('keeps every seller once, and no party that the client put in the product', async () => {
        offering = { status: 200, body: JSON.stringify({ relatedParty: [SHOP, SHOP, OTHER] }) };
        const forged = NEW_ORDER({ productOrderItem: [{ id: 'i-1', productOffering: { id: 'o-1' }, product: { relatedParty: [{ id: 'p-evil', role: 'Seller' }, { id: 'p-ana', role: 'Buyer' }, { id: 'p-ana', role: 'Buyer' }] } }] });

        await post(ana(), forged);

        const sent = bodyOf(sentTo('POST', ORDERING));
        const parties = sent['relatedParty'] as { id: string; role: string }[];
        expect(parties.map((p) => p.id)).toEqual(['p-shop', 'p-other', 'p-ana']);
        const product = (sent['productOrderItem'] as { product: { relatedParty: { id: string }[] } }[])[0]?.product;
        expect(product?.relatedParty.map((p) => p.id)).toEqual(['p-ana', 'p-shop', 'p-other']);
    });

    it('takes the sellers from the product specification when the offering has no parties, and from the first offering of a bundle', async () => {
        offering = { status: 200, body: JSON.stringify({ isBundle: false, productSpecification: { id: 's-1' } }) };
        await post(ana());
        expect(bodyOf(sentTo('POST', ORDERING))['relatedParty']).toHaveLength(2);

        seen = [];
        offering = { status: 200, body: JSON.stringify({ isBundle: true, bundledProductOffering: [{ id: 'o-2' }, { id: 'o-3' }] }) };
        await post(ana());
        expect(bodyOf(sentTo('POST', ORDERING))['relatedParty']).toHaveLength(2);
        expect(seen.filter((request) => request.path.includes('/productOffering/')).map((request) => request.path.split('/').at(-1))).toEqual(['o-1', 'o-2']);
    });

    it('is refused for the customer that is not the caller, even when the caller is also one', async () => {
        const forged = NEW_ORDER({ relatedParty: [{ id: 'p-victim', role: 'Buyer' }, ANA] });

        expect((await post(ana(), forged)).status).toBe(403);
        expect((await post(ana(), NEW_ORDER({ relatedParty: [SHOP] }))).status).toBe(403);
        expect((await post(ana(), NEW_ORDER({ relatedParty: 'p-ana' }))).status).toBe(400);
        expect(seen).toEqual([]);
    });

    it('is refused for an offering of the buyer themselves, of another buyer, and for an order with no items', async () => {
        offering = { status: 200, body: JSON.stringify({ relatedParty: [{ id: 'p-ana', role: 'Seller' }] }) };
        expect((await post(ana())).status).toBe(403);
        offering = { status: 200, body: JSON.stringify({ relatedParty: [SHOP, { id: 'p-other', role: 'Buyer' }] }) };
        expect((await post(ana())).status).toBe(403);
        expect((await post(ana(), NEW_ORDER({ productOrderItem: [] }))).status).toBe(400);
        expect((await post(ana(), NEW_ORDER({ productOrderItem: [{ id: 'i-1', productOffering: { id: 'o-1' } }] }))).status).toBe(400);
        expect(sentTo('POST', ORDERING)).toBeUndefined();
    });

    it('is refused without a billing account of the buyer', async () => {
        expect((await post(ana(), NEW_ORDER({ billingAccount: undefined }))).status).toBe(422);
        account = { status: 200, body: JSON.stringify({ id: 'ba-1', relatedParty: [{ id: 'p-victim', role: 'Seller' }] }) };
        expect((await post(ana())).status).toBe(422);
        account = { status: 404, body: '{}' };
        expect((await post(ana())).status).toBe(422);
        expect(sentTo('POST', ORDERING)).toBeUndefined();
    });

    it('tells the client what the charging backend says, and that the order was made', async () => {
        charging = () => ({ status: 400, body: '{"error":"You must accept the terms and conditions of the offering to acquire it"}' });

        const res = await post(ana());

        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe(`You must accept the terms and conditions of the offering to acquire it. The order ${ID} was created and was not processed`);
    });

    it('is a bad gateway when the charging backend fails, and says that the order was made', async () => {
        charging = () => ({ status: 500, body: '{}' });

        const res = await post(ana());

        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toContain(`The order ${ID} was created`);
    });

    it('answers what the ordering API says when it refuses the order, without telling the charging backend', async () => {
        written = { status: 400, body: '{"error":"bad"}' };

        expect((await post(ana())).status).toBe(400);
        expect(seen.some((request) => request.path.startsWith(CHARGING))).toBe(false);
    });
});

describe('PATCH /ordering/productOrder/:id by the customer', () => {
    it('adds a note as the customer, whatever author and date it says, and keeps the ones the order has', async () => {
        const old = { id: 'urn:ngsi-ld:note:1', author: 'p-shop', text: 'Hello', date: '2026-11-01T00:00:00.000Z' };
        current = { status: 200, body: order({ note: [old] }) };

        const res = await patch(ana(), { note: [old, { text: 'Hi', author: 'p-shop', date: '2001-01-01T00:00:00.000Z' }] });

        expect(res.status).toBe(200);
        const notes = bodyOf(sentTo('PATCH', ORDERING))['note'] as Record<string, unknown>[];
        expect(notes[0]).toEqual(old);
        expect(notes[1]).toMatchObject({ author: 'p-ana', text: 'Hi' });
        expect(notes[1]?.['date']).not.toBe('2001-01-01T00:00:00.000Z');
        expect(Object.keys(bodyOf(sentTo('PATCH', ORDERING)))).toEqual(['note']);
    });

    it('is refused for a change of the existing notes, and for any field that is not a note or the cancellation', async () => {
        const old = { author: 'p-shop', text: 'Hello', date: '2026-11-01' };
        current = { status: 200, body: order({ note: [old] }) };

        expect((await patch(ana(), { note: [{ ...old, text: 'Changed' }] })).status).toBe(403);
        expect((await patch(ana(), { billingAccount: { id: 'ba-2' } })).status).toBe(403);
        expect((await patch(ana(), { note: [old, { text: 'x' }], billingAccount: { id: 'ba-2' } })).status).toBe(403);
        expect((await patch(ana(), { state: 'cancelled', priority: '0' })).status).toBe(403);
        expect((await patch(ana(), { state: 'completed' })).status).toBe(403);
        expect((await patch(ana(), { relatedParty: [] })).status).toBe(403);
        expect((await patch(ana(), { productOrderItem: [] })).status).toBe(403);
        expect(sentTo('PATCH', ORDERING)).toBeUndefined();
    });

    it('cancels an order that nobody has started: the charges are refunded and then every item is cancelled', async () => {
        const res = await patch(ana(), { state: 'Cancelled' });

        expect(res.status).toBe(200);
        expect(seen.filter((request) => request.method !== 'GET').map((request) => request.path)).toEqual([`${CHARGING}/refund`, `${ORDERING}/${encodeURIComponent(ID)}`]);
        expect(bodyOf(sentTo('POST', `${CHARGING}/refund`))).toEqual({ orderId: ID });
        const sent = bodyOf(sentTo('PATCH', ORDERING));
        expect(sent['state']).toBe('cancelled');
        expect((sent['productOrderItem'] as { state: string }[]).map((i) => i.state)).toEqual(['cancelled', 'cancelled']);
        expect(Object.keys(sent).sort()).toEqual(['productOrderItem', 'state']);
    });

    it('writes down with its id that the customer cancelled the order', async () => {
        const log = vi.spyOn(Logger.prototype, 'log');
        await patch(ana(), { state: 'Cancelled' });

        expect(log).toHaveBeenCalledWith({ orderId: ID, change: 'cancelled' }, 'A product order was changed by its customer', 'Orders');
        log.mockRestore();
    });

    it('is not cancelled when an item has started, or has no state', async () => {
        current = { status: 200, body: order({ productOrderItem: [item('i-1', SHOP, 'inProgress')] }) };
        expect((await patch(ana(), { state: 'cancelled' })).status).toBe(403);
        current = { status: 200, body: order({ productOrderItem: [{ id: 'i-1', product: { relatedParty: [SHOP] } }] }) };
        expect((await patch(ana(), { state: 'cancelled' })).status).toBe(403);
        expect(seen.some((request) => request.method !== 'GET')).toBe(false);
    });

    it('does not cancel when the refund fails, and says what the charging backend says', async () => {
        charging = () => ({ status: 409, body: '{"error":"Already refunded"}' });

        const res = await patch(ana(), { state: 'cancelled' });

        expect(res.status).toBe(409);
        expect(sentTo('PATCH', ORDERING)).toBeUndefined();
    });

    it('tells the client when the refund was made and the order could not be cancelled', async () => {
        written = { status: 500, body: '{}' };

        const res = await patch(ana(), { state: 'cancelled' });

        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toBe(`The order ${ID} was refunded and could not be cancelled`);
    });
});

describe('PATCH /ordering/productOrder/:id by a seller', () => {
    const update = (state: string) => ({ productOrderItem: [item('i-1', SHOP, state)] });

    it('changes the state of their items, and the state of the order follows from the items', async () => {
        const res = await patch(seller(), update('inProgress'));

        expect(res.status).toBe(200);
        const sent = bodyOf(sentTo('PATCH', ORDERING));
        expect((sent['productOrderItem'] as { id: string; state: string }[]).map((i) => [i.id, i.state])).toEqual([['i-1', 'inProgress'], ['i-2', 'acknowledged']]);
        expect(sent['state']).toBe('inProgress');
        expect(seen.some((request) => request.path.startsWith(`${CHARGING}/completed`))).toBe(false);
    });

    it('tells the charging backend when the order is completed', async () => {
        current = { status: 200, body: order({ productOrderItem: [item('i-1', SHOP, 'inProgress')] }) };

        const res = await patch(seller(), update('completed'));

        expect(res.status).toBe(200);
        expect(bodyOf(sentTo('PATCH', ORDERING))['state']).toBe('completed');
        expect(sentTo('POST', `${CHARGING}/completed/${encodeURIComponent(ID)}`)).toBeDefined();
    });

    it('says that the order was completed when the charging backend could not be told', async () => {
        current = { status: 200, body: order({ productOrderItem: [item('i-1', SHOP, 'inProgress')] }) };
        charging = () => ({ status: 500, body: '{}' });

        const res = await patch(seller(), update('completed'));

        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toContain(`The order ${ID} was completed`);
    });

    it('is refused for an item that is not theirs, for a field of an item, and for anything but items and notes', async () => {
        expect((await patch(seller(), { productOrderItem: [item('i-2', OTHER, 'completed')] })).status).toBe(403);
        expect((await patch(seller(), { productOrderItem: [{ ...item('i-1', SHOP, 'completed'), action: 'delete' }] })).status).toBe(403);
        expect((await patch(seller(), { state: 'completed' })).status).toBe(403);
        expect((await patch(seller(), { productOrderItem: [item('i-1', SHOP, 'done')] })).status).toBe(400);
        expect(sentTo('PATCH', ORDERING)).toBeUndefined();
    });

    it('is refused for who is not in the order, and for an order that cannot be read', async () => {
        current = { status: 200, body: order({ relatedParty: [OTHER, ANA] }) };
        expect((await patch(seller(), update('completed'))).status).toBe(403);
        current = { status: 404, body: '{}' };
        expect((await patch(seller(), update('completed'))).status).toBe(404);
    });
});

describe('what the portal does not use', () => {
    it('is closed: the delete of an order, the other APIs of the ordering service and the root', async () => {
        const closed: [string, string][] = [['DELETE', `/ordering/productOrder/${ID}`], ['GET', '/ordering/cancelProductOrder'], ['POST', '/ordering/hub'], ['GET', '/ordering']];
        for (const [method, path] of closed) {
            expect((await call(path, { method, headers: ana() })).status).toBe(404);
        }
        expect(seen).toEqual([]);
    });
});
