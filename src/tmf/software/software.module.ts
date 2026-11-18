import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { SoftwareController } from './software.controller';

@Module({ imports: [TmfModule], controllers: [SoftwareController] })
export class SoftwareModule {}
