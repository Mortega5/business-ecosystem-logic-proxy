import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { request } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { FeatureFlagService } from '../../features/feature-flag.service';
import { FeatureGuard } from '../../features/feature.guard';
import { LoggingModule } from '../../logging/logging.module';
import { ConfigDocumentRepository, type ConfigDocument } from '../../persistence/config-store/config-document.repository';
import { AS_ADMIN, AS_ORGANISATION, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { QuoteModule } from './quote.module';

// The feature-flags document of the database, which a test can change
class Documents extends ConfigDocumentRepository {
    document: ConfigDocument | undefined;

    findById(): Promise<ConfigDocument | undefined> {
        return Promise.resolve(this.document);
    }

    upsert(): Promise<void> {
        return Promise.resolve();
    }
}

const documents = new Documents();

@Module({
    imports: [AppConfigModule, LoggingModule, AuthModule, QuoteModule],
    providers: [{ provide: ConfigDocumentRepository, useValue: documents }, FeatureFlagService, { provide: APP_GUARD, useClass: FeatureGuard }]
})
class Root {}

// The legacy application answers anything under /quote
const legacy = express();
legacy.all('/quote/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

const upstream = new FakeUpstream();
const apps: NestExpressApplication[] = [];
const ID = 'urn:ngsi-ld:quote:7a1c0f3e';
const ENC = encodeURIComponent(ID);
const ROOT = '/quote/quoteManagement';
const JSON_LOGGED_IN = { ...LOGGED_IN, 'content-type': 'application/json' };

const serve = async (env: NodeJS.ProcessEnv = {}): Promise<string> => {
    Object.assign(process.env, {
        BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1',
        BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port),
        BAE_HTTP__BODY_LIMIT: '1kb',
        BAE_HTTP__UPLOAD_LIMIT: '1kb',
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
    await upstream.start();
    url = await serve();
});

afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await upstream.stop();
});

beforeEach(() => {
    upstream.reset();
    upstream.answer((res) => upstream.json(res, 200, '{"ok":true}'));
});

afterEach(() => {
    vi.useRealTimers();
    documents.document = undefined;
    delete process.env.BAE_QUOTES__ENABLED;
    delete process.env.BAE_TENDERING__ENABLED;
});

const call = (path: string, method = 'GET', body?: string, headers: Record<string, string> = JSON_LOGGED_IN, base = url) =>
    fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });

describe('the routes of the portal', () => {
    it.each([
        ['POST', '/createQuote', '/quoteManagement/createQuote', '{"a":1}'],
        ['POST', '/quote', '/quoteManagement/quote', '{"a":1}'],
        ['GET', '/quote', '/quoteManagement/quote', undefined],
        ['GET', `/quoteById/${ENC}`, `/quoteManagement/quoteById/${ENC}`, undefined],
        ['DELETE', `/quote/${ENC}`, `/quoteManagement/quote/${ENC}`, undefined],
        ['PATCH', `/updateQuoteStatus/${ENC}`, `/quoteManagement/updateQuoteStatus/${ENC}`, '{"status":"accepted"}'],
        ['PATCH', `/updateQuoteDate/${ENC}`, `/quoteManagement/updateQuoteDate/${ENC}`, undefined],
        ['PATCH', `/addNoteToQuote/${ENC}`, `/quoteManagement/addNoteToQuote/${ENC}`, undefined],
        ['GET', '/quoteByUser/p-ana', '/quoteManagement/quoteByUser/p-ana', undefined],
        ['POST', '/tendering/createCoordinatorQuote', '/quoteManagement/tendering/createCoordinatorQuote', '{"a":1}'],
        ['POST', '/tendering/createQuote', '/quoteManagement/tendering/createQuote', '{"a":1}'],
        ['GET', '/tendering/coordinatorQuotes/p-ana', '/quoteManagement/tendering/coordinatorQuotes/p-ana', undefined],
        ['GET', '/tendering/quotes/p-ana', '/quoteManagement/tendering/quotes/p-ana', undefined],
        ['POST', '/tendering/broadcastMessage', '/quoteManagement/tendering/broadcastMessage', '{"a":1}']
    ])('%s %s goes to %s', async (method, path, expected, body) => {
        const res = await call(`${ROOT}${path}?page=2&filter[status]=open`, method, body);

        expect(res.status).toBe(200);
        expect(upstream.seen?.method).toBe(method);
        expect(upstream.seen?.url).toBe(`${expected}?page=2&filter[status]=open`);
        expect(upstream.seen?.body).toBe(body ?? '');
        expect(upstream.seen?.headers).toMatchObject({ 'x-actor-id': 'u-ana', 'x-party-id': 'p-ana' });
    });

    it.each([
        ['POST', '/quote'],
        ['POST', '/createQuote'],
        ['POST', '/tendering/broadcastMessage']
    ])('%s %s refuses a body that is not JSON, or none', async (method, path) => {
        for (const body of [undefined, 'not json', '"text"', '7']) {
            const res = await call(`${ROOT}${path}`, method, body);
            expect(res.status).toBe(400);
        }
        expect(upstream.seen).toBeUndefined();
    });

    it('lets a route that may come with no body come with one, and refuses a broken one', async () => {
        expect((await call(`${ROOT}/updateQuoteStatus/${ENC}`, 'PATCH', '{"status":"x"}')).status).toBe(200);
        expect(upstream.seen?.body).toBe('{"status":"x"}');
        upstream.reset();
        expect((await call(`${ROOT}/updateQuoteStatus/${ENC}`, 'PATCH', 'not json')).status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('refuses a body bigger than the limit with 413', async () => {
        const res = await call(`${ROOT}/quote`, 'POST', JSON.stringify({ filler: 'x'.repeat(2000) }));
        expect(res.status).toBe(413);
        expect(upstream.seen).toBeUndefined();
    });

    it.each(['..', '%2e%2e', 'a%2Fb', 'a b', 'a;b'])('refuses the id %s and does not call the upstream', async (id) => {
        const res = await call(`${ROOT}/quoteById/${id.replace(' ', '%20')}`);
        expect([400, 404]).toContain(res.status);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        for (const [method, path] of [['GET', '/quote'], ['POST', '/quote'], ['PATCH', `/addAttachmentToQuote/${ENC}`], ['GET', '/tendering/quotes/p-ana']]) {
            expect((await call(`${ROOT}${path}`, method, undefined, {})).status).toBe(401);
        }
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the routes that name a user', () => {
    const PATHS = ['quoteByUser', 'tendering/coordinatorQuotes', 'tendering/quotes'];

    it.each(PATHS)('%s is for the party of the caller, whichever way it is asked', async (path) => {
        expect((await call(`${ROOT}/${path}/p-ana`)).status).toBe(200);
        expect(upstream.seen?.url).toBe(`/quoteManagement/${path}/p-ana`);
    });

    it.each(PATHS)('%s refuses the party of somebody else without calling the upstream', async (path) => {
        const res = await call(`${ROOT}/${path}/p-other`);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: expect.any(String) as string });
        expect(upstream.seen).toBeUndefined();
    });

    it.each(PATHS)('%s lets an administrator ask for any party', async (path) => {
        expect((await call(`${ROOT}/${path}/p-other`, 'GET', undefined, AS_ADMIN)).status).toBe(200);
    });

    it.each(PATHS)('%s lets who acts for an organisation ask for the organisation and for themselves, and no one else', async (path) => {
        expect((await call(`${ROOT}/${path}/p-acme`, 'GET', undefined, AS_ORGANISATION)).status).toBe(200);
        expect((await call(`${ROOT}/${path}/p-ana`, 'GET', undefined, AS_ORGANISATION)).status).toBe(200);
        upstream.reset();
        expect((await call(`${ROOT}/${path}/p-other`, 'GET', undefined, AS_ORGANISATION)).status).toBe(403);
        expect(upstream.seen).toBeUndefined();
    });

    it.each(PATHS)('%s answers 400 for what is not an id, before it looks at whose it is', async (path) => {
        expect((await call(`${ROOT}/${path}/a%20b`)).status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the upload of an attachment', () => {
    const BOUNDARY = '----quote-test-boundary';
    // Bytes that are not text: a body read as text would not come out the same
    const FILE = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe, 0x80, 0x0d, 0x0a, 0xc3, 0x28]);
    const multipart = (file: Buffer): Buffer =>
        Buffer.concat([
            Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
            file,
            Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="description"\r\n\r\nterms\r\n--${BOUNDARY}--\r\n`)
        ]);
    const headers = { ...LOGGED_IN, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

    it('reaches the quote service byte for byte, with its boundary', async () => {
        const body = multipart(FILE);
        const res = await fetch(`${url}${ROOT}/addAttachmentToQuote/${ENC}`, { method: 'PATCH', headers, body: new Uint8Array(body) });

        expect(res.status).toBe(200);
        expect(upstream.seen?.url).toBe(`/quoteManagement/addAttachmentToQuote/${ENC}`);
        expect(upstream.seen?.headers['content-type']).toBe(headers['content-type']);
        expect(upstream.seen?.bytes.equals(body)).toBe(true);
    });

    it('is refused when it is not multipart', async () => {
        const res = await call(`${ROOT}/addAttachmentToQuote/${ENC}`, 'PATCH', '{"a":1}');
        expect(res.status).toBe(415);
        expect(upstream.seen).toBeUndefined();
    });

    it('is refused at once when it declares more than the limit', async () => {
        const res = await fetch(`${url}${ROOT}/addAttachmentToQuote/${ENC}`, { method: 'PATCH', headers, body: new Uint8Array(multipart(Buffer.alloc(2048, 1))) });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 'Upload too large' });
    });

    it('is cut off when it goes over the limit without having said so', async () => {
        const target = new URL(url);
        const status = await new Promise<number>((resolve, reject) => {
            const req = request(
                { host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, path: `${ROOT}/addAttachmentToQuote/${ENC}`, method: 'PATCH', headers: { ...headers, 'transfer-encoding': 'chunked' } },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                }
            );
            req.on('error', reject);
            req.write(Buffer.alloc(900, 1));
            req.write(Buffer.alloc(900, 1));
            req.end(Buffer.alloc(900, 1));
        });
        expect(status).toBe(413);
    });

    it('is private', async () => {
        const res = await fetch(`${url}${ROOT}/addAttachmentToQuote/${ENC}`, { method: 'PATCH', headers: { 'content-type': headers['content-type'] }, body: new Uint8Array(multipart(FILE)) });
        expect(res.status).toBe(401);
    });
});

describe('the features', () => {
    it('close the tendering routes when tendering is off and leave the quotes', async () => {
        const off = await serve({ BAE_TENDERING__ENABLED: 'false' });
        expect((await call(`${ROOT}/tendering/quotes/p-ana`, 'GET', undefined, JSON_LOGGED_IN, off)).status).toBe(404);
        expect((await call(`${ROOT}/tendering/createQuote`, 'POST', '{"a":1}', JSON_LOGGED_IN, off)).status).toBe(404);
        expect((await call(`${ROOT}/quote`, 'GET', undefined, JSON_LOGGED_IN, off)).status).toBe(200);
    });

    it('close the quote routes when quotes are off and leave the tendering ones', async () => {
        const off = await serve({ BAE_QUOTES__ENABLED: 'false' });
        expect((await call(`${ROOT}/quote`, 'GET', undefined, JSON_LOGGED_IN, off)).status).toBe(404);
        expect((await call(`${ROOT}/addAttachmentToQuote/${ENC}`, 'PATCH', undefined, JSON_LOGGED_IN, off)).status).toBe(404);
        expect((await call(`${ROOT}/tendering/quotes/p-ana`, 'GET', undefined, JSON_LOGGED_IN, off)).status).toBe(200);
    });
});

describe('a change of the features in the database', () => {
    const quotes = (base: string) => call(`${ROOT}/quote`, 'GET', undefined, JSON_LOGGED_IN, base).then((res) => res.status);
    // The value is kept for a few seconds; only the clock is moved, not the timers the requests use
    const later = (): void => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 6000);
    };

    it('reaches a route that is running, without a restart', async () => {
        const live = await serve();
        expect(await quotes(live)).toBe(200);

        documents.document = { id: 'feature-flags', features: { quotesEnabled: false } };
        expect(await quotes(live)).toBe(200);
        later();
        expect(await quotes(live)).toBe(404);

        documents.document = { id: 'feature-flags', features: { quotesEnabled: true } };
        later();
        expect(await quotes(live)).toBe(200);
    });

    it('can turn on what the configuration has off', async () => {
        const live = await serve({ BAE_TENDERING__ENABLED: 'false' });
        const tenders = () => call(`${ROOT}/tendering/quotes/p-ana`, 'GET', undefined, JSON_LOGGED_IN, live).then((res) => res.status);
        expect(await tenders()).toBe(404);

        documents.document = { id: 'feature-flags', features: { tenderingEnabled: true } };
        later();
        expect(await tenders()).toBe(200);
    });
});

describe('the rest of /quote', () => {
    it.each([
        ['GET', '/quote'],
        ['GET', '/quote/'],
        ['GET', '/quote/quoteManagement'],
        ['GET', `${ROOT}/other`],
        ['GET', `${ROOT}/createQuote`],
        ['POST', `${ROOT}/quoteById/${ENC}`],
        ['PUT', `${ROOT}/quote/${ENC}`],
        ['DELETE', `${ROOT}/quote`],
        ['GET', `${ROOT}/tendering/other`],
        ['GET', `${ROOT}/listAllQuotes`]
    ])('%s %s is not found, neither here nor in the legacy application', async (method, path) => {
        const res = await call(path, method, method === 'POST' || method === 'PUT' ? '{"a":1}' : undefined);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
