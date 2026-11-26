import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { MetricsService } from './metrics.service';

const serviceWith = (metrics: object): MetricsService =>
    new MetricsService({ metrics: { prefix: '', defaultMetrics: false, httpDurationBuckets: [0.1, 1], ...metrics } } as unknown as AppConfigService);

describe('MetricsService', () => {
    it('records a request by method, route template and class of status', async () => {
        const service = serviceWith({});
        service.observeHttpRequest('GET', '/catalog/:id', 404, 0.05);

        const text = await service.render();
        expect(text).toContain('http_server_request_duration_seconds_bucket{le="0.1",method="GET",route="/catalog/:id",status_class="4xx"} 1');
        expect(text).toContain('http_server_request_duration_seconds_count{method="GET",route="/catalog/:id",status_class="4xx"} 1');
    });

    it('uses the buckets and the prefix of the configuration', async () => {
        const service = serviceWith({ prefix: 'bae_proxy', httpDurationBuckets: [0.5] });
        service.observeHttpRequest('GET', '/x', 200, 0.1);

        const text = await service.render();
        expect(text).toContain('bae_proxy_http_server_request_duration_seconds_bucket{le="0.5"');
        expect(text).not.toContain('le="0.1"');
    });

    it('measures the process only when the configuration says so, and with its standard names whatever the prefix', async () => {
        expect(await serviceWith({ defaultMetrics: false }).render()).not.toContain('process_cpu_user_seconds_total');
        const text = await serviceWith({ defaultMetrics: true, prefix: 'bae_proxy' }).render();
        expect(text).toContain('\nprocess_cpu_user_seconds_total ');
        expect(text).not.toContain('bae_proxy_process');
    });
});
