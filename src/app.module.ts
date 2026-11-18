import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/app-config.module';
import { FeaturesModule } from './features/features.module';
import { DocumentModule } from './tmf/document/document.module';
import { RevenueModule } from './tmf/revenue/revenue.module';
import { SearchModule } from './tmf/search/search.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { MongoPersistenceModule } from './persistence/mongo-persistence.module';

@Module({ imports: [AppConfigModule, AuthModule, LoggingModule, MongoPersistenceModule, FeaturesModule, HealthModule, DocumentModule, RevenueModule, SearchModule] })
export class AppModule {}
