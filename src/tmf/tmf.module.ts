import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { LegacyOperator } from '../legacy/legacy-operator';
import { OwnedResources } from './owned-resources';
import { SellerParties } from './seller-parties';
import { TmfProxy } from './tmf-proxy';

@Module({
    imports: [HttpClientModule],
    providers: [TmfProxy, OwnedResources, SellerParties, LegacyOperator],
    exports: [TmfProxy, OwnedResources, SellerParties]
})
export class TmfModule {}
