import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '../common/domain-error';
import type { ProfileService } from './profile/profile.service';
import type { UserProfile } from './profile/user-profile';
import { RequestAuthenticator } from './request-authenticator';

const profile = {
    id: 'u-ana',
    username: 'ana',
    displayName: 'Ana',
    accessToken: 'tok',
    refreshToken: 'ref',
    idp: 'local',
    partyId: 'p-ana',
    roles: [{ name: 'Seller' }],
    expire: 9_999_999_999,
    organizations: [{ id: 'org-1', name: 'Acme', partyId: 'p-acme', roles: [{ name: 'orgAdmin' }] }]
} as unknown as UserProfile;

const setup = () => {
    const authenticate = vi.fn().mockResolvedValue(profile);
    const authenticator = new RequestAuthenticator({ authenticate } as unknown as ProfileService);
    const run = (headers: IncomingHttpHeaders, session?: { accessToken?: string }) =>
        authenticator.authenticate({ headers, ...(session === undefined ? {} : { session }) } as never);
    return { authenticate, run };
};

describe('RequestAuthenticator', () => {
    it('knows the user by the bearer token, or by the token of the header of the platform', async () => {
        const { run, authenticate } = setup();
        expect(await run({ authorization: 'Bearer tok' })).toBe(profile);
        expect(await run({ 'x-auth-token': 'other' })).toBe(profile);
        expect(authenticate).toHaveBeenNthCalledWith(1, 'tok');
        expect(authenticate).toHaveBeenNthCalledWith(2, 'other');
    });

    it('takes the token of the session when the request has none, and the header before the session', async () => {
        const { run, authenticate } = setup();
        await run({}, { accessToken: 'from-session' });
        await run({ authorization: 'Bearer tok' }, { accessToken: 'from-session' });
        expect(authenticate).toHaveBeenNthCalledWith(1, 'from-session');
        expect(authenticate).toHaveBeenNthCalledWith(2, 'tok');
    });

    it('does not identify a request that carries nothing', async () => {
        const { run, authenticate } = setup();
        expect(await run({})).toBeUndefined();
        expect(await run({}, {})).toBeUndefined();
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('refuses an authorization that is not a bearer token, and a token that is empty', async () => {
        const { run, authenticate } = setup();
        await expect(run({ authorization: 'Basic abc' })).rejects.toThrow('Invalid Auth-Token type (basic)');
        await expect(run({ authorization: 'Bearer ' })).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(run({ authorization: 'Bearer' })).rejects.toBeInstanceOf(UnauthorizedError);
        expect(authenticate).not.toHaveBeenCalled();
    });

    it('passes on the refusal of a token that is not valid', async () => {
        const { run, authenticate } = setup();
        authenticate.mockRejectedValue(new UnauthorizedError('It has not been possible to obtain your user info'));
        await expect(run({ authorization: 'Bearer bad' })).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('lets the user act for one of their organisations, as that organisation with the roles they have in it', async () => {
        const { run } = setup();
        expect(await run({ authorization: 'Bearer tok', 'x-organization': 'org-1' })).toEqual({
            id: 'org-1',
            userId: 'u-ana',
            userPartyId: 'p-ana',
            partyId: 'p-acme',
            roles: [{ name: 'orgAdmin' }],
            displayName: 'Acme',
            email: 'org-1@emailnotusable.com',
            accessToken: 'tok',
            refreshToken: 'ref',
            idp: 'local'
        });
        expect(await run({ authorization: 'Bearer tok', 'x-organization': '' })).toBe(profile);
    });

    it('refuses to act for an organisation the user does not belong to', async () => {
        const { run } = setup();
        await expect(run({ authorization: 'Bearer tok', 'x-organization': 'org-2' })).rejects.toThrow(
            'You are not allowed to act on behalf the provided organization'
        );
    });
});
