import type { AppConfigService } from '../config/app-config.service';

interface FeatureDefinition {
    /** Name under which the `feature-flags` document of the DB (and the admin API and frontend) knows it. */
    dbName: string;
    enabled: (config: AppConfigService) => boolean;
    /** Whether everything the feature needs is configured; a feature that is not never turns on. */
    configured: (config: AppConfigService) => boolean;
}

const always = (): boolean => true;

export const FEATURES = {
    purchase: { dbName: 'purchaseEnabled', enabled: (c) => c.purchase.enabled, configured: always },
    dataSpace: { dbName: 'dataSpaceEnabled', enabled: (c) => c.dataSpace.enabled, configured: always },
    catalogManagement: {
        dbName: 'catalogManagementEnabled',
        enabled: (c) => c.catalogManagement.enabled,
        configured: always
    },
    dsp: {
        dbName: 'dspEnabled',
        enabled: (c) => c.dsp.enabled,
        configured: (c) => c.dsp.contractDefinitionSchema !== undefined
    },
    quotes: { dbName: 'quotesEnabled', enabled: (c) => c.quotes.enabled, configured: always },
    tendering: { dbName: 'tenderingEnabled', enabled: (c) => c.tendering.enabled, configured: always },
    launchValidation: {
        dbName: 'launchValidationEnabled',
        enabled: (c) => c.launchValidation.enabled,
        configured: always
    },
    datasets: { dbName: 'datasetsEnabled', enabled: (c) => c.datasets.enabled, configured: always },
    apiAccess: { dbName: 'apiAccessEnabled', enabled: (c) => c.apiAccess.enabled, configured: always },
    blueprints: { dbName: 'blueprintsEnabled', enabled: (c) => c.blueprints.enabled, configured: always },
    software: { dbName: 'softwareEnabled', enabled: (c) => c.software.enabled, configured: always },
    tenderDevButtons: {
        dbName: 'tenderDevButtonsOpenCloseEnabled',
        enabled: (c) => c.tendering.devButtonsOpenClose,
        configured: always
    }
} as const satisfies Record<string, FeatureDefinition>;

export type Feature = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];
export const definitionOf = (feature: Feature): FeatureDefinition => FEATURES[feature];
