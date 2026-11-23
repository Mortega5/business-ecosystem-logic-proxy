import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { CatalogController } from './catalog.controller';
import { Categories } from './categories';
import { Catalogs } from './catalogs';

@Module({ imports: [TmfModule], controllers: [CatalogController], providers: [Categories, Catalogs] })
export class CatalogModule {}
