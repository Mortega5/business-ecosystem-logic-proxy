import type { IdentityClaims } from '../profile/user-profile';

export interface IdentityTokens {
    accessToken: string;
    refreshToken?: string;
    /** Unix seconds. */
    expire?: number;
}

/**
 * What the proxy needs from an identity provider once a user has a token, whichever protocol the provider speaks. Providers throw
 * when the token is not valid or the provider cannot be reached; the proxy decides what the client is told.
 */
export interface IdentityProvider {
    /** `local` for the main provider, or the id of an external one. */
    readonly id: string;

    /** Who the access token belongs to, asked to the provider (or checked against its keys). */
    claimsOf(accessToken: string): Promise<IdentityClaims>;

    /** New tokens for a refresh token, which can be used once. */
    refresh(refreshToken: string): Promise<IdentityTokens>;
}
