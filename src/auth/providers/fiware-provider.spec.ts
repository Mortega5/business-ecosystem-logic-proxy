import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { FiwareProvider, type FiwareOptions } from './fiware-provider';
import { IdpError } from './idp-http';

interface Call {
    url: string;
    init: RequestInit;
}

const answering = (status: number, body: unknown, calls: Call[] = []): typeof fetch =>
    (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

const KEY = 'a-shared-secret-of-the-idm';
const provider = (extra: Partial<FiwareOptions> = {}): FiwareProvider =>
    new FiwareProvider({ id: 'local', server: 'https://idm.example.org/', clientId: 'bae', clientSecret: 'client-secret', timeoutMs: 1000, ...extra });

const user = {
    id: 'idm-ana',
    username: 'ana',
    displayName: 'Ana López',
    email: 'ana@example.org',
    app_id: 'bae',
    roles: [{ id: 'r1', name: 'seller' }],
    organizations: [{ id: 'org-1', name: 'Acme', roles: [{ id: 'r2', name: 'owner' }] }]
};
const expected = {
    id: 'idm-ana',
    username: 'ana',
    displayName: 'Ana López',
    email: 'ana@example.org',
    roles: [{ id: 'r1', name: 'seller' }],
    organizations: [{ id: 'org-1', name: 'Acme', roles: [{ id: 'r2', name: 'owner' }] }]
};

describe('FiwareProvider: asking the identity manager', () => {
    it('asks for the user of the token, which goes encoded in the query', async () => {
        const calls: Call[] = [];

        const claims = await provider({ fetcher: answering(200, user, calls) }).claimsOf('tok en&x=1');

        expect(calls[0]?.url).toBe('https://idm.example.org/user?access_token=tok%20en%26x%3D1');
        expect(claims).toEqual(expected);
    });

    it('takes the expiry the manager gives, and the username from the display name or the id when it gives none', async () => {
        const claims = await provider({ fetcher: answering(200, { id: 'idm-2', exp: 2_000_000_000 }) }).claimsOf('t');

        expect(claims).toEqual({ id: 'idm-2', username: 'idm-2', roles: [], organizations: [], expire: 2_000_000_000 });
        expect((await provider({ fetcher: answering(200, { id: 'idm-3', displayName: 'Bob' }) }).claimsOf('t')).username).toBe('Bob');
    });

    it('gives the default role to a user without roles, and only to one without', async () => {
        const without = await provider({ defaultRole: 'Seller', fetcher: answering(200, { id: 'idm-2', roles: [] }) }).claimsOf('t');
        const withRoles = await provider({ defaultRole: 'Seller', fetcher: answering(200, user) }).claimsOf('t');

        expect(without.roles).toEqual([{ id: 'Seller', name: 'Seller' }]);
        expect(withRoles.roles).toEqual([{ id: 'r1', name: 'seller' }]);
    });

    it('keeps the country of an organisation, and ignores roles and organisations that are not well formed', async () => {
        const claims = await provider({
            fetcher: answering(200, { id: 'idm-2', roles: [{ id: 'x' }, 'seller', null], organizations: [{ name: 'no id' }, { id: 'org-2', country: 'Spain', roles: 'owner' }, 7] })
        }).claimsOf('t');

        expect(claims.roles).toEqual([]);
        expect(claims.organizations).toEqual([{ id: 'org-2', name: 'org-2', roles: [], country: 'Spain' }]);
    });

    it('rejects a token the manager does not accept, or an answer without a user', async () => {
        await expect(provider({ fetcher: answering(401, { error: 'invalid' }) }).claimsOf('t')).rejects.toBeInstanceOf(IdpError);
        await expect(provider({ fetcher: answering(200, { username: 'ana' }) }).claimsOf('t')).rejects.toBeInstanceOf(IdpError);
    });
});

describe('FiwareProvider: OIDC mode, where the token is a JWT signed with the key', () => {
    const calls: Call[] = [];
    const signed = (claims: object, key = KEY, options: jwt.SignOptions = {}): string => jwt.sign(claims, key, { algorithm: 'HS256', ...options });
    const oidc = (): FiwareProvider => provider({ key: KEY, fetcher: answering(500, 'must not be called', calls) });

    it('reads the user from the token without asking the manager, and takes the expiry from it', async () => {
        const claims = await oidc().claimsOf(signed(user, KEY, { expiresIn: 600 }));

        expect(claims).toMatchObject(expected);
        expect(claims.expire).toBeGreaterThan(Math.floor(Date.now() / 1000) + 590);
        expect(calls).toEqual([]);
    });

    it('rejects a token signed with another key, an expired one, and one that is not signed', async () => {
        await expect(oidc().claimsOf(signed(user, 'another-secret-of-the-idm'))).rejects.toBeDefined();
        await expect(oidc().claimsOf(signed(user, KEY, { expiresIn: -10 }))).rejects.toBeDefined();
        await expect(oidc().claimsOf(jwt.sign(user, '', { algorithm: 'none' }))).rejects.toBeDefined();
        await expect(oidc().claimsOf('not-a-jwt')).rejects.toBeDefined();
    });

    it('rejects a token that claims an algorithm of public keys, the one a forger uses against a shared secret', async () => {
        const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url');
        const payload = Buffer.from(JSON.stringify(user)).toString('base64url');

        await expect(oidc().claimsOf(`${header}.${payload}.AAAA`)).rejects.toBeDefined();
    });
});

describe('FiwareProvider: refreshing', () => {
    it('asks the token endpoint with the client credentials, in the header and the body, as v11 did', async () => {
        const calls: Call[] = [];

        const tokens = await provider({ fetcher: answering(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }, calls) }).refresh('r1');

        expect(calls[0]?.url).toBe('https://idm.example.org/oauth2/token');
        expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Basic ${Buffer.from('bae:client-secret').toString('base64')}`);
        expect(Object.fromEntries(calls[0]?.init.body as URLSearchParams)).toEqual({
            grant_type: 'refresh_token',
            refresh_token: 'r1',
            client_id: 'bae',
            client_secret: 'client-secret'
        });
        expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
        expect(tokens.expire).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    });

    it('rejects when the manager refuses the refresh token', async () => {
        await expect(provider({ fetcher: answering(400, { error: 'invalid_grant' }) }).refresh('used')).rejects.toBeInstanceOf(IdpError);
    });
});
