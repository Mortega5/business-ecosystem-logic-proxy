import type { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { listenToMetricEvents, type MetricEvents } from '../metrics/metric-events';
import type { MongoConnectionService } from '../persistence/mongo-connection.service';
import { MongoHealthIndicator } from './mongo.health-indicator';

const indicatorFor = (reachable: boolean): MongoHealthIndicator =>
    new MongoHealthIndicator(
        { check: () => ({ up: () => ({}), down: () => ({}) }) } as unknown as HealthIndicatorService,
        { ping: () => Promise.resolve(reachable) } as unknown as MongoConnectionService,
        { health: { mongoPingTimeoutMs: 100 } } as unknown as AppConfigService
    );

describe('MongoHealthIndicator: the metrics', () => {
    it('tells whether MongoDB answered each time it is checked', async () => {
        const mongoUp = vi.fn();
        const stop = listenToMetricEvents({ mongoUp } as unknown as MetricEvents);
        try {
            await indicatorFor(true).check();
            await indicatorFor(false).check();
        } finally {
            stop();
        }

        expect(mongoUp.mock.calls).toEqual([[true], [false]]);
    });
});
