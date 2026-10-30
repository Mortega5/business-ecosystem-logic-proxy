import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { MongoPersistenceModule } from './persistence/mongo-persistence.module';

@Module({ imports: [AppConfigModule, LoggingModule, MongoPersistenceModule, HealthModule] })
export class AppModule {}
