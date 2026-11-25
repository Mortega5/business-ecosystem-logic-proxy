import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
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

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    app = await createApp(TestRootModule);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
});

describe('bootstrap', () => {
    it('serves the routes of the application', async () => {
        expect(await (await fetch(`${url}/new`)).json()).toEqual({ from: 'nest' });
        expect(await (await fetch(`${url}/new`, { method: 'POST' })).json()).toEqual({ from: 'nest-post' });
    });

    it('does not say it is Express', async () => {
        expect((await fetch(`${url}/new`)).headers.get('x-powered-by')).toBeNull();
    });

    it('answers a route that does not exist with a 404 that says what was asked for', async () => {
        const res = await fetch(`${url}/nothing/here`, { method: 'POST' });
        expect(res.status).toBe(404);
        expect(await res.text()).toContain('Cannot POST /nothing/here');
    });
});
