import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { sanitizeUrl } from '../logging/pino-options';
import { UpstreamClient, UpstreamError, type UpstreamRequest, type UpstreamResponse } from './upstream-client';

const buildUrl = (baseUrl: string, request: UpstreamRequest): URL => {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${request.path.replace(/^\/+/, '')}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value]) {
            url.searchParams.append(name, item);
        }
    }
    return url;
};

@Injectable()
export class FetchUpstreamClient extends UpstreamClient {
    constructor(
        private readonly config: AppConfigService,
        @InjectPinoLogger(FetchUpstreamClient.name) private readonly logger: PinoLogger
    ) {
        super();
    }

    async send(request: UpstreamRequest): Promise<UpstreamResponse> {
        const upstream = this.config.upstreams[request.upstream];
        if (upstream === undefined) {
            throw new Error(`Unknown upstream "${request.upstream}"`);
        }
        const url = buildUrl(upstream.baseUrl, request);
        const method = request.method ?? 'GET';
        const logged = { upstream: request.upstream, method, url: sanitizeUrl(url.toString()) };
        const started = performance.now();
        const elapsed = (): number => Math.round(performance.now() - started);

        try {
            const response = await fetch(url, {
                method,
                ...(request.headers === undefined ? {} : { headers: request.headers }),
                ...(request.body === undefined ? {} : { body: request.body }),
                redirect: 'manual',
                signal: AbortSignal.timeout(request.timeoutMs ?? upstream.timeoutMs)
            });
            const body = await response.text();
            const level = response.status >= 500 ? 'warn' : 'info';
            this.logger[level]({ ...logged, statusCode: response.status, durationMs: elapsed() }, 'upstream request completed');
            return { status: response.status, headers: response.headers, body };
        } catch (error) {
            const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
            this.logger.error({ ...logged, durationMs: elapsed(), err: error }, 'upstream request failed');
            throw new UpstreamError(
                timedOut ? 'timeout' : 'network',
                request.upstream,
                `${request.upstream} ${timedOut ? 'timed out' : 'is unreachable'}`,
                undefined,
                undefined,
                { cause: error }
            );
        }
    }
}
