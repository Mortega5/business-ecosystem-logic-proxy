import * as client from 'openid-client';
import type { LoginChecks, LoginResult, LoginStart } from './identity-provider';
import { IdpError, type Fetcher } from './idp-http';

export interface OidcLoginOptions {
    /** The issuer, whose discovery document is at `/.well-known/openid-configuration`. */
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    tokenAuthMethod: 'client_secret_basic' | 'client_secret_post';
    scope: string;
    timeoutMs: number;
    fetcher?: Fetcher;
}

/**
 * The authorization code flow of OpenID Connect, done by `openid-client`: the `state`, the `nonce` and the PKCE verifier are
 * generated here and checked on the way back, and the ID token is validated against the keys of the provider.
 */
export class OidcLogin {
    private configuration: Promise<client.Configuration> | undefined;

    constructor(private readonly options: OidcLoginOptions) {}

    async start(redirectUri: string): Promise<LoginStart> {
        const checks: LoginChecks = {
            state: client.randomState(),
            nonce: client.randomNonce(),
            codeVerifier: client.randomPKCECodeVerifier()
        };
        const url = client.buildAuthorizationUrl(await this.configure(), {
            redirect_uri: redirectUri,
            scope: this.options.scope,
            response_type: 'code',
            state: checks.state,
            nonce: checks.nonce,
            code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
            code_challenge_method: 'S256'
        });
        return { url: url.href, checks };
    }

    /** The tokens for the URL the provider sent the browser back to. Rejects when a check fails or the provider refuses. */
    async finish(callbackUrl: string, checks: LoginChecks): Promise<LoginResult> {
        try {
            const tokens = await client.authorizationCodeGrant(await this.configure(), new URL(callbackUrl), {
                expectedState: checks.state,
                expectedNonce: checks.nonce,
                pkceCodeVerifier: checks.codeVerifier,
                idTokenExpected: true
            });
            const expiresIn = tokens.expires_in;
            return {
                accessToken: tokens.access_token,
                ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
                ...(expiresIn === undefined ? {} : { expire: Math.floor(Date.now() / 1000) + expiresIn }),
                ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token })
            };
        } catch (error) {
            // The message names the failed check or the status, and never carries a token
            throw new IdpError(
                `The login could not be completed: ${error instanceof Error ? error.message : 'unknown error'}`
            );
        }
    }

    private configure(): Promise<client.Configuration> {
        // A failed discovery is not kept, so the next login tries again
        this.configuration ??= this.discover().catch((error: unknown) => {
            this.configuration = undefined;
            throw error;
        });
        return this.configuration;
    }

    private async discover(): Promise<client.Configuration> {
        const { issuerUrl, clientId, clientSecret, tokenAuthMethod, timeoutMs, fetcher } = this.options;
        const auth =
            tokenAuthMethod === 'client_secret_post'
                ? client.ClientSecretPost(clientSecret)
                : client.ClientSecretBasic(clientSecret);
        const url = new URL(issuerUrl);
        // The fetcher is for the tests; the library asks for its own type of request init, which `fetch` accepts
        const custom = fetcher as unknown as client.CustomFetch | undefined;
        const configuration = await client.discovery(url, clientId, undefined, auth, {
            timeout: Math.ceil(timeoutMs / 1000),
            ...(custom === undefined ? {} : { [client.customFetch]: custom }),
            ...(url.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : {})
        });
        if (custom !== undefined) {
            configuration[client.customFetch] = custom;
        }
        return configuration;
    }
}
