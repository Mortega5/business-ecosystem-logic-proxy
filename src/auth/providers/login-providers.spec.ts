import { describe, expect, it } from 'vitest';
import { fakeIdp, ISSUER, REDIRECT } from './fake-oidc-idp';
import { IdpError } from './idp-http';
import { KeycloakProvider } from './keycloak-provider';
import { OidcDiscoverProvider } from './oidc-discover-provider';

const back = (state: string) => `${REDIRECT}?code=abc&state=${state}`;

describe('the login of Keycloak', () => {
    const keycloak = (fetcher: typeof fetch) =>
        new KeycloakProvider({
            id: 'local',
            server: 'https://idp.example.org/',
            realm: 'bae',
            clientId: 'bae',
            clientSecret: 'shh',
            timeoutMs: 1000,
            scope: 'openid profile',
            organizationRoles: [],
            organizationName: () => Promise.resolve(undefined),
            fetcher
        });

    it('sends the user to the realm and gives the tokens with the user that Keycloak says they are', async () => {
        const idp = fakeIdp();
        const provider = keycloak(idp.fetcher as typeof fetch);
        const { url, checks } = await provider.beginLogin(REDIRECT);
        expect(url.startsWith(`${ISSUER}/protocol/openid-connect/auth?`)).toBe(true);
        expect(new URL(url).searchParams.get('scope')).toBe('openid profile');

        idp.state.idTokenClaims = { nonce: checks.nonce };
        const outcome = await provider.finishLogin(back(checks.state), checks);
        expect(outcome.tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
        expect(outcome.claims).toMatchObject({ id: 'u1', username: 'ana' });
    });

    it('refuses a forged state', async () => {
        const provider = keycloak(fakeIdp().fetcher as typeof fetch);
        const { checks } = await provider.beginLogin(REDIRECT);
        await expect(provider.finishLogin(back('forged'), checks)).rejects.toBeInstanceOf(IdpError);
    });
});

describe('the login of an OpenID Connect provider', () => {
    const oidc = (fetcher: typeof fetch) =>
        new OidcDiscoverProvider({
            id: 'local',
            issuerUrl: ISSUER,
            clientId: 'bae',
            clientSecret: 'shh',
            tokenAuthMethod: 'client_secret_basic',
            scope: 'openid email',
            timeoutMs: 1000,
            sellerRole: 'Seller',
            fetcher
        });

    it('takes who the user is from the ID token, and gives the roles of the token or the default one', async () => {
        const idp = fakeIdp();
        const provider = oidc(idp.fetcher as typeof fetch);
        const { checks } = await provider.beginLogin(REDIRECT);
        idp.state.idTokenClaims = { nonce: checks.nonce, preferred_username: 'ana', email: 'ana@example.org' };
        const outcome = await provider.finishLogin(back(checks.state), checks);
        expect(outcome.tokens.accessToken).toBe('at');
        expect(outcome.claims).toMatchObject({
            id: 'u1',
            username: 'ana',
            email: 'ana@example.org',
            roles: [{ name: 'Seller' }]
        });
    });

    it('refuses an ID token with another nonce', async () => {
        const idp = fakeIdp();
        const provider = oidc(idp.fetcher as typeof fetch);
        const { checks } = await provider.beginLogin(REDIRECT);
        idp.state.idTokenClaims = { nonce: 'another' };
        await expect(provider.finishLogin(back(checks.state), checks)).rejects.toBeInstanceOf(IdpError);
    });
});
