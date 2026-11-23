import type { CatalogApi, SoftwareApi } from '../tmf/catalog/bootstrap/platform-api';
import type { Catalog, CatalogChanges, CatalogDraft } from '../tmf/schemas/catalog';
import type { Category, CategoryDraft } from '../tmf/schemas/category';
import type { ResourceSpecification } from '../tmf/schemas/resource-specification';

/** The catalog and software APIs of the TMForum, in memory: they give the ids and keep what is made. */
export class FakeApis implements CatalogApi, SoftwareApi {
    catalogs: Catalog[] = [];
    categories: Category[] = [];
    specs: ResourceSpecification[] = [];
    calls: string[] = [];
    private next = 0;
    /** Something that happens in the TMForum while the start-up makes a catalog: another replica made its own. */
    afterCreateCatalog: (() => void) | undefined;

    private id(kind: string): string {
        this.next += 1;
        return `${kind}-${String(this.next).padStart(2, '0')}`;
    }

    private match<T extends object>(items: T[], query: Record<string, string>): T[] {
        return items.filter((item) => Object.entries(query).every(([name, value]) => String((item as Record<string, unknown>)[name]) === value));
    }

    getCatalog = (id: string): Promise<Catalog | null> => Promise.resolve(this.catalogs.find((catalog) => catalog.id === id) ?? null);
    listCatalogs = (query: Record<string, string>): Promise<Catalog[]> => Promise.resolve(this.match(this.catalogs, query));
    createCatalog = (draft: CatalogDraft): Promise<Catalog> => {
        this.calls.push('createCatalog');
        const created: Catalog = { ...draft, id: this.id('catalog') };
        this.catalogs.push(created);
        this.afterCreateCatalog?.();
        return Promise.resolve(created);
    };
    updateCatalog = (id: string, changes: CatalogChanges): Promise<void> => {
        this.calls.push(`updateCatalog ${id}`);
        Object.assign(this.catalogs.find((catalog) => catalog.id === id) ?? {}, changes);
        return Promise.resolve();
    };
    deleteCatalog = (id: string): Promise<void> => {
        this.calls.push(`deleteCatalog ${id}`);
        this.catalogs = this.catalogs.filter((catalog) => catalog.id !== id);
        return Promise.resolve();
    };
    getCategory = (id: string): Promise<Category | null> => Promise.resolve(this.categories.find((category) => category.id === id) ?? null);
    // Like the TMForum, it filters by the name; the root status is left to the one that asks
    listCategories = (query: Record<string, string>): Promise<Category[]> => Promise.resolve(this.categories.filter((category) => category.name === query['name']));
    createCategory = (draft: CategoryDraft): Promise<Category> => {
        this.calls.push(`createCategory ${draft.name}`);
        const created: Category = { ...draft, id: this.id('category') };
        this.categories.push(created);
        return Promise.resolve(created);
    };
    deleteCategory = (id: string): Promise<void> => {
        this.calls.push(`deleteCategory ${id}`);
        this.categories = this.categories.filter((category) => category.id !== id);
        return Promise.resolve();
    };
    getResourceSpec = (id: string): Promise<ResourceSpecification | null> => Promise.resolve(this.specs.find((spec) => spec.id === id) ?? null);
    listResourceSpecs = (query: Record<string, string>): Promise<ResourceSpecification[]> => Promise.resolve(this.match(this.specs, query));
    createResourceSpec = (draft: object): Promise<ResourceSpecification> => {
        this.calls.push('createResourceSpec');
        const created: ResourceSpecification = { ...draft, id: this.id('spec') };
        this.specs.push(created);
        return Promise.resolve(created);
    };
    deleteResourceSpec = (id: string): Promise<void> => {
        this.calls.push(`deleteResourceSpec ${id}`);
        this.specs = this.specs.filter((spec) => spec.id !== id);
        return Promise.resolve();
    };
}
