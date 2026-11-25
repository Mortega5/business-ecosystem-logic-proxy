import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PortalConfigContributors } from './portal-config-contributors';
import { FeatureFlagService } from '../features/feature-flag.service';
import { FEATURES, FEATURE_NAMES } from '../features/feature-flags';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { CatalogDefaults } from '../tmf/catalog/catalog-defaults';
import { MarketplaceSearch } from '../tmf/marketplace-search';
import { isRecord } from '../tmf/related-party';
import { defaultSearchFilters, searchFiltersFrom, type SearchFilters } from './search-filters';

export const SEARCH_FILTERS_DOCUMENT_ID = 'search-filters';

type Json = Record<string, unknown>;

/** What is in both, the proxy's wins: an object of the settings of the deployment is filled in, never replaced. */
export const withExtra = (own: Json, extra: Json): Json => {
    const merged: Json = { ...extra };
    for (const [key, value] of Object.entries(own)) {
        const other = merged[key];
        merged[key] = isRecord(value) && isRecord(other) ? { ...other, ...value } : value;
    }
    return merged;
};

/**
 * What the portal needs to start: the roles, the links and the settings of the deployment, the features that are on, the default catalog and the
 * system categories, and the filters of the search. Whatever else the deployment sets in `portal.extra` goes on as it is.
 */
@Injectable()
export class PortalConfigService {
    private readonly logger = new Logger(PortalConfigService.name);

    constructor(
        private readonly config: AppConfigService,
        private readonly flags: FeatureFlagService,
        private readonly documents: ConfigDocumentRepository,
        private readonly defaults: CatalogDefaults,
        private readonly search: MarketplaceSearch,
        private readonly contributors: PortalConfigContributors
    ) {}

    async read(): Promise<Json> {
        const { auth, portal, quotes, catalog, dsp, fileService } = this.config;
        const [features, searchFilters, contributed] = await Promise.all([this.flags.all(), this.searchFilters(), this.contributors.collect()]);
        const own: Json = {
            roles: { seller: auth.roles.seller, customer: auth.roles.customer, admin: auth.roles.admin, orgAdmin: auth.roles.orgAdmin },
            chat: portal.chatUrl,
            knowledgeBaseUrl: portal.knowledgeBaseUrl,
            ticketingUrl: portal.ticketingUrl,
            matomoId: portal.matomoId,
            matomoUrl: portal.matomoUrl,
            googleTagManagerId: portal.googleTagManagerId,
            theme: portal.theme,
            searchEnabled: this.search.enabled,
            quoteApi: quotes.api,
            defaultId: this.defaults.defaultCatalogId,
            systemCategories: { ...this.defaults.systemCategoryIds },
            reservedCatalogNames: catalog.systemCategories.map((category) => category.name.trim().toLowerCase()),
            searchFilters,
            blueprintSchema: catalog.blueprintSchema,
            // Whether a dataset can be made from a file: it needs the datasets on and a file service, and the portal offers files of
            // the size and the types that the proxy takes
            datasetFilesEnabled: features.datasets && fileService.enabled,
            datasetMaxSizeBytes: fileService.maxSizeMb * 1024 * 1024,
            datasetAcceptedTypes: fileService.acceptedTypes,
            ...(dsp.contractDefinitionSchema === undefined ? {} : { dspContractDefinitionSchema: dsp.contractDefinitionSchema }),
            ...Object.fromEntries(FEATURE_NAMES.map((feature) => [FEATURES[feature].dbName, features[feature]]))
        };
        // What an extension adds goes first, so that it never replaces what the core says
        return withExtra({ ...contributed, ...own }, portal.extra);
    }

    // The ones the administrator saved; when they cannot be read the portal starts with the ones of a new marketplace
    private async searchFilters(): Promise<SearchFilters> {
        try {
            return searchFiltersFrom((await this.documents.findById(SEARCH_FILTERS_DOCUMENT_ID))?.['searchFilters']);
        } catch (error) {
            this.logger.warn(`The filters of the search could not be read: ${error instanceof Error ? error.message : String(error)}`);
            return defaultSearchFilters();
        }
    }
}
