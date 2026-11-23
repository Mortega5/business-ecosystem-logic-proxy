import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { LegacyOperator } from '../legacy/legacy-operator';
import { CatalogDefaults } from './catalog/catalog-defaults';
import { OwnedResources } from './owned-resources';
import { SellerParties } from './seller-parties';
import { TmfProxy } from './tmf-proxy';

@Module({
    imports: [HttpClientModule],
    providers: [TmfProxy, OwnedResources, SellerParties, LegacyOperator, CatalogDefaults],
    exports: [TmfProxy, OwnedResources, SellerParties, LegacyOperator, CatalogDefaults]
})
export class TmfModule {}
