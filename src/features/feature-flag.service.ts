import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { FEATURE_FLAGS, type FeatureFlag } from './feature-flags';

export const FEATURE_FLAGS_DOCUMENT_ID = 'feature-flags';
const REFRESH_MS = 5000;

type Flags = Record<FeatureFlag, boolean>;

/** Static flags from the configuration, overridden by the booleans of the `feature-flags` document in the DB. */
@Injectable()
export class FeatureFlagService {
    private readonly logger = new Logger(FeatureFlagService.name);
    private cached: { flags: Flags; expiresAt: number } | undefined;

    constructor(
        private readonly config: AppConfigService,
        private readonly documents: ConfigDocumentRepository
    ) {}

    async isEnabled(flag: FeatureFlag): Promise<boolean> {
        return (await this.flags())[flag];
    }

    async all(): Promise<Flags> {
        return { ...(await this.flags()) };
    }

    private async flags(): Promise<Flags> {
        if (this.cached !== undefined && this.cached.expiresAt > Date.now()) {
            return this.cached.flags;
        }
        const flags = { ...this.config.features, ...(await this.overrides()) };
        this.cached = { flags, expiresAt: Date.now() + REFRESH_MS };
        return flags;
    }

    // When the DB cannot be read the static flags apply, as in the legacy application
    private async overrides(): Promise<Partial<Flags>> {
        try {
            const features = (await this.documents.findById(FEATURE_FLAGS_DOCUMENT_ID))?.features;
            if (typeof features !== 'object' || features === null || Array.isArray(features)) {
                return {};
            }
            const stored = features as Record<string, unknown>;
            return Object.fromEntries(FEATURE_FLAGS.filter((flag) => typeof stored[flag] === 'boolean').map((flag) => [flag, stored[flag]]));
        } catch (error) {
            this.logger.warn(`Feature flags could not be read from the database: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    }
}
