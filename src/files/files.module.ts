import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileServiceModule } from './file-service.module';

@Module({ imports: [FileServiceModule], controllers: [FileController] })
export class FilesModule {}
