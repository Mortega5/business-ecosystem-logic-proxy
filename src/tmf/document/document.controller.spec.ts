import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { request } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { FakeUpstream } from '../../testing/fake-upstream';
import { useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { DocumentModule } from './document.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, DocumentModule] })
class Root {}

// The legacy application answers anything under /document
const legacy = express();
legacy.all('/document/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

let app: NestExpressApplication;
let url: string;
const ID = 'urn:ngsi-ld:document-specification:7a1c0f3e';

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port) });
    app = await createApp(legacy, Root);
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
    upstream.answer((res) => upstream.json(res, 200, '{"id":"doc"}'));
});

const call = (path: string, init: { method?: string } = {}) =>
    fetch(`${url}${path}`, { ...init, headers: LOGGED_IN });

// fetch normalises dot segments, so what an attacker sends is sent here exactly as written
const raw = (path: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = request({ host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, path, headers: LOGGED_IN }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
    });

describe('GET /document/documentSpecification/:id', () => {
    it('reads the specification from the document API of the TMForum server', async () => {
        const res = await call(`/document/documentSpecification/${encodeURIComponent(ID)}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'doc' });
        expect(upstream.seen?.method).toBe('GET');
        expect(upstream.seen?.url).toBe(`/tmf-api/documentManagement/v4/documentSpecification/${encodeURIComponent(ID)}`);
        expect(upstream.seen?.headers).toMatchObject({ 'x-actor-id': 'u-ana', 'x-party-id': 'p-ana', 'x-roles': 'buyer,' });
    });

    it('keeps the query it was given', async () => {
        await call(`/document/documentSpecification/${encodeURIComponent(ID)}?fields=name,attachment`);
        expect(upstream.seen?.url).toContain('?fields=name,attachment');
    });

    it('is private: without a user it answers 401 and calls nothing', async () => {
        const res = await fetch(`${url}/document/documentSpecification/${encodeURIComponent(ID)}`);
        expect(res.status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });

    it.each([
        ['dots', '..'],
        ['a single dot', '.'],
        ['encoded dots', '%2e%2e'],
        ['half encoded dots', '.%2e'],
        ['dots and a path parameter', '..;']
    ])('refuses an id of %s sent exactly as written', async (_name, id) => {
        const res = await raw(`/document/documentSpecification/${id}`);
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it.each([
        ['an encoded slash', 'a%2Fb'],
        ['a path parameter', 'a;b'],
        ['a space', 'a%20b'],
        ['a very long id', 'a'.repeat(201)],
        ['a query in the id', 'a%3Fb'],
        ['a backslash', 'a%5Cb']
    ])('refuses an id with %s and does not call the upstream', async (_name, id) => {
        const res = await call(`/document/documentSpecification/${id}`);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: expect.stringMatching(/Invalid/) as string });
        expect(upstream.seen).toBeUndefined();
    });
});

describe('the rest of /document', () => {
    it.each([
        ['GET', '/document/documentSpecification'],
        ['GET', '/document/documentSpecification/a/attachment'],
        ['GET', '/document/other'],
        ['GET', '/document'],
        ['GET', '/document/'],
        ['POST', '/document'],
        ['POST', `/document/documentSpecification/${ID}`],
        ['PATCH', `/document/documentSpecification/${ID}`],
        ['PUT', `/document/documentSpecification/${ID}`],
        ['DELETE', `/document/documentSpecification/${ID}`]
    ])('%s %s is not found, neither here nor in the legacy application', async (method, path) => {
        const res = await call(path, { method });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(upstream.seen).toBeUndefined();
    });
});
