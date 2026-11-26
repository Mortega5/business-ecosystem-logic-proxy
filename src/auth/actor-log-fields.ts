import type { Bindings } from 'pino';
import type { AuthenticatedUser } from './request-authenticator';

/**
 * What every log line of a request says about who makes it: the person, and the organisation only when they act for one.
 * Ids only: neither a name nor an email goes to the logs.
 */
export const actorLogFields = (user: AuthenticatedUser): Bindings =>
    'userId' in user
        ? { userId: user.userId, partyId: user.userPartyId, organizationId: user.id }
        : { userId: user.id, partyId: user.partyId };
