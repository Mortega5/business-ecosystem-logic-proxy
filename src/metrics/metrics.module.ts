import { Global, Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';

@Global()
@Module({
    providers: [MetricsService, MetricsServer, HttpMetricsMiddleware],
    exports: [MetricsService]
})
export class MetricsModule implements NestModule {
    constructor(private readonly config: AppConfigService) {}

    configure(consumer: MiddlewareConsumer): void {
        if (this.config.metrics.enabled) {
            consumer.apply(HttpMetricsMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
        }
    }
}
