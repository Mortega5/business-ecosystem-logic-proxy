import { Module } from '@nestjs/common';
import { AnalyticsModule } from './analytics/analytics.module';
import { BlogModule } from './blog/blog.module';
import { ComplianceModule } from './compliance/compliance.module';
import { DomeEnabledGuard } from './dome-enabled.guard';

/**
 * The DOME extension: what the marketplace of DOME adds to the core. `AppModule` imports it and nothing else of the core refers to it.
 * Each controller in it is marked `@DomeRoutes()`, and whatever has to start something (a timer, a connection) asks `dome.enabled` first.
 */
@Module({ imports: [BlogModule, AnalyticsModule, ComplianceModule], providers: [DomeEnabledGuard], exports: [DomeEnabledGuard] })
export class DomeModule {}
