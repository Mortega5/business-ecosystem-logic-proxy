import { Catch, NotFoundException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type LegacyHandler = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Same page Express 4 sends when no route matches
const sendNotFound = (req: IncomingMessage, res: ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(
        `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${escapeHtml(req.method ?? 'GET')} ${escapeHtml(path)}</pre>\n</body>\n</html>\n`
    );
};

// Express 5 serves req.query from a getter on its prototype and Express 4 swaps that prototype
// when it takes over, so the value would vanish; keep it as an own property.
const keepQuery = (req: IncomingMessage): void => {
    if (!Object.hasOwn(req, 'query')) {
        const value = (req as IncomingMessage & { query?: unknown }).query;
        Object.defineProperty(req, 'query', { value, writable: true, enumerable: true, configurable: true });
    }
};

/** Hands every request Nest has no route for to the legacy Express app. */
@Catch(NotFoundException)
export class LegacyFallbackFilter implements ExceptionFilter {
    constructor(private readonly legacy: LegacyHandler) {
        // Turns off the X-Powered-By header of the legacy application
        (legacy as { disable?: (setting: string) => unknown }).disable?.('x-powered-by');
    }

    catch(_exception: NotFoundException, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const req = http.getRequest<IncomingMessage>();
        const res = http.getResponse<ServerResponse>();
        keepQuery(req);
        this.legacy(req, res, (error?: unknown) => {
            if (error === undefined) {
                sendNotFound(req, res);
                return;
            }
            res.statusCode = 500;
            res.end();
        });
    }
}
