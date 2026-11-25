import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdpError } from './idp-http';
import { OidcLogin, type LoginChecks } from './oidc-login';

const ISSUER = 'https://idp.example.org/realms/bae';
const REDIRECT = 'https://bae.example.org/auth/keycloak/callback';
const { publicKey, privateKey }: { publicKey: KeyObject, privateKey: KeyObject } = generateKeyPairSync('rsa', {
    modulusLength: 2048
});

/** A provider with its discovery document, its keys and a token endpoint that answers what the test sets. */
const provider = () => {
    const state = {
        tokenRequests: [] as { headers: Headers, body: URLSearchParams }[],
        tokenStatus: 200,
        idTokenClaims: {} as Record<string, unknown>
    };
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const json = (body: unknown, status = 200) =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
            );
        if (url.pathname.endsWith('/.well-known/openid-configuration')) {
            return json({
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
                token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
                jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
                id_token_signing_alg_values_supported: ['RS256']
            });
        }
        if (url.pathname.endsWith('/certs')) {
            return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'k1' }] });
        }
        if (url.pathname.endsWith('/token')) {
            const request = input instanceof Request ? input : new Request(url, init);
            return request.text().then((text) => {
                state.tokenRequests.push({ headers: request.headers, body: new URLSearchParams(text) });
                if (state.tokenStatus !== 200) {
                    return json({ error: 'invalid_grant', error_description: 'secret-detail' }, state.tokenStatus);
                }
                const now = Math.floor(Date.now() / 1000);
                const idToken = jwt.sign(
                    { iss: ISSUER, aud: 'bae', sub: 'u1', iat: now, exp: now + 300, ...state.idTokenClaims },
                    privateKey,
                    {
                        algorithm: 'RS256',
                        keyid: 'k1'
                    }
                );
                return json({
                    access_token: 'at',
                    refresh_token: 'rt',
                    token_type: 'Bearer',
                    expires_in: 600,
                    id_token: idToken
                });
            });
        }
        return json({}, 404);
    };
    return { state, fetcher };
};

describe('OidcLogin', () => {
    let idp: ReturnType<typeof provider>;
    let login: OidcLogin;

    beforeEach(() => {
        idp = provider();
        login = new OidcLogin({
            issuerUrl: ISSUER,
            clientId: 'bae',
            clientSecret: 'shh',
            tokenAuthMethod: 'client_secret_basic',
            scope: 'openid profile',
            timeoutMs: 5000,
            fetcher: idp.fetcher
        });
    });

    const back = (checks: LoginChecks, state = checks.state) => `${REDIRECT}?code=abc&state=${state}`;

    it('sends the user to the provider with a state, a nonce and a PKCE challenge of its own', async () => {
        const { url, checks } = await login.start(REDIRECT);
        const params = new URL(url).searchParams;
        expect(url.startsWith(`${ISSUER}/protocol/openid-connect/auth?`)).toBe(true);
        expect(Object.fromEntries(params)).toMatchObject({
            client_id: 'bae',
            redirect_uri: REDIRECT,
            response_type: 'code',
            scope: 'openid profile',
            state: checks.state,
            nonce: checks.nonce,
            code_challenge_method: 'S256'
        });
        expect(params.get('code_challenge')).toBe(createHash('sha256').update(checks.codeVerifier).digest('base64url'));
        expect((await login.start(REDIRECT)).checks.state).not.toBe(checks.state);
    });

    it('exchanges the code for the tokens, proving the PKCE verifier and the client', async () => {
        const { checks } = await login.start(REDIRECT);
        idp.state.idTokenClaims = { nonce: checks.nonce };
        const result = await login.finish(back(checks), checks);
        expect(result).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
        expect(result.expire).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(result.idToken).toEqual(expect.any(String));
        const [request] = idp.state.tokenRequests;
        expect(request?.body.get('code_verifier')).toBe(checks.codeVerifier);
        expect(request?.body.get('grant_type')).toBe('authorization_code');
        expect(request?.headers.get('authorization')).toMatch(/^Basic /);
    });

    it('refuses an answer whose state is not the one of the login', async () => {
        const { checks } = await login.start(REDIRECT);
        idp.state.idTokenClaims = { nonce: checks.nonce };
        await expect(login.finish(back(checks, 'forged'), checks)).rejects.toBeInstanceOf(IdpError);
        expect(idp.state.tokenRequests).toHaveLength(0);
    });

    it('refuses an ID token with another nonce', async () => {
        const { checks } = await login.start(REDIRECT);
        idp.state.idTokenClaims = { nonce: 'another' };
        await expect(login.finish(back(checks), checks)).rejects.toBeInstanceOf(IdpError);
    });

    it('refuses an ID token meant for another client', async () => {
        const { checks } = await login.start(REDIRECT);
        idp.state.idTokenClaims = { nonce: checks.nonce, aud: 'someone-else' };
        await expect(login.finish(back(checks), checks)).rejects.toBeInstanceOf(IdpError);
    });

    it('does not leak what the provider answered when it refuses the code', async () => {
        const { checks } = await login.start(REDIRECT);
        idp.state.tokenStatus = 400;
        const failure = await login.finish(back(checks), checks).catch((error: unknown) => error as Error);
        expect(failure).toBeInstanceOf(IdpError);
        expect((failure as Error).message).not.toContain('secret-detail');
    });
});
