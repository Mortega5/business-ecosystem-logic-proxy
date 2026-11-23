import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { CatalogController } from './catalog.controller';
import { Categories } from './categories';
import { Catalogs } from './catalogs';
import { LaunchRequirements } from './launch-requirements';
import { Offerings } from './offerings';
import { PriceReferences } from './price-references';
import { ProductSpecifications } from './product-specifications';

@Module({ imports: [TmfModule], controllers: [CatalogController], providers: [Categories, Catalogs, Offerings, ProductSpecifications, PriceReferences, LaunchRequirements] })
export class CatalogModule {}
