import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import type { PlatformEntities } from './category-rules';

/**
 * What the platform keeps in the TMForum APIs and knows by id: the default catalog, the system categories by key, and the specification of
 * the support packages. The start-up
 * says what they are once it finds them; until then the default catalog is the one that the configuration sets, if any, and there
 * are no system categories.
 */
@Injectable()
export class CatalogDefaults implements PlatformEntities {
    private catalogId: string;
    private categories: Record<string, string> = {};
    private supportSpecId = '';

    constructor(config: AppConfigService) {
        this.catalogId = config.catalog.defaultCatalogId;
    }

    /** The id of the default catalog, or an empty text while it is not known. */
    get defaultCatalogId(): string {
        return this.catalogId;
    }

    /** The ids of the system categories by key (`dataset`, `api`...). */
    get systemCategoryIds(): Readonly<Record<string, string>> {
        return this.categories;
    }

    /** The id of the specification that every support package of the software points at, or an empty text while it is not known. */
    get supportPackageSpecId(): string {
        return this.supportSpecId;
    }

    setSupportPackageSpecId(id: string): void {
        this.supportSpecId = id;
    }

    set(defaultCatalogId: string, systemCategoryIds: Record<string, string>): void {
        this.catalogId = defaultCatalogId;
        this.categories = { ...systemCategoryIds };
    }

    isDefaultCatalog(id: string): boolean {
        return this.catalogId !== '' && id === this.catalogId;
    }

    isSystemCategory(id: string): boolean {
        return Object.values(this.categories).includes(id);
    }
}
