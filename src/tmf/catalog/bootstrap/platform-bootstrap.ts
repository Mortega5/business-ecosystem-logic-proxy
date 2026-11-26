import { SUPPORT_SPECIFICATION, SUPPORT_SPECIFICATION_TYPE } from '../../software/software-rules';
import type { Catalog } from '../../schemas/catalog';
import type { Category } from '../../schemas/category';
import type { RelatedParty } from '../../schemas/related-party';
import { DEFAULT_CATALOG_TYPE } from '../category-rules';
import type { CatalogApi, SoftwareApi } from './platform-api';
import { DuplicateRecordError, PlatformRecords } from './platform-records';

export interface PlatformSettings {
    defaultCatalogId: string;
    defaultCatalogName: string;
    systemCategories: { key: string; name: string; description: string }[];
    /** The role that makes a party the seller of what it owns. */
    sellerRole: string;
    /** The ids of the records in which what was found is kept. */
    records: { defaultCatalog: string; supportPackageSpec: string };
}

export interface PlatformLog {
    info: (message: string) => void;
    warn: (message: string, fields?: object) => void;
}

export interface PlatformResult {
    defaultCatalogId: string;
    systemCategoryIds: Record<string, string>;
}

// The same one in every replica, whoever asks and in whatever order: the smallest id
const smallestId = (items: { id: string }[]): string => items.map((item) => item.id).toSorted()[0] ?? '';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * What the proxy makes sure of every time it starts, doing nothing when it is already so: that the platform has one default catalog with
 * an id that does not change, that the system categories exist, are known by their id and are in the default catalog, and that there is
 * one specification for the support packages of the software. What is stored in Mongo is only the id of each: it can be lost and the
 * entity found again (the catalog by its type, or by its name when it was made before the type existed; a category by its name when no
 * catalog owns it).
 */
export class PlatformBootstrap {
    constructor(
        private readonly settings: PlatformSettings,
        private readonly records: PlatformRecords,
        private readonly catalogs: CatalogApi,
        private readonly software: SoftwareApi,
        private readonly log: PlatformLog
    ) {}

    private isSeller(party: RelatedParty): boolean {
        return party.role.toLowerCase() === this.settings.sellerRole.toLowerCase();
    }

    private hasSeller(catalog: Catalog): boolean {
        return (catalog.relatedParty ?? []).some((party) => this.isSeller(party));
    }

    // A catalog is the default one of the platform when it says so and does not belong to a seller
    private isSystemDefaultCatalog(catalog: Catalog): boolean {
        return catalog.catalogType === DEFAULT_CATALOG_TYPE && !this.hasSeller(catalog);
    }

    /** The whole start-up of the catalog: it throws when something could not be done, so that whoever calls it can try again. */
    async ensure(): Promise<PlatformResult> {
        const defaultCatalogId = await this.ensureDefaultCatalog();
        const categories = await this.ensureSystemCategories(defaultCatalogId);
        await this.reconcileDefaultCatalog(defaultCatalogId, Object.values(categories));
        return { defaultCatalogId, systemCategoryIds: Object.fromEntries(Object.entries(categories).map(([key, category]) => [key, category.id])) };
    }

    // ---- Default catalog

    private async saveDefaultCatalogId(catalogId: string): Promise<void> {
        const [first, ...extra] = await this.records.list('defaultcatalog');
        if (first === undefined) {
            await this.records.ensureUniqueIds('defaultcatalog').catch((error: unknown) => this.log.warn('The default catalog record could not be made unique', { err: error }));
            try {
                await this.records.insert('defaultcatalog', this.settings.records.defaultCatalog, { default_id: catalogId });
                return;
            } catch (error) {
                if (!(error instanceof DuplicateRecordError)) {
                    throw error;
                }
                // Another replica stored its record first: this one holds the same catalog, or is made to
                return this.saveDefaultCatalogId(catalogId);
            }
        }
        await this.records.update('defaultcatalog', first.id, { default_id: catalogId });
        for (const record of extra) {
            await this.records.remove('defaultcatalog', record.id);
        }
    }

    private async findMarkedDefaultCatalogs(): Promise<Catalog[]> {
        return (await this.catalogs.listCatalogs({ catalogType: DEFAULT_CATALOG_TYPE })).filter((catalog) => this.isSystemDefaultCatalog(catalog));
    }

    async ensureDefaultCatalog(): Promise<string> {
        // 1. The one set in the configuration
        const configured = this.settings.defaultCatalogId;
        if (configured !== '') {
            if ((await this.catalogs.getCatalog(configured)) === null) {
                throw new Error(`The default catalog ${configured} set in the configuration does not exist`);
            }
            const records = await this.records.list('defaultcatalog');
            if (records.length !== 1 || records[0]?.['default_id'] !== configured) {
                if (records.some((record) => text(record['default_id']) !== '' && record['default_id'] !== configured)) {
                    this.log.warn(`The default catalog set in the configuration (${configured}) is not the stored one: the configured one is used`);
                }
                await this.saveDefaultCatalogId(configured);
            }
            return configured;
        }

        // 2. The stored one, when it still exists
        const records = await this.records.list('defaultcatalog');
        for (const record of records) {
            const stored = text(record['default_id']);
            if (stored !== '' && (await this.catalogs.getCatalog(stored)) !== null) {
                if (records.length > 1) {
                    this.log.warn(`There are ${records.length} default catalog records: only the one of ${stored} is kept`);
                    await this.saveDefaultCatalogId(stored);
                }
                return stored;
            }
        }

        // 3. The one the TMForum has marked as the default
        const existing = await this.findMarkedDefaultCatalogs();
        if (existing.length > 0) {
            const found = smallestId(existing);
            this.log.info(`The default catalog ${found} was found in the catalog API`);
            await this.saveDefaultCatalogId(found);
            return found;
        }

        // 4. One that was made before the mark existed: the catalog of the platform with the name of the default one, no seller and no
        // other type. It is marked, so that from now on it is found as the others are
        const name = this.settings.defaultCatalogName;
        const unmarked = (await this.catalogs.listCatalogs({ name })).filter(
            (catalog) => catalog.name === name && !catalog.catalogType && !this.hasSeller(catalog) && (catalog.lifecycleStatus ?? '').toLowerCase() !== 'retired'
        );
        if (unmarked.length > 0) {
            const adopted = smallestId(unmarked);
            this.log.info(`The catalog ${adopted} has the name and the owner of the default catalog and no mark: it is the default catalog`);
            await this.catalogs.updateCatalog(adopted, { catalogType: DEFAULT_CATALOG_TYPE });
            await this.saveDefaultCatalogId(adopted);
            return adopted;
        }

        // 5. A new one, straight to the TMForum: the proxy would also make a category for it, and it must not have one
        const created = await this.catalogs.createCatalog({
            name,
            description: 'Root categories of the marketplace',
            catalogType: DEFAULT_CATALOG_TYPE,
            lifecycleStatus: 'Launched',
            category: []
        });
        this.log.info(`The default catalog ${created.id} was created`);

        // Another replica may have created its own at the same time: all of them keep the same one, and the others are deleted
        const winner = smallestId([...(await this.findMarkedDefaultCatalogs()), created]);
        if (winner !== created.id) {
            this.log.info(`The default catalog ${winner} was created first: ${created.id} is deleted`);
            await this.catalogs.deleteCatalog(created.id);
        }
        await this.saveDefaultCatalogId(winner);
        return winner;
    }

    // ---- System categories

    private async readSystemCategoryIds(): Promise<Record<string, string>> {
        return Object.fromEntries((await this.records.list('systemcategory')).map((record) => [record.id, text(record['category_id'])]));
    }

    // Stores the id of the category of a key unless there is one already, and gives the id that is stored. When the one that is stored
    // does not exist any more (`replacing`), it is the record that changes
    private async saveSystemCategoryId(key: string, categoryId: string, replacing: boolean): Promise<string> {
        if (replacing) {
            await this.records.update('systemcategory', key, { category_id: categoryId });
            return categoryId;
        }
        await this.records.ensureUniqueIds('systemcategory').catch((error: unknown) => this.log.warn('The system category records could not be made unique', { err: error }));
        try {
            await this.records.insert('systemcategory', key, { category_id: categoryId });
            return categoryId;
        } catch (error) {
            if (!(error instanceof DuplicateRecordError)) {
                throw error;
            }
            return (await this.readSystemCategoryIds())[key] ?? categoryId;
        }
    }

    // The categories a catalog has as its own: a seller's catalog has one named after it, and it is not a category of the taxonomy
    private async catalogCategoryIds(defaultCatalogId: string): Promise<Set<string>> {
        const ids = new Set<string>();
        for (const catalog of await this.catalogs.listCatalogs({})) {
            if (catalog.id !== defaultCatalogId && !this.isSystemDefaultCatalog(catalog)) {
                (catalog.category ?? []).forEach((category) => ids.add(category.id));
            }
        }
        return ids;
    }

    private async ensureSystemCategory(definition: PlatformSettings['systemCategories'][number], owned: Set<string>): Promise<Category> {
        // 1. The one that is stored, when it still exists
        const stored = (await this.readSystemCategoryIds())[definition.key] ?? '';
        if (stored !== '') {
            const category = await this.catalogs.getCategory(stored);
            if (category !== null) {
                return category;
            }
            this.log.warn(`The system category ${definition.key} (${stored}) does not exist any more`);
        }
        const replacing = stored !== '';

        // 2. One with the exact name that no catalog owns. A catalog can be named the same, and its category must never be taken for this one
        const candidates = (await this.catalogs.listCategories({ name: definition.name, isRoot: 'true' })).filter(
            (category) => category.name === definition.name && category.isRoot !== false && !owned.has(category.id)
        );
        const adopted = candidates.toSorted((a, b) => (a.id < b.id ? -1 : 1))[0];
        if (adopted !== undefined) {
            if (candidates.length > 1) {
                this.log.warn(`There are ${candidates.length} root categories named ${definition.name}: the one with the smallest id is used`);
            }
            const registered = await this.saveSystemCategoryId(definition.key, adopted.id, replacing);
            return registered === adopted.id ? adopted : await this.requiredCategory(registered);
        }

        // 3. A new one
        const created = await this.catalogs.createCategory({ name: definition.name, description: definition.description, isRoot: true, lifecycleStatus: 'Launched' });
        this.log.info(`The system category ${definition.key} was created: ${created.id}`);
        const registered = await this.saveSystemCategoryId(definition.key, created.id, replacing);
        if (registered !== created.id) {
            this.log.info(`The system category ${definition.key} was created first by another replica: ${created.id} is deleted`);
            await this.catalogs.deleteCategory(created.id);
            return this.requiredCategory(registered);
        }
        return created;
    }

    private async requiredCategory(id: string): Promise<Category> {
        const category = await this.catalogs.getCategory(id);
        if (category === null) {
            throw new Error(`The system category ${id} does not exist`);
        }
        return category;
    }

    async ensureSystemCategories(defaultCatalogId: string): Promise<Record<string, Category>> {
        const owned = await this.catalogCategoryIds(defaultCatalogId);
        const categories: Record<string, Category> = {};
        for (const definition of this.settings.systemCategories) {
            categories[definition.key] = await this.ensureSystemCategory(definition, owned);
        }
        return categories;
    }

    // The default catalog lists the system categories: the ones it lacks are added, and the others are left as they are
    async reconcileDefaultCatalog(defaultCatalogId: string, categories: Category[]): Promise<boolean> {
        const catalog = await this.catalogs.getCatalog(defaultCatalogId);
        if (catalog === null) {
            throw new Error(`The default catalog ${defaultCatalogId} does not exist`);
        }
        const current = catalog.category ?? [];
        const missing = categories.filter((category) => !current.some((listed) => listed.id === category.id));
        if (missing.length === 0) {
            return false;
        }
        await this.catalogs.updateCatalog(defaultCatalogId, {
            category: [...current, ...missing.map((category) => ({ id: category.id, href: category.href ?? category.id, name: category.name }))]
        });
        this.log.info(`${missing.length} system categories were added to the default catalog`);
        return true;
    }

    // ---- Support package spec

    private async storedSupportPackageSpecId(): Promise<string> {
        return text((await this.records.list('supportpackagespec'))[0]?.['spec_id']);
    }

    private async saveSupportPackageSpecId(specId: string, replacing: boolean): Promise<string> {
        const record = this.settings.records.supportPackageSpec;
        if (replacing) {
            await this.records.update('supportpackagespec', record, { spec_id: specId });
            return specId;
        }
        await this.records.ensureUniqueIds('supportpackagespec').catch((error: unknown) => this.log.warn('The support package spec record could not be made unique', { err: error }));
        try {
            await this.records.insert('supportpackagespec', record, { spec_id: specId });
            return specId;
        } catch (error) {
            if (!(error instanceof DuplicateRecordError)) {
                throw error;
            }
            return (await this.storedSupportPackageSpecId()) || specId;
        }
    }

    /**
     * The global specification that every software support package points at: the one that is stored, when it still exists, or the
     * one the software API already has (an older deployment made it when its first software was created), or a new one. It is apart from
     * `ensure` because the software API is a service of its own, and the catalog must not wait for it.
     */
    async ensureSupportPackageSpec(): Promise<string> {
        // 1. The one that is stored, when it still exists
        const stored = await this.storedSupportPackageSpecId();
        if (stored !== '') {
            if ((await this.software.getResourceSpec(stored)) !== null) {
                return stored;
            }
            this.log.warn(`The support package spec ${stored} does not exist any more`);
        }
        const replacing = stored !== '';

        // 2. One the software API has already: the checks are repeated here, since what is taken must be the support package spec
        const existing = (await this.software.listResourceSpecs({ '@type': SUPPORT_SPECIFICATION_TYPE })).filter((spec) => spec['@type'] === SUPPORT_SPECIFICATION_TYPE);
        if (existing.length > 0) {
            if (existing.length > 1) {
                this.log.warn(`There are ${existing.length} support package specs: the one with the smallest id is used`);
            }
            const registered = await this.saveSupportPackageSpecId(smallestId(existing), replacing);
            this.log.info(`The support package spec ${registered} was found in the software API`);
            return registered;
        }

        // 3. A new one
        const created = await this.software.createResourceSpec({ ...SUPPORT_SPECIFICATION });
        this.log.info(`The support package spec ${created.id} was created`);
        const registered = await this.saveSupportPackageSpecId(created.id, replacing);
        if (registered !== created.id) {
            this.log.info(`The support package spec was created first by another replica: ${created.id} is deleted`);
            await this.software.deleteResourceSpec(created.id);
        }
        return registered;
    }
}
