import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, UnauthorizedError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import { LoginController } from './login.controller';
import type { LoginService } from './login.service';

const config = {
    auth: { idp: { provider: 'keycloak' } },
    http: { cors: { origins: ['http://localhost:4200'] } }
} as unknown as AppConfigService;

const setup = () => {
    const login = { begin: vi.fn().mockResolvedValue('https://idp.example.org/authorize'), complete: vi.fn() };
    const controller = new LoginController(login as unknown as LoginService, config);
    const res = { redirect: vi.fn(), header: vi.fn() };
    const session = {
        accessToken: undefined as string | undefined,
        regenerate: vi.fn(function (this: typeof session, done: (error?: unknown) => void) {
            this.accessToken = undefined;
            done();
        }),
        destroy: vi.fn((done: (error?: unknown) => void) => done())
    };
    const request = (extra: Record<string, unknown> = {}) =>
        ({ session, query: {}, headers: {}, ...extra }) as unknown as Request;
    return {
        login,
        controller,
        res: res as unknown as Response,
        redirect: res.redirect,
        header: res.header,
        session,
        request
    };
};

describe('LoginController', () => {
    it('sends the user to the main provider, or to another by its id', async () => {
        const { controller, login, res, redirect, request } = setup();
        await controller.start(request(), res);
        await controller.startWith('eori-1', request(), res);
        expect(login.begin).toHaveBeenNthCalledWith(1, expect.anything(), 'local', '/');
        expect(login.begin).toHaveBeenNthCalledWith(2, expect.anything(), 'eori-1', '/');
        expect(redirect).toHaveBeenCalledWith('https://idp.example.org/authorize');
    });

    it('keeps from where the user came, from the portal or from the page of this site that linked here, and nothing from outside', async () => {
        const { controller, login, res, request } = setup();
        await controller.start(request({ query: { came_from: '/offering/7' } }), res);
        await controller.start(request({ query: { came_from: 'https://evil.example.org' } }), res);
        await controller.start(
            request({ headers: { host: 'bae.example.org', referer: 'https://bae.example.org/catalog?a=1' } }),
            res
        );
        await controller.start(
            request({ headers: { host: 'bae.example.org', referer: 'https://other.example.org/x' } }),
            res
        );
        expect(login.begin.mock.calls.map((call) => call[2])).toEqual(['/offering/7', '/', '/catalog?a=1', '/']);
    });

    it('does not take a provider that is not there for a failed login', async () => {
        const { controller, login, res, request } = setup();
        login.begin.mockRejectedValue(new NotFoundError('There is no such identity provider'));
        await expect(controller.startWith('nobody', request(), res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('finishes the login of the main provider under its name, with a new session that keeps the token', async () => {
        const { controller, login, res, redirect, session, request } = setup();
        login.complete.mockImplementation((s: { accessToken?: string }) => {
            s.accessToken = 'at';
            return Promise.resolve({ redirectTo: '/dashboard?token=local' });
        });

        await controller.callback('keycloak', { code: 'abc', state: 's' }, request(), res);

        expect(login.complete).toHaveBeenCalledWith(session, 'local', { code: 'abc', state: 's' });
        expect(session.regenerate).toHaveBeenCalled();
        expect(session.accessToken).toBe('at');
        expect(redirect).toHaveBeenCalledWith('/dashboard?token=local');
    });

    it('finishes the login of another provider under its id', async () => {
        const { controller, login, res, request } = setup();
        login.complete.mockResolvedValue({ redirectTo: '/offering/7' });
        await controller.callback('eori-1', { code: 'abc', state: 's' }, request(), res);
        expect(login.complete).toHaveBeenCalledWith(expect.anything(), 'eori-1', expect.anything());
    });

    it('sends to the error page the login that did not complete, with no new session', async () => {
        const { controller, login, res, redirect, session, request } = setup();
        login.complete.mockRejectedValue(new UnauthorizedError('The login could not be completed'));
        await controller.callback('keycloak', {}, request(), res);
        expect(redirect).toHaveBeenCalledWith('/error');
        expect(session.regenerate).not.toHaveBeenCalled();
    });

    it('lets what is not a failed login through as the failure it is', async () => {
        const { controller, login, res, request } = setup();
        login.complete.mockRejectedValue(new NotFoundError('There is no such identity provider'));
        await expect(controller.callback('nobody', {}, request(), res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('ends the session and sends the user to the main page', async () => {
        const { controller, res, redirect, session, request } = setup();
        await controller.logout(request(), res);
        expect(session.destroy).toHaveBeenCalled();
        expect(redirect).toHaveBeenCalledWith('/');
    });

    it('gives the profile of who is logged in, and lets the cookie in only from the sites the configuration lists', () => {
        const { controller, res, header, request } = setup();
        const user = { id: 'u1', accessToken: 'at' };
        expect(controller.token(request({ user, headers: { origin: 'http://localhost:4200' } }), res)).toBe(user);
        expect(header).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');

        header.mockClear();
        controller.token(request({ user, headers: { origin: 'https://evil.example.org' } }), res);
        controller.token(request({ user }), res);
        expect(header).not.toHaveBeenCalled();
    });
});
