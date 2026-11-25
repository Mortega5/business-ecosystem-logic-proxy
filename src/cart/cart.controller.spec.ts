import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { cartItems, FakeCartModule } from '../testing/fake-cart';
import { AS_ADMIN, useFakeLogin, LOGGED_IN } from '../testing/fake-login';

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeCartModule] })
class Root {}

const JSON_HEADERS = { 'content-type': 'application/json' };
const ANA = { ...LOGGED_IN, ...JSON_HEADERS };
const ROOT = { ...AS_ADMIN, ...JSON_HEADERS };
const OFFERING = { id: 'urn:ngsi-ld:product-offering:1', name: 'Weather API', options: { pricing: { id: 'p-1' } }, termsAccepted: true };

let app: NestExpressApplication;
let url: string;

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
        method: init.method ?? 'GET',
        headers: init.headers ?? ANA,
        ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) })
    });
const add = (item: unknown, headers = ANA): Promise<Response> => call('/shoppingCart/item/', { method: 'POST', headers, body: item });

beforeAll(async () => {
    Object.assign(process.env, { BAE_LIMITS__CART_ITEMS: '3' });
    app = await createApp(Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    delete process.env['BAE_LIMITS__CART_ITEMS'];
    await app.close();
});

beforeEach(async () => {
    await cartItems.deleteMany({ user: 'u-ana' });
    await cartItems.deleteMany({ user: 'u-root' });
});

describe('the shopping cart', () => {
    it('keeps what the portal sends, as it comes, and gives it back to the same user only', async () => {
        const added = await add(OFFERING);

        expect(added.status).toBe(201);
        expect(added.headers.get('location')).toBe('/shoppingCart/item/urn%3Angsi-ld%3Aproduct-offering%3A1');
        expect(await added.json()).toEqual({ status: 'ok' });
        expect(await (await call('/shoppingCart/item/')).json()).toEqual([OFFERING]);
        expect(await (await call('/shoppingCart/item', { headers: ROOT })).json()).toEqual([]);
    });

    it('is private', async () => {
        for (const [method, path] of [['GET', '/shoppingCart/item/'], ['POST', '/shoppingCart/item/'], ['DELETE', '/shoppingCart/item/x'], ['POST', '/shoppingCart/empty/']]) {
            expect((await call(path as string, { method: method as string, headers: JSON_HEADERS, body: method === 'POST' ? '{}' : undefined })).status).toBe(401);
        }
    });

    it('refuses an item that is not an object, has no id or has one that is not usable as an address', async () => {
        for (const body of ['not json', '[]', '{}', '{"id":""}', '{"id":7}', '{"id":{"$ne":"x"}}', '{"id":"a b"}', '{"id":"../x"}']) {
            expect((await add(body)).status, body).toBe(400);
        }
        expect(await cartItems.count()).toBe(0);
    });

    it('does not take the same item twice, nor more than the limit', async () => {
        await add(OFFERING);
        expect((await add(OFFERING)).status).toBe(409);

        await add({ id: 'o-2' });
        await add({ id: 'o-3' });
        expect((await add({ id: 'o-4' })).status).toBe(409);
        expect(await cartItems.count({ user: 'u-ana' })).toBe(3);
    });

    it('removes an item of the caller, and says so when it was not there or is of another user', async () => {
        await add({ id: 'o-1' });
        await add({ id: 'o-1' }, ROOT);

        expect((await call('/shoppingCart/item/o-1', { method: 'DELETE' })).status).toBe(204);
        expect((await call('/shoppingCart/item/o-1', { method: 'DELETE' })).status).toBe(404);
        expect(await cartItems.count({ user: 'u-root' })).toBe(1);
        expect((await call('/shoppingCart/item/a%20b', { method: 'DELETE' })).status).toBe(400);
    });

    it('empties the cart of the caller and nobody else\'s', async () => {
        await add({ id: 'o-1' });
        await add({ id: 'o-2' });
        await add({ id: 'o-1' }, ROOT);

        const res = await call('/shoppingCart/empty/', { method: 'POST', body: {} });

        expect(res.status).toBe(204);
        expect(await cartItems.count({ user: 'u-ana' })).toBe(0);
        expect(await cartItems.count({ user: 'u-root' })).toBe(1);
    });

    it('closes the rest, such as reading one item', async () => {
        expect((await call('/shoppingCart/item/o-1')).status).toBe(404);
        expect((await call('/shoppingCart/other', { method: 'PUT', body: {} })).status).toBe(404);
    });
});
