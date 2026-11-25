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

/** What a login has to remember between sending the user to the provider and getting them back. */
export interface LoginChecks {
    state: string;
    nonce: string;
    codeVerifier: string;
}

export interface LoginStart {
    /** Where the browser goes. */
    url: string;
    /** To keep in the session until the provider answers. */
    checks: LoginChecks;
}

/** The tokens a login got, with the ID token already checked (signature, issuer, audience, expiry and nonce) when there is one. */
export interface LoginResult extends IdentityTokens {
    idToken?: string;
}

/** What a login gives: the tokens and who they are for. */
export interface LoginOutcome {
    tokens: IdentityTokens;
    claims: IdentityClaims;
}

/** A provider the user can log in with (the authorization code flow). */
export interface LoginCapable {
    /** The URL to send the browser to, and what to keep until it comes back to `redirectUri`. */
    beginLogin(redirectUri: string): Promise<LoginStart>;

    /** Completes the login for the URL the browser came back to. Rejects when a check fails or the provider refuses. */
    finishLogin(callbackUrl: string, checks: LoginChecks): Promise<LoginOutcome>;
}
