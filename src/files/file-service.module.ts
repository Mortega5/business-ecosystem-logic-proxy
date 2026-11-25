import { Module } from '@nestjs/common';
import { FileGuards } from './file-guards';
import { FileServiceClient } from './file-service.client';

/** The client of the file service and the checks of whose files are named, for the modules that need to know. */
@Module({ providers: [FileServiceClient, FileGuards], exports: [FileServiceClient, FileGuards] })
export class FileServiceModule {}
