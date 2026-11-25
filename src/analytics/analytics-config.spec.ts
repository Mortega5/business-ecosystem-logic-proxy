import { describe, expect, it } from 'vitest';
import { guestTokenPath, parseAnalyticsConfig, supersetUrl } from './analytics-config';

const valid = {
    analytics: 'https://superset.example.org/',
    analyticsEnabled: true,
    analyticsDashboards: { businessInsightsNonLear: 'a1b2', businessInsightsLear: 'c3d4', usageMonitor: 'e5f6' },
    analyticsSuperset: { guestTokenPath: '/api/v1/dome/guest_token/' }
};

describe('parseAnalyticsConfig', () => {
    it('accepts the settings of v11, takes the slash off the address and trims what is trimmed', () => {
        expect(
            parseAnalyticsConfig({
                ...valid,
                analyticsDashboards: { ...valid.analyticsDashboards, usageMonitor: ' e5f6 ' }
            })
        ).toEqual({
            value: { ...valid, analytics: 'https://superset.example.org' }
        });
    });

    it('says everything that is wrong, not only the first thing', () => {
        const parsed = parseAnalyticsConfig({
            analytics: '',
            analyticsEnabled: 'yes',
            analyticsDashboards: {},
            analyticsSuperset: {}
        });
        expect(parsed).toHaveProperty('errors');
        expect((parsed as { errors: string[] }).errors).toHaveLength(6);
    });

    it('refuses what is not an object, and sections that are not objects', () => {
        expect(parseAnalyticsConfig(null)).toEqual({ errors: ['the body must be an object'] });
        expect(parseAnalyticsConfig([])).toEqual({ errors: ['the body must be an object'] });
        const parsed = parseAnalyticsConfig({ ...valid, analyticsDashboards: [], analyticsSuperset: 'x' }) as {
            errors: string[]
        };
        expect(parsed.errors).toEqual(['analyticsDashboards must be an object', 'analyticsSuperset must be an object']);
    });

    it('refuses an address that is not a plain http or https place, because the token of every user goes to it', () => {
        for (const bad of [
            'ftp://x.example.org',
            'javascript:alert(1)',
            'https://user:pass@x.example.org',
            'https://x.example.org/?a=1',
            'https://x.example.org/#a',
            'not a url'
        ]) {
            expect(parseAnalyticsConfig({ ...valid, analytics: bad }), bad).toHaveProperty('errors');
        }
        expect(supersetUrl('http://localhost:8088/superset')).toBe('http://localhost:8088/superset');
    });

    it('refuses a path that could go somewhere else, and an id of a dashboard that is not one', () => {
        for (const bad of ['api/v1', '//evil.example.org/x', '/a/../b', '/a/./b', '/a\\b', '/a b', '/a#b', '/a\nb']) {
            expect(guestTokenPath(bad), bad).toBeUndefined();
        }
        expect(guestTokenPath('/api/v1/guest_token/?x=1')).toBe('/api/v1/guest_token/?x=1');
        expect(
            parseAnalyticsConfig({
                ...valid,
                analyticsDashboards: { ...valid.analyticsDashboards, usageMonitor: 'a/b' }
            })
        ).toHaveProperty('errors');
    });
});
