import { Module } from '@nestjs/common';
import { FileServiceModule } from '../../files/file-service.module';
import { TmfModule } from '../tmf.module';
import { AdminCatalogController } from './admin-catalog.controller';
import { CatalogController } from './catalog.controller';
import { Categories } from './categories';
import { Catalogs } from './catalogs';
import { LaunchRequirements } from './launch-requirements';
import { OfferingParties } from './offering-parties';
import { OfferingPrices } from './offering-prices';
import { Offerings } from './offerings';
import { PriceReferences } from './price-references';
import { ProductSpecifications } from './product-specifications';

@Module({ imports: [TmfModule, FileServiceModule], controllers: [CatalogController, AdminCatalogController], providers: [Categories, Catalogs, Offerings, ProductSpecifications, PriceReferences, LaunchRequirements, OfferingParties, OfferingPrices] })
export class CatalogModule {}
