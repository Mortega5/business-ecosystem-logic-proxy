import jsonwebtoken from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { I4TrustProvider, type I4TrustLoginOptions } from './i4trust-provider';
import { IdpError } from './idp-http';
import { TEST_CERTIFICATE, TEST_KEY } from './ishare-fixtures';
import { bodyOf } from '../../testing/fetch-input';

const jwt = (claims: object): string =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const roles = { seller: 'Seller', customer: 'Buyer', orgAdmin: 'orgAdmin' };
const login = (extra: Partial<I4TrustLoginOptions> = {}): I4TrustLoginOptions => ({
    server: 'https://idp.example.org/',
    clientId: 'EU.EORI.PROXY',
    idpId: 'EU.EORI.IDP',
    scope: 'jwt openid iSHARE',
    keyPem: TEST_KEY,
    certificatePem: TEST_CERTIFICATE,
    timeoutMs: 1000,
    ...extra
});
const provider = new I4TrustProvider({ id: 'idp-eori-1', roles, login: login() });

describe('I4TrustProvider', () => {
    it('reads the user of the ID token of a login, who is a seller and the administrator of the organisation of the identity provider', () => {
        const claims = provider.claimsFromIdToken(
            jwt({
                sub: 'EU.EORI.1',
                preferred_username: 'ana',
                displayName: 'Ana López',
                email: 'ana@example.org',
                exp: 2_000_000_000
            })
        );

        expect(claims).toEqual({
            id: 'EU.EORI.1',
            username: 'ana',
            displayName: 'Ana López',
            email: 'ana@example.org',
            roles: [{ id: 'Seller', name: 'Seller' }],
            organizations: [
                {
                    id: 'idp-eori-1',
                    name: 'idp-eori-1',
                    roles: [
                        { id: 'Seller', name: 'Seller' },
                        { id: 'Buyer', name: 'Buyer' },
                        { id: 'orgAdmin', name: 'orgAdmin' }
                    ]
                }
            ],
            expire: 2_000_000_000
        });
    });

    it('names a user without username after the display name, or the id', () => {
        expect(provider.claimsFromIdToken(jwt({ sub: 'u1', displayName: 'Ana' })).username).toBe('Ana');
        expect(provider.claimsFromIdToken(jwt({ sub: 'u1' })).username).toBe('u1');
    });

    it('refuses a token without a user, and one that is not a JWT', () => {
        expect(() => provider.claimsFromIdToken(jwt({ preferred_username: 'ana' }))).toThrow(IdpError);
        expect(() => provider.claimsFromIdToken('not-a-jwt')).toThrow(IdpError);
    });

    it('does not accept a token that somebody presents without the keys of the identity provider, which v11 decoded without checking who signed it', async () => {
        await expect(provider.claimsOf(jwt({ sub: 'admin' }))).rejects.toBeInstanceOf(IdpError);
    });

    it('accepts a presented token that the keys of the identity provider sign, and only that', async () => {
        const claims = { sub: 'EU.EORI.1', preferred_username: 'ana' };
        const withKeys = new I4TrustProvider({
            id: 'idp-eori-1',
            roles,
            login: login(),
            verifier: {
                verify: async (token: string) =>
                    token === 'signed' ? claims : Promise.reject(new IdpError('bad signature'))
            } as never
        });

        expect((await withKeys.claimsOf('signed')).id).toBe('EU.EORI.1');
        await expect(withKeys.claimsOf(jwt({ sub: 'admin' }))).rejects.toBeInstanceOf(IdpError);
    });

    it('does not refresh', async () => {
        await expect(provider.refresh()).rejects.toBeInstanceOf(IdpError);
    });

    describe('login', () => {
        const redirect = 'https://bae.example.org/auth/idp-eori-1/callback';

        /** An identity provider that answers where to log in and gives an ID token for the code. */
        const idp = (idToken = jwt({ sub: 'EU.EORI.1', preferred_username: 'ana' })) => {
            const calls: { url: string, headers: Headers, body: URLSearchParams }[] = [];
            const fetcher = (async (url: string, init: RequestInit) => {
                calls.push({ url, headers: new Headers(init.headers), body: new URLSearchParams(bodyOf(init)) });
                return url.endsWith('/authorize')
                    ? new Response(null, { status: 302, headers: { location: '/login?session=1' } })
                    : new Response(JSON.stringify({ access_token: 'at', id_token: idToken }), { status: 200 });
            }) as unknown as typeof fetch;
            return { calls, fetcher };
        };
        const verified = (token: string) =>
            jsonwebtoken.verify(token, TEST_CERTIFICATE, { algorithms: ['RS256'] }) as Record<string, unknown>;

        it('posts a signed request and sends the user where the identity provider says', async () => {
            const server = idp();
            const i4 = new I4TrustProvider({ id: 'idp-eori-1', roles, login: login({ fetcher: server.fetcher }) });

            const { url, checks } = await i4.beginLogin(redirect);
            expect(url).toBe('https://idp.example.org/login?session=1');
            const [post] = server.calls;
            expect(post?.url).toBe('https://idp.example.org/oauth2/authorize');
            const request = post?.body.get('request') as string;
            expect(post?.headers.get('authorization')).toBe(`Bearer ${request}`);
            expect(verified(request)).toMatchObject({
                iss: 'EU.EORI.PROXY',
                aud: 'EU.EORI.IDP',
                redirect_uri: redirect,
                scope: 'jwt openid iSHARE',
                state: checks.state,
                nonce: checks.nonce
            });
            const header = jsonwebtoken.decode(request, { complete: true })?.header as { alg: string, x5c: string[] };
            expect(header.alg).toBe('RS256');
            expect(header.x5c).toHaveLength(1);
            expect(header.x5c[0]).not.toMatch(/\s|BEGIN/);
        });

        it('exchanges the code with a new assertion of the client and reads the user from the ID token', async () => {
            const server = idp();
            const i4 = new I4TrustProvider({ id: 'idp-eori-1', roles, login: login({ fetcher: server.fetcher }) });
            const { checks } = await i4.beginLogin(redirect);

            const outcome = await i4.finishLogin(`${redirect}?code=abc&state=${checks.state}`, checks);
            const exchange = server.calls[1];
            expect(exchange?.url).toBe('https://idp.example.org/oauth2/token');
            expect(exchange?.body.get('code')).toBe('abc');
            expect(exchange?.body.get('code_verifier')).toBeNull();
            expect(exchange?.body.get('client_assertion_type')).toBe(
                'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
            );
            expect(verified(exchange?.body.get('client_assertion') as string)).toMatchObject({
                iss: 'EU.EORI.PROXY',
                sub: 'EU.EORI.PROXY',
                aud: 'EU.EORI.IDP'
            });
            expect(outcome.tokens.accessToken).toBe('at');
            expect(outcome.claims).toMatchObject({
                id: 'EU.EORI.1',
                username: 'ana',
                organizations: [{ id: 'idp-eori-1' }]
            });
        });

        it('refuses an answer for another login, a refusal to say where to log in and an answer without ID token', async () => {
            const server = idp();
            const i4 = new I4TrustProvider({ id: 'idp-eori-1', roles, login: login({ fetcher: server.fetcher }) });
            const { checks } = await i4.beginLogin(redirect);
            await expect(i4.finishLogin(`${redirect}?code=abc&state=forged`, checks)).rejects.toBeInstanceOf(IdpError);

            const refusing = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
            await expect(
                new I4TrustProvider({ id: 'x', roles, login: login({ fetcher: refusing }) }).beginLogin(redirect)
            ).rejects.toBeInstanceOf(IdpError);

            const noToken = (async (url: string) =>
                url.endsWith('/authorize')
                    ? new Response(null, { status: 302, headers: { location: '/l' } })
                    : new Response(JSON.stringify({ access_token: 'at' }))) as unknown as typeof fetch;
            const bare = new I4TrustProvider({ id: 'x', roles, login: login({ fetcher: noToken }) });
            const started = await bare.beginLogin(redirect);
            await expect(
                bare.finishLogin(`${redirect}?code=abc&state=${started.checks.state}`, started.checks)
            ).rejects.toBeInstanceOf(IdpError);
        });
    });
});
