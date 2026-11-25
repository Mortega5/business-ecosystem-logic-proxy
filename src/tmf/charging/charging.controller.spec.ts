import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ADMIN, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { ChargingModule } from './charging.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, ChargingModule] })
class Root {}

const JSON_HEADERS = { 'content-type': 'application/json' };
const CONFIRM = JSON.stringify({ confirm_action: 'accept', reference: 'ref-1', signature: 'abc' });
const FILE = (data: string) => JSON.stringify({ content: { name: 'a.png', data }, contentType: 'image/png', isPublic: true });

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, {
        BAE_UPSTREAMS__CHARGING__HOST: '127.0.0.1',
        BAE_UPSTREAMS__CHARGING__PORT: String(upstream.port),
        BAE_HTTP__BODY_LIMIT: '8kb'
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
    upstream.answer((res) => upstream.json(res, 200, '{"ok":true}'));
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });

describe('POST /charging/api/orderManagement/orders/confirm', () => {
    it('sends the body as it came, with the slash that the backend has, to a visitor who is not logged in', async () => {
        const res = await call('/charging/api/orderManagement/orders/confirm/', { method: 'POST', headers: JSON_HEADERS, body: CONFIRM });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(upstream.seen).toMatchObject({ method: 'POST', url: '/charging/api/orderManagement/orders/confirm/', body: CONFIRM });
        expect(upstream.seen?.headers['x-party-id']).toBeUndefined();
    });

    it('sends it as JSON, whatever type the client said', async () => {
        await call('/charging/api/orderManagement/orders/confirm/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: CONFIRM });
        expect(upstream.seen?.headers['content-type']).toBe('application/json');
    });

    it('is asked for with the identity of whoever is logged in, and is the same with no slash', async () => {
        await call('/charging/api/orderManagement/orders/confirm', { method: 'POST', headers: { ...LOGGED_IN, ...JSON_HEADERS }, body: CONFIRM });

        expect(upstream.seen?.url).toBe('/charging/api/orderManagement/orders/confirm/');
        expect(upstream.seen?.headers).toMatchObject({ 'x-party-id': 'p-ana' });
    });

    it.each(['not json', '[]', 'null'])('refuses the body %s', async (body) => {
        expect((await call('/charging/api/orderManagement/orders/confirm/', { method: 'POST', headers: JSON_HEADERS, body })).status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('refuses a body over the limit', async () => {
        const res = await call('/charging/api/orderManagement/orders/confirm/', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ filler: 'x'.repeat(9000) }) });
        expect(res.status).toBe(413);
        expect(upstream.seen).toBeUndefined();
    });

    it('passes on what the backend answers when it is not a success', async () => {
        upstream.answer((res) => upstream.json(res, 400, '{"error":"bad signature"}'));
        const res = await call('/charging/api/orderManagement/orders/confirm/', { method: 'POST', headers: JSON_HEADERS, body: CONFIRM });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'bad signature' });
    });
});

describe('/charging/api/orderManagement/notify/config', () => {
    const config = JSON.stringify({ smtpServer: 'smtp.example.org', emailPassword: 'secret' });

    it('is read and written by an administrator', async () => {
        expect((await call('/charging/api/orderManagement/notify/config', { headers: AS_ADMIN })).status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'GET', url: '/charging/api/orderManagement/notify/config' });
        expect((await call('/charging/api/orderManagement/notify/config', { headers: AS_ADMIN })).headers.get('cache-control')).toBe('private, no-store');

        const res = await call('/charging/api/orderManagement/notify/config', { method: 'POST', headers: { ...AS_ADMIN, ...JSON_HEADERS }, body: config });
        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'POST', url: '/charging/api/orderManagement/notify/config', body: config });
    });

    it.each([
        ['GET', undefined],
        ['POST', config]
    ])('refuses %s to a user who is not an administrator, and the backend is not asked', async (method, body) => {
        const res = await call('/charging/api/orderManagement/notify/config', { method, headers: { ...LOGGED_IN, ...JSON_HEADERS }, ...(body === undefined ? {} : { body }) });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'You are not allowed to access this resource' });
        expect(upstream.seen).toBeUndefined();
    });

    it.each(['GET', 'POST'])('is private for %s', async (method) => {
        const res = await call('/charging/api/orderManagement/notify/config', { method, headers: JSON_HEADERS, ...(method === 'POST' ? { body: config } : {}) });
        expect(res.status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('POST /charging/api/assetManagement/assets/uploadJob', () => {
    const upload = (body: string, headers: Record<string, string> = { ...LOGGED_IN, ...JSON_HEADERS }) =>
        call('/charging/api/assetManagement/assets/uploadJob', { method: 'POST', headers, body });

    it('sends on a file in base64 as it came, up to the limit of a body', async () => {
        const body = FILE('A'.repeat(4000));
        const res = await upload(body);

        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'POST', url: '/charging/api/assetManagement/assets/uploadJob', body });
        expect(upstream.seen?.headers).toMatchObject({ 'x-party-id': 'p-ana' });
    });

    it('sends on only the fields of an upload', async () => {
        const body = JSON.stringify({ ...JSON.parse(FILE('QQ==')), owner: 'p-victim', content: { name: 'a.png', data: 'QQ==', path: '../x' } });
        expect((await upload(body)).status).toBe(200);
        expect(upstream.seen?.body).toBe(FILE('QQ=='));
    });

    it.each([
        ['a name with a folder', 'sub/a.png', 'image/png', 'QQ==', 'Invalid file name'],
        ['a name that goes up', '../a.png', 'image/png', 'QQ==', 'Invalid file name'],
        ['a name with a backslash', 'a\\b.png', 'image/png', 'QQ==', 'Invalid file name'],
        ['a name that is a double dot', '..', 'image/png', 'QQ==', 'Invalid file name'],
        ['a name with a control character', 'a\u0000.png', 'image/png', 'QQ==', 'Invalid file name'],
        ['an empty name', '', 'image/png', 'QQ==', 'Invalid file name'],
        ['a name that is too long', 'a'.repeat(256), 'image/png', 'QQ==', 'Invalid file name'],
        ['a type that is not a type', 'a.png', 'image/png; charset=x', 'QQ==', 'Invalid content type'],
        ['a type with no subtype', 'a.png', 'image', 'QQ==', 'Invalid content type'],
        ['content that is not base64', 'a.png', 'image/png', 'not base64!', 'Invalid file content']
    ])('refuses %s with 422 and does not call the backend', async (_name, name, contentType, data, error) => {
        const res = await upload(JSON.stringify({ content: { name, data }, contentType, isPublic: true }));
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error });
        expect(upstream.seen).toBeUndefined();
    });

    it.each([
        ['no content', { contentType: 'image/png' }],
        ['a content that is not an object', { content: 'x', contentType: 'image/png' }],
        ['a name that is not a text', { content: { name: 1, data: 'QQ==' }, contentType: 'image/png' }],
        ['no type', { content: { name: 'a.png', data: 'QQ==' } }],
        ['isPublic that is not a boolean', { content: { name: 'a.png', data: 'QQ==' }, contentType: 'image/png', isPublic: 'yes' }]
    ])('refuses %s and does not call the backend', async (_name, body) => {
        expect((await upload(JSON.stringify(body))).status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('refuses a file over the limit of a body', async () => {
        const res = await upload(FILE('A'.repeat(9000)));
        expect(res.status).toBe(413);
        expect(upstream.seen).toBeUndefined();
    });

    it.each(['not json', '[]'])('refuses the body %s', async (body) => {
        expect((await upload(body)).status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await upload(FILE('QQ=='), JSON_HEADERS)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the body is read after the user is known', () => {
    const oversized = JSON.stringify({ filler: 'x'.repeat(9000) });

    it.each(['/charging/api/orderManagement/notify/config', '/charging/api/assetManagement/assets/uploadJob'])(
        'refuses a visitor who is not logged in before reading a body over the limit: %s',
        async (path) => {
            const res = await call(path, { method: 'POST', headers: JSON_HEADERS, body: oversized });
            expect(res.status).toBe(401);
            expect(upstream.seen).toBeUndefined();
        }
    );

    it('refuses a user who is not an administrator before reading a body over the limit', async () => {
        const res = await call('/charging/api/orderManagement/notify/config', { method: 'POST', headers: { ...LOGGED_IN, ...JSON_HEADERS }, body: oversized });
        expect(res.status).toBe(403);
        expect(upstream.seen).toBeUndefined();
    });

    it('still refuses a body over the limit to a user who may send it', async () => {
        const res = await call('/charging/api/orderManagement/notify/config', { method: 'POST', headers: { ...AS_ADMIN, ...JSON_HEADERS }, body: oversized });
        expect(res.status).toBe(413);
    });
});

describe('the rest of /charging', () => {
    it.each([
        ['POST', '/charging/api/orderManagement/orders/refund'],
        ['POST', '/charging/api/orderManagement/orders/preview/'],
        ['GET', '/charging/api/orderManagement/accounting/'],
        ['GET', '/charging/api/orderManagement/orders/confirm/'],
        ['PUT', '/charging/api/orderManagement/notify/config'],
        ['DELETE', '/charging/api/orderManagement/notify/config'],
        ['GET', '/charging/api/orderManagement/notify/configured'],
        ['GET', '/charging/api/assetManagement/assets/uploadJob'],
        ['GET', '/charging/api/assetManagement/assets'],
        ['GET', '/charging/other'],
        ['GET', '/charging']
    ])('%s %s is not found, and the backend is not asked', async (method, path) => {
        const res = await call(path, { method, headers: { ...AS_ADMIN, ...JSON_HEADERS }, ...(method === 'GET' ? {} : { body: '{"a":1}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
