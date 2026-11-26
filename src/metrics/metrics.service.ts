import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';
import { AppConfigService } from '../config/app-config.service';

/** The registry of the process: what is measured by itself, and the metrics that the modules record. */
@Injectable()
export class MetricsService {
    private readonly registry = new Registry();
    private readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;

    constructor(config: AppConfigService) {
        const { prefix, defaultMetrics, httpDurationBuckets } = config.metrics;
        if (defaultMetrics) {
            // With their standard names, which the dashboards of Node.js look for
            collectDefaultMetrics({ register: this.registry });
        }
        this.httpDuration = new Histogram({
            name: `${prefix === '' ? '' : `${prefix}_`}http_server_request_duration_seconds`,
            help: 'Time taken to answer a request, by method, route template and class of status',
            labelNames: ['method', 'route', 'status_class'],
            buckets: httpDurationBuckets,
            registers: [this.registry]
        });
    }

    /** `route` is the template of the route (`/catalog/:id`), never the URL, so the labels stay few. */
    observeHttpRequest(method: string, route: string, status: number, seconds: number): void {
        this.httpDuration.observe({ method, route, status_class: `${Math.floor(status / 100)}xx` }, seconds);
    }

    contentType(): string {
        return this.registry.contentType;
    }

    render(): Promise<string> {
        return this.registry.metrics();
    }
}
