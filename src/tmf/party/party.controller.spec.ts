import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_MEMBER, AS_ORGANISATION, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { OperatorService } from '../../operator/operator.service';
import { PartyModule } from './party.module';


const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, PartyModule] })
class Root {}

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
const apps: NestExpressApplication[] = [];

const answerWith = (status: number, body: string): void => upstream.answer((res) => upstream.json(res, status, body));

const serve = async (env: NodeJS.ProcessEnv = {}): Promise<string> => {
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port), ...env });
    const server = await createApp(Root);
    useFakeLogin(server);
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
});

afterEach(() => {
    vi.restoreAllMocks();
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
        ['a status that is not the directory', 'lifecycleStatus=Retired'],
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

describe('the directory of providers', () => {
    interface Asked {
        method: string | undefined;
        path: string;
        search: URLSearchParams;
    }
    let asked: Asked[];
    let engine: string;
    let offersFail: boolean;
    const SELLER = (id: string) => ({ id, role: 'Seller' });
    const BUYER = { id: 'p-ana', role: 'Buyer' };
    const OFFERS = [
        { id: 'o-1', relatedParty: [SELLER('org-b')] },
        { id: 'o-2', relatedParty: [SELLER('org-a')] },
        { id: 'o-3', relatedParty: [SELLER('org-a')] },
        { id: 'o-4', relatedParty: [SELLER('org-c')] },
        { id: 'o-5', relatedParty: [SELLER('org-d'), BUYER] },
        { id: 'o-6', relatedParty: [SELLER('p-someone')] }
    ];
    const ORGANISATIONS = [
        { id: 'org-a', tradingName: 'Alpha', href: 'org-a' },
        { id: 'org-b', tradingName: 'Zeta', href: 'org-b' },
        { id: 'org-c', tradingName: 'Mid', href: 'org-c' },
        { id: 'org-d', tradingName: 'Delta', href: 'org-d' },
        { id: 'org-x', tradingName: 'Nobody', href: 'org-x' }
    ];
    const names = async (res: Response): Promise<string[]> => ((await res.json()) as { tradingName: string }[]).map((one) => one.tradingName);
    const offerQueries = () => asked.filter((request) => request.path === `${BASE.replace('/party/v4', '/productCatalogManagement/v4')}/productOffering`);

    // Each test has a proxy of its own, as what it keeps is what the tests look at
    let fresh = '';
    const get = (path: string, init: { headers?: Record<string, string> } = {}) => call(path, { ...init, base: fresh });

    beforeEach(async () => {
        fresh = await serve();
        asked = [];
        engine = '[]';
        offersFail = false;
        upstream.answer((res) => {
            const request = upstream.seen;
            const target = new URL(`http://x${request?.url ?? ''}`);
            asked.push({ method: request?.method, path: target.pathname, search: target.searchParams });
            if (target.pathname.startsWith('/api/searchOrganizations')) {
                upstream.json(res, 200, engine);
            } else if (target.pathname.endsWith('/productOffering')) {
                const honoured = target.searchParams.get('relatedParty.role*') !== null;
                upstream.json(res, offersFail ? 500 : 200, JSON.stringify(offersFail ? {} : OFFERS.filter((offer) => !honoured || !offer.relatedParty.some((party) => party.role === 'Buyer'))));
            } else if (target.pathname.endsWith('/organization')) {
                const ids = target.searchParams.get('id')?.split(',');
                upstream.json(res, 200, JSON.stringify(ORGANISATIONS.filter((organisation) => ids === undefined || ids.includes(organisation.id))));
            } else {
                upstream.json(res, 404, '{}');
            }
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('is the sellers of the launched offerings that anybody reads, sorted by name and cut into pages that are full', async () => {
        const first = await get('/party/organization?lifecycleStatus=Launched&offset=0&limit=2&sort=tradingName');
        expect(first.status).toBe(200);
        expect(first.headers.get('x-total-count')).toBe('3');
        expect(await names(first)).toEqual(['Alpha', 'Mid']);
        const second = await get('/party/organization?lifecycleStatus=Launched&offset=2&limit=2');
        expect(await names(second)).toEqual(['Zeta']);
        expect(second.headers.get('x-total-count')).toBe('3');
        expect(await names(await get('/party/organization?lifecycleStatus=Launched&offset=0&limit=2&sort=-tradingName'))).toEqual(['Zeta', 'Mid']);
        const beyond = await get('/party/organization?lifecycleStatus=launched&offset=6&limit=2');
        expect(await beyond.json()).toEqual([]);
        expect(beyond.headers.get('x-total-count')).toBe('3');
    });

    it('asks for what the portal asked of each organisation, and for the offerings that anybody may read', async () => {
        await get('/party/organization?lifecycleStatus=Launched&offset=0&limit=2&fields=id,tradingName');
        const [offers] = offerQueries();
        expect(Object.fromEntries(offers?.search ?? [])).toMatchObject({ lifecycleStatus: 'Launched', fields: 'relatedParty', 'relatedParty.role*': '^(?!Buyer$).*$' });
        const page = asked.filter((request) => request.path.endsWith('/organization')).at(-1);
        expect(page?.search.get('id')).toBe('org-a,org-c');
        expect(page?.search.get('fields')).toBe('id,tradingName');
    });

    it('is read once for a while, whoever asks', async () => {
        await get('/party/organization?lifecycleStatus=Launched&limit=2');
        await get('/party/organization?lifecycleStatus=Launched&limit=2&offset=2', { headers: LOGGED_IN });
        expect(offerQueries()).toHaveLength(1);
    });

    it('leaves out the operator of the marketplace', async () => {
        vi.spyOn(OperatorService.prototype, 'seller').mockReturnValue({ id: 'org-a' });
        const res = await get('/party/organization?lifecycleStatus=Launched&limit=10');
        expect(await names(res)).toEqual(['Mid', 'Zeta']);
        expect(res.headers.get('x-total-count')).toBe('2');
    });

    it('is not kept when it could not be read, and the client is told', async () => {
        offersFail = true;
        expect((await get('/party/organization?lifecycleStatus=Launched&limit=2')).status).toBe(502);
        offersFail = false;
        expect((await get('/party/organization?lifecycleStatus=Launched&limit=2')).status).toBe(200);
    });

    it('does not take a keyword without a search engine, which would look like an answer that it is not', async () => {
        const res = await get('/party/organization?lifecycleStatus=Launched&keyword=cloud&limit=2');
        expect(res.status).toBe(501);
        expect(((await res.json()) as { error: string }).error).toBe('The search is not available');
        expect(asked).toEqual([]);
    });

    describe('with a search engine', () => {
        let withEngine: string;

        afterAll(() => {
            delete process.env['BAE_SEARCH__ENABLED'];
        });

        beforeAll(async () => {
            withEngine = await serve({ BAE_SEARCH__ENABLED: 'true', BAE_UPSTREAMS__SEARCH__HOST: '127.0.0.1', BAE_UPSTREAMS__SEARCH__PORT: String(upstream.port) });
        });

        it('is what the engine finds, in its order, paged by the engine', async () => {
            engine = JSON.stringify([{ id: 'org-b' }, { id: 'org-a' }]);
            const res = await call('/party/organization?lifecycleStatus=Launched&keyword=cloud%20x&offset=2&limit=2&fields=id,tradingName', { base: withEngine });
            expect(await names(res)).toEqual(['Zeta', 'Alpha']);
            const searched = asked.find((request) => request.path.startsWith('/api/searchOrganizations'));
            expect(searched).toMatchObject({ method: 'POST', path: '/api/searchOrganizations/cloud%20x' });
            expect(Object.fromEntries(searched?.search ?? [])).toEqual({ page: '1', size: '2', considerAllOrgs: 'false' });
            const page = asked.filter((request) => request.path.endsWith('/organization')).at(-1);
            expect(page?.search.get('id')).toBe('org-b,org-a');
            expect(page?.search.get('fields')).toBe('id,tradingName');
            expect(offerQueries()).toEqual([]);
        });

        it('does not take a keyword that would leave the path of the engine', async () => {
            const res = await call('/party/organization?keyword=a%2Fb&limit=2', { base: withEngine });
            expect(res.status).toBe(400);
            expect(asked).toEqual([]);
        });

        it('is what the engine finds for the launched ones too, and is empty when it finds nothing', async () => {
            const res = await call('/party/organization?lifecycleStatus=Launched&limit=2', { base: withEngine });
            expect(await res.json()).toEqual([]);
            expect(res.headers.get('x-total-count')).toBe('0');
            expect(asked.map((request) => request.path)).toEqual(['/api/searchOrganizations']);
        });
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
        expect(res.headers.get('cache-control')).toBe('private, no-store');
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
        expect(res.headers.get('cache-control')).toBe('private, no-store');
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

    it('changes the individual themselves, without id and href', async () => {
        const res = await patch('{"id":"p-victim","href":"x","givenName":"Ana"}');

        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'PATCH', url: `${BASE}/individual/p-ana`, body: '{"givenName":"Ana"}' });
    });

    it('sends what it checked, not a second copy of a key', async () => {
        await patch('{"givenName":"Mallory","givenName":"Ana"}');
        expect(upstream.seen?.body).toBe('{"givenName":"Ana"}');
    });

    it('passes on the refusal of the upstream to a change', async () => {
        answerWith(422, '{"error":"no"}');
        expect((await patch('{"givenName":"Ana"}')).status).toBe(422);
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

    it('changes the organisation, for its administrator', async () => {
        const body = JSON.stringify({ tradingName: 'Acme', contactMedium: [PHONE('+34612345678')], partyCharacteristic: [{ name: 'country', value: 'ES' }] });
        const res = await patch(body);

        expect(res.status).toBe(200);
        expect(upstream.seen).toMatchObject({ method: 'PATCH', url: `${BASE}/organization/p-acme`, body });
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
    ])('%s %s is not found, and nothing is written', async (method, path) => {
        const res = await call(`/party${path}`, { method, headers: as(AS_ORGANISATION, JSON_HEADERS), ...(method === 'GET' ? {} : { body: '{"givenName":"x"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
