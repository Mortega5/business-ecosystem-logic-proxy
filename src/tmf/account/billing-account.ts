import { parsePhoneNumber } from 'libphonenumber-js/max';
import { DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';

const E164 = /^\+[1-9]\d{1,14}$/;

const isValidPhoneNumber = (value: unknown): boolean => {
    if (typeof value !== 'string' || !E164.test(value)) {
        return false;
    }
    try {
        return parsePhoneNumber(value).isValid();
    } catch {
        return false;
    }
};

/** The body of a billing account as a JSON object; what is sent on is what was checked, not the text that came. */
export const parseBillingAccount = (body: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    return parsed;
};

/** The contacts of a billing account: a list of contacts with a list of media each, and a valid number in every telephone. */
export const validateContacts = (account: Record<string, unknown>): void => {
    const contacts = account['contact'];
    if (contacts === undefined || contacts === null) {
        return;
    }
    if (!Array.isArray(contacts)) {
        throw new DomainError('Invalid contact format', 400);
    }
    for (const contact of contacts as unknown[]) {
        if (!isRecord(contact) || !Array.isArray(contact['contactMedium'])) {
            throw new DomainError('Invalid contactMedium format', 400);
        }
        for (const medium of contact['contactMedium'] as unknown[]) {
            if (!isRecord(medium)) {
                throw new DomainError('Invalid contactMedium format', 400);
            }
            if (medium['mediumType'] === 'TelephoneNumber') {
                const characteristic = medium['characteristic'];
                if (!isRecord(characteristic) || !isValidPhoneNumber(characteristic['phoneNumber'])) {
                    throw new DomainError('Invalid phone number', 422);
                }
            }
        }
    }
};
