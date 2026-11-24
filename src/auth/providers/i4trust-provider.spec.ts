import { describe, expect, it } from 'vitest';
import { I4TrustProvider } from './i4trust-provider';
import { IdpError } from './idp-http';

const jwt = (claims: object): string => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const provider = new I4TrustProvider({ id: 'idp-eori-1', roles: { seller: 'Seller', customer: 'Buyer', orgAdmin: 'orgAdmin' } });

describe('I4TrustProvider', () => {
    it('reads the user of the ID token of a login, who is a seller and the administrator of the organisation of the identity provider', () => {
        const claims = provider.claimsFromIdToken(jwt({ sub: 'EU.EORI.1', preferred_username: 'ana', displayName: 'Ana López', email: 'ana@example.org', exp: 2_000_000_000 }));

        expect(claims).toEqual({
            id: 'EU.EORI.1',
            username: 'ana',
            displayName: 'Ana López',
            email: 'ana@example.org',
            roles: [{ id: 'Seller', name: 'Seller' }],
            organizations: [
                {
                    id: 'idp-eori-1',
                    name: 'idp-eori-1',
                    roles: [
                        { id: 'Seller', name: 'Seller' },
                        { id: 'Buyer', name: 'Buyer' },
                        { id: 'orgAdmin', name: 'orgAdmin' }
                    ]
                }
            ],
            expire: 2_000_000_000
        });
    });

    it('names a user without username after the display name, or the id', () => {
        expect(provider.claimsFromIdToken(jwt({ sub: 'u1', displayName: 'Ana' })).username).toBe('Ana');
        expect(provider.claimsFromIdToken(jwt({ sub: 'u1' })).username).toBe('u1');
    });

    it('refuses a token without a user, and one that is not a JWT', () => {
        expect(() => provider.claimsFromIdToken(jwt({ preferred_username: 'ana' }))).toThrow(IdpError);
        expect(() => provider.claimsFromIdToken('not-a-jwt')).toThrow(IdpError);
    });

    it('does not accept a token that somebody presents without the keys of the identity provider, which v11 decoded without checking who signed it', async () => {
        await expect(provider.claimsOf(jwt({ sub: 'admin' }))).rejects.toBeInstanceOf(IdpError);
    });

    it('accepts a presented token that the keys of the identity provider sign, and only that', async () => {
        const claims = { sub: 'EU.EORI.1', preferred_username: 'ana' };
        const withKeys = new I4TrustProvider({
            id: 'idp-eori-1',
            roles: { seller: 'Seller', customer: 'Buyer', orgAdmin: 'orgAdmin' },
            verifier: { verify: async (token: string) => (token === 'signed' ? claims : Promise.reject(new IdpError('bad signature'))) } as never
        });

        expect((await withKeys.claimsOf('signed')).id).toBe('EU.EORI.1');
        await expect(withKeys.claimsOf(jwt({ sub: 'admin' }))).rejects.toBeInstanceOf(IdpError);
    });

    it('does not refresh', async () => {
        await expect(provider.refresh()).rejects.toBeInstanceOf(IdpError);
    });
});
