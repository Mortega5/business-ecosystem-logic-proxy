import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LegacyAuthBridge } from '../../legacy/legacy-auth.bridge';
import { LoggingModule } from '../../logging/logging.module';
import { fakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { SearchModule } from './search.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, SearchModule] })
class Root {}

// The legacy application answers anything under /search-bck
const legacy = express();
legacy.all('/search-bck/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

let app: NestExpressApplication;
let url: string;
const FILTERS = '{"categories":["Cloud"],"countries":["ES"]}';
const JSON_HEADERS = { ...LOGGED_IN, 'content-type': 'application/json' };

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, {
        BAE_UPSTREAMS__SEARCH__HOST: '127.0.0.1',
        BAE_UPSTREAMS__SEARCH__PORT: String(upstream.port),
        BAE_HTTP__BODY_LIMIT: '1kb'
    });
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
    upstream.reset();
    upstream.answer((res) => upstream.json(res, 200, '{"content":[]}'));
});

const search = (body: string | undefined, headers: Record<string, string> = JSON_HEADERS, query = '?page=0&size=100') =>
    fetch(`${url}/search-bck/api/searchOrganizations${query}`, { method: 'POST', headers, ...(body === undefined ? {} : { body }) });

describe('POST /search-bck/api/searchOrganizations', () => {
    it('sends the filters as they came, with the page and the size, to the search service', async () => {
        const res = await search(FILTERS);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ content: [] });
        expect(upstream.seen?.method).toBe('POST');
        expect(upstream.seen?.url).toBe('/api/searchOrganizations?page=0&size=100');
        expect(upstream.seen?.headers['content-type']).toBe('application/json');
        expect(upstream.seen?.headers).toMatchObject({ 'x-actor-id': 'u-ana', 'x-party-id': 'p-ana' });
        expect(upstream.seen?.body).toBe(FILTERS);
    });

    it('is private: without a user it answers 401 and calls nothing', async () => {
        const res = await search(FILTERS, { 'content-type': 'application/json' });
        expect(res.status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });

    it.each([
        ['no body', undefined],
        ['text that is not JSON', 'not json'],
        ['JSON that is a string', '"filters"'],
        ['JSON that is a number', '7'],
        ['JSON null', 'null']
    ])('refuses %s and does not call the upstream', async (_name, body) => {
        const res = await search(body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Invalid body' });
        expect(upstream.seen).toBeUndefined();
    });

    it('refuses a body bigger than the limit with 413, in the shape the portal reads', async () => {
        const res = await search(JSON.stringify({ filler: 'x'.repeat(2000) }));
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: expect.any(String) as string });
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the lists the search filters by', () => {
    it.each(['categories', 'countries', 'complianceLevels'])('GET /search-bck/api/%s goes to the search service', async (name) => {
        const res = await fetch(`${url}/search-bck/api/${name}`, { headers: LOGGED_IN });
        expect(res.status).toBe(200);
        expect(upstream.seen?.method).toBe('GET');
        expect(upstream.seen?.url).toBe(`/api/${name}`);
    });

    it.each(['categories', 'countries', 'complianceLevels'])('GET /search-bck/api/%s is private', async (name) => {
        expect((await fetch(`${url}/search-bck/api/${name}`)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the rest of /search-bck', () => {
    it.each([
        ['GET', '/search-bck/api/searchOrganizations'],
        ['PUT', '/search-bck/api/searchOrganizations'],
        ['POST', '/search-bck/api/categories'],
        ['DELETE', '/search-bck/api/countries'],
        ['GET', '/search-bck/api/other'],
        ['GET', '/search-bck/api/categories/1'],
        ['GET', '/search-bck'],
        ['GET', '/search-bck/'],
        ['POST', '/search-bck']
    ])('%s %s is not found, neither here nor in the legacy application', async (method, path) => {
        const res = await fetch(`${url}${path}`, { method, headers: JSON_HEADERS, ...(method === 'POST' ? { body: FILTERS } : {}) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
