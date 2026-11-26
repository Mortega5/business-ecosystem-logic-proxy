import { describe, expect, it } from 'vitest';
import { IdpError } from './idp-http';
import { OAuth2Login, type OAuth2LoginOptions } from './oauth2-login';
import { bodyOf, urlOf } from '../../testing/fetch-input';

const REDIRECT = 'https://bae.example.org/auth/github/callback';

const setup = (
    answer: { status?: number, body: unknown } = { body: { access_token: 'at', refresh_token: 'rt', expires_in: 600 } },
    extra: Partial<OAuth2LoginOptions> = {}
) => {
    const requests: { url: string, headers: Headers, body: URLSearchParams }[] = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
            url: urlOf(input),
            headers: new Headers(init?.headers),
            body: new URLSearchParams(bodyOf(init))
        });
        return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 }));
    }) as typeof fetch;
    const login = new OAuth2Login({
        authorizationUrl: 'https://idp.example.org/authorize',
        tokenUrl: 'https://idp.example.org/token',
        clientId: 'bae',
        clientSecret: 'se:cret',
        scope: 'jwt openid',
        clientAuth: 'basic',
        timeoutMs: 1000,
        fetcher,
        ...extra
    });
    return { login, requests };
};

describe('OAuth2Login', () => {
    it('sends the user to the provider with a state and a PKCE challenge that change in each login', () => {
        const { login } = setup();
        const first = login.start(REDIRECT);
        const params = new URL(first.url).searchParams;
        expect(first.url.startsWith('https://idp.example.org/authorize?')).toBe(true);
        expect(Object.fromEntries(params)).toMatchObject({
            response_type: 'code',
            client_id: 'bae',
            redirect_uri: REDIRECT,
            scope: 'jwt openid',
            state: first.checks.state,
            code_challenge_method: 'S256'
        });
        expect(login.start(REDIRECT).checks.state).not.toBe(first.checks.state);
    });

    it('exchanges the code, with the client in the header and the verifier in the body', async () => {
        const { login, requests } = setup();
        const { checks } = login.start(REDIRECT);
        const tokens = await login.finish(`${REDIRECT}?code=abc&state=${checks.state}&extra=1`, checks);
        expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
        const [request] = requests;
        expect(request?.url).toBe('https://idp.example.org/token');
        expect(request?.headers.get('authorization')).toBe(`Basic ${Buffer.from('bae:se%3Acret').toString('base64')}`);
        expect(Object.fromEntries(request?.body ?? [])).toEqual({
            grant_type: 'authorization_code',
            code: 'abc',
            redirect_uri: REDIRECT,
            code_verifier: checks.codeVerifier
        });
    });

    it('puts the client in the body when the provider wants it there, and adds what the provider asks for', async () => {
        const { login, requests } = setup(undefined, { clientAuth: 'post', tokenParams: { resource: 'x' } });
        const { checks } = login.start(REDIRECT);
        await login.finish(`${REDIRECT}?code=abc&state=${checks.state}`, checks);
        expect(requests[0]?.headers.get('authorization')).toBeNull();
        expect(requests[0]?.body.get('client_secret')).toBe('se:cret');
        expect(requests[0]?.body.get('resource')).toBe('x');
    });

    it('refuses an answer with another state, with no state, or with no code, without asking for tokens', async () => {
        const { login, requests } = setup();
        const { checks } = login.start(REDIRECT);
        for (const query of ['code=abc&state=forged', 'code=abc', `state=${checks.state}`]) {
            await expect(login.finish(`${REDIRECT}?${query}`, checks)).rejects.toBeInstanceOf(IdpError);
        }
        expect(requests).toHaveLength(0);
    });

    it('refuses the login the provider refused, naming only the code of the error', async () => {
        const { login } = setup();
        const { checks } = login.start(REDIRECT);
        const failure = await login
            .finish(`${REDIRECT}?error=access_denied&error_description=text+of+somebody`, checks)
            .catch((e: unknown) => e as Error);
        expect((failure as Error).message).toContain('access_denied');
        expect((failure as Error).message).not.toContain('somebody');
    });

    it('rejects a 200 that carries an error and no token, and a refusal of the code', async () => {
        const { login } = setup({ body: { error: 'bad_verification_code' } });
        const { checks } = login.start(REDIRECT);
        await expect(login.finish(`${REDIRECT}?code=abc&state=${checks.state}`, checks)).rejects.toBeInstanceOf(
            IdpError
        );
        const refused = setup({ status: 400, body: { error: 'invalid_grant' } });
        const second = refused.login.start(REDIRECT);
        await expect(
            refused.login.finish(`${REDIRECT}?code=abc&state=${second.checks.state}`, second.checks)
        ).rejects.toBeInstanceOf(IdpError);
    });
});
