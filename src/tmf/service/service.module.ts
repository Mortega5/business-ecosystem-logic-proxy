import { Module } from '@nestjs/common';
import { FileServiceModule } from '../../files/file-service.module';
import { ServiceSpecifications } from './service-specifications';
import { TmfModule } from '../tmf.module';
import { ServiceController } from './service.controller';

@Module({ imports: [TmfModule, FileServiceModule], controllers: [ServiceController], providers: [ServiceSpecifications] })
export class ServiceModule {}
