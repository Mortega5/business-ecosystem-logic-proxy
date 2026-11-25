import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

// A provider that speaks OpenID Connect, for the tests of the logins
export const ISSUER = 'https://idp.example.org/realms/bae';
export const REDIRECT = 'https://bae.example.org/auth/keycloak/callback';
const { publicKey, privateKey }: { publicKey: KeyObject, privateKey: KeyObject } = generateKeyPairSync('rsa', {
    modulusLength: 2048
});

/** A provider with its discovery document, its keys and a token endpoint that answers what the test sets. */
export const fakeIdp = () => {
    const state = {
        tokenRequests: [] as { headers: Headers, body: URLSearchParams }[],
        tokenStatus: 200,
        idTokenClaims: {} as Record<string, unknown>
    };
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const json = (body: unknown, status = 200) =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
            );
        if (url.pathname.endsWith('/.well-known/openid-configuration')) {
            return json({
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
                token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
                jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
                id_token_signing_alg_values_supported: ['RS256']
            });
        }
        if (url.pathname.endsWith('/userinfo')) {
            return json({ sub: 'u1', preferred_username: 'ana' });
        }
        if (url.pathname.endsWith('/certs')) {
            return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'k1' }] });
        }
        if (url.pathname.endsWith('/token')) {
            const request = input instanceof Request ? input : new Request(url, init);
            return request.text().then((text) => {
                state.tokenRequests.push({ headers: request.headers, body: new URLSearchParams(text) });
                if (state.tokenStatus !== 200) {
                    return json({ error: 'invalid_grant', error_description: 'secret-detail' }, state.tokenStatus);
                }
                const now = Math.floor(Date.now() / 1000);
                const idToken = jwt.sign(
                    { iss: ISSUER, aud: 'bae', sub: 'u1', iat: now, exp: now + 300, ...state.idTokenClaims },
                    privateKey,
                    {
                        algorithm: 'RS256',
                        keyid: 'k1'
                    }
                );
                return json({
                    access_token: 'at',
                    refresh_token: 'rt',
                    token_type: 'Bearer',
                    expires_in: 600,
                    id_token: idToken
                });
            });
        }
        return json({}, 404);
    };
    return { state, fetcher };
};
