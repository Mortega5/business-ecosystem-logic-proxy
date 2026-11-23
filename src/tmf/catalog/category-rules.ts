import { DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';
import { isResourceId } from '../resource-id.pipe';

export interface CategoryShape {
    isRoot: boolean;
    parentId: string | null;
    name: string;
    /** Whether another category may be the same one: it is new, or its name, its parent or its root status changed. */
    needsChecks: boolean;
}

const asParent = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value !== 'string' || !isResourceId(value)) {
        throw new DomainError('The parent id of a category is not valid', 400);
    }
    return value;
};

/**
 * What a category is once a creation or a change is made: root unless it says otherwise, with a parent only when it is not root, and
 * with a name. `previous` is the category as it was, when there is one.
 */
export const categoryShape = (changes: Record<string, unknown>, previous: Record<string, unknown> | undefined, nameLength: number): CategoryShape => {
    if ('isRoot' in changes && typeof changes['isRoot'] !== 'boolean') {
        throw new DomainError('The field isRoot of a category must be true or false', 400);
    }
    const isRoot = 'isRoot' in changes ? changes['isRoot'] === true : previous === undefined ? true : previous['isRoot'] !== false;
    const parentId = asParent('parentId' in changes ? changes['parentId'] : previous?.['parentId']);
    if (isRoot && parentId !== null) {
        throw new DomainError('Parent ID cannot be included when the category is root', 400);
    }
    if (!isRoot && parentId === null) {
        throw new DomainError('Non-root categories must contain a parent category', 400);
    }
    const name = 'name' in changes ? changes['name'] : previous?.['name'];
    if (typeof name !== 'string' || name.trim() === '') {
        throw new DomainError('Category name is mandatory', 400);
    }
    if (name.length > nameLength) {
        throw new DomainError(`Category name is too long, it must be less than ${nameLength} characters`, 400);
    }
    const changed = (field: string): boolean => previous !== undefined && field in changes && changes[field] !== previous[field];
    return { isRoot, parentId, name, needsChecks: previous === undefined || changed('name') || changed('isRoot') || changed('parentId') };
};

/** What the platform keeps: the default catalog and the system categories, which the marketplace relies on being there. */
export interface PlatformEntities {
    isDefaultCatalog: (id: string) => boolean;
    isSystemCategory: (id: string) => boolean;
}

export const DEFAULT_CATALOG_TYPE = 'default';

/**
 * Why the platform refuses a change or a delete of the default catalog or of a system category, if it does: they cannot be deleted,
 * retired or made obsolete, a category cannot be renamed or moved, and the catalog type of the default catalog does not change.
 */
export const systemEntityViolation = (platform: PlatformEntities, kind: 'category' | 'catalog', method: string, id: string, body: unknown): string | undefined => {
    const isDefaultCatalog = kind === 'catalog' && platform.isDefaultCatalog(id);
    const isSystemCategory = kind === 'category' && platform.isSystemCategory(id);
    if (!isDefaultCatalog && !isSystemCategory) {
        return undefined;
    }
    const subject = isDefaultCatalog ? 'The default catalog' : 'A system category';
    if (method === 'DELETE') {
        return `${subject} cannot be deleted`;
    }
    if ((method !== 'PATCH' && method !== 'PUT') || !isRecord(body)) {
        return undefined;
    }
    const status = typeof body['lifecycleStatus'] === 'string' ? body['lifecycleStatus'].toLowerCase() : undefined;
    if (status === 'retired' || status === 'obsolete') {
        return `${subject} cannot be retired`;
    }
    const parent = body['parentId'];
    if (isSystemCategory && (body['name'] !== undefined || body['isRoot'] === false || (parent !== undefined && parent !== null && parent !== ''))) {
        return 'A system category cannot be renamed or moved';
    }
    if (isDefaultCatalog && body['catalogType'] !== undefined && body['catalogType'] !== DEFAULT_CATALOG_TYPE) {
        return 'The catalog type of the default catalog cannot change';
    }
    return undefined;
};
