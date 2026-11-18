import type { IncomingMessage } from 'node:http';
import type { LegacyMiddleware } from '../legacy/legacy-auth.bridge';

/** Stands for the legacy authentication: the token `Bearer ana` is a user, anything else is nobody. */
export const fakeLogin: LegacyMiddleware = (req: IncomingMessage & { user?: object }, _res, next) => {
    if (req.headers.authorization === 'Bearer ana') {
        req.user = {
            id: 'u-ana',
            username: 'ana',
            email: 'ana@example.org',
            partyId: 'p-ana',
            roles: [{ name: 'Buyer' }],
            accessToken: 'ana'
        };
    }
    next();
};

export const LOGGED_IN = { authorization: 'Bearer ana' };
