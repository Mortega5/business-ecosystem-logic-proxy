import { DomainError } from '../common/domain-error';
import { isRecord } from '../tmf/related-party';

/** A text that is not empty once it is trimmed, or nothing. */
export const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

export type Validated<T> = { errors: string[]; value?: undefined } | { errors: []; value: T };

/** The body of a request that is a JSON object, or the error to tell. */
export const objectOf = (body: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    return parsed;
};

/** What a validation found wrong, all of it in one message, since the portal shows the message and not a list. */
export const refuse = (what: string, errors: string[]): never => {
    throw new DomainError(`Invalid ${what} payload: ${errors.join('; ')}`, 400);
};
