import { readFileSync } from 'node:fs';
import type { AppConfig } from '../../config/config.schema';
import { AimarketProvider } from './aimarket-provider';
import { FiwareProvider } from './fiware-provider';
import { GithubProvider } from './github-provider';
import type { IdentityProvider } from './identity-provider';
import type { Fetcher } from './idp-http';
import { I4TrustProvider } from './i4trust-provider';
import { JwksVerifier } from './jwks-verifier';
import { KeycloakProvider } from './keycloak-provider';
import { OidcDiscoverProvider } from './oidc-discover-provider';
import { loadVcPrivateKey } from './vc-key';
import { VcProvider } from './vc-provider';

type IdpSettings = AppConfig['auth']['idp'];

export interface ProviderDependencies {
    timeoutMs: number;
    /** Names of the roles of the platform. */
    roles: AppConfig['auth']['roles'];
    /** The trading name of an organisation that a group of the identity provider names. */
    organizationName: (group: string) => Promise<string | undefined>;
    /** Issuers, or organisation identifiers, whose users are administrators when the token carries a credential. */
    operators?: string[];
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
                // What v11 asked for: with OIDC the token is a JWT (the AI Market does not need `openid`), without it all the data
                scope: idp.scopes ?? (idp.oidcEnabled ? (idp.provider === 'aimarket' ? 'jwt' : 'jwt,openid') : 'all_info'),
                ...(idp.oidcEnabled && idp.oidcKey !== undefined ? { key: idp.oidcKey } : {}),
                ...(idp.defaultRole === undefined ? {} : { defaultRole: idp.defaultRole })
            });
        }
        case 'github': {
            const settings = required(idp, ['clientId', 'clientSecret', 'callbackUrl']);
            return new GithubProvider({
                ...common,
                clientId: settings.clientId,
                clientSecret: settings.clientSecret,
                scope: idp.scopes ?? 'user:email',
                sellerRole: dependencies.roles.seller
            });
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
                ...(idp.audience === undefined ? {} : { audience: idp.audience }),
                credentialPolicy: { roles: dependencies.roles, operators: dependencies.operators ?? [] }
            });
        }
        case 'i4trust': {
            const settings = required(idp, ['server', 'clientId', 'callbackUrl', 'idpId', 'tokenKey', 'tokenCrt']);
            return new I4TrustProvider({
                id,
                roles: dependencies.roles,
                ...(idp.jwksUrl === undefined
                    ? {}
                    : { verifier: new JwksVerifier({ url: idp.jwksUrl, timeoutMs: dependencies.timeoutMs, ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }) }) }),
                login: {
                    server: settings.server,
                    clientId: settings.clientId,
                    idpId: settings.idpId,
                    scope: idp.scopes ?? 'jwt openid iSHARE email profile',
                    // Read at start-up, so that a path that is wrong stops it and does not fail the first login
                    keyPem: readFileSync(settings.tokenKey, 'utf8'),
                    certificatePem: readFileSync(settings.tokenCrt, 'utf8'),
                    timeoutMs: dependencies.timeoutMs,
                    ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher })
                }
            });
        }
        default:
            throw new Error(`auth.idp.provider ${(idp as { provider: string }).provider} is not available yet`);
    }
};

/**
 * The main identity provider and the address it sends its users back to: the login with credentials when `auth.vc.enabled` (as in v11,
 * where it took the place of the other), or else the one of `auth.idp`. It refuses to be built, naming what is missing, when a setting
 * is not there, and when the key cannot be read.
 */
export const createMainIdentityProvider = (
    auth: AppConfig['auth'],
    dependencies: ProviderDependencies,
    id = 'local'
): { provider: IdentityProvider; callbackUrl: string } => {
    const { vc } = auth;
    if (!vc.enabled) {
        const callbackUrl = auth.idp.callbackUrl;
        const provider = createIdentityProvider(auth.idp, { ...dependencies, operators: vc.operators }, id);
        if (callbackUrl === undefined) {
            throw new Error(`auth.idp.callbackUrl required when auth.idp.provider is ${auth.idp.provider}`);
        }
        return { provider, callbackUrl };
    }
    const { clientId, callbackUrl, verifierHost } = vc;
    if (clientId === undefined || callbackUrl === undefined || verifierHost === undefined) {
        throw new Error('auth.vc.clientId, auth.vc.callbackUrl and auth.vc.verifierHost are required when auth.vc.enabled is true');
    }
    const provider = new VcProvider({
        id,
        clientId,
        privateKey: loadVcPrivateKey({
            ...(vc.privateKeyFile === undefined ? {} : { file: vc.privateKeyFile }),
            ...(vc.privateKey === undefined ? {} : { hex: vc.privateKey })
        }),
        signAlgorithm: vc.signAlgorithm,
        callbackUrl,
        verifierHost,
        verifierTokenPath: vc.verifierTokenPath,
        verifierJwksPath: vc.verifierJwksPath,
        ...(vc.verifierIssuer === undefined ? {} : { verifierIssuer: vc.verifierIssuer }),
        policy: { roles: auth.roles, operators: vc.operators },
        timeoutMs: dependencies.timeoutMs,
        ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher })
    });
    return { provider, callbackUrl };
};
