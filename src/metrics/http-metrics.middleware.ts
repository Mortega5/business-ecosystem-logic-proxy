import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

// What no route answered: the portal files, and the paths that do not exist. One label, not one per path
const UNMATCHED = 'unmatched';

/** Times every request that is answered and records it by route template; the ones refused are counted by API. */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
    constructor(private readonly metrics: MetricsService) {}

    use(req: Request, res: Response, next: NextFunction): void {
        const started = process.hrtime.bigint();
        res.once('finish', () => {
            const seconds = Number(process.hrtime.bigint() - started) / 1e9;
            const route = typeof req.route?.path === 'string' ? `${req.baseUrl}${req.route.path}` : UNMATCHED;
            this.metrics.observeHttpRequest(req.method, route, res.statusCode, seconds);
            if (res.statusCode === 401 || res.statusCode === 403) {
                this.metrics.authFailure(res.statusCode, route === UNMATCHED ? UNMATCHED : (route.split('/')[1] ?? UNMATCHED));
            }
        });
        next();
    }
}
