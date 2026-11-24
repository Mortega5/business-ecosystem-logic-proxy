import { Global, Module } from '@nestjs/common';
import { FeatureFlagService } from '../features/feature-flag.service';
import { FEATURE_NAMES, FEATURES, type Feature } from '../features/feature-flags';

/** The features that a test switches on; nothing is on until it says so. */
export const featuresOn = new Set<Feature>();

/** What a module that asks for a feature gets in a test, with no database: import it where the module under test is. */
@Global()
@Module({
    providers: [{ provide: FeatureFlagService, useValue: {
                isEnabled: (feature: Feature) => Promise.resolve(featuresOn.has(feature)),
                all: () => Promise.resolve(Object.fromEntries(FEATURE_NAMES.map((feature) => [feature, featuresOn.has(feature)]))),
                update: (changes: Record<string, boolean>) => {
                    for (const feature of FEATURE_NAMES) {
                        const wanted = changes[FEATURES[feature].dbName];
                        if (wanted !== undefined) {
                            featuresOn[wanted ? 'add' : 'delete'](feature);
                        }
                    }
                    return Promise.resolve(Object.fromEntries(FEATURE_NAMES.map((feature) => [FEATURES[feature].dbName, featuresOn.has(feature)])));
                }
            } }],
    exports: [FeatureFlagService]
})
export class FakeFeaturesModule {}
