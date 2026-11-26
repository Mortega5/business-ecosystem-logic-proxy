import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { IdpError } from './idp-http';
import { OidcDiscoverProvider, type OidcDiscoverOptions } from './oidc-discover-provider';

const ISSUER = 'https://idp.example.org/realms/dome';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] };
const sign = (claims: object, options: jwt.SignOptions = {}): string =>
    jwt.sign({ iss: ISSUER, ...claims }, privateKey.export({ type: 'pkcs8', format: 'pem' }), { algorithm: 'RS256', keyid: 'k1', expiresIn: 600, ...options });

interface Call {
    url: string;
    init: RequestInit;
}

/** The identity provider: its discovery document, its keys and its token endpoint. */
const idp = (answers: { token?: object; document?: object; status?: number } = {}) => {
    const calls: Call[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/.well-known/openid-configuration')) {
            return new Response(JSON.stringify(answers.document ?? { issuer: ISSUER, jwks_uri: `${ISSUER}/certs`, token_endpoint: `${ISSUER}/token` }), { status: answers.status ?? 200 });
        }
        if (url === `${ISSUER}/certs`) {
            return new Response(JSON.stringify(jwks), { status: 200 });
        }
        return new Response(JSON.stringify(answers.token ?? { access_token: 'a2', refresh_token: 'r2', expires_in: 300 }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
};

const provider = (server: ReturnType<typeof idp>, extra: Partial<OidcDiscoverOptions> = {}): OidcDiscoverProvider =>
    new OidcDiscoverProvider({
        id: 'local',
        issuerUrl: ISSUER,
        clientId: 'bae',
        clientSecret: 'client secret',
        tokenAuthMethod: 'client_secret_basic',
        scope: 'openid',
        timeoutMs: 1000,
        sellerRole: 'Seller',
        fetcher: server.fetcher,
        ...extra
    });

describe('OidcDiscoverProvider: who a token belongs to', () => {
    it('finds the keys through the discovery document of the issuer, and takes the user from the token', async () => {
        const server = idp();

        const claims = await provider(server).claimsOf(sign({ sub: 'u1', preferred_username: 'ana', name: 'Ana López', email: 'ana@example.org' }));

        expect(server.calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);
        expect(claims).toMatchObject({ id: 'u1', username: 'ana', displayName: 'Ana López', email: 'ana@example.org' });
        expect(claims.expire).toBeGreaterThan(Math.floor(Date.now() / 1000) + 590);
    });

    it('uses the discovery URL as it is when it is given, and does not add the path to one that already has it', async () => {
        const server = idp();
        const url = 'https://idp.example.org/custom/.well-known/openid-configuration';

        await provider(server, { discoveryUrl: url }).claimsOf(sign({ sub: 'u1' }));

        expect(server.calls[0]?.url).toBe(url);
    });

    it('asks for the discovery document once for many tokens, and again after a failure', async () => {
        const failing = idp({ status: 500 });
        const first = provider(failing);
        await expect(first.claimsOf(sign({ sub: 'u1' }))).rejects.toBeInstanceOf(IdpError);
        await expect(first.claimsOf(sign({ sub: 'u1' }))).rejects.toBeInstanceOf(IdpError);
        expect(failing.calls.filter((call) => call.url.endsWith('openid-configuration'))).toHaveLength(2);

        const working = idp();
        const second = provider(working);
        await Promise.all([second.claimsOf(sign({ sub: 'u1' })), second.claimsOf(sign({ sub: 'u2' })), second.claimsOf(sign({ sub: 'u3' }))]);
        expect(working.calls.filter((call) => call.url.endsWith('openid-configuration'))).toHaveLength(1);
    });

    it('takes the roles of the token, as names or as objects, and the seller role when it has none, or the default one', async () => {
        const server = idp();

        expect((await provider(server).claimsOf(sign({ sub: 'u1', roles: ['admin', { id: 'r2', name: 'seller' }] }))).roles).toEqual([
            { id: 'admin', name: 'admin' },
            { id: 'r2', name: 'seller' }
        ]);
        expect((await provider(server).claimsOf(sign({ sub: 'u1' }))).roles).toEqual([{ id: 'Seller', name: 'Seller' }]);
        expect((await provider(server, { defaultRole: 'Buyer' }).claimsOf(sign({ sub: 'u1' }))).roles).toEqual([{ id: 'Buyer', name: 'Buyer' }]);
    });

    it('takes the organisations the token names, and none otherwise', async () => {
        const server = idp();
        const claims = await provider(server).claimsOf(sign({ sub: 'u1', organizations: [{ id: 'org-1', name: 'Acme', roles: [{ name: 'owner' }] }] }));

        expect(claims.organizations).toEqual([{ id: 'org-1', name: 'Acme', roles: [{ id: 'owner', name: 'owner' }] }]);
        expect((await provider(server).claimsOf(sign({ sub: 'u1' }))).organizations).toEqual([]);
    });

    it('takes the preferred username as the id when the token has no subject, and refuses one with neither', async () => {
        const server = idp();

        expect((await provider(server).claimsOf(sign({ preferred_username: 'ana' }))).id).toBe('ana');
        await expect(provider(server).claimsOf(sign({ name: 'Ana' }))).rejects.toBeInstanceOf(IdpError);
    });

    it('refuses a token that is expired, from another issuer, or signed by somebody else', async () => {
        const server = idp();
        const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

        await expect(provider(server).claimsOf(sign({ sub: 'u1' }, { expiresIn: -10 }))).rejects.toBeDefined();
        await expect(provider(server).claimsOf(sign({ sub: 'u1', iss: 'https://evil.example.org' }))).rejects.toBeDefined();
        await expect(
            provider(server).claimsOf(jwt.sign({ iss: ISSUER, sub: 'admin' }, other.export({ type: 'pkcs8', format: 'pem' }), { algorithm: 'RS256', keyid: 'k1' }))
        ).rejects.toBeDefined();
    });

    it('refuses a discovery document that lacks what it needs', async () => {
        await expect(provider(idp({ document: { issuer: ISSUER } })).claimsOf(sign({ sub: 'u1' }))).rejects.toBeInstanceOf(IdpError);
    });
});

describe('OidcDiscoverProvider: the audience', () => {
    it('is not checked when it is not set, so a token meant for another client is taken', async () => {
        const claims = await provider(idp()).claimsOf(sign({ sub: 'u1', aud: 'another-client' }));

        expect(claims.id).toBe('u1');
    });

    it('is checked when it is set: a token that is meant for another client, or for nobody, is refused', async () => {
        const server = idp();
        const checking = provider(server, { audience: 'bae' });

        await expect(checking.claimsOf(sign({ sub: 'u1', aud: 'bae' }))).resolves.toMatchObject({ id: 'u1' });
        await expect(checking.claimsOf(sign({ sub: 'u1', aud: ['other', 'bae'] }))).resolves.toMatchObject({ id: 'u1' });
        await expect(checking.claimsOf(sign({ sub: 'u1', aud: 'another-client' }))).rejects.toBeDefined();
        await expect(checking.claimsOf(sign({ sub: 'u1' }))).rejects.toBeDefined();
    });
});

describe('OidcDiscoverProvider: refreshing', () => {
    it('asks the token endpoint with the credentials in the Basic header, form-encoded first', async () => {
        const server = idp();

        const tokens = await provider(server).refresh('r1');

        const call = server.calls.find((entry) => entry.url === `${ISSUER}/token`);
        expect((call?.init.headers as Record<string, string> | undefined)?.['authorization']).toBe(`Basic ${Buffer.from('bae:client%20secret').toString('base64')}`);
        expect(Object.fromEntries(call?.init.body as URLSearchParams)).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1' });
        expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    });

    it('puts the credentials in the body when the provider wants them there', async () => {
        const server = idp();

        await provider(server, { tokenAuthMethod: 'client_secret_post' }).refresh('r1');

        const call = server.calls.find((entry) => entry.url === `${ISSUER}/token`);
        expect((call?.init.headers as Record<string, string> | undefined)?.['authorization']).toBeUndefined();
        expect(Object.fromEntries(call?.init.body as URLSearchParams)).toMatchObject({ client_id: 'bae', client_secret: 'client secret' });
    });

    it('rejects an answer without an access token', async () => {
        await expect(provider(idp({ token: { error: 'invalid_grant' } })).refresh('used')).rejects.toBeInstanceOf(IdpError);
    });
});

describe('OidcDiscoverProvider: the claims of a login', () => {
    it('are read like the ones of a token', () => {
        const claims = provider(idp()).claimsFromIdToken({ sub: 'u1', preferred_username: 'ana', email: 'ana@example.org' });

        expect(claims).toMatchObject({ id: 'u1', username: 'ana', email: 'ana@example.org', roles: [{ name: 'Seller' }] });
    });
});

describe('OidcDiscoverProvider: a token that carries a credential', () => {
    const credentialPolicy = {
        roles: { admin: 'admin', customer: 'customer', seller: 'seller', orgAdmin: 'manager', certifier: 'certifier' },
        operators: []
    };
    const credential = (mandatee: object = {}) => ({
        sub: 'did:web:verifier.example.org',
        verifiableCredential: {
            type: ['VerifiableCredential', 'LEARCredentialEmployee'],
            issuer: { id: 'did:elsi:ISSUER' },
            credentialSubject: {
                mandate: {
                    mandator: { organizationIdentifier: 'VATES-1', organization: 'Acme', country: 'ES' },
                    mandatee: { id: 'did:key:ana', email: 'ana@acme.org', first_name: 'Ana', last_name: 'López', ...mandatee },
                    power: [{ function: 'ProductOffering', action: ['Create', 'Update'] }]
                }
            }
        }
    });

    it('is the person and the organisation that the credential names, as in v11, and not the subject of the token', async () => {
        const claims = await provider(idp(), { credentialPolicy }).claimsOf(sign(credential()));

        expect(claims.id).toBe('did:key:ana');
        expect(claims.email).toBe('ana@acme.org');
        expect(claims.organizations).toMatchObject([{ id: 'VATES-1', name: 'Acme' }]);
        // The seller role is the one the powers give in the organisation, not a role of the user in the platform
        expect(claims.roles).toEqual([]);
        expect(claims.organizations[0]?.roles.map((role) => role.name)).toContain('seller');
    });

    it('is the same person at the login, from the ID token that the library validated', () => {
        const claims = provider(idp(), { credentialPolicy }).claimsFromIdToken(credential());

        expect(claims.id).toBe('did:key:ana');
        expect(claims.organizations).toMatchObject([{ id: 'VATES-1' }]);
    });

    it('is read by its claims when it carries no credential', async () => {
        const claims = await provider(idp(), { credentialPolicy }).claimsOf(sign({ sub: 'u1', preferred_username: 'ana' }));

        expect(claims).toMatchObject({ id: 'u1', username: 'ana', organizations: [] });
    });

    it('refuses the login when the credential is there and cannot be read, instead of making somebody else of the user', async () => {
        const broken = credential();
        delete (broken.verifiableCredential.credentialSubject.mandate as { mandator?: unknown }).mandator;

        await expect(provider(idp(), { credentialPolicy }).claimsOf(sign(broken))).rejects.toBeInstanceOf(IdpError);
    });

    it('does not read credentials when there is no policy for them', async () => {
        const claims = await provider(idp()).claimsOf(sign(credential()));

        expect(claims.id).toBe('did:web:verifier.example.org');
    });
});

