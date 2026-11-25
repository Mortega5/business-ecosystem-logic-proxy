import type { INestApplicationContext } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { RequestAuthenticator, type AuthenticatedUser } from '../auth/request-authenticator';

const USERS: Record<string, object> = {
    ana: {
        id: 'u-ana',
        username: 'ana',
        email: 'ana@example.org',
        partyId: 'p-ana',
        roles: [{ name: 'Buyer' }],
        accessToken: 'ana'
    },
    root: {
        id: 'u-root',
        username: 'root',
        email: 'root@example.org',
        partyId: 'p-root',
        roles: [{ name: 'admin' }],
        accessToken: 'root'
    },
    // Ana acting for an organisation
    acme: {
        id: 'org-acme',
        userId: 'u-ana',
        username: 'acme',
        email: 'acme@example.org',
        partyId: 'p-acme',
        userPartyId: 'p-ana',
        roles: [{ name: 'orgAdmin' }],
        accessToken: 'acme'
    },
    seller: {
        id: 'u-sam',
        username: 'sam',
        email: 'sam@example.org',
        partyId: 'p-shop',
        roles: [{ name: 'Seller' }],
        accessToken: 'seller'
    },
    // A member of the same organisation with no role to manage it
    member: {
        id: 'org-acme',
        userId: 'u-bob',
        username: 'acme',
        email: 'acme@example.org',
        partyId: 'p-acme',
        userPartyId: 'p-bob',
        roles: [{ name: 'Buyer' }],
        accessToken: 'member'
    }
};

/** Stands for the authentication: the tokens `Bearer ana`, `Bearer root`, `Bearer acme`, `Bearer member` and `Bearer seller` are users, any other request has no user. */
const fakeUser = (req: IncomingMessage): AuthenticatedUser | undefined => {
    const token = /^Bearer (\w+)$/.exec(req.headers.authorization ?? '')?.[1];
    const user = token === undefined ? undefined : USERS[token];
    return user === undefined ? undefined : ({ ...user } as unknown as AuthenticatedUser);
};

/** Puts the fake users where the real authentication is, for an application that has the authentication module. */
export const useFakeLogin = (app: INestApplicationContext): void => {
    (
        app.get(RequestAuthenticator) as {
            authenticate: (req: IncomingMessage) => Promise<AuthenticatedUser | undefined>
        }
    ).authenticate = (req) => Promise.resolve(fakeUser(req));
};

export const LOGGED_IN = { authorization: 'Bearer ana' };
export const AS_ADMIN = { authorization: 'Bearer root' };
export const AS_ORGANISATION = { authorization: 'Bearer acme' };
export const AS_MEMBER = { authorization: 'Bearer member' };
export const AS_SELLER = { authorization: 'Bearer seller' };
