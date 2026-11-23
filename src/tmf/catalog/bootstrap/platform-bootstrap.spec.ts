import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPlatformRecords } from '../../../testing/in-memory-platform-records';
import { FakeApis } from '../../../testing/fake-platform-apis';
import { PlatformBootstrap, type PlatformSettings } from './platform-bootstrap';

const SETTINGS: PlatformSettings = {
    defaultCatalogId: '',
    defaultCatalogName: 'default',
    systemCategories: [
        { key: 'dataset', name: 'Dataset', description: 'Datasets' },
        { key: 'api', name: 'API', description: 'APIs' }
    ],
    sellerRole: 'Seller',
    records: { defaultCatalog: 'default', supportPackageSpec: 'global' }
};
const SELLER = [{ id: 'p-shop', role: 'Seller' }];

let apis: FakeApis;
let records: InMemoryPlatformRecords;
let warnings: string[];
const build = (settings: Partial<PlatformSettings> = {}) =>
    new PlatformBootstrap({ ...SETTINGS, ...settings }, records, apis, apis, { info: () => undefined, warn: (message) => void warnings.push(message) });
const writes = (): string[] => apis.calls.filter((call) => !call.startsWith('get'));

beforeEach(() => {
    apis = new FakeApis();
    records = new InMemoryPlatformRecords();
    warnings = [];
});

describe('the default catalog and the system categories', () => {
    it('makes them when there are none: the catalog, a category for each kind of product, and the catalog lists them', async () => {
        const result = await build().ensure();

        expect(result.defaultCatalogId).toBe('catalog-01');
        expect(result.systemCategoryIds).toEqual({ dataset: 'category-02', api: 'category-03' });
        expect(apis.catalogs[0]).toMatchObject({ name: 'default', catalogType: 'default', lifecycleStatus: 'Launched' });
        const listed = apis.catalogs[0]?.category ?? [];
        expect(listed.map((category) => category.id)).toEqual(['category-02', 'category-03']);
        expect(apis.categories.map((category) => [category['name'], category['isRoot']])).toEqual([['Dataset', true], ['API', true]]);
        expect(records.records.defaultcatalog).toEqual([{ id: 'default', default_id: 'catalog-01' }]);
        expect(records.records.systemcategory).toEqual([{ id: 'dataset', category_id: 'category-02' }, { id: 'api', category_id: 'category-03' }]);
    });

    it('does nothing when it is already so, however many times it starts', async () => {
        const first = await build().ensure();
        apis.calls = [];

        expect(await build().ensure()).toEqual(first);
        expect(writes()).toEqual([]);
    });

    it('uses the catalog of the configuration, which has to exist, and stores it', async () => {
        apis.catalogs.push({ id: 'catalog-mine', name: 'mine', category: [] });

        expect((await build({ defaultCatalogId: 'catalog-mine' }).ensure()).defaultCatalogId).toBe('catalog-mine');
        expect(records.records.defaultcatalog).toEqual([{ id: 'default', default_id: 'catalog-mine' }]);
        await expect(build({ defaultCatalogId: 'catalog-gone' }).ensure()).rejects.toThrow('does not exist');
    });

    it('takes the stored catalog while it exists, and the one the TMForum marks when the stored one is gone', async () => {
        records.records.defaultcatalog.push({ id: 'old-uuid', default_id: 'catalog-gone' });
        apis.catalogs.push({ id: 'catalog-b', catalogType: 'default', relatedParty: [] }, { id: 'catalog-a', catalogType: 'default' });

        expect((await build().ensureDefaultCatalog())).toBe('catalog-a');
        // The one that was stored by v11 is kept as the only record, now pointing at the one found
        expect(records.records.defaultcatalog).toEqual([{ id: 'old-uuid', default_id: 'catalog-a' }]);
        expect(await build().ensureDefaultCatalog()).toBe('catalog-a');
    });

    it('does not take for the default catalog a marked catalog of a seller', async () => {
        apis.catalogs.push({ id: 'catalog-seller', catalogType: 'default', relatedParty: SELLER });

        expect(await build().ensureDefaultCatalog()).toBe('catalog-01');
    });

    it('adopts and marks the catalog of a deployment that is older than the mark, but never a seller\'s, a retired one or one with a type', async () => {
        apis.catalogs.push(
            { id: 'catalog-1', name: 'default', relatedParty: SELLER },
            { id: 'catalog-2', name: 'default', lifecycleStatus: 'Retired' },
            { id: 'catalog-3', name: 'default', catalogType: 'other' },
            { id: 'catalog-4', name: 'default', lifecycleStatus: 'Launched', category: [] }
        );

        expect(await build().ensureDefaultCatalog()).toBe('catalog-4');
        expect(apis.catalogs.find((catalog) => catalog['id'] === 'catalog-4')?.['catalogType']).toBe('default');
        expect(apis.calls).not.toContain('createCatalog');
    });

    it('keeps the catalog with the smallest id when another replica made its own at the same time, and deletes its own', async () => {
        apis.afterCreateCatalog = () => apis.catalogs.push({ id: 'catalog-00', catalogType: 'default', relatedParty: [] });

        expect(await build().ensureDefaultCatalog()).toBe('catalog-00');
        expect(apis.calls).toContain('deleteCatalog catalog-01');
        expect(records.records.defaultcatalog[0]?.['default_id']).toBe('catalog-00');
    });

    it('keeps one record when there are several, pointing at the catalog that exists', async () => {
        apis.catalogs.push({ id: 'catalog-ok', catalogType: 'default' });
        records.records.defaultcatalog.push({ id: 'r1', default_id: 'catalog-gone' }, { id: 'r2', default_id: 'catalog-ok' });

        expect(await build().ensureDefaultCatalog()).toBe('catalog-ok');
        expect(records.records.defaultcatalog).toEqual([{ id: 'r1', default_id: 'catalog-ok' }]);
    });

    it('adopts a root category with the name when no catalog owns it, and not the one that a seller\'s catalog has', async () => {
        apis.catalogs.push({ id: 'catalog-seller', name: 'Seller shop', relatedParty: SELLER, category: [{ id: 'category-seller' }] });
        apis.categories.push({ id: 'category-seller', name: 'Dataset', isRoot: true }, { id: 'category-free', name: 'Dataset', isRoot: true });

        const result = await build().ensure();

        expect(result.systemCategoryIds['dataset']).toBe('category-free');
        expect(apis.calls).not.toContain('createCategory Dataset');
        expect(apis.calls).toContain('createCategory API');
    });

    it('takes the stored category, and makes another when it is gone, changing the record', async () => {
        records.records.systemcategory.push({ id: 'dataset', category_id: 'category-gone' });

        const result = await build().ensure();

        expect(result.systemCategoryIds['dataset']).not.toBe('category-gone');
        expect(records.records.systemcategory.find((record) => record.id === 'dataset')?.['category_id']).toBe(result.systemCategoryIds['dataset']);
        expect(warnings.some((message) => message.includes('does not exist any more'))).toBe(true);
    });

    it('adds to the default catalog the system categories it lacks and leaves the rest of its categories as they are', async () => {
        const first = await build().ensure();
        const catalog = apis.catalogs.find((candidate) => candidate.id === first.defaultCatalogId);
        catalog!.category = [{ id: 'category-other', name: 'Other' }, { id: first.systemCategoryIds['api'] ?? '', name: 'API' }];

        await build().ensure();

        expect((catalog!.category ?? []).map((category) => category.id)).toEqual(['category-other', first.systemCategoryIds['api'], first.systemCategoryIds['dataset']]);
    });

    it('keeps the category that was stored first when two replicas make one at the same time, and deletes its own', async () => {
        const slow = build();
        const winner = { id: 'dataset', category_id: 'category-first' };
        const original = records.insert.bind(records);
        records.insert = async (collection, id, fields) => {
            if (collection === 'systemcategory' && id === 'dataset') {
                records.records.systemcategory.push(winner);
            }
            return original(collection, id, fields);
        };
        apis.categories.push({ id: 'category-first', name: 'Dataset-first' });

        const result = await slow.ensure();

        expect(result.systemCategoryIds['dataset']).toBe('category-first');
        expect(apis.calls.some((call) => call.startsWith('deleteCategory'))).toBe(true);
    });
});

describe('the support package spec', () => {
    it('makes it when there is none, and takes the stored one from then on', async () => {
        const id = await build().ensureSupportPackageSpec();

        expect(apis.specs[0]).toMatchObject({ '@type': 'SoftwareSupportPackageSpecification', lifecycleStatus: 'Launched' });
        expect(records.records.supportpackagespec).toEqual([{ id: 'global', spec_id: id }]);
        apis.calls = [];
        expect(await build().ensureSupportPackageSpec()).toBe(id);
        expect(apis.calls).toEqual([]);
    });

    it('takes the one that the software API has by its type, the smallest when there are several, and not a spec of another type', async () => {
        apis.specs.push({ id: 'spec-z', '@type': 'SoftwareSupportPackageSpecification' }, { id: 'spec-a', '@type': 'SoftwareSupportPackageSpecification' }, { id: 'spec-0', '@type': 'Other' });

        expect(await build().ensureSupportPackageSpec()).toBe('spec-a');
        expect(apis.calls).not.toContain('createResourceSpec');
    });

    it('makes another when the stored one is gone, changing the record', async () => {
        records.records.supportpackagespec.push({ id: 'global', spec_id: 'spec-gone' });

        const id = await build().ensureSupportPackageSpec();

        expect(id).not.toBe('spec-gone');
        expect(records.records.supportpackagespec).toEqual([{ id: 'global', spec_id: id }]);
    });
});
