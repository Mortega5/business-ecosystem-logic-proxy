import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/config.schema';
import { proxyKeyHex } from './fake-vc-verifier';
import { createMainIdentityProvider, type ProviderDependencies } from './identity-provider-factory';
import { KeycloakProvider } from './keycloak-provider';
import { VcProvider } from './vc-provider';

const dependencies: ProviderDependencies = {
    timeoutMs: 1000,
    roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' },
    organizationName: async () => undefined
};
const vc = {
    enabled: true,
    isRedirection: false,
    clientId: 'bae-client',
    privateKey: proxyKeyHex(),
    signAlgorithm: 'ES256',
    callbackUrl: 'https://bae.example.org/auth/vc/callback',
    requestUri: '/auth/vc/request.jwt',
    verifierHost: 'https://verifier.example.org',
    verifierQrCodePath: '/api/v1/loginQR',
    verifierTokenPath: '/token',
    verifierJwksPath: '/.well-known/jwks',
    operators: [],
    certIssuers: [],
    certifierRole: 'certifier',
    bindPollToSession: true
};
const auth = (override: Record<string, unknown> = {}, idp: Record<string, unknown> = {}) =>
    ({
        roles: dependencies.roles,
        idp: {
            provider: 'keycloak',
            oidcEnabled: true,
            tokenAuthMethod: 'client_secret_basic',
            server: 'https://kc.example.org',
            realm: 'dome',
            clientId: 'bae',
            clientSecret: 's',
            callbackUrl: 'https://bae.example.org/auth/keycloak/callback',
            ...idp
        },
        vc: { ...vc, ...override }
    }) as unknown as AppConfig['auth'];

describe('createMainIdentityProvider', () => {
    it('is the provider of `auth.idp`, with its callback, while the login with credentials is off', () => {
        const main = createMainIdentityProvider(auth({ enabled: false }), dependencies);
        expect(main.provider).toBeInstanceOf(KeycloakProvider);
        expect(main.callbackUrl).toBe('https://bae.example.org/auth/keycloak/callback');
    });

    it('is the login with credentials, called local and with its own callback, instead of the provider of `auth.idp`, which is not even asked for its settings', () => {
        const main = createMainIdentityProvider(auth({}, { server: undefined, clientId: undefined }), dependencies);
        expect(main.provider).toBeInstanceOf(VcProvider);
        expect(main.provider.id).toBe('local');
        expect(main.callbackUrl).toBe('https://bae.example.org/auth/vc/callback');
    });

    it('reads the key from a PEM file when there is one', () => {
        const dir = mkdtempSync(join(tmpdir(), 'bae-vc-'));
        writeFileSync(join(dir, 'missing.txt'), 'not a key');
        expect(() =>
            createMainIdentityProvider(
                auth({ privateKey: undefined, privateKeyFile: join(dir, 'missing.txt') }),
                dependencies
            )
        ).toThrow();
        expect(() =>
            createMainIdentityProvider(
                auth({ privateKey: undefined, privateKeyFile: join(dir, 'nothing.pem') }),
                dependencies
            )
        ).toThrow('ENOENT');
    });

    it('refuses to be built without what it needs, naming it', () => {
        expect(() => createMainIdentityProvider(auth({ clientId: undefined }), dependencies)).toThrow(
            'auth.vc.clientId'
        );
        expect(() => createMainIdentityProvider(auth({ privateKey: undefined }), dependencies)).toThrow('32 bytes');
    });
});
