import type { AppConfig } from '../../config/config.schema';
import { AimarketProvider } from './aimarket-provider';
import { FiwareProvider } from './fiware-provider';
import { GithubProvider } from './github-provider';
import type { IdentityProvider } from './identity-provider';
import type { Fetcher } from './idp-http';
import { KeycloakProvider } from './keycloak-provider';

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
        default:
            throw new Error(`auth.idp.provider ${idp.provider} is not available yet`);
    }
};
