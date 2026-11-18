import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { SearchController } from './search.controller';

@Module({ imports: [TmfModule], controllers: [SearchController] })
export class SearchModule {}
