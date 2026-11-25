import { Module, type OnModuleInit } from '@nestjs/common';
import { PortalConfigContributors } from '../portal/portal-config-contributors';
import { PortalModule } from '../portal/portal.module';
import { ConfigStoreModule } from '../persistence/config-store/config-store.module';
import { AnalyticsConfigController } from './analytics-config.controller';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsSettings } from './analytics-settings';
import { GuestTokens } from './guest-token.service';

/**
 * The analytics: dashboards of Superset that the portal embeds. Whether they are on is kept in `AnalyticsSettings`, which an
 * administrator changes from the portal; it is the one source for that, and is also how `GET /config` tells the portal.
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
        private readonly settings: AnalyticsSettings
    ) {}

    onModuleInit(): void {
        this.portal.register('analytics', () => this.settings.forPortal());
    }
}
