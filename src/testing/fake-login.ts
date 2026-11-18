import type { IncomingMessage } from 'node:http';
import type { LegacyMiddleware } from '../legacy/legacy-auth.bridge';

const USERS: Record<string, object> = {
    ana: { id: 'u-ana', username: 'ana', email: 'ana@example.org', partyId: 'p-ana', roles: [{ name: 'Buyer' }], accessToken: 'ana' },
    root: { id: 'u-root', username: 'root', email: 'root@example.org', partyId: 'p-root', roles: [{ name: 'admin' }], accessToken: 'root' },
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
    }
};

/** Stands for the legacy authentication: the tokens `Bearer ana`, `Bearer root` and `Bearer acme` are users, anything else is nobody. */
export const fakeLogin: LegacyMiddleware = (req: IncomingMessage & { user?: object }, _res, next) => {
    const token = /^Bearer (\w+)$/.exec(req.headers.authorization ?? '')?.[1];
    const user = token === undefined ? undefined : USERS[token];
    if (user !== undefined) {
        req.user = { ...user };
    }
    next();
};

export const LOGGED_IN = { authorization: 'Bearer ana' };
export const AS_ADMIN = { authorization: 'Bearer root' };
export const AS_ORGANISATION = { authorization: 'Bearer acme' };
