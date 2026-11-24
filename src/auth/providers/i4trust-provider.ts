import type { IdentityClaims } from '../profile/user-profile';
import type { IdentityProvider, IdentityTokens } from './identity-provider';
import { IdpError } from './idp-http';
import { jwtPayload } from './jwt-payload';
import type { JwksVerifier } from './jwks-verifier';

export interface I4TrustOptions {
    /** The id the identity provider is registered under: the organisation of its users is named after it. */
    id: string;
    /** Names of the roles of the platform. */
    roles: { seller: string; customer: string; orgAdmin: string };
    /** The keys of the identity provider. Without them a token that somebody presents is not accepted. */
    verifier?: JwksVerifier;
}

/**
 * i4Trust (iSHARE). The user is read from the ID token that the token endpoint gives in the answer to the code, which arrives over
 * TLS from the identity provider itself; that is the only place an identity is taken from. A token that somebody presents later is
 * not accepted unless the keys of the identity provider are configured and sign it: v11 decoded it without checking its signature,
 * so anybody could write the user they wanted in one. Every user is a
 * seller and the administrator of one organisation named after the identity provider.
 */
export class I4TrustProvider implements IdentityProvider {
    readonly id: string;

    constructor(private readonly options: I4TrustOptions) {
        this.id = options.id;
    }

    /** The claims of the ID token of a login. The signature is not checked: the token came from the token endpoint. */
    claimsFromIdToken(idToken: string): IdentityClaims {
        return this.claimsFrom(jwtPayload(idToken));
    }

    private claimsFrom(token: Record<string, unknown> | undefined): IdentityClaims {
        const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
        const id = text(token?.['sub']);
        if (token === undefined || id === undefined) {
            throw new IdpError('The ID token has no user');
        }
        const { seller, customer, orgAdmin } = this.options.roles;
        const username = text(token['preferred_username']) ?? text(token['displayName']) ?? id;
        const displayName = text(token['displayName']);
        const email = text(token['email']);

        return {
            id,
            username,
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            roles: [{ id: seller, name: seller }],
            organizations: [
                {
                    id: this.id,
                    name: this.id,
                    roles: [seller, customer, orgAdmin].map((role) => ({ id: role, name: role }))
                }
            ],
            ...(typeof token['exp'] === 'number' ? { expire: token['exp'] } : {})
        };
    }

    /** A token that somebody presents: accepted only when its signature is checked against the keys of the identity provider. */
    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        if (this.options.verifier === undefined) {
            throw new IdpError('An i4Trust token is only accepted from a login');
        }
        return this.claimsFrom(await this.options.verifier.verify(accessToken));
    }

    refresh(): Promise<IdentityTokens> {
        return Promise.reject(new IdpError('i4Trust tokens are not refreshed'));
    }
}
