import { describe, expect, it } from 'vitest';
import { IdpError } from './idp-http';
import { KeycloakProvider, type KeycloakOptions } from './keycloak-provider';

const jwt = (claims: object): string => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

interface Call {
    url: string;
    init: RequestInit;
}

const answering = (status: number, body: unknown, calls: Call[] = []): typeof fetch =>
    (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

const provider = (fetcher: typeof fetch, extra: Partial<KeycloakOptions> = {}): KeycloakProvider =>
    new KeycloakProvider({
        id: 'local',
        server: 'https://kc.example.org/',
        realm: 'dome',
        clientId: 'bae',
        clientSecret: 'client-secret',
        timeoutMs: 1000,
        organizationRoles: ['Seller', 'Buyer', 'orgAdmin'],
        organizationName: async () => undefined,
        fetcher,
        ...extra
    });

const info = { sub: 'kc-1', preferred_username: 'ana', name: 'Ana López', email: 'ana@example.org' };

describe('KeycloakProvider: who a token belongs to', () => {
    it('asks the user info of the realm with the token, and takes the user from the answer', async () => {
        const calls: Call[] = [];
        const token = jwt({ exp: 2_000_000_000, resource_access: { bae: { roles: ['seller', 'customer'] }, other: { roles: ['admin'] } } });

        const claims = await provider(answering(200, info, calls)).claimsOf(token);

        expect(calls[0]?.url).toBe('https://kc.example.org/realms/dome/protocol/openid-connect/userinfo');
        expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${token}`);
        expect(claims).toEqual({
            id: 'kc-1',
            username: 'ana',
            displayName: 'Ana López',
            email: 'ana@example.org',
            roles: [
                { id: 'seller', name: 'seller' },
                { id: 'customer', name: 'customer' }
            ],
            organizations: [],
            expire: 2_000_000_000
        });
    });

    it('takes only the roles of its own client, and none from a token that is not a JWT', async () => {
        const other = jwt({ resource_access: { other: { roles: ['admin'] } } });

        expect((await provider(answering(200, info)).claimsOf(other)).roles).toEqual([]);
        expect(await provider(answering(200, info)).claimsOf('opaque-token')).toMatchObject({ roles: [], organizations: [] });
    });

    it('makes an organisation of each group, with the name TMForum knows, or the group when it does not', async () => {
        const token = jwt({ groups: ['urn:ngsi-ld:organization:1', 'plain-group', 'broken'] });
        const names: Record<string, string> = { 'urn:ngsi-ld:organization:1': 'Acme S.L.' };

        const claims = await provider(answering(200, info), {
            organizationName: async (group) => {
                if (group === 'broken') {
                    throw new Error('TMForum is down');
                }
                return names[group];
            }
        }).claimsOf(token);

        expect(claims.organizations.map((org) => [org.id, org.name])).toEqual([
            ['urn:ngsi-ld:organization:1', 'Acme S.L.'],
            ['plain-group', 'plain-group'],
            ['broken', 'broken']
        ]);
        expect(claims.organizations[0]?.roles).toEqual([{ name: 'Seller' }, { name: 'Buyer' }, { name: 'orgAdmin' }]);
    });

    it('uses the id as the username when Keycloak gives none, and leaves out what it does not say', async () => {
        const claims = await provider(answering(200, { sub: 'kc-2' })).claimsOf('opaque');

        expect(claims).toEqual({ id: 'kc-2', username: 'kc-2', roles: [], organizations: [] });
    });

    it('rejects a token that Keycloak does not accept, without putting the token in the message', async () => {
        const failure = await provider(answering(401, { error: 'invalid_token' })).claimsOf('secret-token-value').catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(IdpError);
        expect((failure as IdpError).status).toBe(401);
        expect((failure as IdpError).message).not.toContain('secret-token-value');
    });

    it('rejects an answer that has no user, or that is not JSON', async () => {
        await expect(provider(answering(200, { preferred_username: 'ana' })).claimsOf('t')).rejects.toBeInstanceOf(IdpError);
        await expect(provider(answering(200, 'not json')).claimsOf('t')).rejects.toBeInstanceOf(IdpError);
    });

    it('gives up when Keycloak does not answer in time', async () => {
        const silent = ((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;

        await expect(provider(silent, { timeoutMs: 20 }).claimsOf('t')).rejects.toBeDefined();
    });

    it('puts the realm in the URL as one segment, whatever it holds', async () => {
        const calls: Call[] = [];

        await provider(answering(200, info, calls), { realm: 'a/../b' }).claimsOf('t');

        expect(calls[0]?.url).toBe('https://kc.example.org/realms/a%2F..%2Fb/protocol/openid-connect/userinfo');
    });
});

describe('KeycloakProvider: refreshing', () => {
    it('asks the token endpoint of the realm for new tokens with the client credentials', async () => {
        const calls: Call[] = [];
        const before = Math.floor(Date.now() / 1000);

        const tokens = await provider(answering(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 300 }, calls)).refresh('r1');

        expect(calls[0]?.url).toBe('https://kc.example.org/realms/dome/protocol/openid-connect/token');
        expect(calls[0]?.init.method).toBe('POST');
        expect(Object.fromEntries(calls[0]?.init.body as URLSearchParams)).toEqual({
            grant_type: 'refresh_token',
            refresh_token: 'r1',
            client_id: 'bae',
            client_secret: 'client-secret'
        });
        expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
        expect(tokens.expire).toBeGreaterThanOrEqual(before + 300);
    });

    it('does not make up a refresh token or an expiry that Keycloak did not give', async () => {
        expect(await provider(answering(200, { access_token: 'a2' })).refresh('r1')).toEqual({ accessToken: 'a2' });
    });

    it('rejects when Keycloak refuses the refresh token or gives no access token', async () => {
        await expect(provider(answering(400, { error: 'invalid_grant' })).refresh('used')).rejects.toBeInstanceOf(IdpError);
        await expect(provider(answering(200, { token_type: 'Bearer' })).refresh('r1')).rejects.toBeInstanceOf(IdpError);
    });
});
