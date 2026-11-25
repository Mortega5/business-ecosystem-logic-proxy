/** What the portal reads and an administrator saves of the analytics; the shape is the one of v11. */
export interface AnalyticsConfig {
    /** Where Superset is. */
    analytics: string;
    analyticsEnabled: boolean;
    analyticsDashboards: AnalyticsDashboards;
    analyticsSuperset: { guestTokenPath: string };
}

export interface AnalyticsDashboards {
    businessInsightsNonLear: string;
    businessInsightsLear: string;
    usageMonitor: string;
}

export const DASHBOARD_KEYS = ['businessInsightsNonLear', 'businessInsightsLear', 'usageMonitor'] as const;

// What an id of a dashboard of Superset is made of (a UUID, or a number): it goes in the body of a request and in no address
const DASHBOARD_ID = /^[A-Za-z0-9._:-]{1,200}$/;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * The address of Superset: an http or https address with no user and no password, and no query or fragment. The token of the user is
 * sent to it, so it must be plainly a place and nothing else.
 */
export const supersetUrl = (value: unknown): string | undefined => {
    const candidate = text(value);
    if (candidate === undefined) {
        return undefined;
    }
    try {
        const url = new URL(candidate);
        const plain =
            (url.protocol === 'http:' || url.protocol === 'https:') &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === '';
        return plain ? candidate.replace(/\/+$/, '') : undefined;
    } catch {
        return undefined;
    }
};

/** The path of the guest token endpoint: absolute, with no dot segments, no backslash and nothing that is not printable. */
export const guestTokenPath = (value: unknown): string | undefined => {
    const candidate = text(value);
    if (
        candidate === undefined ||
        !candidate.startsWith('/') ||
        candidate.startsWith('//') ||
        /[\\\u0000- \u007f#]/.test(candidate)
    ) {
        return undefined;
    }
    return candidate
        .split('?')[0]
        ?.split('/')
        .some((segment) => segment === '..' || segment === '.') === true
        ? undefined
        : candidate;
};

/** What an administrator sends, checked: the value, or everything that is wrong with it. */
export const parseAnalyticsConfig = (body: unknown): { value: AnalyticsConfig } | { errors: string[] } => {
    const errors: string[] = [];
    if (!isRecord(body)) {
        return { errors: ['the body must be an object'] };
    }

    const analytics = supersetUrl(body['analytics']);
    if (analytics === undefined) {
        errors.push('analytics is required and must be an http or https address with no user, query or fragment');
    }
    if (typeof body['analyticsEnabled'] !== 'boolean') {
        errors.push('analyticsEnabled is required and must be a boolean');
    }

    const dashboards: Partial<AnalyticsDashboards> = {};
    const givenDashboards = body['analyticsDashboards'];
    if (!isRecord(givenDashboards)) {
        errors.push('analyticsDashboards must be an object');
    } else {
        for (const key of DASHBOARD_KEYS) {
            const id = text(givenDashboards[key]);
            if (id === undefined) {
                errors.push(`analyticsDashboards.${key} is required and must be non-empty`);
            } else if (!DASHBOARD_ID.test(id)) {
                errors.push(`analyticsDashboards.${key} has characters that an id of a dashboard does not have`);
            } else {
                dashboards[key] = id;
            }
        }
    }

    const superset = body['analyticsSuperset'];
    let path: string | undefined;
    if (!isRecord(superset)) {
        errors.push('analyticsSuperset must be an object');
    } else {
        path = guestTokenPath(superset['guestTokenPath']);
        if (path === undefined) {
            errors.push(
                'analyticsSuperset.guestTokenPath is required and must be an absolute path with no dot segments'
            );
        }
    }

    if (errors.length > 0 || analytics === undefined || path === undefined) {
        return { errors };
    }
    return {
        value: {
            analytics,
            analyticsEnabled: body['analyticsEnabled'] as boolean,
            analyticsDashboards: dashboards as AnalyticsDashboards,
            analyticsSuperset: { guestTokenPath: path }
        }
    };
};
