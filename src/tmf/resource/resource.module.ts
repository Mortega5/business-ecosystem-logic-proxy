import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { ResourceController } from './resource.controller';

@Module({ imports: [TmfModule], controllers: [ResourceController] })
export class ResourceModule {}
