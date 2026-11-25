import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service';
import {
    ConfigDocumentRepository,
    type ConfigDocument
} from '../../persistence/config-store/config-document.repository';
import { AnalyticsSettings } from './analytics-settings';

class Documents extends ConfigDocumentRepository {
    stored = new Map<string, ConfigDocument>();
    failing = false;
    reads = 0;
    findById(id: string): Promise<ConfigDocument | undefined> {
        this.reads += 1;
        return this.failing ? Promise.reject(new Error('down')) : Promise.resolve(this.stored.get(id));
    }
    upsert(id: string, fields: Record<string, unknown>): Promise<void> {
        if (this.failing) {
            return Promise.reject(new Error('down'));
        }
        this.stored.set(id, { id, ...fields });
        return Promise.resolve();
    }
}

const config = {
    dome: {
        analytics: {
            enabled: true,
            url: 'https://configured.example.org',
            guestTokenPath: '/api/v1/dome/guest_token/',
            dashboards: { businessInsightsNonLear: 'n', businessInsightsLear: 'l', usageMonitor: 'u' },
            timeoutMs: 1000
        }
    }
} as unknown as AppConfigService;

const saved = {
    analytics: 'https://saved.example.org',
    analyticsEnabled: false,
    analyticsDashboards: { businessInsightsNonLear: 'n2', businessInsightsLear: 'l2', usageMonitor: 'u2' },
    analyticsSuperset: { guestTokenPath: '/other/' }
};

describe('AnalyticsSettings', () => {
    it('starts from the configuration, in the shape the portal reads', async () => {
        const settings = new AnalyticsSettings(new Documents(), config);
        expect(await settings.current()).toEqual({
            analytics: 'https://configured.example.org',
            analyticsEnabled: true,
            analyticsDashboards: { businessInsightsNonLear: 'n', businessInsightsLear: 'l', usageMonitor: 'u' },
            analyticsSuperset: { guestTokenPath: '/api/v1/dome/guest_token/' }
        });
        expect(await settings.forPortal()).toEqual({
            analytics: 'https://configured.example.org',
            analyticsEnabled: true
        });
    });

    it('lets what an administrator saved win, and keeps it for the next instance to read', async () => {
        const documents = new Documents();
        await new AnalyticsSettings(documents, config).save(saved);
        expect(documents.stored.get('analytics')).toEqual({ id: 'analytics', analytics: saved });

        const other = new AnalyticsSettings(documents, config);
        expect(await other.current()).toEqual(saved);
    });

    it('reads the database at most every few seconds', async () => {
        const documents = new Documents();
        const settings = new AnalyticsSettings(documents, config);
        await settings.current();
        await settings.current();
        expect(documents.reads).toBe(1);
    });

    it('goes on with the configuration when what is saved is not valid or cannot be read', async () => {
        const documents = new Documents();
        documents.stored.set('analytics', { id: 'analytics', analytics: { analytics: 'ftp://nope' } });
        expect((await new AnalyticsSettings(documents, config).current()).analytics).toBe(
            'https://configured.example.org'
        );

        documents.failing = true;
        expect((await new AnalyticsSettings(documents, config).current()).analytics).toBe(
            'https://configured.example.org'
        );
    });

    it('fails when what is to be saved cannot be, and keeps what it had', async () => {
        const documents = new Documents();
        const settings = new AnalyticsSettings(documents, config);
        documents.failing = true;
        await expect(settings.save(saved)).rejects.toThrow('down');
        documents.failing = false;
        expect((await settings.current()).analytics).toBe('https://configured.example.org');
    });
});
