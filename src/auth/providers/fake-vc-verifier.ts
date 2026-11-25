import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

// A verifier of credentials and the key of the proxy, for the tests of the login with a wallet

const pair = (): { publicKey: KeyObject, privateKey: KeyObject } => generateKeyPairSync('ec', { namedCurve: 'P-256' });

/** The keys with which the verifier signs its tokens, and the document that publishes them. */
export const verifierKeys = pair();
export const VERIFIER_KID = 'verifier-key-1';
export const jwksDocument = (): object => ({
    keys: [{ ...verifierKeys.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'ES256', kid: VERIFIER_KID }]
});

/** The key of the proxy, as its 32 bytes in hexadecimal (what the setting takes) and as the public key that checks what it signs. */
export const proxyKeys = pair();
export const proxyKeyHex = (): string =>
    Buffer.from(proxyKeys.privateKey.export({ format: 'jwk' }).d as string, 'base64url').toString('hex');

/** A token that the verifier signs, with the credential in the payload. */
export const verifierToken = (
    payload: Record<string, unknown>,
    options: { kid?: string | undefined, expiresInSeconds?: number } = {}
): string => {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iat: now, exp: now + (options.expiresInSeconds ?? 300), ...payload }, verifierKeys.privateKey, {
        algorithm: 'ES256',
        ...(options.kid === undefined && 'kid' in options ? {} : { keyid: options.kid ?? VERIFIER_KID })
    });
};

/** What a verifier checks of the proxy: the assertion it sends is signed with its key. */
export const checkedAssertion = (assertion: string): Record<string, unknown> =>
    jwt.verify(assertion, proxyKeys.publicKey, { algorithms: ['ES256'] }) as Record<string, unknown>;

export const LEAR_EMPLOYEE = {
    verifiableCredential: {
        type: ['VerifiableCredential', 'LEARCredentialEmployee'],
        issuer: { id: 'did:elsi:VATES-ISSUER' },
        credentialSubject: {
            mandate: {
                mandator: { organizationIdentifier: 'VATES-A12345678', organization: 'Acme', country: 'ES' },
                mandatee: { id: 'did:key:ana', email: 'ana@acme.example.org', first_name: 'Ana', last_name: 'López' },
                power: [
                    { function: 'Onboarding', action: 'Execute' },
                    { function: 'ProductOffering', action: ['Create', 'Update', 'Delete'] }
                ]
            }
        }
    }
};
