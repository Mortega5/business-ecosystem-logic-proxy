import { Injectable, type NestMiddleware } from '@nestjs/common';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { AppConfigService } from '../config/app-config.service';

/**
 * The body of a request as text, up to `http.bodyLimit`; a bigger one is refused
 * with 413. Applied to the controllers that take a body, so no other route parses one.
 */
@Injectable()
export class RawTextMiddleware implements NestMiddleware {
    private readonly parse: RequestHandler;

    constructor(config: AppConfigService) {
        this.parse = express.text({ type: () => true, limit: config.http.bodyLimit });
    }

    use(req: Request, res: Response, next: NextFunction): void {
        this.parse(req, res, next);
    }
}
