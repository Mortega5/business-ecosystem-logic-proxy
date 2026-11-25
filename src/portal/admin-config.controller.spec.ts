import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { FeatureFlagService } from '../features/feature-flag.service';
import { SearchSettings } from '../features/search-settings';
import { LoggingModule } from '../logging/logging.module';
import { ConfigDocumentRepository, type ConfigDocument } from '../persistence/config-store/config-document.repository';
import { AS_ADMIN, useFakeLogin, LOGGED_IN } from '../testing/fake-login';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';

class Documents extends ConfigDocumentRepository {
    stored = new Map<string, ConfigDocument>();
    broken = false;
    findById(id: string): Promise<ConfigDocument | undefined> {
        return Promise.resolve(this.stored.get(id));
    }
    upsert(id: string, fields: Record<string, unknown>): Promise<void> {
        if (this.broken) {
            return Promise.reject(new Error('down'));
        }
        this.stored.set(id, { ...this.stored.get(id), id, ...fields });
        return Promise.resolve();
    }
}
const documents = new Documents();

@Module({
    imports: [AppConfigModule, LoggingModule, AuthModule],
    controllers: [AdminConfigController],
    providers: [AdminConfigService, FeatureFlagService, SearchSettings, { provide: ConfigDocumentRepository, useValue: documents }]
})
class Root {}

const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const JSON_HEADERS = { 'content-type': 'application/json' };
const ADMIN = { ...AS_ADMIN, ...JSON_HEADERS };
const USER = { ...LOGGED_IN, ...JSON_HEADERS };
let app: NestExpressApplication;
let url: string;

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
        method: init.method ?? 'PATCH',
        headers: init.headers ?? ADMIN,
        ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) })
    });
const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

beforeAll(async () => {
    app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(() => app.close());

beforeEach(() => {
    documents.stored.clear();
    documents.broken = false;
});

describe('every route', () => {
    it('is for an administrator', async () => {
        for (const [method, path, body] of [['PATCH', '/config/features', { quotesEnabled: true }], ['PATCH', '/config/filters', {}], ['GET', '/config/search', undefined], ['PATCH', '/config/search', {}]] as const) {
            expect((await call(path, { method, headers: JSON_HEADERS, body })).status, `${method} ${path} without a login`).toBe(401);
            expect((await call(path, { method, headers: USER, body })).status, `${method} ${path} as a user`).toBe(403);
        }
        expect(documents.stored.size).toBe(0);
    });

    it('leaves the settings of the analytics to the legacy application', async () => {
        expect(await (await call('/config/analytics', { method: 'GET' })).json()).toEqual({ from: 'legacy' });
    });
});

describe('PATCH /config/features', () => {
    it('changes some flags, keeps the ones that were saved and gives the flags that are in force', async () => {
        const first = await call('/config/features', { body: { quotesEnabled: true } });
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({ quotesEnabled: true });

        const second = await call('/config/features', { body: { tenderingEnabled: true, quotesEnabled: false } });

        expect(await second.json()).toMatchObject({ quotesEnabled: false, tenderingEnabled: true });
        expect(documents.stored.get('feature-flags')?.['features']).toEqual({ quotesEnabled: false, tenderingEnabled: true });
    });

    it('refuses what is not a flag that exists, a value that is not a boolean and an empty change, and says which', async () => {
        expect(await errorOf(await call('/config/features', { body: {} }))).toContain('At least one feature flag is required');
        expect(await errorOf(await call('/config/features', { body: { nothing: true } }))).toContain('nothing is not a configurable feature flag');
        expect(await errorOf(await call('/config/features', { body: { quotesEnabled: 'yes' } }))).toContain('quotesEnabled must be a boolean');
        expect((await call('/config/features', { body: '[]' })).status).toBe(400);
        expect(documents.stored.size).toBe(0);
    });

    it('is an error, and not a flag that looks changed, when the database fails', async () => {
        documents.broken = true;

        expect((await call('/config/features', { body: { quotesEnabled: true } })).status).toBe(500);
    });
});

describe('PATCH /config/filters', () => {
    const rooted = (filters: unknown[]) => ({ primaryCategoriesMode: 'rooted', primaryRootName: ' Root ', filters });

    it('keeps the default filters for the first level of the catalog whatever else is sent', async () => {
        const res = await call('/config/filters', { body: { primaryCategoriesMode: 'catalogFirstLevel', primaryRootName: 'x', filters: [{ junk: true }] } });

        expect(await res.json()).toEqual({ primaryCategoriesMode: 'catalogFirstLevel', primaryRootName: '', filters: [] });
    });

    it('saves the filters in their normal form', async () => {
        const res = await call('/config/filters', {
            body: rooted([
                { name: ' Country ', label: 'Country', source: 'configured', children: [{ name: 'ES', label: 'Spain', extra: 1 }], junk: 1 },
                { name: 'Type', source: 'categoryRoot', rootName: ' Types ', offerFormPlacement: 'generalInfo' }
            ])
        });
        const expected = {
            primaryCategoriesMode: 'rooted',
            primaryRootName: 'Root',
            filters: [
                { name: 'Country', source: 'configured', label: 'Country', children: [{ name: 'ES', label: 'Spain' }] },
                { name: 'Type', source: 'categoryRoot', offerFormPlacement: 'generalInfo', rootName: 'Types' }
            ]
        };

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(expected);
        expect(documents.stored.get('search-filters')?.['searchFilters']).toEqual(expected);
    });

    it('refuses what is wrong with the filters, all of it in the message', async () => {
        const message = await errorOf(
            await call('/config/filters', {
                body: rooted([
                    7,
                    { name: '', source: 'other' },
                    { name: 'A', source: 'configured', offerFormPlacement: 'generalInfo', children: [{ name: 'x', source: 'y' }, 3] },
                    { name: 'B', source: 'categoryRoot', children: [1] },
                    { name: 'C', source: 'categoryRoot', rootName: 'r', offerFormPlacement: 'generalInfo' },
                    { name: 'D', source: 'categoryRoot', rootName: 'r', offerFormPlacement: 'generalInfo' }
                ])
            })
        );

        for (const wrong of ['filters[0] must be an object', 'filters[1].name is required', 'filters[1].source must be one of', 'filters[2].offerFormPlacement must be none when source is configured', 'filters[2].children[0] must not include source', 'filters[2].children[1] must be an object', 'filters[3].rootName is required', 'filters[3].children must be empty', 'Only one filter may use offerFormPlacement generalInfo']) {
            expect(message, wrong).toContain(wrong);
        }
        expect(documents.stored.size).toBe(0);
    });

    it('refuses a body that has not what it needs', async () => {
        expect(await errorOf(await call('/config/filters', { body: {} }))).toContain('primaryCategoriesMode is required');
        expect(await errorOf(await call('/config/filters', { body: { primaryCategoriesMode: 'rooted', primaryRootName: '  ', filters: [] } }))).toContain('primaryRootName must be non-empty');
    });
});

describe('/config/search', () => {
    it('gives the address of the engine, which is the one of the configuration, and how the keyword is sent', async () => {
        const res = await call('/config/search', { method: 'GET' });

        expect(await res.json()).toEqual({ searchUrl: '', useQueryKeyword: false });
    });

    it('saves how the keyword is sent when the address is the one that is in force', async () => {
        const res = await call('/config/search', { body: { searchUrl: '', useQueryKeyword: true } });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ searchUrl: '', useQueryKeyword: true });
        expect(documents.stored.get('search')?.['search']).toEqual({ searchUrl: '', useQueryKeyword: true });
        expect(await (await call('/config/search', { method: 'GET' })).json()).toEqual({ searchUrl: '', useQueryKeyword: true });
    });

    it('does not change the address of the engine', async () => {
        const res = await call('/config/search', { body: { searchUrl: 'https://elsewhere.example.org', useQueryKeyword: true } });

        expect(res.status).toBe(400);
        expect(await errorOf(res)).toContain('set by the configuration of the proxy');
        expect(documents.stored.size).toBe(0);
    });

    it('refuses a body that has not an address and a boolean', async () => {
        expect(await errorOf(await call('/config/search', { body: { useQueryKeyword: true } }))).toContain('searchUrl is required and must be a string');
        expect(await errorOf(await call('/config/search', { body: { searchUrl: '' } }))).toContain('useQueryKeyword is required and must be a boolean');
    });
});
