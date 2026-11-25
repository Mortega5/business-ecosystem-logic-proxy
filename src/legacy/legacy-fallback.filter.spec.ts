import { NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { LegacyFallbackFilter } from './legacy-fallback.filter';

const run = (request: Record<string, unknown>) => {
    const legacy = vi.fn();
    const filter = new LegacyFallbackFilter(legacy);
    const req = { url: '/domeblog', method: 'GET', headers: {}, ...request } as unknown as IncomingMessage;
    const host = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) as ServerResponse })
    } as unknown as ArgumentsHost;
    filter.catch(new NotFoundException(), host);
    return { legacy, req };
};

describe('LegacyFallbackFilter', () => {
    it('hands the request to the legacy application', () => {
        const { legacy } = run({});
        expect(legacy).toHaveBeenCalledOnce();
    });

    it('gives the legacy application the token of the session as the bearer token it asks for', () => {
        const { req } = run({ session: { accessToken: 'at-ana' } });
        expect(req.headers['authorization']).toBe('Bearer at-ana');
    });

    it('does not replace a token that the request carries, or invent one when there is no session', () => {
        expect(
            run({ session: { accessToken: 'at-ana' }, headers: { authorization: 'Bearer own' } }).req.headers[
                'authorization'
            ]
        ).toBe('Bearer own');
        expect(
            run({ session: { accessToken: 'at-ana' }, headers: { 'x-auth-token': 'own' } }).req.headers['authorization']
        ).toBeUndefined();
        expect(run({ session: {} }).req.headers['authorization']).toBeUndefined();
        expect(run({}).req.headers['authorization']).toBeUndefined();
    });
});
