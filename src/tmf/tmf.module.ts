import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { OperatorService } from '../operator/operator.service';
import { CatalogDefaults } from './catalog/catalog-defaults';
import { ChargingAssets } from './charging-assets';
import { MarketplaceSearch } from './marketplace-search';
import { NormalizedParties } from './normalized-parties';
import { OwnedResources } from './owned-resources';
import { SellerParties } from './seller-parties';
import { TmfProxy } from './tmf-proxy';

@Module({
    imports: [HttpClientModule],
    providers: [TmfProxy, OwnedResources, SellerParties, OperatorService, CatalogDefaults, ChargingAssets, NormalizedParties, MarketplaceSearch],
    exports: [TmfProxy, OwnedResources, SellerParties, OperatorService, CatalogDefaults, ChargingAssets, NormalizedParties, MarketplaceSearch]
})
export class TmfModule {}
