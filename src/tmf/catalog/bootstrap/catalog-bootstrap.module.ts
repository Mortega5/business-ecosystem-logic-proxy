import { Module } from '@nestjs/common';
import { HttpClientModule } from '../../../http-client/http-client.module';
import { TmfModule } from '../../tmf.module';
import { CatalogBootstrapService } from './catalog-bootstrap.service';
import { MongoPlatformRecords } from './mongo-platform-records';
import { PlatformRecords } from './platform-records';
import { UpstreamPlatformApi } from './upstream-platform-api';

/** The start-up of the platform; apart from the catalog module so that what only needs the routes does not start it. */
@Module({
    imports: [TmfModule, HttpClientModule],
    providers: [{ provide: PlatformRecords, useClass: MongoPlatformRecords }, UpstreamPlatformApi, CatalogBootstrapService]
})
export class CatalogBootstrapModule {}
