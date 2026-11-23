import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DomainError, ForbiddenError } from '../../common/domain-error';
import { isRecord } from '../related-party';
import { isResourceId } from '../resource-id.pipe';

/** The states a seller may give to an order item. */
const ITEM_STATES = ['acknowledged', 'cancelled', 'completed', 'inProgress', 'pending', 'failed'];

const count = (items: Record<string, unknown>[], state: string): number => items.filter((item) => item['state'] === state).length;

/**
 * The state of an order, which nobody sets: it follows from the states of its items. An order whose items have no state yet has none,
 * so nothing is said of it.
 */
export const orderState = (items: Record<string, unknown>[]): string | undefined => {
    for (const item of items) {
        if (item['state'] !== undefined && item['state'] !== null && !(typeof item['state'] === 'string' && ITEM_STATES.includes(item['state']))) {
            throw new DomainError('Bad item state', 400);
        }
    }
    const completed = count(items, 'completed');
    const cancelled = count(items, 'cancelled');
    const failed = count(items, 'failed');
    const finished = completed + cancelled + failed;
    if (items.length > 0 && completed === items.length) {
        return 'completed';
    }
    if (items.length > 0 && cancelled === items.length) {
        return 'cancelled';
    }
    if (items.length > 0 && failed === items.length) {
        return 'failed';
    }
    if (items.length > 0 && finished === items.length) {
        return 'partial';
    }
    if (count(items, 'inProgress') + finished > 0) {
        return 'inProgress';
    }
    if (count(items, 'acknowledged') > 0) {
        return 'acknowledged';
    }
    return count(items, 'pending') > 0 ? 'pending' : undefined;
};

const withoutState = (item: Record<string, unknown>): [string, unknown][] => Object.entries(item).filter(([name]) => name !== 'state');

/**
 * The items of an order once a seller has changed the state of some of them: the order has the same items it had, with the state
 * the seller sent for the ones they own, and nothing else of an item changes. `isOwner` says whether the caller is a seller of an item.
 */
export const itemsWithStates = (
    previous: Record<string, unknown>[],
    sent: unknown,
    isOwner: (item: Record<string, unknown>) => boolean
): Record<string, unknown>[] => {
    if (!Array.isArray(sent) || sent.length === 0 || !sent.every(isRecord)) {
        throw new DomainError('The product order items must be a list of items', 400);
    }
    const ids = sent.map((item) => item['id']);
    if (new Set(ids).size !== ids.length) {
        throw new DomainError('An order item is sent more than once', 400);
    }
    const items = previous.map((item) => ({ ...item }));
    for (const update of sent) {
        const current = items.find((item) => item['id'] === update['id']);
        if (current === undefined) {
            throw new DomainError('You are trying to edit an non-existing item', 400);
        }
        const before = withoutState(current);
        const after = withoutState(update);
        if (before.length !== after.length) {
            throw new ForbiddenError('The fields of an order item cannot be modified');
        }
        for (const [field, value] of before) {
            if (!isDeepStrictEqual(value, update[field])) {
                throw new ForbiddenError(`The value of the field ${field} cannot be changed`);
            }
        }
        // A state that is missing is no change; one that is not the item's own is, and only the seller of the item makes it
        const state = update['state'];
        if (state !== undefined && state !== null && state !== '' && state !== current['state']) {
            if (!isOwner(current)) {
                throw new ForbiddenError('You cannot modify an order item if you are not seller');
            }
            current['state'] = state;
        }
    }
    return items;
};

const sameNote = (first: unknown, second: unknown): boolean =>
    isRecord(first) && isRecord(second) && first['text'] === second['text'] && first['date'] === second['date'] && first['author'] === second['author'];

/**
 * The notes of an order after a note is added: the ones it has, untouched, and the new ones, which are written here. A list that drops
 * or repeats a note the order has is refused; a new note has its text from the client and nothing else (it is the caller's, as of now,
 * with an id that nobody else has).
 */
export const notesWith = (previous: unknown, sent: unknown, author: string, now: Date, limits: { noteLength: number; notesPerRequest: number }): Record<string, unknown>[] => {
    const kept = Array.isArray(previous) ? previous.filter(isRecord) : [];
    if (!Array.isArray(sent) || !sent.every(isRecord)) {
        throw new DomainError('The notes must be a list of notes', 400);
    }
    for (const note of kept) {
        if (sent.filter((candidate) => sameNote(note, candidate)).length !== 1) {
            throw new ForbiddenError('You are not allowed to modify the existing notes of an order');
        }
    }
    const added = sent.filter((candidate) => !kept.some((note) => sameNote(note, candidate)));
    if (added.length === 0 || added.length > limits.notesPerRequest) {
        throw new DomainError(`A request adds between 1 and ${limits.notesPerRequest} notes`, 400);
    }
    const ids = new Set(kept.map((note) => note['id']));
    const created = added.map((note): Record<string, unknown> => {
        const { text, id } = note;
        if (typeof text !== 'string' || text.trim() === '' || text.length > limits.noteLength) {
            throw new DomainError(`A note has a text of at most ${limits.noteLength} characters`, 422);
        }
        const noteId = typeof id === 'string' && isResourceId(id) && !ids.has(id) ? id : `urn:ngsi-ld:note:${randomUUID()}`;
        ids.add(noteId);
        return { id: noteId, author, text, date: now.toISOString() };
    });
    return [...kept, ...created];
};

/** The notes in the order they were written. */
export const sortedByDate = (notes: unknown): unknown[] =>
    Array.isArray(notes) ? notes.toSorted((first, second) => Date.parse(String(isRecord(first) ? first['date'] : '')) - Date.parse(String(isRecord(second) ? second['date'] : ''))) : [];
