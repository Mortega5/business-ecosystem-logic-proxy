import type { AppConfig } from '../../config/config.schema';
import { AimarketProvider } from './aimarket-provider';
import { FiwareProvider } from './fiware-provider';
import { GithubProvider } from './github-provider';
import type { IdentityProvider } from './identity-provider';
import type { Fetcher } from './idp-http';
import { KeycloakProvider } from './keycloak-provider';
import { OidcDiscoverProvider } from './oidc-discover-provider';

type IdpSettings = AppConfig['auth']['idp'];

export interface ProviderDependencies {
    timeoutMs: number;
    /** Names of the roles of the platform. */
    roles: AppConfig['auth']['roles'];
    /** The trading name of an organisation that a group of the identity provider names. */
    organizationName: (group: string) => Promise<string | undefined>;
    fetcher?: Fetcher;
}

/** The settings the provider needs; it refuses to be built, naming what is missing, when one is not there. */
const required = <K extends keyof IdpSettings>(idp: IdpSettings, keys: K[]): { [P in K]-?: NonNullable<IdpSettings[P]> } => {
    const missing = keys.filter((key) => idp[key] === undefined);
    if (missing.length > 0) {
        throw new Error(`${missing.map((key) => `auth.idp.${key}`).join(', ')} required when auth.idp.provider is ${idp.provider}`);
    }
    return idp as unknown as { [P in K]-?: NonNullable<IdpSettings[P]> };
};

/** The main identity provider of the configuration, called `local`, or an error at start-up that says what the configuration lacks. */
export const createIdentityProvider = (idp: IdpSettings, dependencies: ProviderDependencies, id = 'local'): IdentityProvider => {
    const common = { id, timeoutMs: dependencies.timeoutMs, ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }) };
    switch (idp.provider) {
        case 'keycloak': {
            const settings = required(idp, ['server', 'clientId', 'clientSecret', 'callbackUrl', 'realm']);
            const { seller, customer, orgAdmin } = dependencies.roles;
            return new KeycloakProvider({
                ...common,
                server: settings.server,
                realm: settings.realm,
                clientId: settings.clientId,
                clientSecret: settings.clientSecret,
                scope: idp.scopes ?? 'openid profile',
                organizationRoles: [seller, customer, orgAdmin],
                organizationName: dependencies.organizationName
            });
        }
        case 'aimarket':
        case 'fiware': {
            // There is no default key: a fixed one would let anybody who knows it sign a token
            const settings = required(idp, idp.oidcEnabled ? ['server', 'clientId', 'clientSecret', 'callbackUrl', 'oidcKey'] : ['server', 'clientId', 'clientSecret', 'callbackUrl']);
            const Provider = idp.provider === 'aimarket' ? AimarketProvider : FiwareProvider;
            return new Provider({
                ...common,
                server: settings.server,
                clientId: settings.clientId,
                clientSecret: settings.clientSecret,
                ...(idp.oidcEnabled && idp.oidcKey !== undefined ? { key: idp.oidcKey } : {}),
                ...(idp.defaultRole === undefined ? {} : { defaultRole: idp.defaultRole })
            });
        }
        case 'github': {
            required(idp, ['clientId', 'clientSecret', 'callbackUrl']);
            return new GithubProvider({ ...common, sellerRole: dependencies.roles.seller });
        }
        case 'oidc-discover': {
            const settings = required(idp, ['clientId', 'clientSecret', 'callbackUrl']);
            if (idp.server === undefined && idp.discoveryUrl === undefined) {
                throw new Error('auth.idp.server or auth.idp.discoveryUrl required when auth.idp.provider is oidc-discover');
            }
            return new OidcDiscoverProvider({
                ...common,
                clientId: settings.clientId,
                clientSecret: settings.clientSecret,
                tokenAuthMethod: idp.tokenAuthMethod,
                scope: idp.scopes ?? 'openid',
                sellerRole: dependencies.roles.seller,
                ...(idp.server === undefined ? {} : { issuerUrl: idp.server }),
                ...(idp.discoveryUrl === undefined ? {} : { discoveryUrl: idp.discoveryUrl }),
                ...(idp.defaultRole === undefined ? {} : { defaultRole: idp.defaultRole }),
                ...(idp.audience === undefined ? {} : { audience: idp.audience })
            });
        }
        default:
            throw new Error(`auth.idp.provider ${idp.provider} is not available yet`);
    }
};
