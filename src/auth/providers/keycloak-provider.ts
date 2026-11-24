import type { IdentityClaims, ProfileOrganization } from '../profile/user-profile';
import type { IdentityProvider, IdentityTokens } from './identity-provider';
import { IdpError, requestJson, tokensOf, type Fetcher } from './idp-http';
import { jwtPayload } from './jwt-payload';

export interface KeycloakOptions {
    id: string;
    /** Base URL of Keycloak, with or without a trailing slash. */
    server: string;
    realm: string;
    clientId: string;
    clientSecret: string;
    timeoutMs: number;
    /** Names of the roles of the platform that the groups of the user get in their organisations. */
    organizationRoles: string[];
    /** The trading name of an organisation known by the group that names it, when TMForum has it. */
    organizationName: (group: string) => Promise<string | undefined>;
    fetcher?: Fetcher;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/**
 * Keycloak: the user is asked to the user info endpoint of the realm. The roles are the ones of the client in the access token and
 * each group of the token is an organisation the user acts for.
 */
export class KeycloakProvider implements IdentityProvider {
    readonly id: string;
    private readonly realmUrl: string;
    private readonly fetcher: Fetcher;

    constructor(private readonly options: KeycloakOptions) {
        this.id = options.id;
        this.realmUrl = `${options.server.replace(/\/+$/, '')}/realms/${encodeURIComponent(options.realm)}/protocol/openid-connect`;
        this.fetcher = options.fetcher ?? fetch;
    }

    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        const info = await requestJson(this.fetcher, `${this.realmUrl}/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } }, this.options.timeoutMs);
        const id = info['sub'];
        if (typeof id !== 'string' || id === '') {
            throw new IdpError('The identity provider gave a user without id');
        }

        // The token is the one Keycloak has just accepted, so what it says of roles and groups is Keycloak's
        const token = jwtPayload(accessToken);
        const resource = (token?.['resource_access'] as Record<string, { roles?: unknown }> | undefined)?.[this.options.clientId];
        const username = typeof info['preferred_username'] === 'string' && info['preferred_username'] !== '' ? info['preferred_username'] : id;

        return {
            id,
            username,
            ...(typeof info['name'] === 'string' && info['name'] !== '' ? { displayName: info['name'] } : {}),
            ...(typeof info['email'] === 'string' && info['email'] !== '' ? { email: info['email'] } : {}),
            roles: strings(resource?.roles).map((role) => ({ id: role, name: role })),
            organizations: await Promise.all(strings(token?.['groups']).map((group) => this.organizationOf(group))),
            ...(typeof token?.['exp'] === 'number' ? { expire: token['exp'] } : {})
        };
    }

    async refresh(refreshToken: string): Promise<IdentityTokens> {
        const answer = await requestJson(
            this.fetcher,
            `${this.realmUrl}/token`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: this.options.clientId,
                    client_secret: this.options.clientSecret
                })
            },
            this.options.timeoutMs
        );
        return tokensOf(answer);
    }

    private async organizationOf(group: string): Promise<ProfileOrganization> {
        // A name that cannot be found is not a reason to refuse the user: the group is then the name
        const name = await this.options.organizationName(group).catch(() => undefined);
        return { id: group, name: name ?? group, roles: this.options.organizationRoles.map((role) => ({ name: role })) };
    }
}
