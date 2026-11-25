import { Catch, NotFoundException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where the compiled portal is: `portal/bae-frontend` at the root of the project, which is above `src` and above `dist`. */
export const PORTAL_DIR = join(__dirname, '..', '..', 'portal', 'bae-frontend');

const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Serves the files of the portal. It goes after the security headers, so they are on the files too. */
export const servePortal = (app: NestExpressApplication, dir: string = PORTAL_DIR): void => {
    if (existsSync(join(dir, 'index.html'))) {
        app.useStaticAssets(dir, { index: ['index.html'] });
    }
};

/**
 * What no route answers. A browser that asks for a page (it accepts HTML) gets the portal, which has the routes of its own and resolves
 * them in the browser, so a link to one of them works when it is opened directly. Anything else is a 404 that says what was asked for.
 */
@Catch(NotFoundException)
export class PortalFallbackFilter implements ExceptionFilter {
    constructor(private readonly dir: string = PORTAL_DIR) {}

    catch(_exception: NotFoundException, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const req = http.getRequest<Request>();
        const res = http.getResponse<Response>();
        const index = join(this.dir, 'index.html');
        if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html' && existsSync(index)) {
            res.sendFile(index);
            return;
        }
        res.status(404);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        res.end(
            `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot ${escapeHtml(req.method)} ${escapeHtml(req.path)}</pre>\n</body>\n</html>\n`
        );
    }
}
