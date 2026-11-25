import { Module } from '@nestjs/common';
import { SearchSettings } from '../features/search-settings';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { AdminConfigController } from '../portal/admin-config.controller';
import { AdminConfigService } from '../portal/admin-config.service';
import { PortalConfigController } from '../portal/portal-config.controller';
import { PortalConfigContributors } from '../portal/portal-config-contributors';
import { PortalConfigService } from '../portal/portal-config.service';
import { TmfModule } from '../tmf/tmf.module';

/** The routes of the portal settings as `PortalModule` has them, with no document saved by an administrator and no database. */
@Module({
    imports: [TmfModule],
    controllers: [PortalConfigController, AdminConfigController],
    providers: [PortalConfigService, PortalConfigContributors, AdminConfigService, SearchSettings, { provide: ConfigDocumentRepository, useValue: { findById: () => Promise.resolve(undefined), upsert: () => Promise.resolve() } }]
})
export class FakePortalModule {}
