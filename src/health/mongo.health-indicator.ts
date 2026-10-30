import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { AppConfigService } from '../config/app-config.service';
import { MongoConnectionService } from '../persistence/mongo-connection.service';

@Injectable()
export class MongoHealthIndicator {
    constructor(
        private readonly indicators: HealthIndicatorService,
        private readonly mongo: MongoConnectionService,
        private readonly config: AppConfigService
    ) {}

    async check() {
        const indicator = this.indicators.check('mongodb');
        const reachable = await this.mongo.ping(this.config.health.mongoPingTimeoutMs);
        return reachable ? indicator.up() : indicator.down({ message: 'MongoDB is not reachable' });
    }
}
