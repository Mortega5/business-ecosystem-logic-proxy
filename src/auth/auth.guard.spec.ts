import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '../common/domain-error';
import { AuthGuard } from './auth.guard';
import { OptionalAuth, Public } from './public.decorator';
import type { RequestAuthenticator } from './request-authenticator';

class Routes {
    @Public()
    open(): void {}

    @OptionalAuth()
    either(): void {}

    closed(): void {}
}

const setup = (user?: object) => {
    const authenticate = vi.fn().mockResolvedValue(user);
    const guard = new AuthGuard(new Reflector(), { authenticate } as unknown as RequestAuthenticator);
    const request: { user?: object } = {};
    const run = (handler: keyof Routes): Promise<boolean> =>
        guard.canActivate({
            getHandler: () => Routes.prototype[handler],
            getClass: () => Routes,
            switchToHttp: () => ({ getRequest: () => request })
        } as unknown as ExecutionContext);
    return { run, request, authenticate };
};

describe('AuthGuard', () => {
    it('lets a public route in without identifying anybody', async () => {
        const { run, authenticate } = setup({ id: 'u1' });
        expect(await run('open')).toBe(true);
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('lets in a private route the user who is logged in, and puts the user in the request', async () => {
        const { run, request } = setup({ id: 'u1' });
        expect(await run('closed')).toBe(true);
        expect(request.user).toEqual({ id: 'u1' });
    });

    it('refuses a private route when nobody is identified', async () => {
        const { run, request } = setup();
        await expect(run('closed')).rejects.toBeInstanceOf(UnauthorizedError);
        expect(request.user).toBeUndefined();
    });

    it('lets in a route with optional authentication with or without user, and identifies the user when there is one', async () => {
        const anonymous = setup();
        expect(await anonymous.run('either')).toBe(true);
        expect(anonymous.request.user).toBeUndefined();

        const identified = setup({ id: 'u1' });
        expect(await identified.run('either')).toBe(true);
        expect(identified.request.user).toEqual({ id: 'u1' });
    });

    it('refuses a token that is not valid even where the authentication is optional', async () => {
        const { run, authenticate } = setup();
        authenticate.mockRejectedValue(new UnauthorizedError('It has not been possible to obtain your user info'));
        await expect(run('either')).rejects.toBeInstanceOf(UnauthorizedError);
    });
});
