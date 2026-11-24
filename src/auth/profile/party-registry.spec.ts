import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service';
import { UpstreamClient, UpstreamError, type UpstreamRequest, type UpstreamResponse } from '../../http-client/upstream-client';
import { PartyRegistry } from './party-registry';
import type { IdentityClaims } from './user-profile';

type Party = Record<string, unknown>;

/** The party API of TMForum, in memory: lookup by externalReference.name, create and patch. */
class FakeParty extends UpstreamClient {
    readonly calls: UpstreamRequest[] = [];
    readonly individuals: Party[] = [];
    readonly organizations: Party[] = [];
    failing = false;

    async send(request: UpstreamRequest): Promise<UpstreamResponse> {
        this.calls.push(request);
        await new Promise((resolve) => setImmediate(resolve));
        if (this.failing) {
            throw new UpstreamError('network', 'tmforum.party', 'down');
        }
        const kind = request.path.startsWith('/individual') ? 'individual' : 'organization';
        const list = kind === 'individual' ? this.individuals : this.organizations;
        const [, , id] = request.path.split('/');
        const method = request.method ?? 'GET';
        const body = typeof request.body === 'string' ? (JSON.parse(request.body) as Party) : {};
        const reply = (payload: unknown): UpstreamResponse => ({ status: 200, headers: new Headers(), body: JSON.stringify(payload) });

        if (method === 'GET') {
            const wanted = request.query?.['externalReference.name'];
            return reply(list.filter((party) => (party['externalReference'] as { name: string }[]).some((reference) => reference.name === wanted)));
        }
        if (method === 'POST') {
            const party = { id: `urn:ngsi-ld:${kind}:${list.length + 1}`, href: `urn:ngsi-ld:${kind}:${list.length + 1}`, ...body };
            list.push(party);
            return reply(party);
        }
        const party = list.find((candidate) => candidate['id'] === id) as Party;
        Object.assign(party, body);
        return reply(party);
    }

    writes(): string[] {
        return this.calls.filter((call) => call.method !== undefined && call.method !== 'GET').map((call) => `${call.method} ${call.path}`);
    }
}

const logger = { setContext: () => undefined, info: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as PinoLogger;
const registry = (tmforum: FakeParty, editEnabled = true): PartyRegistry =>
    new PartyRegistry(tmforum, { party: { editEnabled } } as AppConfigService, logger);

const ana: IdentityClaims = { id: 'idm-ana', username: 'ana', displayName: 'Ana López', roles: [], organizations: [] };

describe('PartyRegistry: the individual', () => {
    it('creates the individual of a person that TMForum does not know, named after them', async () => {
        const tmforum = new FakeParty();

        const id = await registry(tmforum).individualFor({ ...ana, givenName: 'Ana', familyName: 'López', language: 'es' });

        expect(id).toBe('urn:ngsi-ld:individual:1');
        expect(tmforum.individuals[0]).toMatchObject({
            givenName: 'Ana',
            familyName: 'López',
            externalReference: [{ externalReferenceType: 'idm_id', name: 'idm-ana' }],
            partyCharacteristic: [{ name: 'language', value: 'es', valueType: 'String' }]
        });
    });

    it('uses the display name for both names when the provider gives no others, and the username when there is no display name', async () => {
        const tmforum = new FakeParty();

        await registry(tmforum).individualFor(ana);
        await registry(tmforum).individualFor({ ...ana, id: 'idm-bob', username: 'bob', displayName: undefined as never });

        expect(tmforum.individuals[0]).toMatchObject({ givenName: 'Ana López', familyName: 'Ana López' });
        expect(tmforum.individuals[1]).toMatchObject({ givenName: 'bob', familyName: 'bob' });
    });

    it('looks the person up by the id in the identity provider as a parameter, never glued in the path', async () => {
        const tmforum = new FakeParty();

        await registry(tmforum).individualFor({ ...ana, id: 'a&b=c' });

        expect(tmforum.calls[0]).toMatchObject({ path: '/individual', query: { 'externalReference.name': 'a&b=c' } });
    });

    it('does not create the individual again once it exists', async () => {
        const tmforum = new FakeParty();
        await registry(tmforum).individualFor(ana);

        expect(await registry(tmforum).individualFor(ana)).toBe('urn:ngsi-ld:individual:1');
        expect(tmforum.writes()).toEqual(['POST /individual']);
    });

    it('creates one individual when the same unknown person arrives in several requests at once', async () => {
        const tmforum = new FakeParty();
        const parties = registry(tmforum);

        const ids = await Promise.all([parties.individualFor(ana), parties.individualFor(ana), parties.individualFor(ana)]);

        expect(new Set(ids).size).toBe(1);
        expect(tmforum.individuals).toHaveLength(1);
    });

    it('updates what the provider says when the profile cannot be edited in the portal, and only then', async () => {
        const editable = new FakeParty();
        const locked = new FakeParty();
        for (const tmforum of [editable, locked]) {
            await registry(tmforum).individualFor(ana);
        }

        await registry(editable, true).individualFor({ ...ana, givenName: 'Anita' });
        await registry(locked, false).individualFor({ ...ana, givenName: 'Anita' });

        expect(editable.writes()).toEqual(['POST /individual']);
        expect(locked.writes()).toEqual(['POST /individual', 'PATCH /individual/urn:ngsi-ld:individual:1']);
        expect(locked.individuals[0]).toMatchObject({ givenName: 'Anita' });
    });

    it('does not hide that TMForum is down', async () => {
        const tmforum = new FakeParty();
        tmforum.failing = true;

        await expect(registry(tmforum).individualFor(ana)).rejects.toBeInstanceOf(UpstreamError);
    });
});

describe('PartyRegistry: the organisations', () => {
    const withOrganizations = (...organizations: IdentityClaims['organizations']): IdentityClaims => ({ ...ana, organizations });

    it('creates the organisations and tells the individual the role of the person in each', async () => {
        const tmforum = new FakeParty();
        const parties = registry(tmforum);
        const claims = withOrganizations({ id: 'org-1', name: 'Acme', country: 'Spain', roles: [{ name: 'seller' }, { name: 'orgAdmin' }] });
        const individual = await parties.individualFor(claims);

        const organizations = await parties.organizationsFor(claims, individual);

        expect(organizations).toEqual([{ id: 'org-1', name: 'Acme', country: 'Spain', roles: [{ name: 'seller' }, { name: 'orgAdmin' }], partyId: 'urn:ngsi-ld:organization:1' }]);
        expect(tmforum.organizations[0]).toMatchObject({ tradingName: 'Acme', partyCharacteristic: [{ name: 'country', value: 'ES' }] });
        expect(tmforum.individuals[0]).toMatchObject({
            relatedParty: [{ id: 'urn:ngsi-ld:organization:1', name: 'Acme', role: 'seller,orgAdmin' }]
        });
    });

    it('adds the country to an organisation that has none, and leaves one that has it', async () => {
        const tmforum = new FakeParty();
        tmforum.organizations.push(
            { id: 'urn:ngsi-ld:organization:9', externalReference: [{ name: 'org-1' }], tradingName: 'Acme' },
            { id: 'urn:ngsi-ld:organization:8', externalReference: [{ name: 'org-2' }], tradingName: 'Beta', partyCharacteristic: [{ name: 'country', value: 'FR' }] }
        );
        const parties = registry(tmforum);
        const claims = withOrganizations(
            { id: 'org-1', name: 'Acme', country: 'Italy', roles: [] },
            { id: 'org-2', name: 'Beta', country: 'Italy', roles: [] }
        );

        await parties.organizationsFor(claims, await parties.individualFor(claims));

        expect(tmforum.organizations[0]).toMatchObject({ partyCharacteristic: [{ name: 'country', value: 'IT' }] });
        expect(tmforum.organizations[1]).toMatchObject({ partyCharacteristic: [{ name: 'country', value: 'FR' }] });
    });

    it('creates an organisation once when two people of it arrive at once', async () => {
        const tmforum = new FakeParty();
        const parties = registry(tmforum);
        const organization = { id: 'org-1', name: 'Acme', roles: [{ name: 'seller' }] };
        const bob = { ...ana, id: 'idm-bob', username: 'bob', organizations: [organization] };
        const claims = withOrganizations(organization);

        await Promise.all([
            parties.individualFor(claims).then((id) => parties.organizationsFor(claims, id)),
            parties.individualFor(bob).then((id) => parties.organizationsFor(bob, id))
        ]);

        expect(tmforum.organizations).toHaveLength(1);
    });

    it('does nothing to the individual when the person has no organisations', async () => {
        const tmforum = new FakeParty();
        const parties = registry(tmforum);

        expect(await parties.organizationsFor(ana, await parties.individualFor(ana))).toEqual([]);
        expect(tmforum.writes()).toEqual(['POST /individual']);
    });
});
