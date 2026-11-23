import { describe, expect, it } from 'vitest';
import { categoryShape, systemEntityViolation, type PlatformEntities } from './category-rules';

const shape = (changes: Record<string, unknown>, previous: Record<string, unknown> | undefined, nameLength = 100) => categoryShape(changes, previous, nameLength);

describe('categoryShape', () => {
    it('is root unless it says otherwise, and has to be checked when it is new', () => {
        expect(shape({ name: 'Data' }, undefined)).toEqual({ isRoot: true, parentId: null, name: 'Data', needsChecks: true });
        expect(shape({ name: 'Sub', isRoot: false, parentId: 'c-1' }, undefined)).toMatchObject({ isRoot: false, parentId: 'c-1' });
    });

    it('takes what a change does not say from the category as it was, and checks only what moved', () => {
        const previous = { name: 'Data', isRoot: true };

        expect(shape({ description: 'x' }, previous)).toMatchObject({ name: 'Data', isRoot: true, needsChecks: false });
        expect(shape({ name: 'Data' }, previous).needsChecks).toBe(false);
        expect(shape({ name: 'Other' }, previous).needsChecks).toBe(true);
        expect(shape({ isRoot: false, parentId: 'c-1' }, previous).needsChecks).toBe(true);
        expect(shape({ isRoot: true, parentId: '' }, { name: 'Data', isRoot: false, parentId: 'c-1' })).toMatchObject({ isRoot: true, parentId: null, needsChecks: true });
    });

    it('takes the length of a name from the limit that is given', () => {
        expect(() => shape({ name: 'x'.repeat(11) }, undefined, 10)).toThrow('must be less than 10 characters');
        expect(shape({ name: 'x'.repeat(10) }, undefined, 10).name).toHaveLength(10);
    });

    it('refuses a root with a parent, a child with none, a name that is not there or is too long, and what is not valid', () => {
        expect(() => shape({ name: 'A', isRoot: true, parentId: 'c-1' }, undefined)).toThrow('Parent ID cannot be included');
        expect(() => shape({ name: 'A', isRoot: false }, undefined)).toThrow('Non-root categories must contain a parent');
        expect(() => shape({}, undefined)).toThrow('Category name is mandatory');
        expect(() => shape({ name: '  ' }, undefined)).toThrow('Category name is mandatory');
        expect(() => shape({ name: 'x'.repeat(101) }, undefined)).toThrow('too long');
        expect(() => shape({ name: 'A', isRoot: 'false' }, undefined)).toThrow('true or false');
        expect(() => shape({ name: 'A', isRoot: false, parentId: 'a b&c' }, undefined)).toThrow('parent id');
    });
});

describe('systemEntityViolation', () => {
    const platform: PlatformEntities = { isDefaultCatalog: (id) => id === 'cat-default', isSystemCategory: (id) => id === 'cat-api' };

    it('leaves alone what is not of the platform', () => {
        expect(systemEntityViolation(platform, 'category', 'DELETE', 'c-1', undefined)).toBeUndefined();
        expect(systemEntityViolation(platform, 'catalog', 'PATCH', 'c-1', { lifecycleStatus: 'Retired' })).toBeUndefined();
        // A category is not the catalog that has its id
        expect(systemEntityViolation(platform, 'category', 'DELETE', 'cat-default', undefined)).toBeUndefined();
    });

    it('does not let the default catalog or a system category be deleted or retired', () => {
        expect(systemEntityViolation(platform, 'catalog', 'DELETE', 'cat-default', undefined)).toBe('The default catalog cannot be deleted');
        expect(systemEntityViolation(platform, 'category', 'PATCH', 'cat-api', { lifecycleStatus: 'Obsolete' })).toBe('A system category cannot be retired');
        expect(systemEntityViolation(platform, 'catalog', 'PATCH', 'cat-default', { lifecycleStatus: 'retired' })).toBe('The default catalog cannot be retired');
    });

    it('does not let a system category be renamed or moved, nor the type of the default catalog change', () => {
        expect(systemEntityViolation(platform, 'category', 'PATCH', 'cat-api', { name: 'Other' })).toBe('A system category cannot be renamed or moved');
        expect(systemEntityViolation(platform, 'category', 'PATCH', 'cat-api', { isRoot: false })).toBe('A system category cannot be renamed or moved');
        expect(systemEntityViolation(platform, 'category', 'PATCH', 'cat-api', { parentId: 'c-1' })).toBe('A system category cannot be renamed or moved');
        expect(systemEntityViolation(platform, 'catalog', 'PATCH', 'cat-default', { catalogType: 'seller' })).toBe('The catalog type of the default catalog cannot change');
    });

    it('lets them change in what does not matter', () => {
        expect(systemEntityViolation(platform, 'category', 'PATCH', 'cat-api', { description: 'APIs', parentId: null })).toBeUndefined();
        expect(systemEntityViolation(platform, 'catalog', 'PATCH', 'cat-default', { category: [], catalogType: 'default' })).toBeUndefined();
    });
});
