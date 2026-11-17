export const FEATURE_FLAGS = [
    'purchaseEnabled',
    'dataSpaceEnabled',
    'catalogManagementEnabled',
    'dspEnabled',
    'quotesEnabled',
    'tenderingEnabled',
    'launchValidationEnabled',
    'tenderDevButtonsOpenCloseEnabled'
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
