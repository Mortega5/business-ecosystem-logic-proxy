import { parsePhoneNumber } from 'libphonenumber-js/max';
import { DomainError } from '../common/domain-error';
import { isRecord } from './related-party';

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

/** A list of contact media, each an object, with a valid number, in the international format, in every telephone. */
export const validateContactMedia = (media: unknown): void => {
    if (!Array.isArray(media)) {
        throw new DomainError('Invalid contactMedium format', 400);
    }
    for (const medium of media as unknown[]) {
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
};
