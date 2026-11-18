import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';

const LIFECYCLE = ['active', 'launched', 'retired', 'obsolete'];

const statusOf = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/** Whether a status may follow another: the next one, the same, back from retired to launched, or straight from active to obsolete. */
export const isValidStatusTransition = (from: unknown, to: unknown): boolean => {
    const first = LIFECYCLE.indexOf(statusOf(from));
    const next = LIFECYCLE.indexOf(statusOf(to));
    return first > -1 && next > -1 && (next === first + 1 || next === first || (first === LIFECYCLE.length - 2 && next === first - 1) || (first === 0 && next === LIFECYCLE.length - 1));
};

export const isRetired = (status: unknown): boolean => statusOf(status) === 'retired';

/** A specification that is not retired or obsolete is still in use, and a status that is missing counts as in use. */
export const isInUse = (specification: unknown): boolean => {
    const status = isRecord(specification) ? statusOf(specification['lifecycleStatus']) : '';
    return status !== 'retired' && status !== 'obsolete';
};

const partyOf = (party: unknown): Record<string, unknown> => (isRecord(party) ? party : {});

const byPartyAndRole = (first: unknown, second: unknown): number => {
    const a = partyOf(first);
    const b = partyOf(second);
    return String(a['id']).localeCompare(String(b['id'])) || String(a['role']).localeCompare(String(b['role']));
};

/** Whether the related parties are the same, in any order. */
export const sameRelatedParties = (current: unknown, changed: unknown): boolean =>
    Array.isArray(current) &&
    Array.isArray(changed) &&
    isDeepStrictEqual((current as unknown[]).toSorted(byPartyAndRole), (changed as unknown[]).toSorted(byPartyAndRole));

/** The name is mandatory on creation, and it and the description have a size; `noun` says what the specification is in the refusal. */
export const validateNameAndDescription = (specification: Record<string, unknown>, noun: string, creating: boolean): void => {
    const { name, description } = specification;
    if (name !== undefined && name !== null) {
        if (typeof name !== 'string') {
            throw new DomainError(`${noun} name must be a string`, 422);
        }
        if (name.length > 100) {
            throw new DomainError(`${noun} name is too long, it must be less than 100 characters`, 422);
        }
        if (name.trim() === '') {
            throw new DomainError(`${noun} name is empty`, 422);
        }
    } else if (creating) {
        throw new DomainError(`${noun} name is mandatory`, 422);
    }
    if (description !== undefined && description !== null && description !== '') {
        if (typeof description !== 'string') {
            throw new DomainError(`${noun} description must be a string`, 422);
        }
        if (description.length > 100000) {
            throw new DomainError(`${noun} description is too long, it must be less than 100.000 characters`, 422);
        }
    }
};
