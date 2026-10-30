import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { MongoHealthIndicator } from './mongo.health-indicator';

@Module({
    imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
    controllers: [HealthController],
    providers: [MongoHealthIndicator]
})
export class HealthModule {}
