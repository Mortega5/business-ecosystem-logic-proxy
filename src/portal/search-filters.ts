import { isRecord } from '../tmf/related-party';

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
