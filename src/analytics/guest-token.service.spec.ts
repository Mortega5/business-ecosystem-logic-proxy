import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadGatewayError, DomainError, ForbiddenError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import { FakeUpstream } from '../testing/fake-upstream';
import type { AnalyticsConfig } from './analytics-config';
import type { AnalyticsSettings } from './analytics-settings';
import { GuestTokens } from './guest-token.service';

const superset = new FakeUpstream();
let current: AnalyticsConfig;
let tokens: GuestTokens;

const configFor = (timeoutMs = 2000) =>
    ({
        auth: { roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' } },
        analytics: { timeoutMs }
    }) as unknown as AppConfigService;
const user = (roles: string[], accessToken: string | undefined = 'tok-ana') => ({
    id: 'u1',
    roles: roles.map((name) => ({ name })),
    ...(accessToken === undefined ? {} : { accessToken })
});

beforeAll(async () => {
    await superset.start();
});
afterAll(() => superset.stop());
beforeEach(() => {
    superset.reset();
    superset.answer((res) => superset.json(res, 200, JSON.stringify({ token: 'guest-123' })));
    current = {
        analytics: `http://127.0.0.1:${superset.port}`,
        analyticsEnabled: true,
        analyticsDashboards: {
            businessInsightsNonLear: 'dash-non',
            businessInsightsLear: 'dash-lear',
            usageMonitor: 'dash-usage'
        },
        analyticsSuperset: { guestTokenPath: '/api/v1/dome/guest_token/' }
    };
    tokens = new GuestTokens({ current: () => Promise.resolve(current) } as unknown as AnalyticsSettings, configFor());
});

describe('GuestTokens: which dashboard', () => {
    it('gives a user the non-Lear business dashboard, an organisation administrator the Lear one, and an administrator the usage monitor', async () => {
        expect((await tokens.create(user(['Buyer']), 'businessInsights')).dashboardId).toBe('dash-non');
        expect((await tokens.create(user(['orgAdmin']), 'businessInsights')).dashboardId).toBe('dash-lear');
        expect((await tokens.create(user(['ADMIN']), 'usageMonitor')).dashboardId).toBe('dash-usage');
    });

    it('refuses the usage monitor to whoever is not an administrator, without asking Superset', async () => {
        await expect(tokens.create(user(['orgAdmin']), 'usageMonitor')).rejects.toBeInstanceOf(ForbiddenError);
        expect(superset.seen).toBeUndefined();
    });
});

describe('GuestTokens: what is asked of Superset', () => {
    it('asks with the token of the user and the dashboard, and gives back the guest token', async () => {
        const created = await tokens.create(user(['Buyer']), 'businessInsights');

        expect(created).toEqual({ dashboardId: 'dash-non', token: 'guest-123' });
        expect(superset.seen?.method).toBe('POST');
        expect(superset.seen?.url).toBe('/api/v1/dome/guest_token/');
        expect(superset.seen?.headers['authorization']).toBe('Bearer tok-ana');
        expect(JSON.parse(superset.seen?.body ?? '')).toEqual({ dashboard: 'dash-non' });
    });

    it('answers 403 when the analytics are off, and 500 when they are not configured', async () => {
        current = { ...current, analyticsEnabled: false };
        await expect(tokens.create(user(['Buyer']), 'businessInsights')).rejects.toMatchObject({
            status: 403,
            message: 'Analytics is disabled'
        });

        current = {
            ...current,
            analyticsEnabled: true,
            analyticsDashboards: { ...current.analyticsDashboards, businessInsightsNonLear: '' }
        };
        await expect(tokens.create(user(['Buyer']), 'businessInsights')).rejects.toMatchObject({
            status: 500,
            message: 'Analytics dashboard is not configured'
        });

        current = {
            ...current,
            analyticsDashboards: { ...current.analyticsDashboards, businessInsightsNonLear: 'x' },
            analytics: ''
        };
        await expect(tokens.create(user(['Buyer']), 'businessInsights')).rejects.toMatchObject({
            status: 500,
            message: 'Analytics service is not configured'
        });
    });

    it('does not ask Superset for a user who has no access token', async () => {
        await expect(tokens.create(user(['Buyer'], undefined), 'businessInsights')).rejects.toBeInstanceOf(
            ForbiddenError
        );
        expect(superset.seen).toBeUndefined();
    });
});

describe('GuestTokens: when Superset fails', () => {
    it('tells a 502 that does not say what Superset said, when it refuses', async () => {
        superset.answer((res) =>
            superset.json(res, 500, JSON.stringify({ message: 'internal detail with token tok-ana' }))
        );
        const failure = await tokens
            .create(user(['Buyer']), 'businessInsights')
            .catch((error: unknown) => error as Error);
        expect(failure).toBeInstanceOf(BadGatewayError);
        expect((failure as Error).message).not.toContain('internal detail');
    });

    it('tells a 502 when it answers without a token, and when it cannot be reached', async () => {
        superset.answer((res) => superset.json(res, 200, '{}'));
        await expect(tokens.create(user(['Buyer']), 'businessInsights')).rejects.toBeInstanceOf(BadGatewayError);

        current = { ...current, analytics: 'http://127.0.0.1:1' };
        await expect(tokens.create(user(['Buyer']), 'businessInsights')).rejects.toBeInstanceOf(BadGatewayError);
    });

    it('does not follow a redirect with the token of the user', async () => {
        superset.answer((res) => {
            res.writeHead(302, { location: 'https://evil.example.org/steal' });
            res.end();
        });
        await expect(tokens.create(user(['Buyer']), 'businessInsights')).rejects.toBeInstanceOf(BadGatewayError);
    });

    it('tells a 504 when Superset does not answer in time', async () => {
        const quick = new GuestTokens(
            { current: () => Promise.resolve(current) } as unknown as AnalyticsSettings,
            configFor(100)
        );
        superset.answer(() => undefined);
        const failure = await quick
            .create(user(['Buyer']), 'businessInsights')
            .catch((error: unknown) => error as DomainError);
        expect(failure).toMatchObject({ status: 504 });
    });
});
