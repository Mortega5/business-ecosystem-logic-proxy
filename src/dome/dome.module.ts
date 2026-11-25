import { Module } from '@nestjs/common';
import { DomeEnabledGuard } from './dome-enabled.guard';

/**
 * The DOME extension. It has no pieces of its own for now: the blog, the analytics and the compliance are part of the core, each with its
 * own setting. `AppModule` imports it and nothing else of the core refers to it. A controller that belongs here is marked
 * `@DomeRoutes()`, and whatever has to start something (a timer, a connection) asks `dome.enabled` first.
 */
@Module({ providers: [DomeEnabledGuard], exports: [DomeEnabledGuard] })
export class DomeModule {}
