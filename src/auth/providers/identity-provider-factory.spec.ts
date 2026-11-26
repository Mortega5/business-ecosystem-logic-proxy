import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/config.schema';
import { AimarketProvider } from './aimarket-provider';
import { FiwareProvider } from './fiware-provider';
import { GithubProvider } from './github-provider';
import { createIdentityProvider, type ProviderDependencies } from './identity-provider-factory';
import { KeycloakProvider } from './keycloak-provider';
import { OidcDiscoverProvider } from './oidc-discover-provider';
import { I4TrustProvider } from './i4trust-provider';
import { TEST_CERTIFICATE, TEST_KEY } from './ishare-fixtures';

type Idp = AppConfig['auth']['idp'];

const dependencies: ProviderDependencies = {
    timeoutMs: 1000,
    roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin', certifier: 'certifier' },
    organizationName: async () => undefined
};
const complete = {
    server: 'https://idp.example.org',
    clientId: 'bae',
    clientSecret: 'secret',
    callbackUrl: 'https://bae.example.org/callback'
};

describe('createIdentityProvider', () => {
    it('builds keycloak, and names every setting that is missing', () => {
        expect(
            createIdentityProvider(
                {
                    provider: 'keycloak',
                    oidcEnabled: true,
                    tokenAuthMethod: 'client_secret_basic',
                    ...complete,
                    realm: 'dome'
                },
                dependencies
            )
        ).toBeInstanceOf(KeycloakProvider);

        expect(() =>
            createIdentityProvider(
                {
                    provider: 'keycloak',
                    oidcEnabled: true,
                    tokenAuthMethod: 'client_secret_basic',
                    server: complete.server
                },
                dependencies
            )
        ).toThrow(
            'auth.idp.clientId, auth.idp.clientSecret, auth.idp.callbackUrl, auth.idp.realm required when auth.idp.provider is keycloak'
        );
    });

    it('builds fiware with the key of its tokens, and does not start without it, as no key is a known key', () => {
        const idp: Idp = { provider: 'fiware', oidcEnabled: true, tokenAuthMethod: 'client_secret_basic', ...complete };

        expect(() => createIdentityProvider(idp, dependencies)).toThrow(
            'auth.idp.oidcKey required when auth.idp.provider is fiware'
        );
        expect(createIdentityProvider({ ...idp, oidcKey: 'k'.repeat(16) }, dependencies)).toBeInstanceOf(
            FiwareProvider
        );
    });

    it('needs no key when fiware is asked for the user instead of reading the token', () => {
        expect(
            createIdentityProvider(
                { provider: 'fiware', oidcEnabled: false, tokenAuthMethod: 'client_secret_basic', ...complete },
                dependencies
            )
        ).toBeInstanceOf(FiwareProvider);
    });

    it('builds aimarket with the settings of fiware, key included', () => {
        const idp: Idp = {
            provider: 'aimarket',
            oidcEnabled: true,
            tokenAuthMethod: 'client_secret_basic',
            ...complete
        };

        expect(() => createIdentityProvider(idp, dependencies)).toThrow(
            'auth.idp.oidcKey required when auth.idp.provider is aimarket'
        );
        expect(createIdentityProvider({ ...idp, oidcKey: 'k'.repeat(16) }, dependencies)).toBeInstanceOf(
            AimarketProvider
        );
    });

    it('gives the provider the id it is registered under', () => {
        expect(
            createIdentityProvider(
                { provider: 'fiware', oidcEnabled: false, tokenAuthMethod: 'client_secret_basic', ...complete },
                dependencies
            ).id
        ).toBe('local');
        expect(
            createIdentityProvider(
                { provider: 'fiware', oidcEnabled: false, tokenAuthMethod: 'client_secret_basic', ...complete },
                dependencies,
                'other'
            ).id
        ).toBe('other');
    });

    it('builds github, which needs the credentials of its application', () => {
        expect(
            createIdentityProvider(
                { provider: 'github', oidcEnabled: true, tokenAuthMethod: 'client_secret_basic', ...complete },
                dependencies
            )
        ).toBeInstanceOf(GithubProvider);
        expect(() =>
            createIdentityProvider(
                { provider: 'github', oidcEnabled: true, tokenAuthMethod: 'client_secret_basic' },
                dependencies
            )
        ).toThrow(
            'auth.idp.clientId, auth.idp.clientSecret, auth.idp.callbackUrl required when auth.idp.provider is github'
        );
    });

    it('builds oidc-discover from an issuer or from a discovery URL, and from neither it does not start', () => {
        const idp: Idp = {
            provider: 'oidc-discover',
            oidcEnabled: true,
            tokenAuthMethod: 'client_secret_basic',
            clientId: 'bae',
            clientSecret: 's',
            callbackUrl: 'https://bae.example.org/cb'
        };

        expect(createIdentityProvider({ ...idp, server: 'https://idp.example.org' }, dependencies)).toBeInstanceOf(
            OidcDiscoverProvider
        );
        expect(
            createIdentityProvider(
                { ...idp, discoveryUrl: 'https://idp.example.org/.well-known/openid-configuration' },
                dependencies
            )
        ).toBeInstanceOf(OidcDiscoverProvider);
        expect(() => createIdentityProvider(idp, dependencies)).toThrow(
            'auth.idp.server or auth.idp.discoveryUrl required'
        );
    });

    it('builds i4trust with the key and the certificate it reads from the files, and names what is missing', () => {
        const dir = mkdtempSync(join(tmpdir(), 'bae-ishare-'));
        const tokenKey = join(dir, 'key.pem');
        const tokenCrt = join(dir, 'crt.pem');
        writeFileSync(tokenKey, TEST_KEY);
        writeFileSync(tokenCrt, TEST_CERTIFICATE);
        const base = { provider: 'i4trust', oidcEnabled: true, tokenAuthMethod: 'client_secret_basic', ...complete } as const;

        expect(createIdentityProvider({ ...base, idpId: 'EU.EORI.IDP', tokenKey, tokenCrt }, dependencies)).toBeInstanceOf(I4TrustProvider);
        expect(() => createIdentityProvider(base, dependencies)).toThrow('auth.idp.idpId, auth.idp.tokenKey, auth.idp.tokenCrt required');
        expect(() => createIdentityProvider({ ...base, idpId: 'EU.EORI.IDP', tokenKey: join(dir, 'none.pem'), tokenCrt }, dependencies)).toThrow('ENOENT');
    });

    it('asks for the scopes of v11 unless the configuration says others', () => {
        const scopeOf = (idp: Idp) =>
            (createIdentityProvider(idp, dependencies) as unknown as { options: { scope: string } }).options.scope;
        const withKey = { oidcKey: 'k'.repeat(16), ...complete };
        expect(
            scopeOf({ provider: 'fiware', oidcEnabled: true, tokenAuthMethod: 'client_secret_basic', ...withKey })
        ).toBe('jwt,openid');
        expect(
            scopeOf({ provider: 'aimarket', oidcEnabled: true, tokenAuthMethod: 'client_secret_basic', ...withKey })
        ).toBe('jwt');
        expect(
            scopeOf({ provider: 'fiware', oidcEnabled: false, tokenAuthMethod: 'client_secret_basic', ...complete })
        ).toBe('all_info');
        expect(
            scopeOf({
                provider: 'fiware',
                oidcEnabled: true,
                tokenAuthMethod: 'client_secret_basic',
                scopes: 'jwt',
                ...withKey
            })
        ).toBe('jwt');
    });
});
