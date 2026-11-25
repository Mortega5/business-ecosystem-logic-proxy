import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { checkedAssertion, jwksDocument, LEAR_EMPLOYEE, proxyKeys, verifierToken } from './fake-vc-verifier';
import { IdpError } from './idp-http';
import { VcProvider } from './vc-provider';

const VERIFIER = 'https://verifier.example.org';
const CALLBACK = 'https://bae.example.org/auth/vc/callback';

/** A verifier whose token endpoint answers what the test says, and which records what it was asked. */
const verifier = (
    answer: unknown = { access_token: verifierToken(LEAR_EMPLOYEE), refresh_token: 'refresh-1', expires_in: 600 },
    status = 200
) => {
    const calls: { url: string, body: URLSearchParams }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/jwks')) {
            return new Response(JSON.stringify(jwksDocument()), { status: 200 });
        }
        calls.push({ url, body: new URLSearchParams(String(init?.body)) });
        return new Response(JSON.stringify(answer), { status });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
};

const provider = (fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof VcProvider>[0]> = {}) =>
    new VcProvider({
        id: 'local',
        clientId: 'bae-client',
        privateKey: proxyKeys.privateKey,
        signAlgorithm: 'ES256',
        callbackUrl: CALLBACK,
        verifierHost: `${VERIFIER}/`,
        verifierTokenPath: '/token',
        verifierJwksPath: '/.well-known/jwks',
        policy: {
            roles: {
                admin: 'admin',
                customer: 'customer',
                seller: 'seller',
                orgAdmin: 'manager',
                certifier: 'certifier'
            },
            operators: []
        },
        timeoutMs: 1000,
        fetcher,
        ...extra
    });

describe('VcProvider: the tokens of the verifier', () => {
    it('reads the user from the credential of a token that the verifier signed', async () => {
        const claims = await provider(verifier().fetcher).claimsOf(verifierToken(LEAR_EMPLOYEE));
        expect(claims).toMatchObject({ id: 'did:key:ana', username: 'ana', displayName: 'Ana López' });
    });

    it('refuses a token that another party signed, one that has expired and one that says another issuer when one is asked for', async () => {
        const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const forged = jwt.sign(LEAR_EMPLOYEE, other.privateKey, { algorithm: 'ES256', keyid: 'verifier-key-1' });
        await expect(provider(verifier().fetcher).claimsOf(forged)).rejects.toBeDefined();
        await expect(
            provider(verifier().fetcher).claimsOf(verifierToken(LEAR_EMPLOYEE, { expiresInSeconds: -60 }))
        ).rejects.toBeDefined();
        await expect(
            provider(verifier().fetcher, { verifierIssuer: 'https://other.example.org' }).claimsOf(
                verifierToken({ ...LEAR_EMPLOYEE, iss: VERIFIER })
            )
        ).rejects.toBeDefined();
        await expect(
            provider(verifier().fetcher, { verifierIssuer: VERIFIER }).claimsOf(
                verifierToken({ ...LEAR_EMPLOYEE, iss: VERIFIER })
            )
        ).resolves.toBeDefined();
    });
});

describe('VcProvider: the code', () => {
    it('exchanges a code with an assertion signed by the proxy, and without the address it came back to', async () => {
        const server = verifier();
        const outcome = await provider(server.fetcher).login('code-1', true);

        const [call] = server.calls;
        expect(call?.url).toBe(`${VERIFIER}/token`);
        expect(Object.fromEntries(call?.body ?? [])).toMatchObject({
            grant_type: 'authorization_code',
            code: 'code-1',
            client_id: 'bae-client',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        });
        expect(call?.body.has('redirect_uri')).toBe(false);
        expect(checkedAssertion(call?.body.get('client_assertion') as string)).toMatchObject({
            iss: 'bae-client',
            sub: 'bae-client',
            aud: `${VERIFIER}/`
        });
        expect(outcome.tokens).toMatchObject({ refreshToken: 'refresh-1' });
        expect(outcome.claims.id).toBe('did:key:ana');
    });

    it('exchanges the code that the verifier told the proxy as v11 did, with the address and with no assertion', async () => {
        const server = verifier();
        await provider(server.fetcher).exchange('code-2', false);
        const [call] = server.calls;
        expect(Object.fromEntries(call?.body ?? [])).toEqual({
            grant_type: 'authorization_code',
            code: 'code-2',
            redirect_uri: CALLBACK
        });
    });

    it('does not tell what the verifier answered when it refuses the code, and takes an answer without token for a failure', async () => {
        const refused = await provider(
            verifier({ error: 'invalid_grant', error_description: 'secret-detail' }, 400).fetcher
        )
            .exchange('code', true)
            .catch((error: unknown) => error as Error);
        expect(refused).toBeInstanceOf(IdpError);
        expect((refused as Error).message).not.toContain('secret-detail');
        await expect(provider(verifier({}).fetcher).exchange('code', true)).rejects.toBeInstanceOf(IdpError);
    });

    it('refreshes with the refresh token and an assertion, and has no refresh token when the verifier gave none', async () => {
        const server = verifier({ access_token: 'new', refresh_token: 'refresh-2', expires_in: 60 });
        expect(await provider(server.fetcher).refresh('refresh-1')).toMatchObject({
            accessToken: 'new',
            refreshToken: 'refresh-2'
        });
        expect(server.calls[0]?.body.get('grant_type')).toBe('refresh_token');
        expect(server.calls[0]?.body.get('refresh_token')).toBe('refresh-1');
        expect(server.calls[0]?.body.has('client_assertion')).toBe(true);

        const bare = await provider(verifier({ access_token: verifierToken(LEAR_EMPLOYEE) }).fetcher).exchange(
            'code',
            true
        );
        expect(bare.refreshToken).toBeUndefined();
    });
});

describe('VcProvider: the request of the wallet', () => {
    it('is signed with the key of the proxy and says what the proxy asks of the user', () => {
        const request = provider(verifier().fetcher).requestObject();
        const header = jwt.decode(request, { complete: true })?.header;
        expect(header).toMatchObject({ alg: 'ES256', kid: 'bae-client' });
        expect(jwt.verify(request, proxyKeys.publicKey, { algorithms: ['ES256'] })).toMatchObject({
            iss: 'bae-client',
            aud: `${VERIFIER}/`,
            response_type: 'code',
            client_id: 'bae-client',
            redirect_uri: CALLBACK,
            scope: 'openid learcredential'
        });
    });

    it('does not let out what the library says when it cannot sign', () => {
        const failing = provider(verifier().fetcher, { signAlgorithm: 'RS256' });
        expect(() => failing.requestObject()).toThrow('could not sign');
    });
});
