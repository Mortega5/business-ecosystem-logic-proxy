import { Module } from '@nestjs/common';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';
import { PortalConfigController } from '../portal/portal-config.controller';
import { PortalConfigService } from '../portal/portal-config.service';
import { TmfModule } from '../tmf/tmf.module';

/** The routes of the portal settings as `PortalModule` has them, with no document saved by an administrator and no database. */
@Module({
    imports: [TmfModule],
    controllers: [PortalConfigController],
    providers: [PortalConfigService, { provide: ConfigDocumentRepository, useValue: { findById: () => Promise.resolve(undefined), upsert: () => Promise.resolve() } }]
})
export class FakePortalModule {}
