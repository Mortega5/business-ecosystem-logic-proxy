import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { LoggingModule } from './logging/logging.module';
import { MongoPersistenceModule } from './persistence/mongo-persistence.module';

@Module({ imports: [AppConfigModule, LoggingModule, MongoPersistenceModule] })
export class AppModule {}
