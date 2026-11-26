import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { UpstreamClient } from '../../http-client/upstream-client';
import { normalizeCountry } from './countries';
import { SingleFlight } from './single-flight';
import type { IdentityClaims, ProfileOrganization } from './user-profile';

type Json = Record<string, unknown>;

const PARTY = 'tmforum.party' as const;
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

const idOf = (party: unknown): string => {
    const id = typeof party === 'object' && party !== null ? (party as Json)['id'] : undefined;
    if (typeof id !== 'string' || id === '') {
        throw new Error('TMForum answered a party without id');
    }
    return id;
};

const characteristic = (name: string, value: string): Json => ({ name, value, valueType: 'String' });

/** What the identity provider says about a person that goes to their individual. */
const changesOf = (claims: IdentityClaims): Json => {
    const characteristics = [
        claims.academicTitle === undefined ? undefined : characteristic('academicTitle', claims.academicTitle),
        claims.language === undefined ? undefined : characteristic('language', claims.language),
        claims.pictureUrl === undefined ? undefined : characteristic('pictureUrl', claims.pictureUrl)
    ].filter((entry) => entry !== undefined);
    return {
        ...(claims.givenName ? { givenName: claims.givenName } : {}),
        ...(claims.familyName ? { familyName: claims.familyName } : {}),
        ...(claims.gender ? { gender: claims.gender } : {}),
        ...(characteristics.length > 0 ? { partyCharacteristic: characteristics } : {})
    };
};

/**
 * The parties of TMForum behind a user: their individual and the organisations they act for, created the first time they are seen.
 * Two requests of a person who is not known yet share the work, so the same person is not created twice by this process.
 */
@Injectable()
export class PartyRegistry {
    private readonly individuals = new SingleFlight<string>();
    private readonly organizations = new SingleFlight<Json>();

    constructor(
        private readonly upstream: UpstreamClient,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(PartyRegistry.name);
    }

    /** The id of the individual of the user: found by their id in the identity provider, or created. */
    individualFor(claims: IdentityClaims): Promise<string> {
        return this.individuals.run(claims.id, () => this.findOrCreateIndividual(claims));
    }

    /** The trading name that TMForum has for the organisation known by `group`, if it has one. */
    async organizationName(group: string): Promise<string | undefined> {
        const found = await this.upstream.json<unknown>({ upstream: PARTY, path: '/organization', query: { 'externalReference.name': group } });
        const name = Array.isArray(found) ? (found[0] as Json | undefined)?.['tradingName'] : undefined;
        return typeof name === 'string' && name !== '' ? name : undefined;
    }

    /**
     * The organisations of the user with their party ids, created when they do not exist. The individual is told which role the person
     * has in each of them.
     */
    async organizationsFor(claims: IdentityClaims, individualId: string): Promise<ProfileOrganization[]> {
        const parties = await Promise.all(claims.organizations.map((org) => this.organizations.run(org.id, () => this.findOrCreateOrganization(org))));
        if (parties.length > 0) {
            const relatedParty = parties.map((party, index) => ({
                id: idOf(party),
                name: party['tradingName'],
                href: party['href'],
                role: (claims.organizations[index]?.roles ?? []).map((role) => role.name).join(',')
            }));
            await this.send('PATCH', `/individual/${individualId}`, { relatedParty });
        }
        return claims.organizations.map((org, index) => ({ ...org, partyId: idOf(parties[index]) }));
    }

    private async findOrCreateIndividual(claims: IdentityClaims): Promise<string> {
        const found = await this.upstream.json<unknown>({ upstream: PARTY, path: '/individual', query: { 'externalReference.name': claims.id } });
        const existing = Array.isArray(found) ? (found as unknown[])[0] : undefined;
        if (existing !== undefined) {
            const id = idOf(existing);
            const changes = changesOf(claims);
            // With the editing of the profile off, the identity provider is the only source of these data
            if (!this.config.party.editEnabled && Object.keys(changes).length > 0) {
                await this.send('PATCH', `/individual/${id}`, changes);
            }
            return id;
        }

        const name = claims.displayName || claims.username;
        const created = await this.send('POST', '/individual', {
            birthDate: '',
            contactMedium: [],
            countryOfBirth: '',
            familyName: name,
            gender: '',
            givenName: name,
            maritalStatus: '',
            nationality: '',
            placeOfBirth: '',
            title: '',
            partyCharacteristic: [],
            externalReference: [{ externalReferenceType: 'idm_id', name: claims.id }],
            ...changesOf(claims)
        });
        this.logger.info({ userId: claims.id, partyId: idOf(created) }, 'The individual of a user was created');
        return idOf(created);
    }

    private async findOrCreateOrganization(org: ProfileOrganization): Promise<Json> {
        const found = await this.upstream.json<unknown>({ upstream: PARTY, path: '/organization', query: { 'externalReference.name': org.id } });
        const existing = Array.isArray(found) ? (found[0] as Json | undefined) : undefined;
        const country = org.country ? normalizeCountry(org.country) : undefined;

        if (existing === undefined) {
            const created = await this.send('POST', '/organization', {
                tradingName: org.name,
                externalReference: [{ externalReferenceType: 'idm_id', name: org.id }],
                ...(country === undefined ? {} : { partyCharacteristic: [{ name: 'country', value: country }] })
            });
            this.logger.info({ organizationId: org.id, partyId: idOf(created) }, 'An organisation of a user was created');
            return created;
        }

        const characteristics = Array.isArray(existing['partyCharacteristic']) ? (existing['partyCharacteristic'] as Json[]) : [];
        if (country !== undefined && !characteristics.some((entry) => entry['name'] === 'country')) {
            await this.send('PATCH', `/organization/${idOf(existing)}`, { partyCharacteristic: [...characteristics, { name: 'country', value: country }] });
        }
        return existing;
    }

    private async send(method: string, path: string, body: Json): Promise<Json> {
        return this.upstream.json<Json>({ upstream: PARTY, path, method, headers: JSON_HEADERS, body: JSON.stringify(body) });
    }
}
