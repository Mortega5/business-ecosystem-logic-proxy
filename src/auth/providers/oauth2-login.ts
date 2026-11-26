import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LoginChecks, LoginResult, LoginStart } from './identity-provider';
import { IdpError, requestJson, tokensOf, idpFetch, type Fetcher } from './idp-http';

export interface OAuth2LoginOptions {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope: string;
    /** `basic` sends the credentials in the `Authorization` header, `post` in the body, and `none` sends none (`tokenParams` gives what the provider wants instead). */
    clientAuth: 'basic' | 'post' | 'none';
    /** Whether the PKCE verifier is sent with the code. On by default. */
    pkce?: boolean;
    timeoutMs: number;
    /** More parameters for the token request, for a provider that asks for them; a function is asked at each exchange. */
    tokenParams?: Record<string, string> | (() => Record<string, string>);
    fetcher?: Fetcher;
}

const random = (): string => randomBytes(32).toString('base64url');

const same = (a: string, b: string): boolean => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The authorization code flow of OAuth2 for the providers that are not OpenID Connect, so that there is no ID token to check. The
 * `state` ties the answer to the login that started it and the PKCE verifier ties the code to this server; a provider that does not
 * know PKCE ignores the challenge.
 */
export class OAuth2Login {
    private readonly fetcher: Fetcher;

    constructor(private readonly options: OAuth2LoginOptions) {
        this.fetcher = options.fetcher ?? idpFetch;
    }

    start(redirectUri: string): LoginStart {
        // There is no ID token, so the nonce is never used
        const checks: LoginChecks = { state: random(), nonce: random(), codeVerifier: random() };
        const url = new URL(this.options.authorizationUrl);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.options.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', this.options.scope);
        url.searchParams.set('state', checks.state);
        url.searchParams.set('code_challenge', createHash('sha256').update(checks.codeVerifier).digest('base64url'));
        url.searchParams.set('code_challenge_method', 'S256');
        return { url: url.href, checks };
    }

    /** The tokens for the URL the provider sent the browser back to. Rejects when the answer is not for this login. */
    async finish(callbackUrl: string, checks: LoginChecks): Promise<LoginResult> {
        const url = new URL(callbackUrl);
        if (url.searchParams.has('error')) {
            // Only the code of the error: the description is written by whoever sent the browser here
            throw new IdpError(`The identity provider refused the login: ${url.searchParams.get('error')}`);
        }
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (state === null || !same(state, checks.state)) {
            throw new IdpError('The answer of the identity provider is not for this login');
        }
        if (code === null || code === '') {
            throw new IdpError('The identity provider gave no code');
        }
        const { clientId, clientSecret, clientAuth } = this.options;
        const form = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            // The redirect URI of the request, without what the provider added
            redirect_uri: `${url.origin}${url.pathname}`,
            ...(this.options.pkce === false ? {} : { code_verifier: checks.codeVerifier }),
            ...(typeof this.options.tokenParams === 'function' ? this.options.tokenParams() : this.options.tokenParams)
        });
        const headers: Record<string, string> = {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json'
        };
        if (clientAuth === 'basic') {
            headers['authorization'] =
                `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
        } else if (clientAuth === 'post') {
            form.set('client_id', clientId);
            form.set('client_secret', clientSecret);
        }
        const answer = await requestJson(
            this.fetcher,
            this.options.tokenUrl,
            { method: 'POST', headers, body: form },
            this.options.timeoutMs
        );
        // A provider may answer 200 with an error, which has no access token
        const idToken = answer['id_token'];
        return { ...tokensOf(answer), ...(typeof idToken === 'string' && idToken !== '' ? { idToken } : {}) };
    }
}
