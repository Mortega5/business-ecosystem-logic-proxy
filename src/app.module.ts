import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/app-config.module';
import { FeaturesModule } from './features/features.module';
import { AccountModule } from './tmf/account/account.module';
import { DocumentModule } from './tmf/document/document.module';
import { InventoryModule } from './tmf/inventory/inventory.module';
import { InvoicingModule } from './tmf/invoicing/invoicing.module';
import { PartyModule } from './tmf/party/party.module';
import { QuoteModule } from './tmf/quote/quote.module';
import { ResourceModule } from './tmf/resource/resource.module';
import { RevenueModule } from './tmf/revenue/revenue.module';
import { ServiceModule } from './tmf/service/service.module';
import { SearchModule } from './tmf/search/search.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { MongoPersistenceModule } from './persistence/mongo-persistence.module';

@Module({ imports: [AppConfigModule, AuthModule, LoggingModule, MongoPersistenceModule, FeaturesModule, HealthModule, DocumentModule, RevenueModule, SearchModule, InvoicingModule, QuoteModule, InventoryModule, AccountModule, PartyModule, ResourceModule, ServiceModule] })
export class AppModule {}
