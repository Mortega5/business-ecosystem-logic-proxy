import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './bootstrap';
import { AppConfigModule } from './config/app-config.module';
import { LoggingModule } from './logging/logging.module';

@Controller('new')
class NewController {
    @Get()
    read() {
        return { from: 'nest' };
    }

    @Post()
    create() {
        return { from: 'nest-post' };
    }
}

@Module({ imports: [AppConfigModule, LoggingModule], controllers: [NewController] })
class TestRootModule {}

// An Express 4 app standing in for server.js, with the kind of routes and body handling it has
const legacy = express();
legacy.use(express.text({ type: () => true, limit: '50mb' }));
legacy.get('/legacy/hello', (_req, res) => {
    res.json({ from: 'legacy' });
});
legacy.all('/api/*', (req, res) => {
    res.json({ from: 'legacy-wildcard', path: req.path, body: req.body as unknown });
});
legacy.get('/query', (req, res) => {
    // read after an async hop, as the legacy middleware chain does
    setImmediate(() => {
        res.json({ query: req.query });
    });
});
legacy.get('/boom', () => {
    throw new Error('legacy failure');
});
legacy.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
});

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    app = await createApp(legacy, TestRootModule);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
});

describe('hybrid bootstrap', () => {
    it('serves the routes Nest owns', async () => {
        const res = await fetch(`${url}/new`);

        expect(await res.json()).toEqual({ from: 'nest' });
    });

    it('serves the routes Nest owns for other methods', async () => {
        const res = await fetch(`${url}/new`, { method: 'POST' });

        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ from: 'nest-post' });
    });

    it('falls back to the legacy app for the rest', async () => {
        const res = await fetch(`${url}/legacy/hello`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ from: 'legacy' });
    });

    it('keeps Express 4 wildcard routes working in the legacy app', async () => {
        const res = await fetch(`${url}/api/anything/deep?x=1`);

        expect(await res.json()).toMatchObject({ from: 'legacy-wildcard', path: '/api/anything/deep' });
    });

    it('hands the legacy app the request body untouched, as raw text', async () => {
        const body = '{"keep": "spacing",  "as": 1}';

        const res = await fetch(`${url}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

        expect(await res.json()).toMatchObject({ body });
    });

    it('keeps req.query available to the legacy app', async () => {
        const res = await fetch(`${url}/query?fields=name&limit=2`);

        expect(await res.json()).toEqual({ query: { fields: 'name', limit: '2' } });
    });

    it('parses nested query keys the way Express 4 does', async () => {
        const res = await fetch(`${url}/query?filter[status]=Launched&relatedParty.role=seller`);

        expect(await res.json()).toEqual({ query: { filter: { status: 'Launched' }, 'relatedParty.role': 'seller' } });
    });

    it('lets the legacy error handling answer its own failures', async () => {
        const res = await fetch(`${url}/boom`);

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'legacy failure' });
    });

    it('answers unknown routes like Express does', async () => {
        const res = await fetch(`${url}/does/not/exist`);

        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(await res.text()).toContain('<pre>Cannot GET /does/not/exist</pre>');
    });
});
