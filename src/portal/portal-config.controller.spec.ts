import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { ConfigDocumentRepository, type ConfigDocument } from '../persistence/config-store/config-document.repository';
import { FakeFeaturesModule, featuresOn } from '../testing/fake-features';
import { CatalogDefaults } from '../tmf/catalog/catalog-defaults';
import { TmfModule } from '../tmf/tmf.module';
import { PortalConfigContributors } from './portal-config-contributors';
import { PortalConfigController } from './portal-config.controller';
import { PortalConfigService } from './portal-config.service';

class Documents extends ConfigDocumentRepository {
    stored: ConfigDocument | undefined;
    broken = false;
    findById(): Promise<ConfigDocument | undefined> {
        return this.broken ? Promise.reject(new Error('down')) : Promise.resolve(this.stored);
    }
    upsert(): Promise<void> {
        return Promise.resolve();
    }
}
const documents = new Documents();

@Module({
    imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeaturesModule, TmfModule],
    controllers: [PortalConfigController],
    providers: [PortalConfigService, PortalConfigContributors, { provide: ConfigDocumentRepository, useValue: documents }]
})
class Root {}

const ENV = {
    BAE_PORTAL__CHAT_URL: 'https://chat.example.org',
    BAE_PORTAL__THEME: 'dark',
    // What a deployment adds: a key of its own, an object that adds to one of the proxy's, and keys that the proxy sets itself
    BAE_PORTAL__EXTRA: JSON.stringify({ about: 'https://about.example.org', roles: { certifier: 'certifier', seller: 'forged' }, chat: 'forged', siop: { enabled: true } })
};

let app: NestExpressApplication;
let url: string;
const read = async (): Promise<Record<string, unknown>> => (await (await fetch(`${url}/config`)).json()) as Record<string, unknown>;

beforeAll(async () => {
    Object.assign(process.env, ENV);
    app = await createApp(Root);
    await app.listen(0);
    url = await app.getUrl();
    app.get(CatalogDefaults).set('urn:ngsi-ld:catalog:default', { api: 'urn:ngsi-ld:category:api' });
});

afterAll(async () => {
    Object.keys(ENV).forEach((key) => delete process.env[key]);
    await app.close();
});

describe('GET /config', () => {
    it('is public and has what the portal starts with', async () => {
        featuresOn.add('quotes');
        const res = await fetch(`${url}/config`);
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(200);
        expect(body).toMatchObject({
            roles: { seller: 'Seller', customer: 'Buyer', admin: 'admin', orgAdmin: 'orgAdmin' },
            chat: 'https://chat.example.org',
            theme: 'dark',
            matomoId: '',
            searchEnabled: false,
            defaultId: 'urn:ngsi-ld:catalog:default',
            systemCategories: { api: 'urn:ngsi-ld:category:api' },
            reservedCatalogNames: ['dataset', 'api', 'blueprint'],
            quotesEnabled: true,
            purchaseEnabled: false,
            quoteApi: '/quote/quoteManagement',
            datasetFilesEnabled: false,
            datasetMaxSizeBytes: 100 * 1024 * 1024,
            datasetAcceptedTypes: '.csv,.json,text/csv,application/json'
        });
        featuresOn.clear();
    });

    it('sends what the deployment adds, and never takes from it what the proxy sets', async () => {
        const body = await read();

        expect(body['about']).toBe('https://about.example.org');
        // The login with credentials is the proxy's: it is off here, and what the deployment adds does not turn it on
        expect(body['siop']).toEqual({ enabled: false });
        expect(body['chat']).toBe('https://chat.example.org');
        expect(body['roles']).toEqual({ seller: 'Seller', customer: 'Buyer', admin: 'admin', orgAdmin: 'orgAdmin', certifier: 'certifier' });
    });

    it('has the filters of a new marketplace, or the ones that were saved with the placement that is missing', async () => {
        expect((await read())['searchFilters']).toEqual({ primaryCategoriesMode: 'catalogFirstLevel', primaryRootName: '', filters: [] });

        documents.stored = { id: 'search-filters', searchFilters: { primaryCategoriesMode: 'x', filters: [{ source: 'categoryRoot', id: 'a' }, { source: 'categoryRoot', id: 'b', offerFormPlacement: 'top' }, { source: 'other' }, 7] } };
        expect((await read())['searchFilters']).toEqual({
            primaryCategoriesMode: 'x',
            filters: [{ source: 'categoryRoot', id: 'a', offerFormPlacement: 'none' }, { source: 'categoryRoot', id: 'b', offerFormPlacement: 'top' }, { source: 'other' }, 7]
        });

        documents.stored = { id: 'search-filters', searchFilters: 'broken' };
        expect((await read())['searchFilters']).toEqual({ primaryCategoriesMode: 'catalogFirstLevel', primaryRootName: '', filters: [] });
        documents.stored = undefined;
    });

    it('still answers when the filters cannot be read', async () => {
        documents.broken = true;

        const res = await fetch(`${url}/config`);

        expect(res.status).toBe(200);
        expect(((await res.json()) as { searchFilters: unknown }).searchFilters).toEqual({ primaryCategoriesMode: 'catalogFirstLevel', primaryRootName: '', filters: [] });
        documents.broken = false;
    });

    it('has no other routes under it', async () => {
        expect((await fetch(`${url}/config/features`)).status).toBe(404);
        expect((await fetch(`${url}/config`, { method: 'POST' })).status).toBe(404);
    });
});
