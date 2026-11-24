import { Injectable } from '@nestjs/common';
import { DomainError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { FeatureFlagService } from '../features/feature-flag.service';
import { SearchSettings } from '../features/search-settings';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { validateFeatureFlags } from './feature-overrides';
import { SEARCH_FILTERS_DOCUMENT_ID } from './portal-config.service';
import { validateSearchFilters, type SearchFilters } from './search-filters';
import { objectOf, refuse } from './validation';

export interface SearchConfig {
    searchUrl: string;
    useQueryKeyword: boolean;
}

const withoutTrailingSlash = (url: string): string => url.trim().replace(/\/+$/, '');

/**
 * What an administrator changes of the portal: the features that are on, the filters of the search, and how the keyword is given to the search
 * engine. The address of the engine is the one of the configuration (`upstreams.search`) and is not changed from here.
 */
@Injectable()
export class AdminConfigService {
    constructor(
        private readonly config: AppConfigService,
        private readonly flags: FeatureFlagService,
        private readonly documents: ConfigDocumentRepository,
        private readonly settings: SearchSettings
    ) {}

    /** Changes some flags and gives the ones that are in force, by the names that the portal knows. */
    updateFeatures(body: string): Promise<Record<string, boolean>> {
        const checked = validateFeatureFlags(objectOf(body));
        return this.flags.update(checked.value ?? refuse('feature flags', checked.errors));
    }

    async updateSearchFilters(body: string): Promise<SearchFilters> {
        const checked = validateSearchFilters(objectOf(body));
        const filters = checked.value ?? refuse('search filters', checked.errors);
        await this.documents.upsert(SEARCH_FILTERS_DOCUMENT_ID, { searchFilters: filters });
        return filters;
    }

    async searchConfig(): Promise<SearchConfig> {
        return { searchUrl: this.engine(), useQueryKeyword: await this.settings.useQueryKeyword() };
    }

    async updateSearchConfig(body: string): Promise<SearchConfig> {
        const sent = objectOf(body);
        const errors: string[] = [];
        if (typeof sent['searchUrl'] !== 'string') {
            errors.push('searchUrl is required and must be a string');
        }
        if (typeof sent['useQueryKeyword'] !== 'boolean') {
            errors.push('useQueryKeyword is required and must be a boolean');
        }
        if (errors.length > 0) {
            refuse('search config', errors);
        }
        // The address of the engine is a setting of the deployment: it can be sent back as it is, and not changed
        if (withoutTrailingSlash(sent['searchUrl'] as string) !== withoutTrailingSlash(this.engine())) {
            throw new DomainError('The address of the search engine is set by the configuration of the proxy (upstreams.search) and cannot be changed here', 400);
        }
        await this.settings.save(sent['useQueryKeyword'] as boolean, this.engine());
        return this.searchConfig();
    }

    /** The address of the engine, or nothing when the marketplace has none. */
    private engine(): string {
        return this.config.hasUpstream('search') ? this.config.upstream('search').baseUrl : '';
    }
}
