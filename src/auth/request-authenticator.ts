import { Injectable } from '@nestjs/common';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { UnauthorizedError } from '../common/domain-error';
import { ProfileService } from './profile/profile.service';
import type { ProfileRole, UserProfile } from './profile/user-profile';

/** A user acting for an organisation they belong to: the organisation is who makes the request, and the user is behind it. */
export interface OrganizationActor {
    id: string;
    userId: string;
    userPartyId: string;
    partyId: string | undefined;
    roles: ProfileRole[];
    displayName: string;
    email: string;
    accessToken: string;
    refreshToken: string;
    idp: string;
}

export type AuthenticatedUser = UserProfile | OrganizationActor;

type RequestWithSession = IncomingMessage & { session?: { accessToken?: string } };

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
};

/** The token the request carries: `X-Auth-Token`, or `Authorization: Bearer`. Another kind of authorization is refused. */
const tokenOf = (headers: IncomingHttpHeaders): string | undefined => {
    const own = header(headers, 'x-auth-token');
    if (own !== undefined) {
        return own;
    }
    const authorization = header(headers, 'authorization');
    if (authorization === undefined) {
        return undefined;
    }
    const [scheme = '', token] = authorization.split(' ');
    if (scheme.toLowerCase() !== 'bearer') {
        throw new UnauthorizedError(`Invalid Auth-Token type (${scheme.toLowerCase()})`);
    }
    // `Bearer` with nothing after it is a token that is empty, not a request without one
    return token ?? '';
};

/**
 * Who makes a request: the token of the headers, or else the one the session of the browser keeps. A token that is not valid is
 * a 401, never an anonymous request. `X-Organization` makes the user act for one of their organisations.
 */
@Injectable()
export class RequestAuthenticator {
    constructor(private readonly profiles: ProfileService) {}

    /** The user, or undefined when the request carries no identity. */
    async authenticate(req: RequestWithSession): Promise<AuthenticatedUser | undefined> {
        const token = tokenOf(req.headers) ?? req.session?.accessToken;
        if (token === undefined) {
            return undefined;
        }
        if (token === '') {
            throw new UnauthorizedError('It has not been possible to obtain your user info');
        }
        return this.actingAs(await this.profiles.authenticate(token), header(req.headers, 'x-organization'));
    }

    private actingAs(profile: UserProfile, organizationId: string | undefined): AuthenticatedUser {
        if (organizationId === undefined || organizationId === '') {
            return profile;
        }
        const organization = profile.organizations.find((candidate) => candidate.id === organizationId);
        if (organization === undefined) {
            throw new UnauthorizedError('You are not allowed to act on behalf the provided organization');
        }
        return {
            id: organization.id,
            userId: profile.id,
            userPartyId: profile.partyId,
            partyId: organization.partyId,
            roles: organization.roles,
            displayName: organization.name,
            email: `${organization.id}@emailnotusable.com`,
            accessToken: profile.accessToken,
            refreshToken: profile.refreshToken,
            idp: profile.idp
        };
    }
}
