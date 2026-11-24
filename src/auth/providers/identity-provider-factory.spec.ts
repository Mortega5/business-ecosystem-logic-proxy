import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/config.schema';
import { FiwareProvider } from './fiware-provider';
import { createIdentityProvider, type ProviderDependencies } from './identity-provider-factory';
import { KeycloakProvider } from './keycloak-provider';

type Idp = AppConfig['auth']['idp'];

const dependencies: ProviderDependencies = {
    timeoutMs: 1000,
    roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' },
    organizationName: async () => undefined
};
const complete = { server: 'https://idp.example.org', clientId: 'bae', clientSecret: 'secret', callbackUrl: 'https://bae.example.org/callback' };

describe('createIdentityProvider', () => {
    it('builds keycloak, and names every setting that is missing', () => {
        expect(createIdentityProvider({ provider: 'keycloak', oidcEnabled: true, ...complete, realm: 'dome' }, dependencies)).toBeInstanceOf(KeycloakProvider);

        expect(() => createIdentityProvider({ provider: 'keycloak', oidcEnabled: true, server: complete.server }, dependencies)).toThrow(
            'auth.idp.clientId, auth.idp.clientSecret, auth.idp.callbackUrl, auth.idp.realm required when auth.idp.provider is keycloak'
        );
    });

    it('builds fiware with the key of its tokens, and does not start without it, as no key is a known key', () => {
        const idp: Idp = { provider: 'fiware', oidcEnabled: true, ...complete };

        expect(() => createIdentityProvider(idp, dependencies)).toThrow('auth.idp.oidcKey required when auth.idp.provider is fiware');
        expect(createIdentityProvider({ ...idp, oidcKey: 'k'.repeat(16) }, dependencies)).toBeInstanceOf(FiwareProvider);
    });

    it('needs no key when fiware is asked for the user instead of reading the token', () => {
        expect(createIdentityProvider({ provider: 'fiware', oidcEnabled: false, ...complete }, dependencies)).toBeInstanceOf(FiwareProvider);
    });

    it('gives the provider the id it is registered under', () => {
        expect(createIdentityProvider({ provider: 'fiware', oidcEnabled: false, ...complete }, dependencies).id).toBe('local');
        expect(createIdentityProvider({ provider: 'fiware', oidcEnabled: false, ...complete }, dependencies, 'other').id).toBe('other');
    });

    it('says so when the provider is not ported yet', () => {
        expect(() => createIdentityProvider({ provider: 'github', oidcEnabled: true }, dependencies)).toThrow('not available yet');
    });
});
