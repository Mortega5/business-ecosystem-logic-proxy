import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { text } from 'body-parser';
import type { Request, RequestHandler, Response } from 'express';
import type { Observable } from 'rxjs';
import { AppConfigService } from '../config/app-config.service';

/**
 * The body of a request as text, up to `http.bodyLimit`; a bigger one is refused with 413. A multipart body is left alone, for a
 * route that sends it on as a stream. It is an interceptor, which runs after the guards, and not a middleware, which runs before
 * them: the body of a request that is refused for who it comes from, or for a feature that is off, is never read. Declared on the
 * controllers that take a body, so no other route parses one.
 */
@Injectable()
export class BodyTextInterceptor implements NestInterceptor {
    private readonly parse: RequestHandler;

    constructor(config: AppConfigService) {
        this.parse = text({
            type: (req) => !(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data'),
            limit: config.http.bodyLimit
        });
    }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
        const http = context.switchToHttp();
        await new Promise<void>((resolve, reject) => {
            this.parse(http.getRequest<Request>(), http.getResponse<Response>(), (error?: unknown) => (error === undefined ? resolve() : reject(error)));
        });
        return next.handle();
    }
}
