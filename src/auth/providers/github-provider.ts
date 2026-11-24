import type { IdentityClaims } from '../profile/user-profile';
import type { IdentityProvider, IdentityTokens } from './identity-provider';
import { IdpError, requestJson, type Fetcher } from './idp-http';

export interface GithubOptions {
    id: string;
    timeoutMs: number;
    /** Name of the role of a seller in the platform: every user of GitHub is one. */
    sellerRole: string;
    /** `https://api.github.com` unless a test says another. */
    apiUrl?: string;
    fetcher?: Fetcher;
}

/**
 * GitHub: the user is asked to its API with the token. Nobody has organisations or more role than seller, as in v11. GitHub OAuth
 * tokens do not expire and are not refreshed, so a client of the API presents the same token until it revokes it.
 */
export class GithubProvider implements IdentityProvider {
    readonly id: string;
    private readonly apiUrl: string;
    private readonly fetcher: Fetcher;

    constructor(private readonly options: GithubOptions) {
        this.id = options.id;
        this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
        this.fetcher = options.fetcher ?? fetch;
    }

    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        const user = await requestJson(
            this.fetcher,
            `${this.apiUrl}/user`,
            // GitHub refuses a call that has no User-Agent
            { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'business-ecosystem-logic-proxy' } },
            this.options.timeoutMs
        );
        const id = typeof user['id'] === 'number' || typeof user['id'] === 'string' ? String(user['id']) : undefined;
        if (id === undefined || id === '') {
            throw new IdpError('The identity provider gave a user without id');
        }
        const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
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

    refresh(): Promise<IdentityTokens> {
        return Promise.reject(new IdpError('GitHub tokens are not refreshed'));
    }
}
