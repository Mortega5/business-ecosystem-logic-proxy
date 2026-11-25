import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { FeatureGuard } from '../features/feature.guard';
import { LoggingModule } from '../logging/logging.module';
import { AS_SELLER, LOGGED_IN, useFakeLogin } from '../testing/fake-login';
import { featuresOn, FakeFeaturesModule } from '../testing/fake-features';
import { FakeUpstream } from '../testing/fake-upstream';
import { FilesModule } from './files.module';

@Module({
    imports: [AppConfigModule, LoggingModule, FakeFeaturesModule, AuthModule, FilesModule],
    providers: [{ provide: APP_GUARD, useClass: FeatureGuard }]
})
class Root {}

const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const fileService = new FakeUpstream();
const FILES: Record<string, { fileId: string, labels: Record<string, string>, visibility: string, size: number }> = {
    'f-own': { fileId: 'f-own', labels: { owner: 'p-shop' }, visibility: 'private', size: 5 },
    'f-other': { fileId: 'f-other', labels: { owner: 'p-bob' }, visibility: 'private', size: 5 }
};
const calls: { method?: string, url?: string, headers: Record<string, unknown>, body: string }[] = [];

let app: NestExpressApplication;
let url: string;

const start = async (env: Record<string, string> = {}): Promise<void> => {
    Object.assign(process.env, {
        BAE_FILE_SERVICE__ENABLED: 'true',
        BAE_FILE_SERVICE__URL: `http://127.0.0.1:${fileService.port}`,
        BAE_FILE_SERVICE__TOKEN: 'service-token',
        BAE_FILE_SERVICE__MAX_SIZE_MB: '1',
        ...env
    });
    app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
};
const stop = async (): Promise<void> => {
    await app.close();
    [
        'BAE_FILE_SERVICE__ENABLED',
        'BAE_FILE_SERVICE__URL',
        'BAE_FILE_SERVICE__TOKEN',
        'BAE_FILE_SERVICE__MAX_SIZE_MB'
    ].forEach((key) => delete process.env[key]);
};

const form = (bytes: string | Buffer, visibility?: string, name = 'data.csv'): FormData => {
    const data = new FormData();
    if (visibility !== undefined) {
        data.append('visibility', visibility);
    }
    data.append('file', new Blob([bytes as BlobPart], { type: 'text/csv' }), name);
    return data;
};

beforeAll(async () => {
    await fileService.start();
    fileService.answer((res) => {
        const request = fileService.seen;
        calls.push({
            ...(request?.method === undefined ? {} : { method: request.method }),
            ...(request?.url === undefined ? {} : { url: request.url }),
            headers: request?.headers ?? {},
            body: request?.body ?? ''
        });
        const id = /^\/api\/files\/([^/]+)(\/content)?$/.exec(request?.url ?? '')?.[1];
        if (request?.method === 'POST' && request.url === '/api/files') {
            return fileService.json(
                res,
                200,
                JSON.stringify({ fileId: 'f-new', visibility: 'private', size: 4, labels: { owner: 'p-shop' } })
            );
        }
        if (id !== undefined && request?.url?.endsWith('/content') === true) {
            res.writeHead(206, {
                'content-type': 'text/csv',
                'content-range': 'bytes 0-4/5',
                'x-secret-internal': 'no'
            });
            return void res.end('hello');
        }
        if (id !== undefined && request?.method === 'GET') {
            const file = FILES[id];
            return file === undefined
                ? fileService.json(res, 404, '{}')
                : fileService.json(res, 200, JSON.stringify(file));
        }
        if (id !== undefined && request?.method === 'PUT') {
            return fileService.json(res, 200, JSON.stringify({ ...FILES[id], size: 9 }));
        }
        if (id !== undefined && request?.method === 'DELETE') {
            res.writeHead(204);
            return void res.end();
        }
        fileService.json(res, 404, '{}');
    });
    await start();
});
afterAll(async () => {
    await stop();
    await fileService.stop();
});
beforeEach(() => {
    calls.length = 0;
    featuresOn.add('datasets');
});
afterEach(() => featuresOn.clear());

describe('POST /file', () => {
    it('streams the file of a seller to the file service with its owner as a label, and answers what the file service made', async () => {
        const res = await fetch(`${url}/file`, { method: 'POST', headers: AS_SELLER, body: form('a,b\n', 'public') });

        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ fileId: 'f-new', visibility: 'private', size: 4 });
        const [call] = calls;
        expect(call?.url).toBe('/api/files');
        expect(call?.headers['authorization']).toBe('Bearer service-token');
        expect(call?.body).toContain('name="visibility"\r\n\r\npublic');
        expect(call?.body).toContain('name="labels"\r\n\r\n{"owner":"p-shop"}');
        expect(call?.body).toContain('filename="data.csv"');
        expect(call?.body).toContain('a,b\n');
    });

    it('makes a file private unless it is said to be public, and refuses another visibility', async () => {
        await fetch(`${url}/file`, { method: 'POST', headers: AS_SELLER, body: form('x') });
        expect(calls[0]?.body).toContain('name="visibility"\r\n\r\nprivate');

        calls.length = 0;
        const res = await fetch(`${url}/file`, { method: 'POST', headers: AS_SELLER, body: form('x', 'secret') });
        expect(res.status).toBe(422);
        expect(calls).toHaveLength(0);
    });

    it('is only for sellers, and for those who are logged in, and answers after reading what was sent', async () => {
        expect((await fetch(`${url}/file`, { method: 'POST', headers: LOGGED_IN, body: form('x') })).status).toBe(403);
        expect((await fetch(`${url}/file`, { method: 'POST', body: form('x') })).status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it('refuses a file larger than the limit with a 413, and a body that is not multipart with a 400', async () => {
        const big = await fetch(`${url}/file`, {
            method: 'POST',
            headers: AS_SELLER,
            body: form(Buffer.alloc(2 * 1024 * 1024, 'a'))
        });
        expect(big.status).toBe(413);

        const plain = await fetch(`${url}/file`, {
            method: 'POST',
            headers: { ...AS_SELLER, 'content-type': 'application/json' },
            body: '{}'
        });
        expect(plain.status).toBe(400);
    });

    it('refuses a request that has other parts than the visibility and the file', async () => {
        const data = form('x');
        data.append('extra', '1');
        expect((await fetch(`${url}/file`, { method: 'POST', headers: AS_SELLER, body: data })).status).toBe(400);
    });
});

describe('GET /file/:id', () => {
    it('tells of a file of the seller without its labels, and of no other', async () => {
        const own = await fetch(`${url}/file/f-own`, { headers: AS_SELLER });
        expect(own.status).toBe(200);
        expect(await own.json()).toEqual({ fileId: 'f-own', size: 5, visibility: 'private' });

        expect((await fetch(`${url}/file/f-other`, { headers: AS_SELLER })).status).toBe(404);
        expect((await fetch(`${url}/file/f-none`, { headers: AS_SELLER })).status).toBe(404);
        expect((await fetch(`${url}/file/${encodeURIComponent('../etc')}`, { headers: AS_SELLER })).status).toBe(404);
    });

    it('is only for sellers', async () => {
        expect((await fetch(`${url}/file/f-own`, { headers: LOGGED_IN })).status).toBe(403);
    });
});

describe('GET /file/:id/content', () => {
    it('gives the bytes with the headers that matter, passing on the range, and none of the others', async () => {
        const res = await fetch(`${url}/file/f-own/content`, { headers: { ...AS_SELLER, range: 'bytes=0-4' } });

        expect(res.status).toBe(206);
        expect(await res.text()).toBe('hello');
        expect(res.headers.get('content-range')).toBe('bytes 0-4/5');
        expect(res.headers.get('x-secret-internal')).toBeNull();
        expect(calls.find((call) => call.url?.endsWith('/content'))?.headers['range']).toBe('bytes=0-4');
    });

    it('does not give the content of a file of another party', async () => {
        expect((await fetch(`${url}/file/f-other/content`, { headers: AS_SELLER })).status).toBe(404);
        expect(calls.some((call) => call.url?.endsWith('/content'))).toBe(false);
    });
});

describe('PUT /file/:id and DELETE /file/:id', () => {
    it('replaces the file of the seller and removes it', async () => {
        const replaced = await fetch(`${url}/file/f-own`, {
            method: 'PUT',
            headers: AS_SELLER,
            body: form('new bytes')
        });
        expect(replaced.status).toBe(200);
        expect(await replaced.json()).toMatchObject({ fileId: 'f-own', size: 9 });
        expect(calls.find((call) => call.method === 'PUT')?.body).toContain('new bytes');

        expect((await fetch(`${url}/file/f-own`, { method: 'DELETE', headers: AS_SELLER })).status).toBe(204);
        expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });

    it('does not replace or remove the file of another party', async () => {
        expect(
            (await fetch(`${url}/file/f-other`, { method: 'PUT', headers: AS_SELLER, body: form('x') })).status
        ).toBe(404);
        expect((await fetch(`${url}/file/f-other`, { method: 'DELETE', headers: AS_SELLER })).status).toBe(404);
        expect(calls.some((call) => call.method === 'PUT' || call.method === 'DELETE')).toBe(false);
    });
});

describe('what is not served', () => {
    it('answers 404 to anything else under /file, and when the datasets are off', async () => {
        expect((await fetch(`${url}/file/f-own/other/thing`, { headers: AS_SELLER })).status).toBe(404);
        featuresOn.clear();
        expect((await fetch(`${url}/file/f-own`, { headers: AS_SELLER })).status).toBe(404);
    });

    it('answers 404 when there is no file service', async () => {
        await stop();
        await start({ BAE_FILE_SERVICE__ENABLED: 'false' });
        featuresOn.add('datasets');
        expect((await fetch(`${url}/file/f-own`, { headers: AS_SELLER })).status).toBe(404);
        expect((await fetch(`${url}/file`, { method: 'POST', headers: AS_SELLER, body: form('x') })).status).toBe(404);
    });
});
