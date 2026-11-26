import type { SessionData } from 'express-session';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, UnauthorizedError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import type { ProfileService } from '../profile/profile.service';
import type { UserProfile } from '../profile/user-profile';
import type { IdentityProvider, LoginCapable, LoginChecks, LoginOutcome } from '../providers/identity-provider';
import { IdentityProviderRegistry } from '../providers/identity-provider-registry';
import { LoginService, sitePath } from './login.service';

const CALLBACK = 'https://bae.example.org/auth/local/callback';

class FakeProvider implements IdentityProvider, LoginCapable {
    finishes: { url: string, checks: LoginChecks }[] = [];
    fails = false;
    private counter = 0;

    constructor(readonly id: string) {}

    claimsOf = vi.fn();
    refresh = vi.fn();

    beginLogin(redirectUri: string) {
        this.counter += 1;
        const checks = { state: `state-${this.id}-${this.counter}`, nonce: 'n', codeVerifier: 'v' };
        return Promise.resolve({
            url: `https://idp.example.org/authorize?redirect_uri=${redirectUri}&state=${checks.state}`,
            checks
        });
    }

    finishLogin(url: string, checks: LoginChecks): Promise<LoginOutcome> {
        this.finishes.push({ url, checks });
        return this.fails
            ? Promise.reject(new Error('token endpoint said secret-detail'))
            : Promise.resolve({
                  tokens: { accessToken: 'at', refreshToken: 'rt' },
                  claims: { id: 'u1', username: 'ana', roles: [], organizations: [] }
              });
    }
}

const setup = (auth: Record<string, unknown> = {}) => {
    const registry = new IdentityProviderRegistry();
    const local = new FakeProvider('local');
    registry.add(local, CALLBACK);
    const profile = { id: 'u1', accessToken: 'at' } as unknown as UserProfile;
    const admit = vi.fn().mockResolvedValue(profile);
    const forget = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const service = new LoginService(
        registry,
        { admit, forget } as unknown as ProfileService,
        { auth } as unknown as AppConfigService,
        { setContext: vi.fn(), warn } as unknown as PinoLogger
    );
    return { service, registry, local, admit, forget, warn };
};

describe('LoginService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('forgets the profile of the token of the session when the login ends, and does nothing for a session without one', async () => {
        const { service, forget } = setup();
        await service.end({ accessToken: 'at-1' } as SessionData);
        expect(forget).toHaveBeenCalledExactlyOnceWith('at-1');

        await service.end({} as SessionData);
        expect(forget).toHaveBeenCalledOnce();
    });

    it('sends the user to the provider and keeps in the session what the answer will be checked against', async () => {
        const { service } = setup();
        const session = {} as SessionData;

        const url = await service.begin(session, 'local', '/catalog?x=1');

        expect(url).toContain(
            'https://idp.example.org/authorize?redirect_uri=https://bae.example.org/auth/local/callback'
        );
        expect(session.logins?.['state-local-1']).toMatchObject({
            idp: 'local',
            cameFrom: '/catalog?x=1',
            checks: { codeVerifier: 'v' }
        });
    });

    it('does not start a login with a provider that is not there, cannot log in or has no callback', async () => {
        const { service, registry } = setup();
        registry.add({ id: 'only-token', claimsOf: vi.fn(), refresh: vi.fn() } as IdentityProvider, CALLBACK);
        registry.add(new FakeProvider('no-callback'));
        for (const idp of ['nobody', 'only-token', 'no-callback']) {
            await expect(service.begin({} as SessionData, idp, '/')).rejects.toBeInstanceOf(NotFoundError);
        }
    });

    it('keeps few logins in the session and forgets the old ones', async () => {
        const { service } = setup();
        const session = {} as SessionData;
        for (let i = 0; i < 12; i++) {
            await service.begin(session, 'local', '/');
        }
        expect(Object.keys(session.logins ?? {})).toHaveLength(10);
        expect(session.logins?.['state-local-1']).toBeUndefined();

        vi.advanceTimersByTime(11 * 60 * 1000);
        await service.begin(session, 'local', '/');
        expect(Object.keys(session.logins ?? {})).toEqual(['state-local-13']);
    });

    it('takes the user in: finishes with the checks of the login, admits the profile and keeps the token in the session', async () => {
        const { service, local, admit } = setup();
        const session = {} as SessionData;
        await service.begin(session, 'local', '/');

        const done = await service.complete(session, 'local', { code: 'abc', state: 'state-local-1' });

        expect(local.finishes[0]?.url).toBe(`${CALLBACK}?code=abc&state=state-local-1`);
        expect(local.finishes[0]?.checks).toEqual({ state: 'state-local-1', nonce: 'n', codeVerifier: 'v' });
        expect(admit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'u1' }),
            { accessToken: 'at', refreshToken: 'rt' },
            'local'
        );
        expect(session.accessToken).toBe('at');
        expect(done.redirectTo).toBe('/dashboard?token=local');
    });

    it('sends the user to the portal of another site, with the token, when there is one', async () => {
        const { service } = setup({ externalPortal: 'https://portal.example.org/' });
        const session = {} as SessionData;
        await service.begin(session, 'local', '/');
        expect((await service.complete(session, 'local', { code: 'abc', state: 'state-local-1' })).redirectTo).toBe(
            'https://portal.example.org/dashboard?token=at'
        );
    });

    it('sends the user of an external provider back to where they came from', async () => {
        const { service, registry } = setup();
        registry.add(new FakeProvider('eori-1'), 'https://bae.example.org/auth/eori-1/callback');
        const session = {} as SessionData;
        await service.begin(session, 'eori-1', '/offering/7');
        expect((await service.complete(session, 'eori-1', { code: 'abc', state: 'state-eori-1-1' })).redirectTo).toBe(
            '/offering/7'
        );
    });

    it('refuses an answer with a state that was not started, was used, belongs to another provider or has expired', async () => {
        const { service, registry, local } = setup();
        registry.add(new FakeProvider('eori-1'), 'https://bae.example.org/auth/eori-1/callback');
        const session = {} as SessionData;
        await service.begin(session, 'local', '/');

        await expect(service.complete(session, 'local', { code: 'abc', state: 'forged' })).rejects.toBeInstanceOf(
            UnauthorizedError
        );
        await expect(service.complete(session, 'local', { code: 'abc' })).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(
            service.complete(session, 'eori-1', { code: 'abc', state: 'state-local-1' })
        ).rejects.toBeInstanceOf(UnauthorizedError);
        // The wrong try used it up
        await expect(
            service.complete(session, 'local', { code: 'abc', state: 'state-local-1' })
        ).rejects.toBeInstanceOf(UnauthorizedError);

        await service.begin(session, 'local', '/');
        vi.advanceTimersByTime(11 * 60 * 1000);
        await expect(
            service.complete(session, 'local', { code: 'abc', state: 'state-local-2' })
        ).rejects.toBeInstanceOf(UnauthorizedError);
        expect(local.finishes).toHaveLength(0);
    });

    it('does not leave the user logged in when the provider fails, and does not tell the client why', async () => {
        const { service, local, warn } = setup();
        local.fails = true;
        const session = {} as SessionData;
        await service.begin(session, 'local', '/');

        const failure = await service
            .complete(session, 'local', { code: 'abc', state: 'state-local-1' })
            .catch((e: unknown) => e as Error);

        expect(failure).toBeInstanceOf(UnauthorizedError);
        expect((failure as Error).message).not.toContain('secret-detail');
        expect(session.accessToken).toBeUndefined();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-detail');
    });
});

describe('sitePath', () => {
    it('lets through the paths of this site and nothing else', () => {
        expect(sitePath('/offering/7?q=1')).toBe('/offering/7?q=1');
        for (const bad of [
            'https://evil.example.org',
            '//evil.example.org',
            '/\\evil.example.org',
            'offering',
            '',
            undefined,
            42,
            '/a\nb'
        ]) {
            expect(sitePath(bad)).toBe('/');
        }
    });
});
