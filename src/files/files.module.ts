import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileGuards } from './file-guards';
import { FileServiceClient } from './file-service.client';

@Module({
    controllers: [FileController],
    providers: [FileServiceClient, FileGuards],
    exports: [FileServiceClient, FileGuards]
})
export class FilesModule {}
