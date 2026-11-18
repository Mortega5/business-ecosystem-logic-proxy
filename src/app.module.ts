import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/app-config.module';
import { FeaturesModule } from './features/features.module';
import { DocumentModule } from './tmf/document/document.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { MongoPersistenceModule } from './persistence/mongo-persistence.module';

@Module({ imports: [AppConfigModule, AuthModule, LoggingModule, MongoPersistenceModule, FeaturesModule, HealthModule, DocumentModule] })
export class AppModule {}
