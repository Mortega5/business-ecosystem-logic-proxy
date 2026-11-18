import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { DomainError } from '../common/domain-error';
import { parseSize } from '../common/size';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamName } from '../config/upstream-names';
import { forwardableHeaders, UpstreamClient, UpstreamError, type UpstreamResponse } from '../http-client/upstream-client';
import { buildUpstreamHeaders, type UpstreamUser } from './upstream-headers';

export interface ProxyTarget {
    upstream: UpstreamName;
    /** The path on the upstream, built by the controller from what it has validated; never the client's own URL. */
    path: string;
    /** The method to use when it is not the request's own, as in a read that comes before a write. */
    method?: string;
    /** The body to send, when the route takes one: it is the controller that says so, never the request. */
    body?: string;
    /** The request is a file upload (multipart): its body is sent on as it arrives, up to `http.uploadLimit`. */
    upload?: boolean;
    /** The query string to send, with its `?`; when the route sets it, the client's own is not sent at all. */
    search?: string;
    /** Headers of the answer that the route sets itself, whatever the upstream said. */
    responseHeaders?: Record<string, string>;
}

// What an upstream must not decide for the proxy's own origin: cookies, cross-origin policy, what software it runs
const NOT_FORWARDED = new Set(['set-cookie', 'server', 'x-powered-by']);

/**
 * Passes a request to an upstream and the answer back. It decides nothing about who may ask or what may be asked:
 * the guard and the controller have done that before calling it, and what the controller wants checked or changed in
 * the answer it does between `send` and `reply`.
 */
@Injectable()
export class TmfProxy {
    constructor(
        private readonly upstream: UpstreamClient,
        private readonly config: AppConfigService
    ) {}

    async send(req: Request, target: ProxyTarget): Promise<UpstreamResponse> {
        const queryStart = req.originalUrl.indexOf('?');
        const search = target.search ?? (queryStart < 0 ? undefined : req.originalUrl.slice(queryStart));
        try {
            return await this.upstream.send({
                upstream: target.upstream,
                path: target.path,
                method: target.method ?? req.method,
                ...(target.body === undefined ? {} : { body: target.body }),
                ...(target.upload === true ? { body: this.upload(req) } : {}),
                ...(search === undefined ? {} : { search }),
                headers: buildUpstreamHeaders({
                    client: req.headers,
                    user: (req as Request & { user?: UpstreamUser }).user,
                    forwardedFor: req.ip,
                    policy: this.config.auth
                })
            });
        } catch (error) {
            if (error instanceof UpstreamError) {
                throw new DomainError('Service unreachable', 504);
            }
            throw error;
        }
    }

    /** The body of the request as a stream, refused when it is not a multipart one or goes over the limit. */
    private upload(req: Request): ReadableStream<Uint8Array> {
        const limit = parseSize(this.config.http.uploadLimit) ?? 0;
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data')) {
            throw new DomainError('Unsupported media type', 415);
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            throw new DomainError('Upload too large', 413);
        }
        let received = 0;
        const counter = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > limit) {
                    controller.error(new DomainError('Upload too large', 413));
                    return;
                }
                controller.enqueue(chunk);
            }
        });
        return (Readable.toWeb(req) as ReadableStream<Uint8Array>).pipeThrough(counter);
    }

    reply(res: Response, response: UpstreamResponse, headers: Record<string, string> = {}): void {
        res.status(response.status);
        for (const [name, value] of Object.entries(forwardableHeaders(response.headers))) {
            if (!NOT_FORWARDED.has(name) && !name.startsWith('access-control-')) {
                res.setHeader(name, value);
            }
        }
        for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
        }
        // Without a type the body is not HTML, and no browser is to guess that it is
        if (!res.hasHeader('content-type')) {
            res.setHeader('content-type', 'application/octet-stream');
        }
        res.setHeader('x-content-type-options', 'nosniff');
        res.send(Buffer.from(response.body));
    }

    async forward(req: Request, res: Response, target: ProxyTarget): Promise<void> {
        this.reply(res, await this.send(req, target), target.responseHeaders);
    }
}
