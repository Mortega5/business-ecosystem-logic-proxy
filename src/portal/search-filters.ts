import { isRecord } from '../tmf/related-party';
import { nonEmpty, type Validated } from './validation';

export interface SearchFilters extends Record<string, unknown> {
    primaryCategoriesMode: string;
    primaryRootName: string;
    filters: unknown[];
}

export const defaultSearchFilters = (): SearchFilters => ({ primaryCategoriesMode: 'catalogFirstLevel', primaryRootName: '', filters: [] });

/**
 * The filters of the search as the administrator saved them, for the portal. The ones that take their values from the children of a root
 * category and say nothing of where the offer form shows them are not shown there.
 */
export const searchFiltersFrom = (stored: unknown): SearchFilters => {
    if (!isRecord(stored)) {
        return defaultSearchFilters();
    }
    const filters = Array.isArray(stored['filters'])
        ? (stored['filters'] as unknown[]).map((filter) => (isRecord(filter) && filter['source'] === 'categoryRoot' && !Object.hasOwn(filter, 'offerFormPlacement') ? { ...filter, offerFormPlacement: 'none' } : filter))
        : stored['filters'];
    return { ...stored, ...(filters === undefined ? {} : { filters }) } as SearchFilters;
};

const PLACEMENTS = ['none', 'generalInfo', 'categorySection'];

const validateOption = (option: unknown, at: string, errors: string[]): { name: string; label?: string } | undefined => {
    if (!isRecord(option)) {
        errors.push(`${at} must be an object`);
        return undefined;
    }
    for (const forbidden of ['source', 'rootName', 'children']) {
        if (forbidden in option) {
            errors.push(`${at} must not include ${forbidden === 'children' ? 'nested children' : forbidden}`);
        }
    }
    const name = nonEmpty(option['name']);
    if (name === undefined) {
        errors.push(`${at}.name is required and must be non-empty`);
    }
    if ('label' in option && typeof option['label'] !== 'string') {
        errors.push(`${at}.label must be a string`);
    }
    return name === undefined ? undefined : { name, ...(typeof option['label'] === 'string' ? { label: option['label'] } : {}) };
};

const validateFilter = (filter: unknown, index: number, errors: string[]): Record<string, unknown> | undefined => {
    const at = `filters[${index}]`;
    if (!isRecord(filter)) {
        errors.push(`${at} must be an object`);
        return undefined;
    }
    const name = nonEmpty(filter['name']);
    if (name === undefined) {
        errors.push(`${at}.name is required and must be non-empty`);
    }
    if ('label' in filter && typeof filter['label'] !== 'string') {
        errors.push(`${at}.label must be a string`);
    }
    const source = filter['source'];
    if (source !== 'configured' && source !== 'categoryRoot') {
        errors.push(`${at}.source must be one of: configured, categoryRoot`);
    }
    const placement = Object.hasOwn(filter, 'offerFormPlacement') ? filter['offerFormPlacement'] : 'none';
    if (typeof placement !== 'string' || !PLACEMENTS.includes(placement)) {
        errors.push(`${at}.offerFormPlacement must be one of: ${PLACEMENTS.join(', ')}`);
    } else if (source === 'configured' && placement !== 'none') {
        errors.push(`${at}.offerFormPlacement must be none when source is configured`);
    }
    let children: unknown[] = [];
    let rootName: string | undefined;
    if (source === 'configured') {
        if ('children' in filter && !Array.isArray(filter['children'])) {
            errors.push(`${at}.children must be an array`);
        } else if (Array.isArray(filter['children'])) {
            children = filter['children'].map((option: unknown, position: number) => validateOption(option, `${at}.children[${position}]`, errors)).filter((option) => option !== undefined);
        }
    } else if (source === 'categoryRoot') {
        rootName = nonEmpty(filter['rootName']);
        if (rootName === undefined) {
            errors.push(`${at}.rootName is required and must be non-empty when source is categoryRoot`);
        }
        if ('children' in filter) {
            if (!Array.isArray(filter['children'])) {
                errors.push(`${at}.children must be an array when provided`);
            } else if (filter['children'].length > 0) {
                errors.push(`${at}.children must be empty when source is categoryRoot`);
            }
        }
    }
    if (name === undefined || (source !== 'configured' && source !== 'categoryRoot')) {
        return undefined;
    }
    return {
        name,
        source,
        ...(typeof filter['label'] === 'string' ? { label: filter['label'] } : {}),
        ...(source === 'configured' ? { children } : { offerFormPlacement: placement, rootName })
    };
};

/** The filters of the search that an administrator saves: what is valid, in its normal form, or what is wrong with it. */
export const validateSearchFilters = (body: Record<string, unknown>): Validated<SearchFilters> => {
    const errors: string[] = [];
    for (const required of ['primaryCategoriesMode', 'primaryRootName', 'filters']) {
        if (!Object.hasOwn(body, required)) {
            errors.push(`${required} is required`);
        }
    }
    const mode = body['primaryCategoriesMode'];
    if (mode !== 'catalogFirstLevel' && mode !== 'rooted') {
        errors.push('primaryCategoriesMode must be one of: catalogFirstLevel, rooted');
    }
    if (typeof body['primaryRootName'] !== 'string') {
        errors.push('primaryRootName must be a string');
    }
    if (!Array.isArray(body['filters'])) {
        errors.push('filters must be an array');
    }
    if (errors.length > 0) {
        return { errors };
    }
    if (mode === 'catalogFirstLevel') {
        return { errors: [], value: defaultSearchFilters() };
    }
    const primaryRootName = nonEmpty(body['primaryRootName']);
    if (primaryRootName === undefined) {
        errors.push('primaryRootName must be non-empty when primaryCategoriesMode is rooted');
    }
    const filters = (body['filters'] as unknown[]).map((filter, index) => validateFilter(filter, index, errors)).filter((filter) => filter !== undefined);
    if (filters.filter((filter) => filter['offerFormPlacement'] === 'generalInfo').length > 1) {
        errors.push('Only one filter may use offerFormPlacement generalInfo');
    }
    return errors.length > 0 || primaryRootName === undefined ? { errors } : { errors: [], value: { primaryCategoriesMode: 'rooted', primaryRootName, filters } };
};
