import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { LegacyOperator } from '../legacy/legacy-operator';
import { CatalogDefaults } from './catalog/catalog-defaults';
import { ChargingAssets } from './charging-assets';
import { OwnedResources } from './owned-resources';
import { SellerParties } from './seller-parties';
import { TmfProxy } from './tmf-proxy';

@Module({
    imports: [HttpClientModule],
    providers: [TmfProxy, OwnedResources, SellerParties, LegacyOperator, CatalogDefaults, ChargingAssets],
    exports: [TmfProxy, OwnedResources, SellerParties, LegacyOperator, CatalogDefaults, ChargingAssets]
})
export class TmfModule {}
