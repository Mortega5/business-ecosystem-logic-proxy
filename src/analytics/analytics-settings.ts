import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { parseAnalyticsConfig, type AnalyticsConfig } from './analytics-config';

export const ANALYTICS_DOCUMENT_ID = 'analytics';
const REFRESH_MS = 5000;

/**
 * The settings of the analytics. The ones of the configuration are the start; what an administrator saves from the portal, in the
 * `analytics` document of the database (where v11 kept it), wins. They are read at most every few seconds, so that every instance
 * comes to agree, and a document that cannot be read or is not valid leaves the ones of the configuration.
 */
@Injectable()
export class AnalyticsSettings {
    private readonly logger = new Logger(AnalyticsSettings.name);
    private cached: { value: AnalyticsConfig, expiresAt: number } | undefined;

    constructor(
        private readonly documents: ConfigDocumentRepository,
        private readonly config: AppConfigService
    ) {}

    async current(): Promise<AnalyticsConfig> {
        if (this.cached !== undefined && this.cached.expiresAt > Date.now()) {
            return this.cached.value;
        }
        const value = (await this.saved()) ?? this.fromConfiguration();
        this.cached = { value, expiresAt: Date.now() + REFRESH_MS };
        return value;
    }

    /** Saves what an administrator sent, already checked; fails when the database does, with nothing changed. */
    async save(value: AnalyticsConfig): Promise<AnalyticsConfig> {
        await this.documents.upsert(ANALYTICS_DOCUMENT_ID, { analytics: value });
        this.cached = { value, expiresAt: Date.now() + REFRESH_MS };
        return value;
    }

    /** What the portal is given with its settings: where the analytics are and whether they are on. */
    async forPortal(): Promise<{ analytics: string, analyticsEnabled: boolean }> {
        const { analytics, analyticsEnabled } = await this.current();
        return { analytics, analyticsEnabled };
    }

    private fromConfiguration(): AnalyticsConfig {
        const { enabled, url, guestTokenPath, dashboards } = this.config.analytics;
        return {
            analytics: url,
            analyticsEnabled: enabled,
            analyticsDashboards: { ...dashboards },
            analyticsSuperset: { guestTokenPath }
        };
    }

    private async saved(): Promise<AnalyticsConfig | undefined> {
        try {
            const stored = (await this.documents.findById(ANALYTICS_DOCUMENT_ID))?.['analytics'];
            if (stored === undefined || stored === null) {
                return undefined;
            }
            const parsed = parseAnalyticsConfig(stored);
            if ('errors' in parsed) {
                this.logger.warn(
                    `The analytics settings that are saved are not valid: ${parsed.errors.length} problems`
                );
                return undefined;
            }
            return parsed.value;
        } catch (error) {
            this.logger.warn(
                `The analytics settings could not be read: ${error instanceof Error ? error.message : String(error)}`
            );
            return undefined;
        }
    }
}
