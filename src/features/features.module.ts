import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigStoreModule } from '../persistence/config-store/config-store.module';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureGuard } from './feature.guard';

// The flags are asked from any module that has something to switch
@Global()
@Module({
    imports: [ConfigStoreModule],
    providers: [FeatureFlagService, { provide: APP_GUARD, useClass: FeatureGuard }],
    exports: [FeatureFlagService]
})
export class FeaturesModule {}
