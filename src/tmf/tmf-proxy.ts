import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamName } from '../config/upstream-names';
import { forwardableHeaders, UpstreamClient, UpstreamError, type UpstreamResponse } from '../http-client/upstream-client';
import { buildUpstreamHeaders, type UpstreamUser } from './upstream-headers';

export interface ProxyTarget {
    upstream: UpstreamName;
    /** The path on the upstream, built by the controller from what it has validated; never the client's own URL. */
    path: string;
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
        try {
            return await this.upstream.send({
                upstream: target.upstream,
                path: target.path,
                method: req.method,
                ...(queryStart < 0 ? {} : { search: req.originalUrl.slice(queryStart) }),
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

    reply(res: Response, response: UpstreamResponse): void {
        res.status(response.status);
        for (const [name, value] of Object.entries(forwardableHeaders(response.headers))) {
            if (!NOT_FORWARDED.has(name) && !name.startsWith('access-control-')) {
                res.setHeader(name, value);
            }
        }
        // Without a type the body is not HTML, and no browser is to guess that it is
        if (!res.hasHeader('content-type')) {
            res.setHeader('content-type', 'application/octet-stream');
        }
        res.setHeader('x-content-type-options', 'nosniff');
        res.send(Buffer.from(response.body));
    }

    async forward(req: Request, res: Response, target: ProxyTarget): Promise<void> {
        this.reply(res, await this.send(req, target));
    }
}
