import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { definitionOf, FEATURE_NAMES, type Feature } from './feature-flags';

export const FEATURE_FLAGS_DOCUMENT_ID = 'feature-flags';
const REFRESH_MS = 5000;

type Flags = Record<Feature, boolean>;

/** Static flags from the configuration, overridden by the booleans of the `feature-flags` document in the DB. */
@Injectable()
export class FeatureFlagService {
    private readonly logger = new Logger(FeatureFlagService.name);
    private cached: { flags: Flags; expiresAt: number } | undefined;

    constructor(
        private readonly config: AppConfigService,
        private readonly documents: ConfigDocumentRepository
    ) {}

    async isEnabled(feature: Feature): Promise<boolean> {
        return (await this.flags())[feature];
    }

    async all(): Promise<Flags> {
        return { ...(await this.flags()) };
    }

    /**
     * Saves what an administrator changes, by the names that the database and the portal know, over the overrides that are saved, and gives
     * the flags that are in force. Unlike a read, a database that fails is an error: the change was not made.
     */
    async update(changes: Record<string, boolean>): Promise<Record<string, boolean>> {
        const features = (await this.documents.findById(FEATURE_FLAGS_DOCUMENT_ID))?.features;
        const saved = typeof features === 'object' && features !== null && !Array.isArray(features) ? (features as Record<string, unknown>) : {};
        const kept = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean'));
        await this.documents.upsert(FEATURE_FLAGS_DOCUMENT_ID, { features: { ...kept, ...changes } });
        this.cached = undefined;
        const flags = await this.flags();
        return Object.fromEntries(FEATURE_NAMES.map((feature) => [definitionOf(feature).dbName, flags[feature]]));
    }

    private async flags(): Promise<Flags> {
        if (this.cached !== undefined && this.cached.expiresAt > Date.now()) {
            return this.cached.flags;
        }
        const overrides = await this.overrides();
        const flags = Object.fromEntries(
            FEATURE_NAMES.map((feature) => [feature, this.resolve(feature, overrides[feature])])
        ) as Flags;
        this.cached = { flags, expiresAt: Date.now() + REFRESH_MS };
        return flags;
    }

    private resolve(feature: Feature, override: boolean | undefined): boolean {
        const { enabled, configured } = definitionOf(feature);
        const wanted = override ?? enabled(this.config);
        if (wanted && !configured(this.config)) {
            this.logger.warn(`Feature "${feature}" is on but its configuration is incomplete, so it stays off`);
            return false;
        }
        return wanted;
    }

    // When the database cannot be read the static flags apply
    private async overrides(): Promise<Partial<Flags>> {
        try {
            const features = (await this.documents.findById(FEATURE_FLAGS_DOCUMENT_ID))?.features;
            if (typeof features !== 'object' || features === null || Array.isArray(features)) {
                return {};
            }
            const stored = features as Record<string, unknown>;
            return Object.fromEntries(
                FEATURE_NAMES.map((feature) => [feature, stored[definitionOf(feature).dbName]]).filter(
                    ([, value]) => typeof value === 'boolean'
                )
            );
        } catch (error) {
            this.logger.warn(`Feature flags could not be read from the database: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    }
}
