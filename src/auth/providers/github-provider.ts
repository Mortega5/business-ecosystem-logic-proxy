import type { IdentityClaims } from '../profile/user-profile';
import type {
    IdentityProvider,
    IdentityTokens,
    LoginCapable,
    LoginChecks,
    LoginOutcome,
    LoginStart
} from './identity-provider';
import { IdpError, requestJson, idpFetch, type Fetcher } from './idp-http';
import { OAuth2Login } from './oauth2-login';

export interface GithubOptions {
    id: string;
    timeoutMs: number;
    clientId: string;
    clientSecret: string;
    /** What is asked at the login; `user:email` gives the address of the user. */
    scope: string;
    /** Name of the role of a seller in the platform: every user of GitHub is one. */
    sellerRole: string;
    /** `https://api.github.com` unless a test says another. */
    apiUrl?: string;
    /** `https://github.com` unless a test says another. */
    siteUrl?: string;
    fetcher?: Fetcher;
}

/**
 * GitHub: the user is asked to its API with the token. Nobody has organisations or more role than seller, as in v11. GitHub OAuth
 * tokens do not expire and are not refreshed, so a client of the API presents the same token until it revokes it.
 */
export class GithubProvider implements IdentityProvider, LoginCapable {
    readonly id: string;
    private readonly apiUrl: string;
    private readonly fetcher: Fetcher;
    private readonly login: OAuth2Login;

    constructor(private readonly options: GithubOptions) {
        this.id = options.id;
        this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
        this.fetcher = options.fetcher ?? idpFetch;
        const site = (options.siteUrl ?? 'https://github.com').replace(/\/+$/, '');
        this.login = new OAuth2Login({
            authorizationUrl: `${site}/login/oauth/authorize`,
            tokenUrl: `${site}/login/oauth/access_token`,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            scope: options.scope,
            clientAuth: 'post',
            timeoutMs: options.timeoutMs,
            fetcher: this.fetcher
        });
    }

    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        const user = await requestJson(
            this.fetcher,
            `${this.apiUrl}/user`,
            // GitHub refuses a call that has no User-Agent
            {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'business-ecosystem-logic-proxy'
                }
            },
            this.options.timeoutMs
        );
        const id = typeof user['id'] === 'number' || typeof user['id'] === 'string' ? String(user['id']) : undefined;
        if (id === undefined || id === '') {
            throw new IdpError('The identity provider gave a user without id');
        }
        const text = (value: unknown): string | undefined =>
            typeof value === 'string' && value !== '' ? value : undefined;
        const username = text(user['login']) ?? id;
        const displayName = text(user['name']);
        const email = text(user['email']);

        return {
            id,
            username,
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            roles: [{ id: this.options.sellerRole, name: this.options.sellerRole }],
            organizations: []
        };
    }

    beginLogin(redirectUri: string): Promise<LoginStart> {
        return Promise.resolve(this.login.start(redirectUri));
    }

    async finishLogin(callbackUrl: string, checks: LoginChecks): Promise<LoginOutcome> {
        const tokens = await this.login.finish(callbackUrl, checks);
        return { tokens, claims: await this.claimsOf(tokens.accessToken) };
    }

    refresh(): Promise<IdentityTokens> {
        return Promise.reject(new IdpError('GitHub tokens are not refreshed'));
    }
}
