import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeIdp, ISSUER, REDIRECT } from './fake-oidc-idp';
import type { LoginChecks } from './identity-provider';
import { IdpError } from './idp-http';
import { OidcLogin } from './oidc-login';

describe('OidcLogin', () => {
    let idp: ReturnType<typeof fakeIdp>;
    let login: OidcLogin;

    beforeEach(() => {
        idp = fakeIdp();
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
