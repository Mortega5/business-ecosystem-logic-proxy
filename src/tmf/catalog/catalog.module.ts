import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { CatalogController } from './catalog.controller';
import { Categories } from './categories';

@Module({ imports: [TmfModule], controllers: [CatalogController], providers: [Categories] })
export class CatalogModule {}
