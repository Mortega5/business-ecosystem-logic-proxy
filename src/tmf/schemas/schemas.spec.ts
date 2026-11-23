import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { category } from './category';
import { parseEntity } from './parse';
import { relatedParty } from './related-party';
import { resourceSpecification } from './resource-specification';

describe('the entities of the TMForum', () => {
    it('take a catalog with what the code reads and keep the rest of what it has', () => {
        const found = parseEntity(catalog, { id: 'c-1', name: 'default', catalogType: null, relatedParty: [{ id: 'p-1', role: 'Seller', name: 'x' }], category: [{ id: 'k-1' }], extra: 1 }, 'The catalog');

        expect(found.id).toBe('c-1');
        expect(found.relatedParty?.[0]).toMatchObject({ id: 'p-1', role: 'Seller', name: 'x' });
        expect((found as Record<string, unknown>)['extra']).toBe(1);
    });

    it('take a catalog with no party and no category, as the default one is made', () => {
        expect(parseEntity(catalog, { id: 'c-1' }, 'The catalog')).toEqual({ id: 'c-1' });
    });

    it('refuse a party with no role, an entity with no id, and a field of another type, saying where', () => {
        expect(() => parseEntity(catalog, { id: 'c-1', relatedParty: [{ id: 'p-1' }] }, 'The catalog')).toThrow('The catalog is not as expected: relatedParty.0.role');
        expect(() => parseEntity(category, { name: 'Data' }, 'The category')).toThrow('The category is not as expected: id');
        expect(() => parseEntity(category, { id: 'k-1', isRoot: 'yes' }, 'The category')).toThrow('isRoot');
        expect(() => parseEntity(relatedParty, { id: '', role: 'Seller' }, 'The party')).toThrow('The party is not as expected: id');
        expect(() => parseEntity(resourceSpecification, 'not an object', 'The spec')).toThrow('The spec is not as expected: (the value)');
    });
});
