import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { MongoHealthIndicator } from './mongo.health-indicator';

@Controller('health')
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        private readonly mongo: MongoHealthIndicator
    ) {}

    /** The process is running; deliberately independent of every dependency so an outage never restarts the pod. */
    @Get('live')
    live(): { status: string } {
        return { status: 'ok' };
    }

    /** Ready to receive traffic: needs MongoDB, and follows its state as the connection drops and recovers. */
    @Get('ready')
    @HealthCheck()
    ready() {
        return this.health.check([() => this.mongo.check()]);
    }
}
