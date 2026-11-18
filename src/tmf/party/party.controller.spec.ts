import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LoggingModule } from '../../logging/logging.module';
import { AS_MEMBER, AS_ORGANISATION, fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { PartyModule } from './party.module';

const { partyClient } = createRequire(__filename)('../../../lib/party') as { partyClient: { clearPartyCache: (id: string) => void } };

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, PartyModule] })
class Root {}

// The legacy application answers anything under /party
const legacy = express();
legacy.all('/party/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

const JSON_HEADERS = { 'content-type': 'application/json' };
const BASE = '/tmf-api/party/v4';
const INDIVIDUAL = JSON.stringify({
    id: 'p-bob',
    href: 'p-bob',
    '@type': 'Individual',
    givenName: 'Bob',
    familyName: 'Builder',
    birthDate: '1980-01-01',
    contactMedium: [{ mediumType: 'Email', characteristic: { emailAddress: 'bob@example.org' } }]
});
const PHONE = (phoneNumber: string) => ({ mediumType: 'TelephoneNumber', characteristic: { contactType: 'Mobile', phoneNumber } });

let url: string;
let clearCache: ReturnType<typeof vi.spyOn>;
const apps: NestExpressApplication[] = [];

const answerWith = (status: number, body: string): void => upstream.answer((res) => upstream.json(res, status, body));

const serve = async (env: NodeJS.ProcessEnv = {}): Promise<string> => {
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port), ...env });
    const server = await createApp(legacy, Root);
    server.get(LegacyAuthBridge).attach([fakeLogin]);
    await server.listen(0);
    apps.push(server);
    return server.getUrl();
};

beforeAll(async () => {
    await upstream.start();
    url = await serve();
});

afterAll(async () => {
    await Promise.all(apps.map((server) => server.close()));
    await upstream.stop();
});

beforeEach(() => {
    upstream.reset();
    answerWith(200, INDIVIDUAL);
    clearCache = vi.spyOn(partyClient, 'clearPartyCache').mockImplementation(() => undefined);
});

afterEach(() => {
    clearCache.mockRestore();
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; base?: string } = {}) =>
    fetch(`${init.base ?? url}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const as = (user: Record<string, string>, extra: Record<string, string> = {}) => ({ ...user, ...extra });

describe('GET /party/organization, the list', () => {
    it('is open to anybody and sends what the portal asks for', async () => {
        const res = await call('/party/organization?fields=id,tradingName&offset=10&limit=5');

        expect(res.status).toBe(200);
        expect(upstream.seen?.url).toBe(`${BASE}/organization?fields=id%2CtradingName&offset=10&limit=5`);
        expect(upstream.seen?.headers['x-party-id']).toBeUndefined();
    });

    it('is asked for with the identity of whoever is logged in', async () => {
        await call('/party/organization', { headers: LOGGED_IN });
        expect(upstream.seen?.url).toBe(`${BASE}/organization`);
        expect(upstream.seen?.headers).toMatchObject({ 'x-party-id': 'p-ana' });
    });

    it.each([
        ['the directory of providers', 'lifecycleStatus=Launched&offset=0&limit=12'],
        ['a keyword', 'keyword=cloud'],
        ['a sort', 'sort=name'],
        ['a filter that is not one of the portal', 'organizationIdentification.identificationId=x'],
        ['the raw query', 'q=a'],
        ['a parameter twice', 'limit=1&limit=2'],
        ['a limit that is not a number', 'limit=abc'],
        ['a nested parameter', 'limit[a]=1'],
        ['fields that carry another parameter', 'fields=id%26x%3D1']
    ])('refuses %s and does not call the upstream', async (_name, query) => {
        const res = await call(`/party/organization?${query}`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Invalid query' });
        expect(upstream.seen).toBeUndefined();
    });
});

describe('GET /party/organization/:id', () => {
    it('is open to anybody, and nothing of the query is sent', async () => {
        const res = await call('/party/organization/urn%3Angsi-ld%3Aorganization%3A1?fields=name');
        expect(res.status).toBe(200);
        expect(upstream.seen?.url).toBe(`${BASE}/organization/urn%3Angsi-ld%3Aorganization%3A1`);
    });

    it('is asked for with the identity of whoever is logged in', async () => {
        await call('/party/organization/x', { headers: LOGGED_IN });
        expect(upstream.seen?.headers).toMatchObject({ 'x-party-id': 'p-ana' });
    });

    it('passes on what the upstream answers when it is not a success', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await call('/party/organization/x');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it.each(['..', 'a%20b', 'a;b'])('refuses the id %s and does not call the upstream', async (id) => {
        expect([400, 404]).toContain((await call(`/party/organization/${id}`, { headers: LOGGED_IN })).status);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('GET /party/individual/:id', () => {
    it('is given whole to the individual themselves', async () => {
        answerWith(200, JSON.stringify({ id: 'p-ana', givenName: 'Ana', contactMedium: [{ mediumType: 'Email' }] }));
        const res = await call('/party/individual/p-ana?fields=name', { headers: LOGGED_IN });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'p-ana', givenName: 'Ana', contactMedium: [{ mediumType: 'Email' }] });
        expect(upstream.seen?.url).toBe(`${BASE}/individual/p-ana`);
    });

    it('is given whole to the individual behind the organisation they act for', async () => {
        answerWith(200, JSON.stringify({ id: 'p-ana', givenName: 'Ana', birthDate: '1980-01-01' }));
        const res = await call('/party/individual/p-ana', { headers: AS_ORGANISATION });
        expect(await res.json()).toEqual({ id: 'p-ana', givenName: 'Ana', birthDate: '1980-01-01' });
    });

    it('is given to anybody else with the name only', async () => {
        const res = await call('/party/individual/p-bob', { headers: LOGGED_IN });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'p-bob', href: 'p-bob', '@type': 'Individual', givenName: 'Bob', familyName: 'Builder' });
    });

    it.each([
        ['something that is not JSON', 'not json'],
        ['a list', '[]'],
        ['null', 'null']
    ])('is not given to another one when the upstream answers with %s', async (_name, body) => {
        answerWith(200, body);
        const res = await call('/party/individual/p-bob', { headers: LOGGED_IN });
        expect(res.status).toBe(502);
        expect(JSON.stringify(await res.json())).not.toContain('not json');
    });

    it('passes on what the upstream answers when it is not a success', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await call('/party/individual/p-bob', { headers: LOGGED_IN });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it('is private', async () => {
        expect((await call('/party/individual/p-bob')).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });

    it.each(['..', 'a%20b', 'a;b'])('refuses the id %s and does not call the upstream', async (id) => {
        expect([400, 404]).toContain((await call(`/party/individual/${id}`, { headers: LOGGED_IN })).status);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('PATCH /party/individual/:id', () => {
    const patch = (body: string, headers: Record<string, string> = LOGGED_IN, id = 'p-ana', base?: string) =>
        call(`/party/individual/${id}`, { method: 'PATCH', headers: { ...JSON_HEADERS, ...headers }, body, ...(base === undefined ? {} : { base }) });

    it('changes the individual themselves, without id and href, and then the legacy application forgets them', async () => {
        const res = await patch('{"id":"p-victim","href":"x","givenName":"Ana"}');

        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'PATCH', url: `${BASE}/individual/p-ana`, body: '{"givenName":"Ana"}' });
        expect(clearCache).toHaveBeenCalledExactlyOnceWith('p-ana');
    });

    it('sends what it checked, not a second copy of a key', async () => {
        await patch('{"givenName":"Mallory","givenName":"Ana"}');
        expect(upstream.seen?.body).toBe('{"givenName":"Ana"}');
    });

    it('forgets the individual also when the upstream refuses the change', async () => {
        answerWith(422, '{"error":"no"}');
        expect((await patch('{"givenName":"Ana"}')).status).toBe(422);
        expect(clearCache).toHaveBeenCalledExactlyOnceWith('p-ana');
    });

    it.each([
        ['somebody else', LOGGED_IN, 'p-bob'],
        ['an administrator for somebody else', { authorization: 'Bearer root' }, 'p-bob'],
        ['an individual while acting for an organisation', AS_ORGANISATION, 'p-ana'],
        ['the organisation as an individual', AS_ORGANISATION, 'p-acme']
    ])('refuses to change %s and does not call the upstream', async (_name, headers, id) => {
        const res = await patch('{"givenName":"Ana"}', headers, id);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'You are not allowed to access this resource' });
        expect(upstream.seen).toBeUndefined();
        expect(clearCache).not.toHaveBeenCalled();
    });

    it.each(['not json', '[]', 'null'])('refuses the body %s', async (body) => {
        expect((await patch(body)).status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('is closed in an instance that does not allow to edit parties', async () => {
        const off = await serve({ BAE_PARTY__EDIT_ENABLED: 'false' });
        try {
            const res = await patch('{"givenName":"Ana"}', LOGGED_IN, 'p-ana', off);
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: 'Editing party info is disabled in this instance' });
            expect(upstream.seen).toBeUndefined();
        } finally {
            delete process.env['BAE_PARTY__EDIT_ENABLED'];
        }
    });

    it('is private', async () => {
        expect((await call('/party/individual/p-ana', { method: 'PATCH', headers: JSON_HEADERS, body: '{}' })).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('PATCH /party/organization/:id', () => {
    const patch = (body: string, headers: Record<string, string> = AS_ORGANISATION, id = 'p-acme') =>
        call(`/party/organization/${id}`, { method: 'PATCH', headers: { ...JSON_HEADERS, ...headers }, body });

    it('changes the organisation, for its administrator, and then the legacy application forgets it', async () => {
        const body = JSON.stringify({ tradingName: 'Acme', contactMedium: [PHONE('+34612345678')], partyCharacteristic: [{ name: 'country', value: 'ES' }] });
        const res = await patch(body);

        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'PATCH', url: `${BASE}/organization/p-acme`, body });
        expect(clearCache).toHaveBeenCalledExactlyOnceWith('p-acme');
    });

    it.each([
        ['somebody else', AS_ORGANISATION, 'p-other'],
        ['an individual', LOGGED_IN, 'p-ana'],
        ['a member who does not administer it', AS_MEMBER, 'p-acme'],
        ['an administrator who is not acting for it', { authorization: 'Bearer root' }, 'p-acme']
    ])('refuses to change it for %s and does not call the upstream', async (_name, headers, id) => {
        const res = await patch('{"tradingName":"Acme"}', headers, id);
        expect(res.status).toBe(403);
        expect(upstream.seen).toBeUndefined();
        expect(clearCache).not.toHaveBeenCalled();
    });

    it.each([
        ['contact media that are not a list', { contactMedium: {} }, 400, 'Invalid contactMedium format'],
        ['a medium that is null', { contactMedium: [null] }, 400, 'Invalid contactMedium format'],
        ['a telephone with no number', { contactMedium: [{ mediumType: 'TelephoneNumber' }] }, 422, 'Invalid phone number'],
        ['a telephone that is not valid', { contactMedium: [PHONE('12')] }, 422, 'Invalid phone number'],
        ['characteristics that are not a list', { partyCharacteristic: {} }, 400, 'Invalid partyCharacteristic format'],
        ['a characteristic that is null', { partyCharacteristic: [null] }, 400, 'Invalid partyCharacteristic format'],
        ['a country of three letters', { partyCharacteristic: [{ name: 'country', value: 'ESP' }] }, 422, 'Invalid country code'],
        ['a country with no value', { partyCharacteristic: [{ name: 'country' }] }, 422, 'Invalid country code']
    ])('refuses %s and does not call the upstream', async (_name, changes, status, error) => {
        const res = await patch(JSON.stringify(changes));
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error });
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await call('/party/organization/p-acme', { method: 'PATCH', headers: JSON_HEADERS, body: '{}' })).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the rest of /party', () => {
    it.each([
        ['GET', '/individual'],
        ['GET', '/individual/'],
        ['POST', '/individual'],
        ['POST', '/organization'],
        ['DELETE', '/individual/p-ana'],
        ['DELETE', '/organization/p-acme'],
        ['PUT', '/individual/p-ana'],
        ['PATCH', '/individual'],
        ['POST', '/organization/p-acme'],
        ['GET', '/individual/p-ana/history'],
        ['GET', '/other'],
        ['GET', '']
    ])('%s %s is not found, neither here nor in the legacy application, and nothing is written', async (method, path) => {
        const res = await call(`/party${path}`, { method, headers: as(AS_ORGANISATION, JSON_HEADERS), ...(method === 'GET' ? {} : { body: '{"givenName":"x"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
        expect(clearCache).not.toHaveBeenCalled();
    });
});
