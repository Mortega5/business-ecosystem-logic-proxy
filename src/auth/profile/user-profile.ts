export interface ProfileRole {
    id?: string;
    name: string;
}

export interface ProfileOrganization {
    id: string;
    name: string;
    roles: ProfileRole[];
    country?: string;
    /** Id of the organisation in TMForum; set when the profile is completed. */
    partyId?: string;
}

/** What an identity provider says about a user, whatever the provider. */
export interface IdentityClaims {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
    roles: ProfileRole[];
    organizations: ProfileOrganization[];
    givenName?: string;
    familyName?: string;
    gender?: string;
    academicTitle?: string;
    language?: string;
    pictureUrl?: string;
    /** Unix seconds at which the access token ends, when the provider knows it. */
    expire?: number;
    issuerDid?: string;
}

/**
 * The user once the proxy has completed the claims: tokens, the identity provider they came from and their party in TMForum.
 * It is what is cached by access token, and a superset of the `UpstreamUser` the upstream headers are built from.
 */
export interface UserProfile extends IdentityClaims {
    displayName: string;
    accessToken: string;
    /** Empty when the token came from an API client that never logged in: it cannot be refreshed. */
    refreshToken: string;
    /** Unix seconds. */
    expire: number;
    /** `local` for the main identity provider, or the id of an external one. */
    idp: string;
    partyId: string;
}

export const isUserProfile = (value: unknown): value is UserProfile =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UserProfile).accessToken === 'string' &&
    typeof (value as UserProfile).expire === 'number' &&
    typeof (value as UserProfile).idp === 'string' &&
    typeof (value as UserProfile).partyId === 'string' &&
    Array.isArray((value as UserProfile).organizations);
