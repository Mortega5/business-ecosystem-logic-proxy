import { Module } from '@nestjs/common';
import { ConfigStoreModule } from '../persistence/config-store/config-store.module';
import { TmfModule } from '../tmf/tmf.module';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { PortalConfigController } from './portal-config.controller';
import { PortalConfigService } from './portal-config.service';

@Module({ imports: [ConfigStoreModule, TmfModule], controllers: [PortalConfigController, AdminConfigController], providers: [PortalConfigService, AdminConfigService] })
export class PortalModule {}
