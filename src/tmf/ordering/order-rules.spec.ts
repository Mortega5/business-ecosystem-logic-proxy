import { describe, expect, it } from 'vitest';
import { itemsWithStates, notesWith, orderState, sortedByDate } from './order-rules';

const item = (id: string, state?: string, extra: object = {}) => ({ id, product: { name: id }, ...(state === undefined ? {} : { state }), ...extra });
const NOW = new Date('2026-11-23T10:00:00.000Z');
const addNote = (previous: unknown, sent: unknown, author: string, now: Date, limits = { noteLength: 10_000, notesPerRequest: 20 }) => notesWith(previous, sent, author, now, limits);

describe('orderState', () => {
    it('follows from the states of the items', () => {
        expect(orderState([item('a', 'completed'), item('b', 'completed')])).toBe('completed');
        expect(orderState([item('a', 'cancelled'), item('b', 'cancelled')])).toBe('cancelled');
        expect(orderState([item('a', 'failed')])).toBe('failed');
        expect(orderState([item('a', 'completed'), item('b', 'failed')])).toBe('partial');
        expect(orderState([item('a', 'completed'), item('b', 'acknowledged')])).toBe('inProgress');
        expect(orderState([item('a', 'inProgress'), item('b', 'acknowledged')])).toBe('inProgress');
        expect(orderState([item('a', 'acknowledged'), item('b')])).toBe('acknowledged');
        expect(orderState([item('a', 'pending')])).toBe('pending');
    });

    it('is nothing when the items have no state, and refuses a state that is not one', () => {
        expect(orderState([item('a'), item('b')])).toBeUndefined();
        expect(() => orderState([item('a', 'done')])).toThrow('Bad item state');
    });
});

describe('itemsWithStates', () => {
    const previous = [item('a', 'acknowledged'), item('b', 'acknowledged')];
    const mine = (it: Record<string, unknown>) => it['id'] === 'a';

    it('gives the state the seller sent to their items and keeps the rest of the order as it was', () => {
        const items = itemsWithStates(previous, [item('a', 'completed')], mine);

        expect(items).toEqual([item('a', 'completed'), item('b', 'acknowledged')]);
        expect(previous[0]).toEqual(item('a', 'acknowledged'));
    });

    it('takes a state that is missing as no change', () => {
        expect(itemsWithStates(previous, [item('a')], mine)).toEqual(previous);
    });

    it('refuses a state of an item that is not theirs, a field that changes, a field that is added, and an item that is not there', () => {
        expect(() => itemsWithStates(previous, [item('b', 'completed')], mine)).toThrow('if you are not seller');
        expect(() => itemsWithStates(previous, [{ ...item('a', 'completed'), product: { name: 'other' } }], mine)).toThrow('The value of the field product cannot be changed');
        expect(() => itemsWithStates(previous, [{ ...item('a', 'completed'), extra: 1 }], mine)).toThrow('The fields of an order item cannot be modified');
        expect(() => itemsWithStates(previous, [item('z', 'completed')], mine)).toThrow('non-existing item');
        expect(() => itemsWithStates(previous, [item('a', 'completed'), item('a', 'failed')], mine)).toThrow('more than once');
        expect(() => itemsWithStates(previous, [], mine)).toThrow('list of items');
    });
});

describe('notesWith', () => {
    const old = { id: 'urn:ngsi-ld:note:1', author: 'p-ana', text: 'Hello', date: '2026-11-01T00:00:00.000Z' };

    it('keeps the notes of the order and writes the new one as the caller, as of now', () => {
        const notes = addNote([old], [old, { id: 'urn:ngsi-ld:note:2', author: 'p-victim', text: 'Hi', date: '2001-01-01T00:00:00.000Z', extra: 'x' }], 'p-shop', NOW);

        expect(notes).toEqual([old, { id: 'urn:ngsi-ld:note:2', author: 'p-shop', text: 'Hi', date: NOW.toISOString() }]);
    });

    it('gives an id of its own to a note whose id is not valid or is taken', () => {
        const [, first, second] = addNote([old], [old, { id: old.id, text: 'A' }, { id: 'a b', text: 'B' }], 'p-shop', NOW);

        expect(first?.['id']).toMatch(/^urn:ngsi-ld:note:[0-9a-f-]{36}$/);
        expect(second?.['id']).toMatch(/^urn:ngsi-ld:note:[0-9a-f-]{36}$/);
        expect(first?.['id']).not.toBe(second?.['id']);
    });

    it('refuses a list that drops, changes or repeats a note of the order', () => {
        expect(() => addNote([old], [{ text: 'New' }], 'p-shop', NOW)).toThrow('existing notes');
        expect(() => addNote([old], [{ ...old, text: 'Changed' }, { text: 'New' }], 'p-shop', NOW)).toThrow('existing notes');
        expect(() => addNote([old], [old, old, { text: 'New' }], 'p-shop', NOW)).toThrow('existing notes');
    });

    it('takes what a note and a request may have from the limits that are given', () => {
        const limits = { noteLength: 5, notesPerRequest: 2 };

        expect(() => addNote(undefined, [{ text: 'x'.repeat(6) }], 'p-shop', NOW, limits)).toThrow('at most 5 characters');
        expect(() => addNote(undefined, [{ text: 'a' }, { text: 'b' }, { text: 'c' }], 'p-shop', NOW, limits)).toThrow('between 1 and 2 notes');
        expect(addNote(undefined, [{ text: 'a' }, { text: 'b' }], 'p-shop', NOW, limits)).toHaveLength(2);
    });

    it('refuses a request with no new note, a note with no text, and one that is too long', () => {
        expect(() => addNote([old], [old], 'p-shop', NOW)).toThrow('adds between');
        expect(() => addNote(undefined, [{ text: '  ' }], 'p-shop', NOW)).toThrow('has a text');
        expect(() => addNote(undefined, [{ text: 'x'.repeat(10_001) }], 'p-shop', NOW)).toThrow('has a text');
        expect(() => addNote(undefined, 'note', 'p-shop', NOW)).toThrow('list of notes');
    });
});

describe('sortedByDate', () => {
    it('puts the oldest first, and is nothing when there are no notes', () => {
        expect(sortedByDate([{ date: '2026-02-01' }, { date: '2026-01-01' }])).toEqual([{ date: '2026-01-01' }, { date: '2026-02-01' }]);
        expect(sortedByDate(undefined)).toEqual([]);
    });
});
