import { Module } from '@nestjs/common';
import { DomeEnabledGuard } from './dome-enabled.guard';

/**
 * The DOME extension: what the marketplace of DOME adds to the core. `AppModule` imports it and nothing else of the core refers to it.
 * Each controller in it is marked `@DomeRoutes()`, and whatever has to start something (a timer, a connection) asks `dome.enabled` first.
 */
@Module({ providers: [DomeEnabledGuard] })
export class DomeModule {}
