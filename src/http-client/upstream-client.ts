import type { UpstreamName } from '../config/upstream-names';

export interface UpstreamRequest {
    upstream: UpstreamName;
    path: string;
    method?: string;
    query?: Record<string, string | string[]>;
    headers?: Record<string, string>;
    body?: string | Uint8Array<ArrayBuffer> | FormData;
    timeoutMs?: number;
}

export interface UpstreamResponse {
    status: number;
    headers: Headers;
    body: string;
}

export type UpstreamErrorKind = 'http' | 'timeout' | 'network';

export class UpstreamError extends Error {
    constructor(
        readonly kind: UpstreamErrorKind,
        readonly upstream: string,
        message: string,
        readonly status?: number,
        readonly body?: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'UpstreamError';
    }
}

export abstract class UpstreamClient {
    /** Resolves for any HTTP status; rejects with an UpstreamError on timeouts and network failures. */
    abstract send(request: UpstreamRequest): Promise<UpstreamResponse>;

    /** Like send, but rejects with an UpstreamError on non-2xx statuses and parses the JSON body. */
    async json<T = unknown>(request: UpstreamRequest): Promise<T> {
        const response = await this.send(request);
        if (response.status < 200 || response.status >= 300) {
            throw new UpstreamError(
                'http',
                request.upstream,
                `${request.upstream} answered ${response.status}`,
                response.status,
                response.body
            );
        }
        return (response.body === '' ? undefined : JSON.parse(response.body)) as T;
    }
}

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

/** fetch has already decoded the body, so encoding and length no longer describe it. */
export const forwardableHeaders = (headers: Headers): Record<string, string> => {
    const forwarded: Record<string, string> = {};
    headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name) && name !== 'content-encoding' && name !== 'content-length') {
            forwarded[name] = value;
        }
    });
    return forwarded;
};
