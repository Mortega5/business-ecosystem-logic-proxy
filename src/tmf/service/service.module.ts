import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { ServiceController } from './service.controller';

@Module({ imports: [TmfModule], controllers: [ServiceController] })
export class ServiceModule {}
