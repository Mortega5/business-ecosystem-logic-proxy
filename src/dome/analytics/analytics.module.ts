import { Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PortalConfigContributors } from '../../portal/portal-config-contributors';
import { PortalModule } from '../../portal/portal.module';
import { ConfigStoreModule } from '../../persistence/config-store/config-store.module';
import { AnalyticsConfigController } from './analytics-config.controller';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsSettings } from './analytics-settings';
import { GuestTokens } from './guest-token.service';

/**
 * The analytics of DOME: dashboards of Superset that the portal embeds. `AnalyticsSettings` is exported for whatever has to tell the
 * portal where they are.
 */
@Module({
    imports: [ConfigStoreModule, PortalModule],
    controllers: [AnalyticsController, AnalyticsConfigController],
    providers: [AnalyticsSettings, GuestTokens],
    exports: [AnalyticsSettings]
})
export class AnalyticsModule implements OnModuleInit {
    constructor(
        private readonly portal: PortalConfigContributors,
        private readonly settings: AnalyticsSettings,
        private readonly config: AppConfigService
    ) {}

    onModuleInit(): void {
        // With the extension off the portal is not told of analytics at all, as if the proxy had none
        if (this.config.dome.enabled) {
            this.portal.register('analytics', () => this.settings.forPortal());
        }
    }
}
