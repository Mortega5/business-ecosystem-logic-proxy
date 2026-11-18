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
