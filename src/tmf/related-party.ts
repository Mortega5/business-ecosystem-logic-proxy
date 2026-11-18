import type { Request } from 'express';
import { ForbiddenError } from '../common/domain-error';
import type { UpstreamUser } from './upstream-headers';

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The party of the caller: the individual's or, when acting for an organisation, the organisation's. */
export const callerParty = (req: Request, refusal: string): string => {
    const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
    if (typeof partyId !== 'string' || partyId === '') {
        throw new ForbiddenError(refusal);
    }
    return partyId;
};

const isParty = (party: unknown, partyId: string, role: string): boolean =>
    isRecord(party) && party['id'] === partyId && typeof party['role'] === 'string' && party['role'].toLowerCase() === role.toLowerCase();

/** Whether the party is among the related parties of the resource in the given role. */
export const isRelatedAs = (resource: unknown, partyId: string, role: string): boolean => {
    const parties = isRecord(resource) ? resource['relatedParty'] : undefined;
    return Array.isArray(parties) && parties.some((party: unknown) => isParty(party, partyId, role));
};

/** Whether the related parties of the resource are the party in the given role and nobody else. */
export const isOwnedOnlyBy = (resource: unknown, partyId: string, role: string): boolean => {
    const parties = isRecord(resource) ? resource['relatedParty'] : undefined;
    return Array.isArray(parties) && parties.length > 0 && parties.every((party: unknown) => isParty(party, partyId, role));
};
