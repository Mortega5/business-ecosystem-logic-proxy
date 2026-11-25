import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortalFallbackFilter, servePortal } from './portal-static';

@Controller('api')
class ApiController {
    @Get()
    read() {
        return { from: 'api' };
    }
}

@Module({ controllers: [ApiController] })
class Root {}

const dir = mkdtempSync(join(tmpdir(), 'portal-'));
let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    writeFileSync(join(dir, 'index.html'), '<html>portal</html>');
    writeFileSync(join(dir, 'main.js'), 'console.log(1)');
    app = await NestFactory.create<NestExpressApplication>(Root, { logger: false });
    app.useGlobalFilters(new PortalFallbackFilter(dir));
    servePortal(app, dir);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
});

const asBrowser = { accept: 'text/html,application/xhtml+xml' };

describe('the portal', () => {
    it('serves its files, and its page at the root', async () => {
        expect(await (await fetch(`${url}/main.js`)).text()).toBe('console.log(1)');
        expect(await (await fetch(`${url}/`)).text()).toBe('<html>portal</html>');
    });

    it('gives its page to a browser that opens a link of the portal, so it resolves the route itself', async () => {
        const res = await fetch(`${url}/dashboard/my-offerings`, { headers: asBrowser });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('<html>portal</html>');
    });

    it('does not give its page to a client of the API, which is told that there is no such route', async () => {
        const res = await fetch(`${url}/dashboard/my-offerings`, { headers: { accept: 'application/json' } });
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('Cannot GET /dashboard/my-offerings');
    });

    it('does not give its page to something that is not a GET', async () => {
        expect((await fetch(`${url}/dashboard`, { method: 'POST', headers: asBrowser })).status).toBe(404);
    });

    it('leaves the routes of the API as they are', async () => {
        expect(await (await fetch(`${url}/api`, { headers: asBrowser })).json()).toEqual({ from: 'api' });
    });
});
