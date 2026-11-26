import { Injectable, Logger } from '@nestjs/common';
import { BadGatewayError, DomainError, ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamUser } from '../tmf/upstream-headers';
import { guestTokenPath, supersetUrl } from './analytics-config';
import { AnalyticsSettings } from './analytics-settings';

export const TABS = ['businessInsights', 'usageMonitor'] as const;
export type Tab = (typeof TABS)[number];

const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * The token with which the portal embeds a dashboard of Superset. Superset is asked with the access token of the user, which is the
 * one that says who they are there; the dashboard depends on the tab and on the role of the user in the platform.
 */
@Injectable()
export class GuestTokens {
    private readonly logger = new Logger(GuestTokens.name);

    constructor(
        private readonly settings: AnalyticsSettings,
        private readonly config: AppConfigService
    ) {}

    async create(user: UpstreamUser, tab: Tab): Promise<{ dashboardId: string, token: string }> {
        const current = await this.settings.current();
        if (!current.analyticsEnabled) {
            throw new ForbiddenError('Analytics is disabled');
        }
        const { admin, orgAdmin } = this.config.auth.roles;
        const has = (role: string): boolean =>
            (user.roles ?? []).some((candidate) => candidate.name.toLowerCase() === role.toLowerCase());
        if (tab === 'usageMonitor' && !has(admin)) {
            throw new ForbiddenError('You are not authorized to access Usage Monitor');
        }
        const key =
            tab === 'usageMonitor'
                ? 'usageMonitor'
                : has(orgAdmin)
                  ? 'businessInsightsLear'
                  : 'businessInsightsNonLear';
        const dashboardId = nonEmpty(current.analyticsDashboards[key]);
        if (dashboardId === undefined) {
            throw new DomainError('Analytics dashboard is not configured', 500);
        }
        const base = supersetUrl(current.analytics);
        const path = guestTokenPath(current.analyticsSuperset.guestTokenPath);
        if (base === undefined || path === undefined) {
            throw new DomainError('Analytics service is not configured', 500);
        }
        if (user.accessToken === undefined || user.accessToken === '') {
            throw new ForbiddenError('You need an access token to see the analytics');
        }
        return { dashboardId, token: await this.ask(`${base}${path}`, dashboardId, user.accessToken) };
    }

    private async ask(url: string, dashboardId: string, accessToken: string): Promise<string> {
        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                    authorization: `Bearer ${accessToken}`
                },
                body: JSON.stringify({ dashboard: dashboardId }),
                // A redirect would take the token of the user to another place
                redirect: 'manual',
                signal: AbortSignal.timeout(this.config.analytics.timeoutMs)
            });
        } catch (error) {
            if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                this.logger.warn({ err: error }, 'The analytics service did not answer in time');
                throw new DomainError('The analytics service did not answer in time', 504);
            }
            this.logger.warn({ err: error }, 'The analytics service could not be reached');
            throw new BadGatewayError('It was not possible to generate the analytics guest token');
        }
        if (!response.ok) {
            // What it says is not for the client: it may carry the token or the structure of the service
            this.logger.warn({ statusCode: response.status }, 'The analytics service did not give a guest token');
            throw new BadGatewayError('It was not possible to generate the analytics guest token');
        }
        const body: unknown = await response.json().catch(() => undefined);
        const token = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined;
        if (typeof token !== 'string' || token === '') {
            throw new BadGatewayError('Superset guest token not found in response');
        }
        return token;
    }
}
