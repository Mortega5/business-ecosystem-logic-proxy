import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { AppConfigService } from '../config/app-config.service';
import { listenToMetricEvents, type MetricEvents } from './metric-events';

/** The registry of the process: what is measured by itself, and the metrics that the modules tell about. */
@Injectable()
export class MetricsService implements MetricEvents, OnModuleInit, OnModuleDestroy {
    private readonly registry = new Registry();
    private readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;
    private readonly upstreamDuration: Histogram<'upstream' | 'method' | 'outcome'>;
    private readonly authFailures: Counter<'status' | 'api'>;
    private readonly logins: Counter<'provider' | 'result'>;
    private readonly profileCaches: Counter<'result'>;
    private readonly statsRefreshes: Counter<'result'>;
    private readonly draining: Gauge;
    // Created by the first check: a gauge that has never been set would say 0, as if MongoDB were down
    private mongo: Gauge | undefined;
    private readonly named: (name: string) => string;
    private stopListening: (() => void) | undefined;

    constructor(config: AppConfigService) {
        const { prefix, defaultMetrics, httpDurationBuckets, upstreamDurationBuckets } = config.metrics;
        const named = (name: string): string => `${prefix === '' ? '' : `${prefix}_`}${name}`;
        this.named = named;
        const registers = [this.registry];
        if (defaultMetrics) {
            // With their standard names, which the dashboards of Node.js look for
            collectDefaultMetrics({ register: this.registry });
        }
        this.httpDuration = new Histogram({
            name: named('http_server_request_duration_seconds'),
            help: 'Time taken to answer a request, by method, route template and class of status',
            labelNames: ['method', 'route', 'status_class'],
            buckets: httpDurationBuckets,
            registers
        });
        this.upstreamDuration = new Histogram({
            name: named('upstream_request_duration_seconds'),
            help: 'Time taken by a call to a third party, by its name, method and outcome',
            labelNames: ['upstream', 'method', 'outcome'],
            buckets: upstreamDurationBuckets,
            registers
        });
        this.authFailures = new Counter({
            name: named('auth_failures_total'),
            help: 'Requests refused for who makes them (401) or for what they may do (403), by API',
            labelNames: ['status', 'api'],
            registers
        });
        this.logins = new Counter({
            name: named('login_total'),
            help: 'Logins that ended, by identity provider and result',
            labelNames: ['provider', 'result'],
            registers
        });
        this.profileCaches = new Counter({
            name: named('profile_cache_total'),
            help: 'Tokens whose profile was kept (hit) or had to be asked for (miss)',
            labelNames: ['result'],
            registers
        });
        this.statsRefreshes = new Counter({
            name: named('stats_refresh_total'),
            help: 'Reads of the figures of the landing page that ended, by result',
            labelNames: ['result'],
            registers
        });
        this.draining = new Gauge({
            name: named('draining'),
            help: '1 while the process shuts down and no longer takes traffic, 0 otherwise',
            registers
        });
        this.draining.set(0);
    }

    onModuleInit(): void {
        this.stopListening = listenToMetricEvents(this);
    }

    onModuleDestroy(): void {
        this.draining.set(1);
        this.stopListening?.();
    }

    /** `route` is the template of the route (`/catalog/:id`), never the URL, so the labels stay few. */
    observeHttpRequest(method: string, route: string, status: number, seconds: number): void {
        this.httpDuration.observe({ method, route, status_class: `${Math.floor(status / 100)}xx` }, seconds);
    }

    /** `api` is the first segment of the route that refused it. */
    authFailure(status: 401 | 403, api: string): void {
        this.authFailures.inc({ status: String(status), api });
    }

    upstreamCall(upstream: string, method: string, outcome: string, seconds: number): void {
        this.upstreamDuration.observe({ upstream, method, outcome }, seconds);
    }

    login(provider: string, result: 'success' | 'failure'): void {
        this.logins.inc({ provider, result });
    }

    profileCache(result: 'hit' | 'miss'): void {
        this.profileCaches.inc({ result });
    }

    statsRefresh(result: 'success' | 'failure'): void {
        this.statsRefreshes.inc({ result });
    }

    mongoUp(up: boolean): void {
        this.mongo ??= new Gauge({
            name: this.named('mongo_up'),
            help: 'Whether MongoDB answered the last readiness check: 1 or 0. It has no value until the first check',
            registers: [this.registry]
        });
        this.mongo.set(up ? 1 : 0);
    }

    contentType(): string {
        return this.registry.contentType;
    }

    render(): Promise<string> {
        return this.registry.metrics();
    }
}
