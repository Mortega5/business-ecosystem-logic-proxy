import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppConfigService } from '../config/app-config.service';
import { HealthController } from './health.controller';
import { MongoHealthIndicator } from './mongo.health-indicator';

@Module({
    imports: [
        TerminusModule.forRootAsync({
            inject: [AppConfigService],
            useFactory: (config: AppConfigService) => ({
                errorLogStyle: 'json',
                gracefulShutdownTimeoutMs: config.app.shutdownDelayMs
            })
        })
    ],
    controllers: [HealthController],
    providers: [MongoHealthIndicator]
})
export class HealthModule {}
