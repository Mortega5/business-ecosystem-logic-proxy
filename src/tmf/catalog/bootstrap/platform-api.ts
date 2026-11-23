import type { Catalog, CatalogChanges, CatalogDraft } from '../../schemas/catalog';
import type { Category, CategoryDraft } from '../../schemas/category';
import type { ResourceSpecification } from '../../schemas/resource-specification';

/** The catalog API for what the proxy does by itself, outside of a request: the default catalog and the system categories. */
export interface CatalogApi {
    getCatalog: (id: string) => Promise<Catalog | null>;
    listCatalogs: (query: Record<string, string>) => Promise<Catalog[]>;
    createCatalog: (draft: CatalogDraft) => Promise<Catalog>;
    updateCatalog: (id: string, changes: CatalogChanges) => Promise<void>;
    deleteCatalog: (id: string) => Promise<void>;
    getCategory: (id: string) => Promise<Category | null>;
    listCategories: (query: Record<string, string>) => Promise<Category[]>;
    createCategory: (draft: CategoryDraft) => Promise<Category>;
    deleteCategory: (id: string) => Promise<void>;
}

/** The software API for the same, the global specification of the support packages. */
export interface SoftwareApi {
    getResourceSpec: (id: string) => Promise<ResourceSpecification | null>;
    listResourceSpecs: (query: Record<string, string>) => Promise<ResourceSpecification[]>;
    /** Makes the specification; `draft` is what the software API takes, which is not read here. */
    createResourceSpec: (draft: object) => Promise<ResourceSpecification>;
    deleteResourceSpec: (id: string) => Promise<void>;
}
