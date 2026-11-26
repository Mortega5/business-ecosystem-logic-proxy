import { DomainError } from '../../common/domain-error';
import { validateContactMedia } from '../contact-medium';
import { isRecord } from '../related-party';

/** The body of a billing account as a JSON object; what is sent on is what was checked, not the text that came. */
export const parseBillingAccount = (body: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    return parsed;
};

/** The contacts of a billing account: a list of contacts with a list of media each. */
export const validateContacts = (account: Record<string, unknown>): void => {
    const contacts = account['contact'];
    if (contacts === undefined || contacts === null) {
        return;
    }
    if (!Array.isArray(contacts)) {
        throw new DomainError('Invalid contact format', 400);
    }
    for (const contact of contacts as unknown[]) {
        if (!isRecord(contact)) {
            throw new DomainError('Invalid contactMedium format', 400);
        }
        validateContactMedia(contact['contactMedium']);
    }
};

const POSTAL_FIELDS = ['contactType', 'street1', 'city', 'stateOrProvince', 'postCode', 'country'];
const CONTACT_FIELDS: Record<string, string[]> = {
    Email: ['contactType', 'emailAddress'],
    PostalAddress: POSTAL_FIELDS,
    TelephoneNumber: ['contactType', 'phoneNumber']
};

const pick = (source: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
    const picked: Record<string, unknown> = {};
    for (const field of fields) {
        if (field in source) {
            picked[field] = source[field];
        }
    }
    return picked;
};

const contactMediumView = (medium: unknown): Record<string, unknown>[] => {
    if (!isRecord(medium) || typeof medium['mediumType'] !== 'string') {
        return [];
    }
    const fields = CONTACT_FIELDS[medium['mediumType']];
    if (fields === undefined) {
        return [];
    }
    const characteristic = isRecord(medium['characteristic']) ? medium['characteristic'] : {};
    return [{ mediumType: medium['mediumType'], characteristic: pick(characteristic, fields) }];
};

/**
 * What the seller of an order gets of the billing account of its buyer: the name and the ways to reach and bill them,
 * and nothing else. Only the fields listed are kept, so a field the account gets later is not given by accident; the
 * order of the contact media is kept, as the portal reads them by position.
 */
export const sellerView = (account: Record<string, unknown>): Record<string, unknown> => {
    const view = pick(account, ['id', 'href', 'name']);
    const contacts = Array.isArray(account['contact']) ? (account['contact'] as unknown[]) : [];
    view['contact'] = contacts.filter(isRecord).map((contact) => ({
        contactMedium: (Array.isArray(contact['contactMedium']) ? (contact['contactMedium'] as unknown[]) : []).flatMap(contactMediumView)
    }));
    return view;
};
