import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { metric } from './metric-events';
import { MetricsService } from './metrics.service';

const serviceWith = (metrics: object): MetricsService =>
    new MetricsService({ metrics: { prefix: '', defaultMetrics: false, httpDurationBuckets: [0.1, 1], upstreamDurationBuckets: [0.1, 1], ...metrics } } as unknown as AppConfigService);

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

    it('records the calls to third parties by name, method and outcome', async () => {
        const service = serviceWith({});
        service.upstreamCall('charging', 'POST', 'timeout', 0.5);

        expect(await service.render()).toContain('upstream_request_duration_seconds_count{upstream="charging",method="POST",outcome="timeout"} 1');
    });

    it('counts what is refused, the logins, the profile cache and the reads of the figures', async () => {
        const service = serviceWith({});
        service.authFailure(403, 'catalog');
        service.login('keycloak', 'failure');
        service.profileCache('hit');
        service.statsRefresh('success');

        const text = await service.render();
        expect(text).toContain('auth_failures_total{status="403",api="catalog"} 1');
        expect(text).toContain('login_total{provider="keycloak",result="failure"} 1');
        expect(text).toContain('profile_cache_total{result="hit"} 1');
        expect(text).toContain('stats_refresh_total{result="success"} 1');
    });

    it('says whether MongoDB answered, and has no value before the first check', async () => {
        const service = serviceWith({});
        expect(await service.render()).not.toContain('\nmongo_up ');

        service.mongoUp(false);
        expect(await service.render()).toContain('\nmongo_up 0');
        service.mongoUp(true);
        expect(await service.render()).toContain('\nmongo_up 1');
    });

    it('says it is draining when the module is destroyed', async () => {
        const service = serviceWith({});
        service.onModuleInit();
        expect(await service.render()).toContain('\ndraining 0');

        service.onModuleDestroy();
        expect(await service.render()).toContain('\ndraining 1');
    });

    it('listens to the events of the proxy while the module lives', async () => {
        const service = serviceWith({});
        service.onModuleInit();
        metric.profileCache('miss');
        service.onModuleDestroy();
        metric.profileCache('miss');

        expect(await service.render()).toContain('profile_cache_total{result="miss"} 1');
    });
});
