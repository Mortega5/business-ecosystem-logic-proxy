import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ORGANISATION, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { AccountModule } from './account.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, AccountModule] })
class Root {}

const TARGET = '/tmf-api/accountManagement/v4/billingAccount';
const JSON_HEADERS = { 'content-type': 'application/json' };
const OWNER = { id: 'p-ana', role: 'Seller' };
const PHONE = (phoneNumber: string) => ({ mediumType: 'TelephoneNumber', characteristic: { contactType: 'Mobile', phoneNumber } });
const account = (extra: object = {}) => JSON.stringify({ name: 'Home', relatedParty: [OWNER], ...extra });
const MINE = JSON.stringify({ id: 'x-1', relatedParty: [OWNER] });

let app: NestExpressApplication;
let url: string;
let requests: { method: string | undefined; url: string | undefined }[];

const answerWith = (status: number, body: string): void =>
    upstream.answer((res) => {
        requests.push({ method: res.req.method, url: res.req.url });
        upstream.json(res, status, body);
    });

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
    requests = [];
    answerWith(200, MINE);
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: { ...LOGGED_IN, ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) });
const sentQuery = (): [string, string][] => [...new URL(`http://x${upstream.seen?.url ?? ''}`).searchParams.entries()];

describe('GET /account/billingAccount, the list', () => {
    it('is the list of the caller as the owner: every filter goes on, then the party and its role', async () => {
        const res = await call('/account/billingAccount/?limit=5&state=Defined&fields=name&relatedParty.id=p-victim&relatedParty.role=Buyer');

        expect(res.status).toBe(200);
        expect(upstream.seen?.url?.startsWith(`${TARGET}?`)).toBe(true);
        expect(sentQuery()).toEqual([
            ['limit', '5'],
            ['state', 'Defined'],
            ['fields', 'name'],
            ['relatedParty.id', 'p-ana'],
            ['relatedParty.role', 'Seller']
        ]);
        expect(upstream.seen?.headers).toMatchObject({ 'x-party-id': 'p-ana' });
    });

    it('is the list of the organisation the caller acts for', async () => {
        await call('/account/billingAccount', { headers: AS_ORGANISATION });
        expect(sentQuery()).toEqual([
            ['relatedParty.id', 'p-acme'],
            ['relatedParty.role', 'Seller']
        ]);
    });

    it('refuses a filter that carries another parameter', async () => {
        const res = await call('/account/billingAccount?name=a%26relatedParty.id%3Dp-victim');
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await fetch(`${url}/account/billingAccount`)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('GET /account/billingAccount/:id', () => {
    it('is given to its owner, and nothing of the query is sent', async () => {
        const res = await call('/account/billingAccount/x-1?fields=name&relatedParty.id=p-victim');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(JSON.parse(MINE));
        expect(upstream.seen?.url).toBe(`${TARGET}/x-1`);
    });

    it.each([
        ['somebody else', JSON.stringify({ id: 'x-1', relatedParty: [{ id: 'p-other', role: 'Seller' }] })],
        ['the caller as a buyer', JSON.stringify({ id: 'x-1', relatedParty: [{ id: 'p-ana', role: 'Buyer' }] })],
        ['no related parties', JSON.stringify({ id: 'x-1' })],
        ['something that is not JSON', 'not json']
    ])('is refused when the upstream answers with %s, and what it said is not leaked', async (_name, body) => {
        answerWith(200, body);
        const res = await call('/account/billingAccount/x-1');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'The user making the request is not the specified owner' });
    });

    it('is not given to the individual behind an organisation', async () => {
        answerWith(200, JSON.stringify({ id: 'x-1', relatedParty: [{ id: 'p-acme', role: 'Seller' }] }));
        expect((await call('/account/billingAccount/x-1', { headers: AS_ORGANISATION })).status).toBe(200);
        expect((await call('/account/billingAccount/x-1')).status).toBe(403);
    });

    it('passes on what the upstream answers when it is not a success', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await call('/account/billingAccount/x-1');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it.each(['..', 'a%20b', 'a;b'])('refuses the id %s and does not call the upstream', async (id) => {
        expect([400, 404]).toContain((await call(`/account/billingAccount/${id}`)).status);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await fetch(`${url}/account/billingAccount/x-1`)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('POST /account/billingAccount', () => {
    it('creates the account of the caller', async () => {
        const body = account({ contact: [{ contactName: 'Ana', contactMedium: [PHONE('+34612345678')] }] });
        const res = await call('/account/billingAccount/', { method: 'POST', headers: JSON_HEADERS, body });

        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'POST', url: TARGET });
        expect(JSON.parse(upstream.seen?.body ?? '')).toEqual({
            ...(JSON.parse(body) as object),
            relatedParty: [{ id: 'p-ana', href: 'p-ana', name: 'u-ana', role: 'Seller', '@referredType': 'Individual' }]
        });
    });

    it('sends what it checked: a key that comes twice is the one it read, so the upstream cannot read the other', async () => {
        const body = `{"relatedParty":[{"id":"p-victim","role":"Seller"}],"relatedParty":[{"id":"p-ana","role":"Seller"}]}`;
        const res = await call('/account/billingAccount', { method: 'POST', headers: JSON_HEADERS, body });

        expect(res.status).toBe(200);
        expect(upstream.seen?.body).toBe('{"relatedParty":[{"id":"p-ana","href":"p-ana","name":"u-ana","role":"Seller","@referredType":"Individual"}]}');
    });

    it('creates the account of the organisation the caller acts for', async () => {
        const body = JSON.stringify({ relatedParty: [{ id: 'p-acme', role: 'seller' }] });
        expect((await call('/account/billingAccount', { method: 'POST', headers: { ...JSON_HEADERS, ...AS_ORGANISATION }, body })).status).toBe(200);
    });

    it.each([
        ['no related parties', JSON.stringify({ name: 'x' }), 400, 'Missing relatedParty field'],
        ['an empty list of related parties', JSON.stringify({ relatedParty: [] }), 400, 'Missing relatedParty field'],
        ['the caller and somebody else as owners', JSON.stringify({ relatedParty: [OWNER, { id: 'p-victim', role: 'Seller' }] }), 403, 'The user making the request is not the specified owner'],
        ['somebody else as the owner', JSON.stringify({ relatedParty: [{ id: 'p-victim', role: 'Seller' }] }), 403, 'The user making the request is not the specified owner'],
        ['the caller as a buyer only', JSON.stringify({ relatedParty: [{ id: 'p-ana', role: 'Buyer' }] }), 403, 'The user making the request is not the specified owner'],
        ['contacts that are not a list', account({ contact: {} }), 400, 'Invalid contact format'],
        ['a contact with no media', account({ contact: [{}] }), 400, 'Invalid contactMedium format'],
        ['a contact that is null', account({ contact: [null] }), 400, 'Invalid contactMedium format'],
        ['a medium that is not an object', account({ contact: [{ contactMedium: ['x'] }] }), 400, 'Invalid contactMedium format'],
        ['a telephone with no number', account({ contact: [{ contactMedium: [{ mediumType: 'TelephoneNumber' }] }] }), 422, 'Invalid phone number'],
        ['a number that is not in E.164', account({ contact: [{ contactMedium: [PHONE('612345678')] }] }), 422, 'Invalid phone number'],
        ['a number that does not exist', account({ contact: [{ contactMedium: [PHONE('+34000000000')] }] }), 422, 'Invalid phone number']
    ])('refuses %s and does not call the upstream', async (_name, body, status, error) => {
        const res = await call('/account/billingAccount', { method: 'POST', headers: JSON_HEADERS, body });
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error });
        expect(upstream.seen).toBeUndefined();
    });

    it.each(['not json', '[]', 'null'])('refuses the body %s', async (body) => {
        const res = await call('/account/billingAccount', { method: 'POST', headers: JSON_HEADERS, body });
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await fetch(`${url}/account/billingAccount`, { method: 'POST', headers: JSON_HEADERS, body: account() })).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('PATCH /account/billingAccount/:id', () => {
    const patch = (body: string, headers: Record<string, string> = {}) =>
        call('/account/billingAccount/x-1', { method: 'PATCH', headers: { ...JSON_HEADERS, ...headers }, body });

    it('reads the account and then changes it, as its owner', async () => {
        const body = account({ contact: [{ contactMedium: [PHONE('+34612345678')] }] });
        const res = await patch(body);

        expect(res.status).toBe(200);
        expect(requests).toEqual([
            { method: 'GET', url: `${TARGET}/x-1` },
            { method: 'PATCH', url: `${TARGET}/x-1` }
        ]);
        expect(upstream.seen?.body).toBe(body);
    });

    it('sends what it checked, not a second copy of a key', async () => {
        await patch('{"relatedParty":[{"id":"p-victim","role":"Seller"}],"relatedParty":[{"id":"p-ana","role":"Seller"}]}');
        expect(upstream.seen?.body).toBe('{"relatedParty":[{"id":"p-ana","role":"Seller"}]}');
    });

    it('does not need the owner in the changes when they do not touch it', async () => {
        expect((await patch('{"state":"Active"}')).status).toBe(200);
    });

    it('refuses an account of somebody else and does not change it', async () => {
        answerWith(200, JSON.stringify({ id: 'x-1', relatedParty: [{ id: 'p-other', role: 'Seller' }] }));
        const res = await patch('{"state":"Active"}');

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'The user making the request is not the specified owner' });
        expect(requests.map((request) => request.method)).toEqual(['GET']);
    });

    it.each([
        ['somebody else', [{ id: 'p-victim', role: 'Seller' }]],
        ['themselves and somebody else', [OWNER, { id: 'p-victim', role: 'Seller' }]],
        ['nobody', []],
        ['the caller as a buyer', [{ id: 'p-ana', role: 'Buyer' }]]
    ])('refuses to hand the account to %s', async (_name, relatedParty) => {
        const res = await patch(JSON.stringify({ relatedParty }));
        expect(res.status).toBe(403);
        expect(requests.map((request) => request.method)).toEqual(['GET']);
    });

    it('passes on the answer of the upstream when it has no such account, and does not change anything', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await patch('{"state":"Active"}');

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
        expect(requests.map((request) => request.method)).toEqual(['GET']);
    });

    it('refuses an invalid phone number', async () => {
        const res = await patch(JSON.stringify({ contact: [{ contactMedium: [PHONE('12')] }] }));
        expect(res.status).toBe(422);
        expect(requests.map((request) => request.method)).toEqual(['GET']);
    });

    it('refuses a body that is not JSON before reading anything', async () => {
        expect((await patch('not json')).status).toBe(400);
        expect(requests).toEqual([]);
    });

    it('is private', async () => {
        expect((await fetch(`${url}/account/billingAccount/x-1`, { method: 'PATCH', headers: JSON_HEADERS, body: '{}' })).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the rest of /account', () => {
    it.each([
        ['DELETE', '/billingAccount/x-1'],
        ['PUT', '/billingAccount/x-1'],
        ['PATCH', '/billingAccount'],
        ['POST', '/billingAccount/x-1'],
        ['GET', '/partyAccount'],
        ['GET', '/billingAccount/x-1/history'],
        ['GET', ''],
        ['GET', '/']
    ])('%s %s is not found, and nothing is written', async (method, path) => {
        const res = await call(`/account${path}`, { method, headers: JSON_HEADERS, ...(method === 'GET' ? {} : { body: '{"state":"Active"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
