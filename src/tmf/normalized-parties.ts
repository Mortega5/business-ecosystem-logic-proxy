import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { BadGatewayError } from '../common/domain-error';
import { isRecord } from './related-party';
import { isResourceId } from './resource-id.pipe';
import { parseJson } from './specification/specifications';
import { TmfProxy } from './tmf-proxy';
import type { UpstreamUser } from './upstream-headers';

export interface PartyRef {
    id: string;
    href: string;
    role: string;
}

/**
 * A party as v11 wrote it in what it stored: its id and href, its role, whether it is an organisation or an individual, and its
 * name, which is the one the identity manager knows (the caller's own when it is the caller, and otherwise the party is read).
 */
@Injectable()
export class NormalizedParties {
    constructor(private readonly proxy: TmfProxy) {}

    async of(req: Request, user: UpstreamUser, party: PartyRef): Promise<Record<string, unknown>> {
        const organization = party.id.includes('organization');
        let name = '';
        if (party.id === user.partyId) {
            name = user.id;
        } else {
            if (!isResourceId(party.id)) {
                throw new BadGatewayError(`The party ${party.id} is not valid`);
            }
            const response = await this.proxy.send(req, { upstream: 'tmforum.party', path: `/${organization ? 'organization' : 'individual'}/${encodeURIComponent(party.id)}`, method: 'GET', search: '' });
            const found = parseJson(response.body);
            if (response.status >= 400 || !isRecord(found)) {
                throw new BadGatewayError(`The party ${party.id} could not be read`);
            }
            const references = Array.isArray(found['externalReference']) ? found['externalReference'] : [];
            const reference: unknown = references.find((candidate) => isRecord(candidate) && typeof candidate['externalReferenceType'] === 'string' && candidate['externalReferenceType'].toLowerCase() === 'idm_id');
            name = isRecord(reference) && typeof reference['name'] === 'string' ? reference['name'] : '';
        }
        return { id: party.id, href: party.href, name, role: party.role, '@referredType': organization ? 'Organization' : 'Individual' };
    }
}
