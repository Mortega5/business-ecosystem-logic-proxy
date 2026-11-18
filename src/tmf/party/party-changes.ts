import { DomainError } from '../../common/domain-error';
import { validateContactMedia } from '../contact-medium';
import { isRecord } from '../related-party';

/** The changes to a party as a JSON object without `id` and `href`, which the TMForum server rejects in a patch. */
export const parsePartyChanges = (body: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    const { id: _id, href: _href, ...changes } = parsed;
    return changes;
};

/** What the portal's form for an organisation sends: valid telephones and a country code of two letters. */
export const validateOrganizationChanges = (changes: Record<string, unknown>): void => {
    if (changes['contactMedium'] !== undefined && changes['contactMedium'] !== null) {
        validateContactMedia(changes['contactMedium']);
    }
    const characteristics = changes['partyCharacteristic'];
    if (characteristics === undefined || characteristics === null) {
        return;
    }
    if (!Array.isArray(characteristics)) {
        throw new DomainError('Invalid partyCharacteristic format', 400);
    }
    for (const characteristic of characteristics as unknown[]) {
        if (!isRecord(characteristic)) {
            throw new DomainError('Invalid partyCharacteristic format', 400);
        }
        if (characteristic['name'] === 'country' && (typeof characteristic['value'] !== 'string' || characteristic['value'].length !== 2)) {
            throw new DomainError('Invalid country code', 422);
        }
    }
};
