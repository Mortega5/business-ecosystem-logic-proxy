import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigService } from '../config/app-config.service';

@Module({
    imports: [
        MongooseModule.forRootAsync({
            inject: [AppConfigService],
            useFactory: (config: AppConfigService) => ({
                uri: config.mongo.uri,
                maxPoolSize: config.mongo.maxPoolSize,
                serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
                autoIndex: false
            })
        })
    ]
})
export class MongoPersistenceModule {}
