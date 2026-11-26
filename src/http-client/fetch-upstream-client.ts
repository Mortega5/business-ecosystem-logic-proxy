import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DomainError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { sanitizeUrl } from '../logging/pino-options';
import { currentRequestId } from '../logging/request-id';
import { assertSafePath } from './safe-path';
import { upstreamErrorDetail } from './upstream-error-detail';
import { UpstreamClient, UpstreamError, type UpstreamRequest, type UpstreamResponse } from './upstream-client';

// The path is checked before it is joined, and the result afterwards: whatever the URL parser did, the request must
// still go to the same server and stay under the base path of its API
const buildUrl = (baseUrl: string, request: UpstreamRequest): URL => {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}${assertSafePath(`/${request.path.replace(/^\/+/, '')}`)}`);
    if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
        throw new DomainError('Invalid request path', 400);
    }
    if (request.search !== undefined && request.search !== '') {
        url.search = request.search;
    }
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
        private readonly logger: PinoLogger
    ) {
        super();
        this.logger.setContext(FetchUpstreamClient.name);
    }

    async send(request: UpstreamRequest): Promise<UpstreamResponse> {
        const upstream = this.config.upstream(request.upstream);
        const url = buildUrl(upstream.baseUrl, request);
        const method = request.method ?? 'GET';
        const logged = { upstream: request.upstream, method, url: sanitizeUrl(url.toString()) };
        const requestId = currentRequestId();
        const headers = requestId === undefined ? request.headers : { 'x-request-id': requestId, ...request.headers };
        const started = performance.now();
        const elapsed = (): number => Math.round(performance.now() - started);

        try {
            const response = await fetch(url, {
                method,
                ...(headers === undefined ? {} : { headers }),
                ...(request.body === undefined ? {} : { body: request.body }),
                ...(request.body instanceof ReadableStream ? { duplex: 'half' } : {}),
                redirect: 'manual',
                signal: AbortSignal.timeout(request.timeoutMs ?? upstream.timeoutMs)
            });
            const body = await response.text();
            // The access line of the request already says that it went well
            const level = response.status >= 500 ? 'warn' : response.status >= 400 ? 'info' : 'debug';
            const detail = response.status >= 400 ? upstreamErrorDetail(body) : undefined;
            this.logger[level](
                { ...logged, statusCode: response.status, durationMs: elapsed(), ...(detail === undefined ? {} : { upstreamError: detail }) },
                'upstream request completed'
            );
            return { status: response.status, headers: response.headers, body };
        } catch (error) {
            // What a route raised while its body was being sent, such as a file over the limit
            const raised = error instanceof DomainError ? error : error instanceof Error ? error.cause : undefined;
            if (raised instanceof DomainError) {
                throw raised;
            }
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
