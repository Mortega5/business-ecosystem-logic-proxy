import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigDocumentRepository } from './config-document.repository';
import { ConfigEntry, ConfigEntrySchema } from './config-entry.schema';
import { MongooseConfigDocumentRepository } from './mongoose-config-document.repository';

@Module({
    imports: [MongooseModule.forFeature([{ name: ConfigEntry.name, schema: ConfigEntrySchema }])],
    providers: [{ provide: ConfigDocumentRepository, useClass: MongooseConfigDocumentRepository }],
    exports: [ConfigDocumentRepository]
})
export class ConfigStoreModule {}
