import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import {
    ConfigDocumentRepository,
    type ConfigDocument
} from '../persistence/config-store/config-document.repository';
import { AS_ADMIN, AS_ORGANISATION, LOGGED_IN, useFakeLogin } from '../testing/fake-login';
import { FakeUpstream } from '../testing/fake-upstream';
import { AnalyticsConfigController } from './analytics-config.controller';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsSettings } from './analytics-settings';
import { GuestTokens } from './guest-token.service';

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
        this.stored.set(id, { id, ...fields });
        return Promise.resolve();
    }
}
const documents = new Documents();
const superset = new FakeUpstream();

@Module({
    imports: [AppConfigModule, LoggingModule, AuthModule],
    controllers: [AnalyticsController, AnalyticsConfigController],
    providers: [
        AnalyticsSettings,
        GuestTokens,
        { provide: ConfigDocumentRepository, useValue: documents }
    ]
})
class Root {}

const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const ENV = [
    'BAE_ANALYTICS__URL',
    'BAE_ANALYTICS__DASHBOARDS__BUSINESS_INSIGHTS_NON_LEAR',
    'BAE_ANALYTICS__DASHBOARDS__BUSINESS_INSIGHTS_LEAR',
    'BAE_ANALYTICS__DASHBOARDS__USAGE_MONITOR',
    'BAE_DOME__ENABLED'
];
const JSON_HEADERS = { 'content-type': 'application/json' };
let app: NestExpressApplication;
let url: string;

const start = async (env: Record<string, string> = {}): Promise<void> => {
    Object.assign(process.env, {
        BAE_ANALYTICS__URL: `http://127.0.0.1:${superset.port}`,
        BAE_ANALYTICS__DASHBOARDS__BUSINESS_INSIGHTS_NON_LEAR: 'dash-non',
        BAE_ANALYTICS__DASHBOARDS__BUSINESS_INSIGHTS_LEAR: 'dash-lear',
        BAE_ANALYTICS__DASHBOARDS__USAGE_MONITOR: 'dash-usage',
        ...env
    });
    app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
};
const stop = async (): Promise<void> => {
    await app.close();
    ENV.forEach((key) => delete process.env[key]);
};
const post = (headers: Record<string, string>, body: unknown): Promise<Response> =>
    fetch(`${url}/analytics/guest-token`, {
        method: 'POST',
        headers: { ...headers, ...JSON_HEADERS },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
const config = (method: string, headers: Record<string, string>, body?: unknown): Promise<Response> =>
    fetch(`${url}/config/analytics`, {
        method,
        headers: { ...headers, ...JSON_HEADERS },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

const valid = {
    analytics: 'https://superset.example.org',
    analyticsEnabled: true,
    analyticsDashboards: { businessInsightsNonLear: 'a', businessInsightsLear: 'b', usageMonitor: 'c' },
    analyticsSuperset: { guestTokenPath: '/guest/' }
};

beforeAll(async () => {
    await superset.start();
    superset.answer((res) => superset.json(res, 200, JSON.stringify({ token: 'guest-123' })));
    await start();
});
afterAll(async () => {
    await stop();
    await superset.stop();
});
beforeEach(() => {
    documents.stored.clear();
    documents.broken = false;
});

describe('POST /analytics/guest-token', () => {
    it('gives who is logged in the token of their dashboard, asked with their own access token', async () => {
        const res = await post(LOGGED_IN, { tab: 'businessInsights' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ dashboardId: 'dash-non', token: 'guest-123' });
        expect(superset.seen?.headers['authorization']).toBe('Bearer ana');

        expect(await (await post(AS_ORGANISATION, { tab: 'businessInsights' })).json()).toMatchObject({
            dashboardId: 'dash-lear'
        });
        expect(await (await post(AS_ADMIN, { tab: 'usageMonitor' })).json()).toMatchObject({
            dashboardId: 'dash-usage'
        });
    });

    it('is private, and the usage monitor is for administrators', async () => {
        expect((await post({}, { tab: 'businessInsights' })).status).toBe(401);
        expect((await post(LOGGED_IN, { tab: 'usageMonitor' })).status).toBe(403);
    });

    it('refuses a tab that is not one and a body that is not JSON', async () => {
        for (const body of [{ tab: 'other' }, {}, { tab: 5 }]) {
            expect((await post(LOGGED_IN, body)).status).toBe(400);
        }
        expect((await post(LOGGED_IN, 'not json')).status).toBe(400);
    });

    it('closes the rest of /analytics', async () => {
        expect((await fetch(`${url}/analytics/other`, { headers: LOGGED_IN })).status).toBe(404);
        expect((await fetch(`${url}/analytics/guest-token/x`, { headers: LOGGED_IN })).status).toBe(404);
    });
});

describe('GET and PATCH /config/analytics', () => {
    it('are for administrators', async () => {
        expect((await config('GET', {})).status).toBe(401);
        expect((await config('GET', LOGGED_IN)).status).toBe(403);
        expect((await config('PATCH', LOGGED_IN, valid)).status).toBe(403);
    });

    it('read the settings of the configuration, and save what the administrator sends, which then wins', async () => {
        const before = await config('GET', AS_ADMIN);
        expect(await before.json()).toMatchObject({
            analyticsEnabled: true,
            analyticsSuperset: { guestTokenPath: '/api/v1/dome/guest_token/' }
        });

        const saved = await config('PATCH', AS_ADMIN, valid);
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual(valid);
        expect(documents.stored.get('analytics')).toMatchObject({ analytics: valid });
        expect(await (await config('GET', AS_ADMIN)).json()).toEqual(valid);
    });

    it('refuse settings that are not valid, saying what is wrong, and a database that fails', async () => {
        const wrong = await config('PATCH', AS_ADMIN, { ...valid, analytics: 'ftp://x.example.org' });
        expect(wrong.status).toBe(400);
        expect(((await wrong.json()) as { error: string }).error).toContain('analytics is required');
        expect(documents.stored.size).toBe(0);

        documents.broken = true;
        expect((await config('PATCH', AS_ADMIN, valid)).status).toBe(502);
    });
});

describe('with the DOME extension off', () => {
    it('is still served: the analytics are not a piece of the extension', async () => {
        await stop();
        await start({ BAE_DOME__ENABLED: 'false' });
        expect((await config('GET', AS_ADMIN)).status).toBe(200);
        expect((await post(LOGGED_IN, { tab: 'businessInsights' })).status).not.toBe(404);
    });
});
