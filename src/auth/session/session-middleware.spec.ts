import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service';
import { MemoryAuthStore } from '../store/memory-auth-store';
import { createSessionMiddleware } from './session-middleware';

const configWith = (session: Record<string, unknown>) =>
    ({
        auth: { session: { maxAgeMs: 60_000, cookieSecure: 'false', cookieSameSite: 'lax', ...session } }
    }) as unknown as AppConfigService;

const run = (middleware: ReturnType<typeof createSessionMiddleware>, req: Record<string, unknown>) => {
    const headers: Record<string, unknown> = {};
    const res = {
        getHeader: (name: string) => headers[name.toLowerCase()],
        setHeader: (name: string, value: unknown) => (headers[name.toLowerCase()] = value),
        on: () => res,
        end: () => undefined,
        writeHead: () => undefined
    };
    return new Promise<{ req: Request, headers: Record<string, unknown> }>((resolve, reject) => {
        const request = { headers: {}, url: '/', originalUrl: '/', connection: {}, ...req } as unknown as Request;
        middleware(request, res as unknown as Response, (err?: unknown) =>
            err ? reject(err as Error) : resolve({ req: request, headers })
        );
    });
};

describe('createSessionMiddleware', () => {
    const secret = 's'.repeat(32);

    it('refuses to be built without a secret', () => {
        expect(() => createSessionMiddleware(configWith({}), new MemoryAuthStore(10))).toThrow('auth.session.secret');
    });

    it('gives each request a session that has the cookie settings of the configuration', async () => {
        const middleware = createSessionMiddleware(
            configWith({ secret, cookieSameSite: 'strict' }),
            new MemoryAuthStore(10)
        );
        const { req } = await run(middleware, {});
        expect(req.session.cookie).toMatchObject({
            httpOnly: true,
            sameSite: 'strict',
            secure: false,
            originalMaxAge: 60_000
        });
    });
});
