import { describe, expect, it } from 'vitest';
import { actorLogFields } from './actor-log-fields';
import type { OrganizationActor } from './request-authenticator';
import type { UserProfile } from './profile/user-profile';

describe('actorLogFields', () => {
    it('gives the user and their party when they act for themselves', () => {
        const profile = { id: 'u1', partyId: 'urn:party:u1', email: 'a@b.c' } as UserProfile;
        expect(actorLogFields(profile)).toEqual({ userId: 'u1', partyId: 'urn:party:u1' });
    });

    it('gives the person behind the organisation, and the organisation apart', () => {
        const actor = {
            id: 'org-1',
            partyId: 'urn:party:org',
            userId: 'u1',
            userPartyId: 'urn:party:u1',
            email: 'org-1@emailnotusable.com'
        } as OrganizationActor;
        expect(actorLogFields(actor)).toEqual({ userId: 'u1', partyId: 'urn:party:u1', organizationId: 'org-1' });
    });
});
